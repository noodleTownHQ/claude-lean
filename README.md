# lean

A Claude Code mod that borrows [oh-my-pi](https://github.com/can1357/oh-my-pi)'s token savers.

- **Trimmed output.** Bash and Grep output over 10,000 characters (configurable) keeps its head and tail; the full text is saved to `/tmp/claude-lean/<id>.txt` and the output names the file, so Claude reads the middle only when it needs it. Output large enough for Claude Code to save to a file itself is left alone.
- **`lean:scout`.** A read-only search agent on Haiku that answers with `path:line` hits instead of file dumps; a short system-prompt note tells Claude to send searches there.
- **Hashline edits (an experiment).** `HashRead` tags each line `LINE:HASH|text`; `HashEdit` changes lines by those anchors instead of retyping the old text, refuses stale anchors, and runs as an ordinary Edit, so permission prompts and diffs still apply.
- **Optional guards** (off by default):
  - *Protected branch:* refuses `git push` to a branch you name (say `main`, where a push deploys). Prefix the command with `LEAN_ALLOW_PUSH=1` for a push you asked for.
  - *Single-file bind mounts:* refuses relative single-file bind mounts in compose YAML under a folder you name. When git replaces such a file, the container keeps the old inode. End a line with `# lean: file-mount-ok` to allow one.
- **Checks after each edit** (on by default, like omp's LSP diagnostics but lighter). After Edit, Write or HashEdit, a fast checker for the file type runs and its errors reach Claude with the result: `ruff` limited to syntax errors and undefined names for Python (so old lint debt stays quiet), `bash -n` for shell, a JSON parse for `.json`. A checker that is not installed stays silent. TypeScript is left out: `tsc` is too slow to run per edit.
- **Pattern rules** (omp's TTSR, applied at the tool call). A JSON array of rules, from the `rulesFile` setting and from a project's `.claude/lean-rules.json`. Each rule's regex is matched against what a call runs or writes (a Bash command, an Edit's new text, a Write's content); a match with `block: true` refuses the call with the rule, otherwise the call runs and the rule is handed to Claude with its result.

  ```json
  [
    { "name": "no-latest", "match": ":latest\\b", "rule": "Pin images to a sha tag, never :latest.", "block": true },
    { "tool": "Bash", "match": "\\bnpm install\\b", "rule": "This repo uses pnpm." }
  ]
  ```

  Fields: `match` (regex, required), `rule` (text, required), `flags`, `tool` (only this tool), `name`, `block`.
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
| `diagnostics` | `true` | Run a checker after each edit |
| `rulesFile` | empty | Absolute path to your own rules file (projects' `.claude/lean-rules.json` is read either way) |
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
