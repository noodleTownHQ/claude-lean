import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { SessionStats, Tally } from '../types'
import { addedFileMounts, isGuardedYaml, planEdit, pushesBranch, tagLines, trimMiddle } from './lib'
import type { HashEditOp } from './lib'

// Output past `trimChars` (default 10,000) keeps 40% head and 30% tail; the full text goes to OUT_DIR.
const OUT_DIR = '/tmp/claude-lean'

const HASH_READ = 'mcp__lean__HashRead'
const HASH_EDIT = 'mcp__lean__HashEdit'
const SCOUT = 'lean:scout'

const zero = (): Tally => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const fresh = (): SessionStats => ({
  main: zero(), sub: zero(), trims: 0, charsCut: 0,
  hashReads: 0, hashEdits: 0, hashEditFails: 0, editCharsSaved: 0, guards: 0,
})
const stats = atom({ plugin: 'lean', key: 'stats' } as const, fresh())

type Lifetime = Record<'on' | 'off', Tally & { sessions: number }>

const add = (t: Tally, u: TurnUsage): Tally => ({
  turns: t.turns + 1,
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
})

const bump = ($: EngineInterface, fn: (s: SessionStats) => SessionStats) => update($, stats, fn)

const absolute = async ($: EngineInterface, path: string) =>
  path.startsWith('/') ? path : `${(await $.session.cwd()).replace(/\/$/, '')}/${path}`

const failEdit = async ($: EngineInterface, why: string) => {
  await bump($, s => ({ ...s, hashEditFails: s.hashEditFails + 1 }))
  return { deny: why }
}

const SCOUT_PROMPT = `You are a fast, read-only scout. Find what you were asked to find and report it tersely:
- one line per hit: path:line, then a few words on what is there
- then a one to three sentence answer to the question
Quote code only when the answer depends on its exact text, and then only the few lines that matter. Never paste whole files or long outputs. Do not edit, write, or run anything that changes state. Stop as soon as you can answer.`

const guide = (tools: readonly string[]): string | undefined => {
  const lines: string[] = []
  if (tools.includes(HASH_EDIT)) {
    lines.push(`- For an edit spanning several lines, read the region with ${HASH_READ}, then change it with ${HASH_EDIT} using the LINE:HASH anchors, instead of retyping the old text into Edit. Keep using Edit for a one-line change.`)
  }
  if (tools.includes('Agent')) {
    lines.push(`- Send searches across many files, and other look-up work whose answer is a few paths and lines, to the ${SCOUT} agent (a cheap, fast model) rather than reading the files yourself.`)
  }
  lines.push('- Long Bash and Grep output arrives trimmed to its head and tail, with the full text saved to a file the output names. When you need the middle, read that file with offset/limit or grep it rather than running the command again.')
  return `# Token discipline (lean mod)\n${lines.join('\n')}`
}

export const register: Register = (on, options) => {
  const branch = String(options.protectBranch ?? '').trim()
  const pushNote = String(options.pushNote ?? '').trim()
  const mountPath = String(options.mountGuardPath ?? '').trim()
  const LIMIT = Math.max(2_000, Number(options.trimChars ?? 10_000) || 10_000)
  const HEAD = Math.round(LIMIT * 0.4)
  const TAIL = Math.round(LIMIT * 0.3)
  let hashOn = true
  let cwd = ''

  on('session.start', async ($, e, next) => {
    hashOn = ((await $.store.get('hashline')) ?? true) === true
    cwd = e.cwd

    await $.command.register({
      name: 'lean',
      description: 'Token report for this session and the hashline A/B',
      argumentHint: '[hashline on|off]',
    })

    if (hashOn) {
      await $.tool.register({
        name: 'HashRead',
        description: 'Read a text file with each line tagged LINE:HASH|text, for use with HashEdit. Same paging as Read (offset is the 1-based first line, limit the line count).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['path'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'HashEdit',
        description: 'Edit a file by the LINE:HASH anchors HashRead gave. Each edit is {start, end?, text} (replace lines start..end inclusive with text; text "" deletes them) or {after, text} (insert text after that line). A changed line makes its anchor stale and the call fails: HashRead again. Runs as an ordinary Edit, so its permission rules apply.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  start: { type: 'string', description: 'LINE:HASH of the first line to replace' },
                  end: { type: 'string', description: 'LINE:HASH of the last line to replace (default: start)' },
                  after: { type: 'string', description: 'LINE:HASH of the line to insert after' },
                  text: { type: 'string', description: 'The new lines, joined by newlines' },
                },
                required: ['text'],
              },
            },
          },
          required: ['path', 'edits'],
        },
        isDeferred: false,
      })
    }

    await $.agent.register({
      name: 'scout',
      description: 'Cheap, fast read-only search: finds files, definitions and usages across the codebase and answers with paths and line numbers, not file dumps.',
      prompt: SCOUT_PROMPT,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      model: 'haiku',
      maxTurns: 25,
      omitClaudeMd: true,
    })

    const mode = hashOn ? 'on' : 'off'
    const life = ((await $.store.get('lifetime')) ?? {}) as Partial<Lifetime>
    const row = life[mode] ?? { ...zero(), sessions: 0 }
    await $.store.set('lifetime', { ...life, [mode]: { ...row, sessions: row.sessions + 1 } })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = guide(e.tools)
    return text === undefined
      ? composed
      : { sections: [...composed.sections, { id: 'lean:guide', text, scope: 'session' }] }
  })

  // Bash: the protected-branch guard, then trimming.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (pushesBranch(e.command, branch, cwd)) {
      await bump($, s => ({ ...s, guards: s.guards + 1 }))
      return {
        deny: `lean: pushes to ${branch} are protected in this setup${pushNote ? ` (${pushNote})` : ''}. Push to another branch instead. If the person asked for this push in this conversation, prefix the command with LEAN_ALLOW_PUSH=1.`,
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const r = ran.result
    if (r.isImage || r.backgroundTaskId !== undefined || r.persistedOutputPath !== undefined) return ran

    const saved = `${OUT_DIR}/${e.tool_use_id}.txt`
    const out = trimMiddle(r.stdout, LIMIT, HEAD, TAIL, saved)
    const err = trimMiddle(r.stderr, LIMIT, HEAD, TAIL, saved)
    if (!out && !err) return ran

    await $.fs.write(saved, r.stderr ? `${r.stdout}\n--- stderr ---\n${r.stderr}` : r.stdout)
    await bump($, s => ({
      ...s, trims: s.trims + 1, charsCut: s.charsCut + (out?.cutChars ?? 0) + (err?.cutChars ?? 0),
    }))
    return { result: { ...r, stdout: out?.text ?? r.stdout, stderr: err?.text ?? r.stderr } }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const r = ran.result
    if (r.mode !== 'content' || r.content === undefined) return ran

    const saved = `${OUT_DIR}/${e.tool_use_id}.txt`
    const cut = trimMiddle(r.content, LIMIT, HEAD, TAIL, saved)
    if (!cut) return ran

    await $.fs.write(saved, r.content)
    await bump($, s => ({ ...s, trims: s.trims + 1, charsCut: s.charsCut + cut.cutChars }))
    return { result: { ...r, content: cut.text } }
  }).catch(($, e, next) => next(e))

  // No single-file bind mounts of checkout files in the guarded compose folder.
  const mountDeny = (found: string[]) => ({
    deny: `lean: ${found.join(', ')} would be a single-file bind mount. When git replaces the file (a reset, a checkout, a pull) the container keeps the old inode and stops seeing changes. Mount the directory instead. If it really must be one file, end that line with "# lean: file-mount-ok".`,
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!isGuardedYaml(e.file_path, mountPath)) return next(e)
    const found = addedFileMounts(e.new_string, e.old_string)
    if (found.length === 0) return next(e)
    await bump($, s => ({ ...s, guards: s.guards + 1 }))
    return mountDeny(found)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'lean: its compose guard failed' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!isGuardedYaml(e.file_path, mountPath)) return next(e)
    const before = await $.fs.read(e.file_path).catch(() => '')
    const found = addedFileMounts(e.content, typeof before === 'string' ? before : '')
    if (found.length === 0) return next(e)
    await bump($, s => ({ ...s, guards: s.guards + 1 }))
    return mountDeny(found)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'lean: its compose guard failed' }))

  on('tool.call', { tool: HASH_READ }, async ($, e) => {
    const args = e as unknown as { path: string; offset?: number; limit?: number }
    const file_path = await absolute($, args.path)
    const r = await $.tool.call({
      tool: 'Read', file_path,
      ...(args.offset !== undefined && { offset: args.offset }),
      ...(args.limit !== undefined && { limit: args.limit }),
    })
    if (r.deny !== undefined) return { deny: `Read refused: ${r.deny}` }
    if (r.isError === true) return { deny: r.text ?? 'Read failed' }
    const res = r.result
    if (res.type !== 'text') return { deny: `${file_path} is not a text file; use Read` }

    await bump($, s => ({ ...s, hashReads: s.hashReads + 1 }))
    const f = res.file
    const tagged = tagLines(f.content, f.startLine)
    const last = f.startLine + (tagged === '' ? 0 : tagged.split('\n').length) - 1
    // Read counts the empty line after a final newline; past the end, the shown lines are the total.
    const isEnd = f.startLine + f.numLines - 1 >= f.totalLines
    const total = isEnd ? last : f.totalLines
    const more = isEnd ? '' : ` (more below: offset=${last + 1})`
    return { result: `${f.filePath} lines ${f.startLine}-${last} of ${total}${more}\n${tagged}` }
  })

  on('tool.call', { tool: HASH_EDIT }, async ($, e) => {
    const args = e as unknown as { path: string; edits: HashEditOp[] }
    const file_path = await absolute($, args.path)

    const text = await $.fs.read(file_path).catch(() => undefined)
    if (typeof text !== 'string') return failEdit($, `cannot read ${file_path}`)
    const plan = planEdit(text, args.edits ?? [])
    if (!plan.ok) return failEdit($, `${plan.error}. HashRead the region again and retry.`)

    const r = await $.tool.call({ tool: 'Edit', file_path, old_string: plan.old, new_string: plan.new })
    if (r.deny !== undefined) return failEdit($, `Edit refused: ${r.deny}`)
    if (r.isError === true) return failEdit($, `Edit failed: ${r.text ?? 'unknown error'}`)

    // What an Edit call would have had the model type, less the anchors it typed instead.
    const typed = JSON.stringify(args.edits).length
    await bump($, s => ({
      ...s, hashEdits: s.hashEdits + 1,
      editCharsSaved: s.editCharsSaved + Math.max(0, plan.old.length + plan.new.length - typed),
    }))

    const shift = plan.delta === 0 ? '' : ` Lines below ${plan.last + 1} moved by ${plan.delta > 0 ? '+' : ''}${plan.delta}; their old anchors are stale.`
    return {
      result: `Edited ${file_path}.${shift} Fresh anchors for the edited region:\n${tagLines(plan.newRegion.join('\n'), plan.first + 1)}`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const u = e.usage
    if (!u) return done
    const side = e.agentId === undefined ? 'main' : 'sub'
    await bump($, s => ({ ...s, [side]: add(s[side], u) }))
    if (side === 'main') {
      const mode = hashOn ? 'on' : 'off'
      const life = ((await $.store.get('lifetime')) ?? {}) as Partial<Lifetime>
      const row = life[mode] ?? { ...zero(), sessions: 0 }
      await $.store.set('lifetime', { ...life, [mode]: { ...add(row, u), sessions: row.sessions } })
    }
    return done
  })

  on('command.run', { command: 'lean' }, async ($, e) => {
    const [what, value] = e.args.trim().split(/\s+/)
    if (what === 'hashline') {
      if (value !== 'on' && value !== 'off') return { text: 'Usage: /lean hashline on|off' }
      await $.store.set('hashline', value === 'on')
      return { text: `hashline ${value} from the next session (this one stays ${hashOn ? 'on' : 'off'}).` }
    }
    return { text: await report($, hashOn) }
  })
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
const perTurn = (t: Tally) => (t.turns === 0 ? '-' : k(Math.round(t.output / t.turns)))

const report = async ($: EngineInterface, hashOn: boolean): Promise<string> => {
  const s = await read($, stats)
  const usage = await $.session.usage().catch(() => undefined)
  const life = ((await $.store.get('lifetime')) ?? {}) as Partial<Lifetime>
  const row = (name: string, t?: Tally & { sessions: number }) =>
    t ? `  ${name}: ${t.sessions} sessions, ${t.turns} turns, ${perTurn(t)} output tokens per turn` : `  ${name}: no data yet`

  return [
    `lean, this session (hashline ${hashOn ? 'on' : 'off'})`,
    `  main loop: ${s.main.turns} turns, output ${k(s.main.output)} (${perTurn(s.main)}/turn), input ${k(s.main.input)}, cache read ${k(s.main.cacheRead)}, cache write ${k(s.main.cacheWrite)}`,
    `  subagents: ${s.sub.turns} turns, output ${k(s.sub.output)}, input ${k(s.sub.input + s.sub.cacheRead + s.sub.cacheWrite)}`,
    usage?.cost ? `  cost so far: $${usage.cost.usd.toFixed(2)}${usage.context.percent !== undefined ? `, context ${usage.context.percent}% full` : ''}` : '',
    'savings (estimated at 4 chars per token)',
    `  trimmed outputs: ${s.trims}, about ${k(Math.round(s.charsCut / 4))} tokens kept out of context`,
    `  hashline: ${s.hashReads} reads, ${s.hashEdits} edits (${s.hashEditFails} failed), about ${k(Math.round(s.editCharsSaved / 4))} output tokens not typed`,
    `  guards fired: ${s.guards}`,
    'hashline A/B, all sessions (main loop)',
    row('on ', life.on),
    row('off', life.off),
    'Switch with /lean hashline on|off (applies from the next session).',
  ].filter(Boolean).join('\n')
}
