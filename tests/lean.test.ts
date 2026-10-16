import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addedFileMounts, hashLine, isGuardedYaml, planEdit, pushesBranch, tagLines, trimMiddle } from '../hooks/lib'

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

  test('HashRead then HashEdit makes one ordinary Edit', async ($, on) => {
    world(on, { '/repo/a.txt': FILE }, {})
    on('tool.call', { tool: 'Read' }, () => ({
      result: { type: 'text', file: { filePath: '/repo/a.txt', content: FILE, numLines: 4, startLine: 1, totalLines: 4 } },
    }))
    const edits: { old_string: string; new_string: string }[] = []
    on('tool.call', { tool: 'Edit' }, ($, e) => {
      edits.push({ old_string: e.old_string, new_string: e.new_string })
      return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: FILE, structuredPatch: [], userModified: false, replaceAll: false } }
    })

    await $.session.start(START)
    const read = await $.tool.call({ tool: 'mcp__lean__HashRead', path: 'a.txt' } as never)
    expect(String((read as { result?: unknown }).result)).toContain(`${at(2)}|beta`)

    const done = await $.tool.call({ tool: 'mcp__lean__HashEdit', path: 'a.txt', edits: [{ start: at(3), text: 'GAMMA' }] } as never)
    expect(String((done as { result?: unknown }).result)).toContain('Edited /repo/a.txt')
    expect(edits.length).toBe(1)
    expect(FILE.replace(edits[0]!.old_string, edits[0]!.new_string)).toBe('alpha\nbeta\nGAMMA\ndelta\n')
  })
})
