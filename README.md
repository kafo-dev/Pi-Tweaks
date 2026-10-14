# Pi-Tweaks

Miscellaneous tools for the [pi](https://github.com/earendil-works/pi) coding
agent harness: skills, extensions, and a `bwrap` sandbox wrapper.

## Install

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks
# or, from a local checkout:
pi install /path/to/Pi-Tweaks
```

The `pi` manifest in [`package.json`](package.json) declares the resources; pi
installs the dependencies and discovers each skill's `SKILL.md` plus every
extension listed in `pi.extensions`. The skills load on demand and are available
as `/skill:browser-tools` and `/skill:web-tools`; the packaged extensions are
loaded at startup. `notify` alerts on the terminal out of the box; its push
stays off until a topic is set. The experimental extensions in
`extensions/experiments/` are loaded too, but each registers nothing until its section is enabled in
`pi-tweaks.json` (`experiment-prune-sessions`, `experiment-pop`,
`experiment-url`, `experiment-move-host`).

## Configuration

Every extension reads one file: `pi-tweaks.json` in pi's agent directory
(`$PI_CODING_AGENT_DIR/pi-tweaks.json`, or `~/.pi/agent/pi-tweaks.json`). It
holds one section per extension, named after the extension's file, with that
extension's settings and an `enabled` switch:

```json
{
  "pi-bash-timeout": { "enabled": true, "timeoutSeconds": 10 },
  "notify": {
    "enabled": true,
    "backend": "termcodes",
    "topic": "",
    "server": "https://ntfy.sh"
  },
  "prompt-fragment": {
    "enabled": true,
    "fragments": [
      { "path": "docs/style.md", "stripFrontmatter": false }
    ]
  },
  "exit-alias": { "enabled": true }
}
```

A missing file, a missing section, or a malformed file means "enabled, with
defaults": a typo cannot silently disable a tool. Only the boolean `false`
disables an extension, and a disabled extension registers nothing. pi imports
extension modules at startup, so a change to `enabled` takes effect on the next
start (or `/reload`).

| Section | Settings |
|---------|----------|
| `pi-bash-timeout` | `timeoutSeconds` (default 32) |
| `notify` | `backend`, `topic`, `server`, `token`; `/pi-tweaks notify` writes them back here |
| `prompt-fragment` | `fragments`: paths whose full text is prepended to the system prompt |
| `exit-alias` | `enabled` only |
| `snippet` | `enabled` only |
| `pi-tweaks` | `enabled` only; the `/pi-tweaks` command itself |

`prompt-fragment` also reads a project file, `<cwd>/.pi/prompt-fragment.json`,
when the project is trusted; it takes precedence over the section. Both forms
hold the same objects. A `path` that starts with `~` resolves against the home
directory; any other relative `path` resolves against the directory of the file
that names it:

```json
[
  { "path": "../docs/style.md", "stripFrontmatter": false },
  { "path": "~/notes/style.md", "stripFrontmatter": true },
  { "path": "/absolute/path/notes.md", "stripFrontmatter": true }
]
```

Both keys are required: `path` and the boolean `stripFrontmatter`.
`stripFrontmatter` removes a leading YAML frontmatter block. The fragment text
is prepended verbatim to the top of the system prompt, in config order, with no
wrapper; a path named twice is prepended once.

Settings written by an extension (`/pi-tweaks notify`) merge into the file, so
the other sections and the `enabled` switch survive.

pi's own `pi config` command can also enable or disable an installed
extension through `settings.json`; `enabled` in `pi-tweaks.json` is the switch
that lives with the rest of the extension's settings.

## The `/pi-tweaks` command

[`pi-tweaks.ts`](extensions/pi-tweaks.ts) registers one command for the whole package:

```
/pi-tweaks list              every packaged extension, and whether it is enabled
/pi-tweaks notify …          the notify settings, and a test dialog
/pi-tweaks prompt-fragment   the fragments prompt-fragment resolves, and its errors
/pi-tweaks prune-sessions …  a pruning round over the session store
```

`list` is the command's own subcommand: it reads `pi.extensions` and the
sections above, so it reports the extensions that register something and the
ones that are switched off. A subcommand is named after the extension that
answers it and calls a function that extension exports; a subcommand whose
extension is off says so instead of reporting work that would not happen. On
its own, `/pi-tweaks` prints the subcommands that are available.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.extensions`, `pi.skills`) + dependencies |
| [`extensions/pi-tweaks.ts`](extensions/pi-tweaks.ts) | Extension that registers the package's `/pi-tweaks` command: `list` for the extensions and their switches, plus one subcommand per extension that reports something. |
| [`lib/pi-tweaks-config.ts`](lib/pi-tweaks-config.ts) | Shared configuration for every extension: reads and writes `pi-tweaks.json`, applies the `enabled` switch and the per-extension settings, and validates each value. |
| [`lib/session-store.mjs`](lib/session-store.mjs) | Session display names, read from a session file. Plain JavaScript, used by the prune-sessions experiment. |
| [`lib/pi-tweaks-cache.mjs`](lib/pi-tweaks-cache.mjs) | The directory for Pi-Tweaks runtime state, `$XDG_CACHE_HOME/pi-tweaks` (default `~/.cache/pi-tweaks`): the last prune round. Runtime state does not belong in the agent directory that holds configuration, and the sandbox wrapper binds the cache directory read-write. Plain JavaScript, shared by the extensions. |
| [`extensions/notify/`](extensions/notify/) | Extension that alerts on the local machine — a desktop banner, or an Android notification through `termux-notification` when pi runs inside Termux — and, optionally, pushes to a phone over ntfy when pi settles a turn or blocks on a dialog. Terminal notifications on by default, push off. See its [README](extensions/notify/README.md). |
| [`extensions/prompt-fragment.ts`](extensions/prompt-fragment.ts) | Extension that prepends the full text of the Markdown documents named in `prompt-fragment.fragments` to the top of the system prompt on every turn, so they apply without the model deciding to read them. A `~` path resolves against the home directory, and any other relative path against the config file that names it. `stripFrontmatter` removes a leading YAML frontmatter block. The text is deterministic, which keeps it inside the provider's cached prefix. An invalid config or an unreadable document is reported as an error, and nothing is prepended for that turn. `/pi-tweaks prompt-fragment` reports the resolved set, the byte size, and an estimated token count (four characters per token). |
| [`extensions/exit-alias.ts`](extensions/exit-alias.ts) | Extension that adds `/exit` as an alias for pi's built-in `/quit`. |
| [`extensions/snippet.ts`](extensions/snippet.ts) | Extension whose `/snippet` command opens a picker over the code in the conversation: one tab for fenced code blocks (listed with the language and the first and last lines), one for inline spans. The most recent block is first, and Enter copies the selected text to the system clipboard without the backticks or the language mark. Only the text of user and assistant messages on the active branch is read; tool results and tool-call arguments are skipped. |
| [`extensions/pi-bash-timeout.ts`](extensions/pi-bash-timeout.ts) | Extension that fills in the built-in `bash` tool's `timeout` parameter (in seconds) when the model omits it, so a hung command cannot stall a turn. An explicit model value wins. The default is `pi-bash-timeout.timeoutSeconds` (32). |
| [`skills/browser-tools/`](skills/browser-tools/) | CDP browser-automation skill. **Read [`skills/browser-tools/NOTICE.md`](skills/browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`skills/web-tools/`](skills/web-tools/) | Free, keyless web search through Exa's hosted MCP server, plus `web-read`, a local POSIX `sh` reader that turns a URL into LLM-friendly markdown. No API key. See its [README](skills/web-tools/README.md). |
| [`extras/`](extras/) | `bwrap` sandbox wrapper for the `pi` CLI. See its [README](extras/README.md). |
| [`extensions/experiments/`](extensions/experiments/) | Experimental extensions, listed in the manifest but off until enabled in `pi-tweaks.json`. See its [README](extensions/experiments/README.md). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in each subdirectory —
see [`skills/browser-tools/README.md`](skills/browser-tools/README.md),
[`skills/web-tools/README.md`](skills/web-tools/README.md), and
[`extensions/notify/README.md`](extensions/notify/README.md).

## AI usage

This project is written with AI assistance. The extensions, the skills, and
the `bwrap` wrapper, along with this README and the other documentation, were
written and revised with an AI coding agent.

## Contributing

This project uses **scoped commits** (`<scope>: <description>`), not
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and
examples.

## License

- Repository files outside `skills/browser-tools/`: ISC — see [`LICENSE`](LICENSE).
  This includes `extensions/`, `skills/web-tools/`, and `lib/`.
- `skills/browser-tools/`: MIT, overriding the root ISC for that directory. See
  [`skills/browser-tools/LICENSE`](skills/browser-tools/LICENSE) and
  [`skills/browser-tools/NOTICE.md`](skills/browser-tools/NOTICE.md).
- The package as a whole (`package.json`) is `(ISC AND MIT)`.
