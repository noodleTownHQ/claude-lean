export type Tally = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type SessionStats = {
  main: Tally
  sub: Tally
  trims: number
  charsCut: number
  hashReads: number
  hashEdits: number
  hashEditFails: number
  editCharsSaved: number
  guards: number
}

declare module 'claude-code' {
  interface PluginState {
    lean: { stats: SessionStats }
  }
}
