# lean

A Claude Code mod that borrows [oh-my-pi](https://github.com/can1357/oh-my-pi)'s token savers.

- **Trimmed output.** Bash and Grep output over 10,000 characters (configurable) keeps its head and tail; the full text is saved to `/tmp/claude-lean/<id>.txt` and the output names the file, so Claude reads the middle only when it needs it. Output large enough for Claude Code to save to a file itself is left alone.
- **`lean:scout`.** A read-only search agent on Haiku that answers with `path:line` hits instead of file dumps; a short system-prompt note tells Claude to send searches there.
- **Hashline edits (an experiment).** `HashRead` tags each line `LINE:HASH|text`; `HashEdit` changes lines by those anchors instead of retyping the old text, refuses stale anchors, and runs as an ordinary Edit, so permission prompts and diffs still apply.
- **Optional guards** (off by default):
  - *Protected branch:* refuses `git push` to a branch you name (say `main`, where a push deploys). Prefix the command with `LEAN_ALLOW_PUSH=1` for a push you asked for.
  - *Single-file bind mounts:* refuses relative single-file bind mounts in compose YAML under a folder you name. When git replaces such a file, the container keeps the old inode. End a line with `# lean: file-mount-ok` to allow one.
- **`/lean`.** This session's tokens, cost and estimated savings, plus output tokens per turn with hashline on versus off across sessions. `/lean hashline on|off` switches it from the next session.

Savings are estimates (4 characters per token); the hashline on/off comparison is the real test. Claude is already good at its own Edit tool, so hashline's gain is mainly on large edits.

## Install

Needs a Claude Code version with mods (function hooks); `claude update` first if `/lean` is unknown after installing.

From a shell:

```
claude plugin install lean --marketplace noodleTownHQ/claude-lean
```

At the prompt of a terminal session:

```
/plugin install lean --marketplace noodleTownHQ/claude-lean
```

On an older version without `--marketplace`:

```
claude plugin marketplace add noodleTownHQ/claude-lean
claude plugin install lean@claude-lean
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `noodleTownHQ/claude-lean`, then Add plugin.

## Settings

Set in the config menu (`/config`), or in `~/.claude/settings.json` under `pluginConfigs`:

| Setting | Default | What it does |
|---|---|---|
| `trimChars` | `10000` | Output longer than this is trimmed |
| `protectBranch` | empty (off) | Branch whose pushes are refused |
| `pushNote` | empty | Why, shown to Claude when it refuses |
| `mountGuardPath` | empty (off) | Path fragment of the compose folder to guard, e.g. `deploy/compose/` |

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
