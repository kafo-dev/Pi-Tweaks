# Patches applied to browser-tools

Base: `badlogic/pi-skills` @ `90bb51c` (2026-06-06), path `browser-tools/`.
Upstream files are otherwise untouched, so a diff against that commit stays
reviewable:

```bash
git diff 90bb51c:browser-tools .   # from a clone of upstream
```

## Patch 1 — Linux support

**File:** [`browser-start-linux.js`](browser-start-linux.js) (added)

Upstream `browser-start.js` is macOS-only: it hardcodes
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
`~/Library/Application Support/Google/Chrome/`, and `killall 'Google Chrome'`.

The added script:

- auto-detects a Chromium/Chrome binary (override with `$CHROME_BIN`);
- starts a **dedicated, persistent agent profile** at `~/.cache/browser-tools`,
  never the user's live profile, and opens its own
  `Pi-Coding-Agent-Dedicated-Profile` profile there by default;
- with `--profile`, refreshes the seeded user profiles from the real Chromium
  profile via `rsync --delete` (auto-detected; `$BROWSER_PROFILE` override),
  excluding `SingletonLock`/`SingletonSocket`/`SingletonCookie`, session/tab
  files and the agent's own `Pi-Coding-Agent-Dedicated-Profile` directory, then
  re-registers that profile in `Local State` (rsync replaces it) while keeping
  the agent's top-level `Local State`, including its cookie-encryption key;
- always passes `--profile-directory` (default
  `Pi-Coding-Agent-Dedicated-Profile`, override with `--profile-directory
  <name>` or `$BROWSER_PROFILE_DIR`) so Chrome never shows the profile picker,
  and refuses `Guest Profile`, whose windows cannot open new tabs over CDP;
- `--list-profiles` prints the profiles and their display names from
  `Local State`, so a different profile can be chosen without the picker;
- reuses an existing `:9222` if one is already serving CDP;
- sets the Linux window class via `--class` (or `$BROWSER_APP_CLASS`) — the
  Wayland toplevel `app_id` and the X11 `WM_CLASS` — defaulting to
  `Pi-Coding-Agent-Control-chromium`; an empty value disables it;
- launches detached with `--remote-debugging-port=9222 --user-data-dir=<agent>
  --profile-directory=<profile> --no-first-run --no-default-browser-check
  --hide-crash-restore-bubble`.

## Patch 2 — Output / context discipline

**File:** [`SKILL.md`](SKILL.md) (upstream, modified — MIT)

Tool stdout lands directly in the model's context, and raw page/search output is
large. The skill now documents, up front:

- redirect tool output to a scratch file and query the file rather than print it;
- return the smallest useful value from the page (never dump the DOM or
  `document.body.innerText`);
- treat screenshots as the most expensive output — DOM-first for page state;
- chain filtering into a single shell call and suppress narration output;
- prefer whatever standard filters are available (`rg`/`grep`, `jq`, `head`,
  `wc`, ...), counting or slicing before printing.

It also documents the `chrome-extension://` → `✗ No active tab found` gotcha.

## Patch 3 — SKILL.md corrections

**File:** [`SKILL.md`](SKILL.md) (upstream, modified — MIT)

- Fixed the setup path: `cd {baseDir}/browser-tools` → `cd {baseDir}`.
- Documented the Linux start script alongside the macOS one.
- Added the Output Discipline section (Patch 2).
- Added profile guidance: prefer the agent's own dedicated profile, list the
  profiles and ask the user before opening a different one, and never Guest.
  On a fresh agent profile, ask whether to start clean or seed from one of the
  user's real profiles before launching.

The full diff is ~87 changed lines against upstream; regenerate it with the
`git diff` command above.

## Patch 4 — packaged as a pi package

**Files:** root [`package.json`](../package.json) (added), root
[`.gitignore`](../.gitignore) (added); removed `browser-tools/package.json` and
`browser-tools/package-lock.json`; `SKILL.md` Setup updated.

- Added a root package manifest with `"keywords": ["pi-package"]` and
  `"pi": { "skills": ["./browser-tools"] }`, so `pi install
  git:github.com/kafo-dev/Pi-Tweaks` works.
- **Hoisted dependencies to the root** so `pi install` installs them
  automatically (pi runs `npm install` at the package root, not in nested
  directories).
- **Dropped unused dependencies** from the upstream nested manifest: `puppeteer`
  (pulls a bundled Chromium), `puppeteer-extra`, and
  `puppeteer-extra-plugin-stealth`. No script imports them; the tools use
  `puppeteer-core` against the system browser. Kept: `puppeteer-core`,
  `@mozilla/readability`, `jsdom`, `turndown`, `turndown-plugin-gfm`, `cheerio`.
- The package license is `(ISC AND MIT)` (root ISC + `browser-tools/` MIT).

## Patch 5 — keep agent-provisioned extensions across `--profile`

**File:** [`browser-start-linux.js`](browser-start-linux.js)

`--profile` seeds the agent user-data-dir with `rsync -a --delete`. Chromium
reads the agent's own extension-provisioning directory, `External Extensions/`,
from the user-data-dir on every launch, and uninstalls an externally installed
extension once its entry disappears. A real Chromium profile does not carry that
directory, so `--delete` removed it and a seeded refresh silently dropped every
extension provisioned there.

`External Extensions` is now excluded from the seeded refresh, alongside
`SingletonLock`/`SingletonSocket`/`SingletonCookie` and the agent's own
`Pi-Coding-Agent-Dedicated-Profile` directory.
