# browser-tools

The `browser-tools` skill from
[`badlogic/pi-skills`](https://github.com/badlogic/pi-skills), forked at
`90bb51c` (2026-06-06) and patched in Pi-Tweaks. It drives a Chromium/Chrome
instance over the Chrome DevTools Protocol (`:9222`).

The skill instructions live in [`SKILL.md`](SKILL.md).

## Licensing & attribution

Everything in this directory is **MIT** — see [LICENSE](LICENSE). This
directory-level license **overrides** the repository root ISC license. See
[NOTICE.md](NOTICE.md) for per-file origin and attribution.

## Patches

See [PATCHES.md](PATCHES.md) for details. In short:

1. **Linux support** — [`browser-start-linux.js`](browser-start-linux.js):
   auto-detects Chromium and starts a dedicated, persistent agent profile at
   `~/.cache/browser-tools` (`--profile` refreshes the seeded user profiles
   from the real profile while keeping the agent's own). It opens its own
   dedicated profile there by default and refuses Guest, so Chrome never shows
   the profile picker; `--list-profiles` lists the alternatives. The window
   class defaults to `Pi-Coding-Agent-Control-chromium` on Wayland (`app_id`)
   and X11 (`WM_CLASS`), overridable with `--class`.
2. **Output / context discipline** — folded into [`SKILL.md`](SKILL.md)
   (redirect tool output to a file and query it, return the smallest useful
   value, avoid needless screenshots, use standard filters).
3. **`SKILL.md` fixes** — corrected setup path, documented the Linux script,
   and added profile-selection guidance (prefer the cached profile; on a fresh
   agent profile ask before seeding; list and ask before using another).

## Install into pi

This directory is the skill declared by the Pi-Tweaks pi package. Install the
package globally:

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks   # or: pi install /path/to/Pi-Tweaks
```

pi installs the dependencies and discovers `browser-tools/SKILL.md`. The skill
then loads on demand and is available as `/skill:browser-tools`.

## Setup (manual checkout)

If you cloned the repository by hand instead of installing the package, install
dependencies in the repository root:

```bash
cd Pi-Tweaks
npm install          # scripts use puppeteer-core + the system browser
```

## Usage

```bash
# macOS
./browser-start.js [--profile]

# Linux
./browser-start-linux.js [--profile] [--profile-directory <name>]
./browser-start-linux.js --list-profiles

./browser-nav.js https://example.com [--new] [--reload]
./browser-eval.js 'document.title'
./browser-screenshot.js
./browser-cookies.js
./browser-content.js https://example.com
./browser-pick.js "Click the submit button"
./browser-hn-scraper.js
```

See [`SKILL.md`](SKILL.md) for the full reference and output discipline.
