# Pi-Tweaks

A [pi](https://github.com/badlogic/pi-mono) package with tweaks to pi: a
patched **browser-tools**, forked from
[`badlogic/pi-skills`](https://github.com/badlogic/pi-skills), a
**keyless Exa web search** skill with a local, unmetered `web-read` reader, a
`bwrap` **sandbox wrapper** for the `pi` CLI, **pi-notify**, which alerts
you on the desktop and on your phone when pi needs you, a **`python`** tool
that runs Python 3 without shell quoting, and an **`/exit`** alias for pi's
built-in `/quit`.

## Install

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks
# or, from a local checkout:
pi install /path/to/Pi-Tweaks
```

The `pi` manifest in [`package.json`](package.json) declares the resources; pi
installs the dependencies and discovers each skill's `SKILL.md` and the
`pi-notify`, `pi-exit`, and `pi-python` extensions. The skills then load on
demand and are available as `/skill:browser-tools` and `/skill:web-tools`;
`pi-notify`, `pi-exit`, and `pi-python` are always loaded. `pi-notify` notifies
on the terminal out of the box, while its phone leg stays off until you
configure it.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.extensions`, `pi.skills`) + dependencies |
| [`pi-notify/`](pi-notify/) | Extension that notifies you — desktop and KDE Connect phone alarm — when pi settles a turn or blocks on a dialog. Terminal notifications on by default, phone off. See its [README](pi-notify/README.md). |
| [`pi-exit.ts`](pi-exit.ts) | Extension that adds `/exit` as an alias for pi's built-in `/quit`. |
| [`pi-python.ts`](pi-python.ts) | Extension that adds a `python` tool: raw Python 3 source is passed as one argv entry, so no shell quoting, escaping, or code fences are needed. |
| [`browser-tools/`](browser-tools/) | CDP browser-automation skill. **Read [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`web-tools/`](web-tools/) | Free, keyless web search through Exa's hosted MCP server, plus `web-read`, a local POSIX `sh` reader that turns a URL into LLM-friendly markdown. No API key. See its [README](web-tools/README.md). |
| [`Extras/`](Extras/) | `bwrap` sandbox wrapper for the `pi` CLI. See its [README](Extras/README.md). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in each subdirectory —
see [`browser-tools/README.md`](browser-tools/README.md),
[`web-tools/README.md`](web-tools/README.md), and
[`pi-notify/README.md`](pi-notify/README.md).

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
