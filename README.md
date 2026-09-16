# Pi-Tweaks

A [pi](https://github.com/badlogic/pi-mono) package with tweaks to pi: a
patched **browser-tools**, forked from
[`badlogic/pi-skills`](https://github.com/badlogic/pi-skills), a
**keyless Exa web search** skill with a local, unmetered `web-read` reader,
and a `bwrap` **sandbox wrapper** for the `pi` CLI.

## Install

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks
# or, from a local checkout:
pi install /path/to/Pi-Tweaks
```

The `pi` manifest in [`package.json`](package.json) declares the skills; pi
installs the dependencies and discovers each skill's `SKILL.md`. The skills
then load on demand and are available as `/skill:browser-tools` and
`/skill:web-tools`.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.skills`) + dependencies |
| [`browser-tools/`](browser-tools/) | CDP browser-automation skill. **Read [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`web-tools/`](web-tools/) | Free, keyless web search through Exa's hosted MCP server, plus `web-read`, a local POSIX `sh` reader that turns a URL into LLM-friendly markdown. No API key. See its [README](web-tools/README.md). |
| [`Extras/`](Extras/) | `bwrap` sandbox wrapper for the `pi` CLI. See its [README](Extras/README.md). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in each skill's directory
— see [`browser-tools/README.md`](browser-tools/README.md) and
[`web-tools/README.md`](web-tools/README.md).

## Contributing

This project uses **scoped commits** (`<scope>: <description>`), not
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and
examples.

## License

- Repository files outside `browser-tools/`: ISC — see [`LICENSE`](LICENSE).
  This includes everything in `web-tools/`.
- `browser-tools/`: MIT, overriding the root ISC for that directory. See
  [`browser-tools/LICENSE`](browser-tools/LICENSE) and
  [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md).
- The package as a whole (`package.json`) is `(ISC AND MIT)`.
