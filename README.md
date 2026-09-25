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
  "pin-document": {
    "enabled": true,
    "documents": [
      { "path": "docs/style.md", "showPathToAgent": true, "stripFrontmatter": false }
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
| `pi-bash-timeout` | `timeoutSeconds` (default 10) |
| `pi-notify` | `backend`, `phone`, `device`; `/notify` writes them back here |
| `pin-document` | `documents`: paths whose full text is pinned into the system prompt |
| `exit-alias` | `enabled` only |
| `pi-tweaks` | `enabled` only; the `/pi-tweaks` command itself |

`pin-document` also reads a project file, `<cwd>/.pi/pin-document.json`, when
the project is trusted; it takes precedence over the section. Both forms hold
the same objects. A `path` that starts with `~` resolves against the home
directory; any other relative `path` resolves against the directory of the file
that names it:

```json
[
  { "path": "../docs/style.md", "showPathToAgent": true, "stripFrontmatter": false },
  { "path": "~/notes/style.md", "showPathToAgent": false, "stripFrontmatter": true },
  { "path": "/absolute/path/notes.md", "showPathToAgent": false, "stripFrontmatter": true }
]
```

All three keys are required: `path`, the boolean `showPathToAgent`, and the
boolean `stripFrontmatter`. `stripFrontmatter` removes a leading YAML
frontmatter block. Either boolean true wraps the document in a `<document>`
element; `showPathToAgent` adds the path to it, so the model can read the file
for the parts the block omits. The reported path is relative to the working
directory when the document is under it, `~/…` when it is under the home
directory, and absolute otherwise. With both false the document text is
appended as-is.

Settings written by an extension (`/notify`) merge into the file, so the other
sections and the `enabled` switch survive. An extension that had its own file
before — `pi-notify.json` — is still read for backward compatibility until the
matching section exists; the first write migrates the settings into
`pi-tweaks.json`.

pi's own `pi config` command can also enable or disable an installed
extension through `settings.json`; `enabled` in `pi-tweaks.json` is the switch
that lives with the rest of the extension's settings.

## The `/pi-tweaks` command

[`pi-tweaks.ts`](pi-tweaks.ts) registers one command for the whole package:

```
/pi-tweaks list           every packaged extension, and whether it is enabled
/pi-tweaks pin-document   the documents pin-document resolves, and its errors
```

`list` is the command's own subcommand: it reads `pi.extensions` and the
sections above, so it names the extensions whose switch is off and the ones
whose section `pi-tweaks.json` lacks. A subcommand is named after the extension
that answers it and calls a function that extension exports; a subcommand whose
extension is off says so instead of reporting work that would not happen. On
its own, `/pi-tweaks` prints the subcommands that are available.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.extensions`, `pi.skills`) + dependencies |
| [`pi-tweaks.ts`](pi-tweaks.ts) | Extension that registers the package's `/pi-tweaks` command: `list` for the extensions and their switches, plus one subcommand per extension that reports something. |
| [`pi-tweaks-config.ts`](pi-tweaks-config.ts) | Shared configuration for every extension: reads and writes `pi-tweaks.json`, applies the `enabled` switch and the per-extension settings, and validates each value. |
| [`pi-notify/`](pi-notify/) | Extension that notifies you — desktop and KDE Connect phone alarm — when pi settles a turn or blocks on a dialog. Terminal notifications on by default, phone off. See its [README](pi-notify/README.md). |
| [`pin-document.ts`](pin-document.ts) | Extension that appends the full text of the Markdown documents named in `pin-document.documents` to the system prompt on every turn, so they apply without the model deciding to read them. A `~` path resolves against the home directory, and any other relative path against the config file that names it. A document is appended as-is unless `showPathToAgent` or `stripFrontmatter` is true, which wraps it in a `<document>` element and, for `showPathToAgent`, writes a path into it — working-directory-relative, `~/…` under home, or absolute. The text is deterministic, which keeps it inside the provider's cached prefix. An invalid config or an unreadable document is reported as an error, and nothing is pinned for that turn. `/pi-tweaks pin-document` reports the resolved set, the byte size, and an estimated token count (four characters per token). |
| [`exit-alias.ts`](exit-alias.ts) | Extension that adds `/exit` as an alias for pi's built-in `/quit`. |
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
