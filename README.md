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
loaded at startup. `pi-notify` notifies on the terminal out of the box, while
its phone leg stays off until you configure it. The experimental extensions in
`Experiment/` are loaded too, but each registers nothing until its section is
enabled in `pi-tweaks.json` (`experiment-minimal-mode`).

## Configuration

Every extension reads one file: `pi-tweaks.json` in pi's agent directory
(`$PI_CODING_AGENT_DIR/pi-tweaks.json`, or `~/.pi/agent/pi-tweaks.json`). It
holds one section per extension, named after the extension's file, with that
extension's settings and an `enabled` switch:

```json
{
  "pi-bash-timeout": { "enabled": true, "timeoutSeconds": 10 },
  "pi-notify": {
    "enabled": true,
    "backend": "termcodes",
    "phone": "off",
    "device": ""
  },
  "pi-pinned-skills": { "enabled": true, "skills": ["agent-context"] },
  "pi-exit": { "enabled": true }
}
```

A missing file, a missing section, or a malformed file means "enabled, with
defaults": a typo cannot silently disable a tool. Only the boolean `false`
disables an extension, and a disabled extension registers nothing. pi imports
extension modules at startup, so a change to `enabled` takes effect on the next
start (or `/reload`).

| Section | Settings |
|---------|----------|
| `pi-bash-timeout` | `timeoutSeconds` (default 10) |
| `pi-notify` | `backend`, `phone`, `device`; `/notify` writes them back here |
| `pi-pinned-skills` | `skills`: names whose full text is pinned into the system prompt |
| `pi-exit` | `enabled` only |

Settings written by an extension (`/notify`) merge into the file, so the other
sections and the `enabled` switch survive. Extensions that had their own files
before — `pi-notify.json` and `pinned-skills.json` — are still read for
backward compatibility until the matching section exists; the first write
migrates the settings into `pi-tweaks.json`.

pi's own `pi config` command can also enable or disable an installed
extension through `settings.json`; `enabled` in `pi-tweaks.json` is the switch
that lives with the rest of the extension's settings.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.extensions`, `pi.skills`) + dependencies |
| [`pi-tweaks-config.ts`](pi-tweaks-config.ts) | Shared configuration for every extension: reads and writes `pi-tweaks.json`, applies the `enabled` switch and the per-extension settings, and validates each value. |
| [`pi-notify/`](pi-notify/) | Extension that notifies you — desktop and KDE Connect phone alarm — when pi settles a turn or blocks on a dialog. Terminal notifications on by default, phone off. See its [README](pi-notify/README.md). |
| [`pi-pinned-skills.ts`](pi-pinned-skills.ts) | Extension that appends the full text of skills named in `pi-pinned-skills.skills` to the system prompt on every turn, so they apply without the model deciding to read them. The block is deterministic, which keeps it inside the provider's cached prefix. `/pinned-skills` reports what resolved. |
| [`pi-exit.ts`](pi-exit.ts) | Extension that adds `/exit` as an alias for pi's built-in `/quit`. |
| [`pi-bash-timeout.ts`](pi-bash-timeout.ts) | Extension that fills in the built-in `bash` tool's `timeout` parameter (in seconds) when the model omits it, so a hung command cannot stall a turn. An explicit model value wins. The default is `pi-bash-timeout.timeoutSeconds` (10). |
| [`browser-tools/`](browser-tools/) | CDP browser-automation skill. **Read [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`web-tools/`](web-tools/) | Free, keyless web search through Exa's hosted MCP server, plus `web-read`, a local POSIX `sh` reader that turns a URL into LLM-friendly markdown. No API key. See its [README](web-tools/README.md). |
| [`Extras/`](Extras/) | `bwrap` sandbox wrapper for the `pi` CLI. See its [README](Extras/README.md). |
| [`.archived/`](.archived/) | Tools retired from the package, kept for reference. See its [README](.archived/README.md). |
| [`Experiment/`](Experiment/) | Experimental extensions, listed in the manifest but off until enabled in `pi-tweaks.json`. See its [README](Experiment/README.md). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in each subdirectory —
see [`browser-tools/README.md`](browser-tools/README.md),
[`web-tools/README.md`](web-tools/README.md), and
[`pi-notify/README.md`](pi-notify/README.md).

## AI usage

This project is written with AI assistance. The extensions, the skills, and
the `bwrap` wrapper, along with this README and the other documentation, were
written and revised with an AI coding agent.

## Contributing

This project uses **scoped commits** (`<scope>: <description>`), not
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and
examples.

## License

- Repository files outside `browser-tools/`: ISC — see [`LICENSE`](LICENSE).
  This includes everything in `web-tools/` and `pi-notify/`.
- `browser-tools/`: MIT, overriding the root ISC for that directory. See
  [`browser-tools/LICENSE`](browser-tools/LICENSE) and
  [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md).
- The package as a whole (`package.json`) is `(ISC AND MIT)`.
