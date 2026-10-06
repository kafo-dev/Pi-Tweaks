# Attribution & notices

This directory contains code derived from **pi-skills** by Mario Zechner.

- Upstream: https://github.com/badlogic/pi-skills
- Upstream path: `browser-tools/`
- Forked at commit: `90bb51cae36515a648515b633a81c0c6efc8c74d` (2026-06-06)

Parts of the device emulation, cookie dismissal, browser stop, and console/network
logging tools are adapted from **agent-stuff** by Mario Zechner:

- Upstream: https://github.com/mitsuhiko/agent-stuff
- Upstream path: `skills/web-browser/`

## License

Everything in `browser-tools/` is licensed under the **MIT License** — see
[LICENSE](LICENSE). This directory-level license **overrides** the repository
root ISC license ([`../../LICENSE`](../../LICENSE)) for **all files in this
directory**, including those added by Pi-Tweaks. Do not apply the root ISC
terms to anything under `browser-tools/`.

## Attribution

Original files are by Mario Zechner (pi-skills, MIT). Files added or modified
here are likewise MIT. Per-file origin:

| File | Origin |
|------|--------|
| `browser-start.js` | upstream, modified by Pi-Tweaks (headless, watcher) |
| `browser-nav.js` | upstream, modified by Pi-Tweaks (active emulation) |
| `browser-eval.js` | upstream, modified by Pi-Tweaks (active emulation) |
| `browser-screenshot.js` | upstream, modified by Pi-Tweaks (`--full-page`, `--device`, active emulation) |
| `browser-pick.js` | upstream, modified by Pi-Tweaks (active emulation) |
| `browser-cookies.js` | upstream, modified by Pi-Tweaks (active emulation) |
| `browser-content.js` | upstream, modified by Pi-Tweaks (active emulation) |
| `browser-hn-scraper.js` | upstream |
| `browser-start-linux.js` | added by Pi-Tweaks |
| `browser-devices.js`, `browser-emulation.js`, `browser-emulate.js` | added by Pi-Tweaks, adapted from `mitsuhiko/agent-stuff` (MIT) |
| `browser-dismiss-cookies.js` | added by Pi-Tweaks, adapted from `mitsuhiko/agent-stuff` (MIT) |
| `browser-watch.js`, `browser-logs-tail.js`, `browser-net-summary.js` | added by Pi-Tweaks, adapted from `mitsuhiko/agent-stuff` (MIT) |
| `browser-stop.js` | added by Pi-Tweaks, adapted from `mitsuhiko/agent-stuff` (MIT) |
| `LICENSE` | upstream MIT text, copyright line added for Pi-Tweaks |
| `SKILL.md` | upstream, modified by Pi-Tweaks |
| `README.md`, `NOTICE.md`, `PATCHES.md` | added by Pi-Tweaks |
Dependency declarations for this skill live in the repository root
[`../../package.json`](../../package.json) (added by Pi-Tweaks); the upstream nested
`package.json`/`package-lock.json` were removed when the repo became a pi
package.
