import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

import { addedFileMounts, checkerFor, hashLine, isGuardedYaml, matchRules, parseAdvice, parseRules, planEdit, pushesBranch, streamHit, tagLines, trimMiddle } from '../hooks/lib'

const FILE = 'alpha\nbeta\ngamma\ndelta\n'
const at = (n: number) => `${n}:${hashLine(FILE.split('\n')[n - 1]!)}`

describe('planEdit', () => {
  test('replaces a range', () => {
    const p = planEdit(FILE, [{ start: at(2), end: at(3), text: 'B\nC\nC2' }])
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(FILE.replace(p.old, p.new)).toBe('alpha\nB\nC\nC2\ndelta\n')
    expect(p.delta).toBe(1)
  })

  test('deletes lines without leaving a blank one', () => {
    const p = planEdit(FILE, [{ start: at(2), text: '' }])
    if (!p.ok) throw new Error(p.error)
    expect(FILE.replace(p.old, p.new)).toBe('alpha\ngamma\ndelta\n')
  })

  test('deletes the last line of a file with no final newline', () => {
    const text = 'a\nb'
    const p = planEdit(text, [{ start: `2:${hashLine('b')}`, text: '' }])
    if (!p.ok) throw new Error(p.error)
    expect(text.replace(p.old, p.new)).toBe('a')
  })

  test('inserts after a line, and applies several edits at once', () => {
    const p = planEdit(FILE, [{ after: at(1), text: 'one' }, { start: at(4), text: 'D' }])
    if (!p.ok) throw new Error(p.error)
    expect(FILE.replace(p.old, p.new)).toBe('alpha\none\nbeta\ngamma\nD\n')
  })

  test('widens a region until it is unique', () => {
    const text = 'x\nsame\ny\nsame\n'
    const p = planEdit(text, [{ start: `4:${hashLine('same')}`, text: 'new' }])
    if (!p.ok) throw new Error(p.error)
    expect(text.split(p.old).length).toBe(2)
    expect(text.replace(p.old, p.new)).toBe('x\nsame\ny\nnew\n')
  })

  test('refuses stale anchors and overlaps', () => {
    expect(planEdit(FILE, [{ start: '2:zzz', text: 'x' }]).ok).toBe(false)
    expect(planEdit(FILE, [{ start: at(2), end: at(3), text: 'x' }, { start: at(3), text: 'y' }]).ok).toBe(false)
  })

  test('tags lines from the first line number given', () => {
    expect(tagLines('a\nb\n', 7)).toBe(`7:${hashLine('a')}|a\n8:${hashLine('b')}|b`)
  })
})

describe('rules', () => {
  test('push to the protected branch', () => {
    const main = (c: string, cwd?: string) => pushesBranch(c, 'main', cwd)
    expect(main('git push origin main')).toBe(true)
    expect(main('cd x && git push -u origin HEAD:main')).toBe(true)
    expect(main('git -C /r push --all')).toBe(true)
    expect(main('git push -u origin claude/feature')).toBe(false)
    expect(main('git push origin main --dry-run')).toBe(false)
    expect(main('LEAN_ALLOW_PUSH=1 git push origin main')).toBe(false)
    expect(main('git log main')).toBe(false)
    expect(main('git -C /tmp/other push origin main', '/repo')).toBe(false)
    expect(main('cd /tmp/other && git push origin main', '/repo')).toBe(false)
    expect(main('git -C /repo/sub push origin main', '/repo')).toBe(true)
    expect(pushesBranch('git push origin main', '')).toBe(false)
    expect(pushesBranch('git push origin release.1', 'release.1')).toBe(true)
    expect(pushesBranch('git push origin releasex1', 'release.1')).toBe(false)
  })

  test('guarded YAML paths', () => {
    expect(isGuardedYaml('/r/deploy/compose/app/compose.yml', 'deploy/compose/')).toBe(true)
    expect(isGuardedYaml('/r/deploy/compose/app/README.md', 'deploy/compose/')).toBe(false)
    expect(isGuardedYaml('/r/deploy/compose/app/compose.yml', '')).toBe(false)
  })

  test('single-file bind mounts', () => {
    expect(addedFileMounts('    - ./config.yml:/app/config.yml:ro', '')).toEqual(['./config.yml'])
    expect(addedFileMounts('    - ./config/:/app/config', '')).toEqual([])
    expect(addedFileMounts('    - /var/run/docker.sock:/var/run/docker.sock', '')).toEqual([])
    expect(addedFileMounts('        source: ../x/app.env', '')).toEqual(['../x/app.env'])
    expect(addedFileMounts('    - ./a.yml:/a.yml # lean: file-mount-ok', '')).toEqual([])
    expect(addedFileMounts('    - ./a.yml:/a.yml', '    - ./a.yml:/a.yml')).toEqual([])
  })

  test('trimMiddle keeps head and tail', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const t = trimMiddle(big, 1000, 300, 200, '/tmp/x.txt')
    expect(t).toBeDefined()
    expect(t!.text.startsWith('line 0\n')).toBe(true)
    expect(t!.text.endsWith('line 1999')).toBe(true)
    expect(t!.text).toContain('/tmp/x.txt')
    expect(trimMiddle('short', 1000, 300, 200, '/tmp/x.txt')).toBeUndefined()
  })
})

// The engine beneath the plugin: just enough of it to start a session.
const world = (on: On, files: Record<string, string>, written: Record<string, string>) => {
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__lean__${e.name}` } }))
  on('agent.register', ($, e) => ({ value: { agent: `lean:${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

const START = { cwd: '/repo', surface: null, isInteractive: true } as const

describe('hooks', () => {
  test('long Bash output is trimmed and saved whole', async ($, on) => {
    const written: Record<string, string> = {}
    world(on, {}, written)
    const big = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n')
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: big, stderr: '', interrupted: false } }))

    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Bash', command: 'seq 3000' })
    if (r.deny !== undefined || r.isError === true) throw new Error('Bash failed')
    expect(r.result.stdout.length).toBeLessThan(big.length)
    expect(r.result.stdout).toContain('[lean: cut')
    expect(Object.values(written)).toContain(big)
  })

  test('a push to the protected branch is refused', { options: { protectBranch: 'main' } }, async ($, on) => {
    world(on, {}, {})
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'pushed', stderr: '', interrupted: false } }))

    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(r.deny ?? (r.isError === true ? r.text : undefined)).toContain('LEAN_ALLOW_PUSH=1')
  })

  test('HashRead then HashEdit writes the file without a nested Edit call', async ($, on) => {
    const written: Record<string, string> = {}
    world(on, { '/repo/a.txt': FILE }, written)
    on('tool.call', { tool: 'Read' }, () => ({
      result: { type: 'text', file: { filePath: '/repo/a.txt', content: FILE, numLines: 4, startLine: 1, totalLines: 4 } },
    }))
    let edits = 0
    on('tool.call', { tool: 'Edit' }, () => {
      edits++
      return { deny: 'auto mode: no request behind this call' }
    })

    await $.session.start(START)
    const read = await $.tool.call({ tool: 'mcp__lean__HashRead', path: 'a.txt' } as never)
    expect(String((read as { result?: unknown }).result)).toContain(`${at(2)}|beta`)

    const done = await $.tool.call({ tool: 'mcp__lean__HashEdit', path: 'a.txt', edits: [{ start: at(3), text: 'GAMMA $& $1' }] } as never)
    expect(String((done as { result?: unknown }).result)).toContain('Edited /repo/a.txt')
    expect(edits).toBe(0)
    expect(written['/repo/a.txt']).toBe('alpha\nbeta\nGAMMA $& $1\ndelta\n')
  })

  test('HashEdit honours an Edit deny rule', async ($, on) => {
    const written: Record<string, string> = {}
    world(on, { '/repo/a.txt': FILE }, written)
    on('tool.check', () => ({ decision: 'deny', reason: 'protected path' }))

    await $.session.start(START)
    const done = await $.tool.call({ tool: 'mcp__lean__HashEdit', path: 'a.txt', edits: [{ start: at(3), text: 'X' }] } as never)
    expect(done.deny ?? (done.isError === true ? done.text : undefined)).toContain('protected path')
    expect(written['/repo/a.txt']).toBeUndefined()
  })
})

describe('pattern rules and checks', () => {
  const RULES = JSON.stringify([
    { name: 'no-latest', match: ':latest\\b', rule: 'Pin images to a sha tag, never :latest.', block: true },
    { tool: 'Bash', match: '\\bnpm install\\b', rule: 'This repo uses pnpm.' },
    { match: '(', rule: 'a bad regex, dropped' },
    { rule: 'no match field, dropped' },
  ])

  test('parseRules keeps valid rules only', () => {
    expect(parseRules(RULES).map(r => r.name ?? r.rule)).toEqual(['no-latest', 'This repo uses pnpm.'])
    expect(parseRules('not json')).toEqual([])
    expect(parseRules('{}')).toEqual([])
  })

  test('matchRules looks at what a call runs or writes, and honours `tool`', () => {
    const rules = parseRules(RULES)
    expect(matchRules(rules, 'Edit', { new_string: 'image: foo:latest' }).map(r => r.name)).toEqual(['no-latest'])
    expect(matchRules(rules, 'Bash', { command: 'npm install x' })).toHaveLength(1)
    expect(matchRules(rules, 'Write', { content: 'npm install x' })).toHaveLength(0)
    expect(matchRules(rules, 'mcp__lean__HashEdit', { edits: [{ text: 'a:latest' }] })).toHaveLength(1)
  })

  test('checkerFor picks a checker by extension', () => {
    expect(checkerFor('/a/b.py')?.[0]).toBe('ruff')
    expect(checkerFor('x.sh')).toEqual(['bash', '-n', 'x.sh'])
    expect(checkerFor('x.json')?.[0]).toBe('python3')
    expect(checkerFor('x.ts')).toBeUndefined()
  })

  test('a blocking rule refuses the call', { options: { rulesFile: '/home/rules.json' } }, async ($, on) => {
    world(on, { '/home/rules.json': RULES }, {})
    let ran = false
    on('tool.call', { tool: 'Bash' }, () => {
      ran = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Bash', command: 'docker pull foo:latest' })
    expect(r.deny ?? (r.isError === true ? r.text : undefined)).toContain('Pin images to a sha tag')
    expect(ran).toBe(false)
  })

  test("a project's advisory rule runs the call and hands the rule along", async ($, on) => {
    world(on, { '/repo/.claude/lean-rules.json': RULES }, {})
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Bash', command: 'npm install left-pad' })
    expect(r.deny).toBeUndefined()
    expect((r as { context?: readonly string[] }).context?.join('\n') ?? '').toContain('uses pnpm')
  })

  test('an Edit to a Python file with errors hands back the checker output', async ($, on) => {
    world(on, {}, {})
    on('tool.call', { tool: 'Edit' }, ($, e) => ({
      result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: 'x', structuredPatch: [], userModified: false, replaceAll: false },
    }))
    on('process.run', ($, e) => ({
      value: { exitCode: 1, stdout: `${e.argv.at(-1)}:1:1: F821 Undefined name \`foo\``, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py', old_string: 'x', new_string: 'foo()' })
    expect((r as { context?: readonly string[] }).context?.join('\n') ?? '').toContain('F821')
  })

  test('diagnostics off: no checker runs', { options: { diagnostics: false } }, async ($, on) => {
    world(on, {}, {})
    on('tool.call', { tool: 'Edit' }, ($, e) => ({
      result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: 'x', structuredPatch: [], userModified: false, replaceAll: false },
    }))
    let runs = 0
    on('process.run', () => {
      runs++
      return { value: { exitCode: 1, stdout: 'bad', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py', old_string: 'x', new_string: 'y' })
    expect(runs).toBe(0)
  })
})

describe('stream rules and the advisor', () => {
  const STREAM_RULES = JSON.stringify([
    { name: 'no-leak', match: 'Box::leak', rule: "Don't reach for Box::leak.", stream: true },
    { match: ':latest', rule: 'tool-call rule' },
  ])
  const STEP = { turnId: 't1', index: 0, model: 'opus', messageCount: 3 } as const
  // Reads a step's stream to its end: its chunks and what it returned.
  const drain = async (stream: AsyncGenerator<TurnStepChunk, unknown>) => {
    const chunks: TurnStepChunk[] = []
    for (;;) {
      const n = await stream.next()
      if (n.done) return { chunks, r: n.value as { stopReason: string; toolUses: unknown[] } }
      chunks.push(n.value)
    }
  }

  test('streamHit and matchRules keep stream and tool-call rules apart', () => {
    const rules = parseRules(STREAM_RULES)
    expect(streamHit(rules, 'we could Box::leak it', new Set())).toBe(0)
    expect(streamHit(rules, 'we could Box::leak it', new Set([0]))).toBeUndefined()
    expect(streamHit(rules, 'image :latest', new Set())).toBeUndefined()
    expect(matchRules(rules, 'Bash', { command: 'Box::leak' })).toHaveLength(0)
  })

  test('parseAdvice reads JSON, fenced or not, and treats anything else as none', () => {
    expect(parseAdvice('```json\n{"level":"concern","note":"Tests were not run."}\n```')).toEqual({ level: 'concern', note: 'Tests were not run.' })
    expect(parseAdvice('{"level":"weird","note":"x"}').level).toBe('none')
    expect(parseAdvice('{"level":"blocker","note":""}').level).toBe('none')
    expect(parseAdvice('looks fine to me').level).toBe('none')
  })

  test('a stream rule cuts the reply and ends the step with a Rule call', { options: { rulesFile: '/r.json' } }, async ($, on) => {
    world(on, { '/r.json': STREAM_RULES }, {})
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'Easiest is ' } as TurnStepChunk
      yield { kind: 'text', index: 0, text: 'Box::leak(s) here' } as TurnStepChunk
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } as TurnStepChunk
      return { turnId: 't1', index: 0, answer: 'Easiest is Box::leak(s) here', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start(START)

    const { chunks, r } = await drain($.turn.step(STEP))

    expect(chunks.filter(c => c.kind === 'text').map(c => (c as { text: string }).text)).toEqual(['Easiest is '])
    expect(chunks.find(c => c.kind === 'tool')).toMatchObject({ name: 'mcp__lean__Rule', index: 1 })
    expect(r.stopReason).toBe('tool_use')
    expect(JSON.stringify(r.toolUses)).toContain("Don't reach for Box::leak.")

    const ruled = await $.tool.call({ tool: 'mcp__lean__Rule', rule: 'x' } as never)
    expect(String((ruled as { result?: unknown }).result)).toContain('Carry on from there')
  })

  test('with no stream rules a step passes through untouched', async ($, on) => {
    world(on, {}, {})
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'Box::leak' } as TurnStepChunk
      return { turnId: 't1', index: 0, answer: 'Box::leak', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start(START)
    const { chunks, r } = await drain($.turn.step(STEP))
    expect(r.stopReason).toBe('end_turn')
    expect(chunks).toHaveLength(1)
  })

  const adviseWith = (on: On, text: string) => {
    world(on, {}, {})
    on('turn.step', async function* () {
      return { turnId: 't1', index: 0, answer: 'Done, all tests pass.', toolUses: [{ name: 'Edit', input: { file_path: 'a.ts' } }], stopReason: 'end_turn', usage: null }
    })
    on('model.complete', () => ({ value: { isAnswered: true, text, usage: {} as never } }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('classic.Stop', () => ({}))
  }

  test('the advisor hands a concern back and keeps the agent going', { options: { advisorModel: 'opus' } }, async ($, on) => {
    adviseWith(on, '{"level":"concern","note":"It claims tests pass but never ran them."}')
    await $.session.start(START)
    await $.turn.start({ text: 'fix the bug and run the tests', turnId: 't1' })
    await drain($.turn.step(STEP))
    const r = await $.classic.Stop({ stop_hook_active: false } as never)
    expect(r.block).toContain('never ran them')
  })

  test('the advisor stays quiet when it has nothing to say', { options: { advisorModel: 'opus' } }, async ($, on) => {
    adviseWith(on, '{"level":"none","note":""}')
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await drain($.turn.step(STEP))
    expect((await $.classic.Stop({ stop_hook_active: false } as never)).block).toBeUndefined()
  })
})
