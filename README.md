# Pi-Tweaks

A [pi](https://github.com/badlogic/pi-mono) package with tweaks to pi skills.
Currently a patched **browser-tools**, forked from
[`badlogic/pi-skills`](https://github.com/badlogic/pi-skills).

## Install

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks
# or, from a local checkout:
pi install /path/to/Pi-Tweaks
```

The `pi` manifest in [`package.json`](package.json) declares the skill; pi
installs the dependencies and discovers
[`browser-tools/SKILL.md`](browser-tools/SKILL.md). The skill then loads on
demand and is available as `/skill:browser-tools`.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.skills`) + dependencies |
| [`browser-tools/`](browser-tools/) | CDP browser-automation skill. **Read [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in
[`browser-tools/`](browser-tools/) — see its [README](browser-tools/README.md).

## Contributing

This project uses **scoped commits** (`<scope>: <description>`), not
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and
examples.

## License

- Repository files outside `browser-tools/`: ISC — see [`LICENSE`](LICENSE).
- `browser-tools/`: MIT, overriding the root ISC for that directory. See
  [`browser-tools/LICENSE`](browser-tools/LICENSE) and
  [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md).
- The package as a whole (`package.json`) is `(ISC AND MIT)`.
