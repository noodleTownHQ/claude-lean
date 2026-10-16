// Pure helpers: no `$`, so the tests can drive them directly.

// FNV-1a over the line's UTF-16 units, last three base-36 digits.
export const hashLine = (line: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(3, '0').slice(-3)
}

// A file's lines without the empty element a trailing newline leaves.
const realLines = (text: string): string[] => {
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.slice(0, -1) : lines
}

export const tagLines = (text: string, firstLine: number): string =>
  realLines(text)
    .map((line, i) => `${firstLine + i}:${hashLine(line)}|${line}`)
    .join('\n')

export type HashEditOp = {
  start?: string
  end?: string
  after?: string
  text: string
}

export type EditPlan =
  | { ok: true; old: string; new: string; first: number; last: number; delta: number; newRegion: string[] }
  | { ok: false; error: string }

const ANCHOR = /^(\d+):([0-9a-z]{3})$/

const resolve = (lines: string[], anchor: string): number | string => {
  const m = ANCHOR.exec(anchor.trim())
  if (!m) return `bad anchor "${anchor}": expected LINE:HASH like 12:k3f`
  const idx = Number(m[1]) - 1
  if (idx < 0 || idx >= lines.length) return `anchor ${anchor} is past the end of the file (${lines.length} lines)`
  if (hashLine(lines[idx]!) !== m[2]) return `anchor ${anchor} is stale: line ${m[1]} has changed since it was read`
  return idx
}

const count = (hay: string, needle: string): number => {
  let n = 0
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++
  return n
}

// Turns anchored edits into the one old/new pair an Edit call takes.
export const planEdit = (text: string, ops: readonly HashEditOp[]): EditPlan => {
  if (ops.length === 0) return { ok: false, error: 'no edits given' }
  const lines = realLines(text)
  const spans: { from: number; to: number; insertAt: number; repl: string[] }[] = []

  for (const op of ops) {
    const repl = op.text === '' ? [] : op.text.replace(/\n$/, '').split('\n')
    if (op.after !== undefined) {
      const at = resolve(lines, op.after)
      if (typeof at === 'string') return { ok: false, error: at }
      spans.push({ from: at + 1, to: at, insertAt: at, repl })
      continue
    }
    if (op.start === undefined) return { ok: false, error: 'each edit needs `start` (replace) or `after` (insert)' }
    const from = resolve(lines, op.start)
    if (typeof from === 'string') return { ok: false, error: from }
    const to = op.end === undefined ? from : resolve(lines, op.end)
    if (typeof to === 'string') return { ok: false, error: to }
    if (to < from) return { ok: false, error: `end ${op.end} is before start ${op.start}` }
    spans.push({ from, to, insertAt: from, repl })
  }

  spans.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.from <= spans[i - 1]!.to) return { ok: false, error: 'edits overlap; merge them into one' }
  }

  let first = Math.min(...spans.map(s => Math.min(s.from, s.insertAt)))
  let last = Math.max(...spans.map(s => Math.max(s.to, s.insertAt)))

  const build = (lo: number, hi: number): string[] => {
    const out: string[] = []
    let i = lo
    for (const s of spans) {
      while (i < s.from) out.push(lines[i++]!)
      out.push(...s.repl)
      i = s.to + 1
    }
    while (i <= hi) out.push(lines[i++]!)
    return out
  }

  // Each side carries the newline next to the region, so deleting lines leaves no blank one.
  const pair = (lo: number, hi: number) => {
    const before = lines.slice(lo, hi + 1)
    const after = build(lo, hi)
    const hasLineBelow = hi < lines.length - 1 || text.endsWith('\n')
    if (hasLineBelow) {
      return { old: before.join('\n') + '\n', new: after.length ? after.join('\n') + '\n' : '', after }
    }
    if (lo > 0) {
      return { old: '\n' + before.join('\n'), new: after.length ? '\n' + after.join('\n') : '', after }
    }
    return { old: before.join('\n'), new: after.join('\n'), after }
  }

  let p = pair(first, last)
  // Edit needs old_string to occur once: widen the region until it does.
  while (count(text, p.old) > 1) {
    if (first === 0 && last === lines.length - 1) return { ok: false, error: 'could not make the edited region unique' }
    if (first > 0) first--
    if (last < lines.length - 1) last++
    p = pair(first, last)
  }
  if (p.old === p.new) return { ok: false, error: 'the edits change nothing' }

  const delta = spans.reduce((d, s) => d + s.repl.length - (s.to - s.from + 1), 0)
  return { ok: true, old: p.old, new: p.new, first, last, delta, newRegion: p.after }
}

export type Trim = { text: string; cutLines: number; cutChars: number }

// Keeps the head and tail of long output, cut on line boundaries.
export const trimMiddle = (text: string, limit: number, keepHead: number, keepTail: number, savedTo: string): Trim | undefined => {
  if (text.length <= limit) return undefined
  const headEnd = text.lastIndexOf('\n', keepHead)
  const tailStart = text.indexOf('\n', text.length - keepTail)
  const head = text.slice(0, headEnd > 0 ? headEnd : keepHead)
  const tail = text.slice(tailStart > 0 ? tailStart + 1 : text.length - keepTail)
  const middle = text.slice(head.length, text.length - tail.length)
  const cutLines = middle.split('\n').length - 1
  const note = `\n[lean: cut ${cutLines} lines (${middle.length} chars) from the middle. Full output: ${savedTo} (Read it with offset/limit, or grep it)]\n`
  return { text: head + note + tail, cutLines, cutChars: middle.length - note.length }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A `git push` that names `branch` (or pushes everything) and was not cleared with LEAN_ALLOW_PUSH=1.
// A push run in another repository (`git -C <dir>` or `cd <dir>` outside `cwd`) is not this project's.
export const pushesBranch = (command: string, branch: string, cwd = ''): boolean => {
  if (branch === '' || /\bLEAN_ALLOW_PUSH=1\b/.test(command)) return false
  const named = new RegExp(`^\\+?(?:\\S*:)?(?:refs/heads/)?${escape(branch)}$`)
  const isElsewhere = (dir: string) =>
    cwd !== '' && dir.startsWith('/') && dir !== cwd && !dir.startsWith(cwd.replace(/\/$/, '') + '/')
  let dir = ''
  return command.split(/&&|\|\||;|\||\n/).some(segment => {
    const cd = /^\s*cd\s+["']?([^\s"']+)/.exec(segment)
    if (cd) dir = cd[1]!
    const m = /(?:^|\s)git((?:\s+-[Cc]\s+\S+)*)\s+push\b(.*)$/.exec(segment)
    if (!m) return false
    const gitDir = /-[Cc]\s+["']?([^\s"']+)/.exec(m[1]!)?.[1] ?? dir
    if (isElsewhere(gitDir)) return false
    const args = m[2]!.trim().split(/\s+/)
    if (args.includes('--dry-run') || args.includes('-n')) return false
    return args.some(a => a === '--all' || a === '--mirror' || named.test(a))
  })
}

// A YAML file under a folder whose path contains `fragment` (e.g. `deploy/compose/`).
export const isGuardedYaml = (path: string, fragment: string): boolean =>
  fragment !== '' && path.includes(fragment) && /\.ya?ml$/.test(path)

const FILE_LIKE = /\.[A-Za-z0-9]{1,8}$/

// Bind mounts of a single checkout file added by an edit (relative sources only: a `git reset` or checkout
// replaces the file, and a single-file mount keeps the old inode).
export const addedFileMounts = (newText: string, oldText: string): string[] => {
  const old = new Set(oldText.split('\n').map(l => l.trim()))
  const found: string[] = []
  for (const line of newText.split('\n')) {
    if (old.has(line.trim()) || line.includes('lean: file-mount-ok')) continue
    const short = /^\s*-\s*["']?(\.{1,2}\/[^\s:"']*)\s*:\s*\//.exec(line)
    const long = /^\s*source:\s*["']?(\.{1,2}\/[^\s"']*)/.exec(line)
    const source = short?.[1] ?? long?.[1]
    if (source && !source.endsWith('/') && FILE_LIKE.test(source)) found.push(source)
  }
  return found
}
