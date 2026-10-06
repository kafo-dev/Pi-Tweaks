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

## Patch 6 — CRX extension provisioning

**File:** [`browser-install-extension.js`](browser-install-extension.js) (added)

Chromium's external-extension mechanism is the way to install an extension into
the agent profile without a developer-mode prompt. The script wraps it:

- `--id <extension-id>` downloads the CRX from
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=<chrome-major>&acceptformat=crx2,crx3&x=id%3D<id>%26uc`,
  using the detected Chromium major version; `--crx <file>` uses a local CRX
  instead.
- Reads the extension id from the CRX3 `signed_header_data.crx_id` field (for
  CRX2, the first 16 bytes of SHA-256 over the inline public key) and the
  version from the CRX's `manifest.json`, so `--crx` alone is enough;
  `--version` overrides a version that cannot be read.
- Stores the CRX at `~/.cache/browser-tools-extensions/<id>.crx` and writes
  `~/.cache/browser-tools/External Extensions/<id>.json` with `external_crx`
  and `external_version`.
- Deletes `extensions.settings.<id>` from the agent profile's `Preferences`
  (and `Secure Preferences` when the id is there) before the next launch,
  because an external install is one-shot and Chromium would otherwise keep the
  already-registered copy.
- Refuses while a Chromium owns the agent user-data-dir. It resolves
  `SingletonLock` (`<host>-<pid>`) and checks `/proc/<pid>/cmdline`; matching
  argv with `pgrep -f --user-data-dir=...` would match the invoking shell.

Rejected alternative: loading the unpacked CRX with `--load-extension` plus
`--disable-features=DisableLoadExtensionCommandLineSwitch`. It does not persist
across launches, needs a launcher flag every run, and may show a developer-mode
prompt; the `external_crx` mechanism used here does persist.

## Patch 7 — survive a read-only `XDG_CONFIG_HOME`

**File:** [`browser-start-linux.js`](browser-start-linux.js)

Chromium derives its crash-dump directory from `XDG_CONFIG_HOME` (default
`~/.config`) as `<config-home>/<product>/Crash Reports`, and passes it to
`chrome_crashpad_handler` as `--database`. Inside the bubblewrap sandbox
`~/.config` is mounted read-only: the directory cannot be created, the handler
starts without `--database` and exits, and Chromium dies with `SIGTRAP` before
opening a tab. The script reported `✗ Failed to connect to Chrome on :9222`.
`--crash-dumps-dir` does not move the path, and `--disable-crash-reporter` and
`--disable-breakpad` do not skip the handler.

The start script probes the config home with a real write. When it is not
writable, the child receives `XDG_CONFIG_HOME=~/.cache/browser-tools-xdg`,
created on demand. `--user-data-dir` is passed explicitly, so the browser
profile is unaffected and only crash reports move. A writable
`XDG_CONFIG_HOME` is used unchanged.

The alternative fix, listing `~/.config/chromium` in `~/.pi/rw-paths.txt`, fixes
every Chromium launch in the sandbox but is a host change, not a repository
change.

## Patch 8 — Headless launch and `browser-stop.js`

**Files:** [`browser-start.js`](browser-start.js),
[`browser-start-linux.js`](browser-start-linux.js),
[`browser-stop.js`](browser-stop.js) (added)

Both start scripts accept `--headless` (Chromium `--headless=new`), and the
Linux script starts [`browser-watch.js`](browser-watch.js) after the browser is
up.

`browser-stop.js` stops the agent browser without matching the invoking shell:
it reads `ps -eo pid=,command=`, keeps processes whose argv carries
`--user-data-dir=~/.cache/browser-tools`, skips `--type=` children, and sends
`SIGTERM`. It stops the browser on `:9222` by default and every agent browser
with `--all`. The skill no longer needs the `pkill` recipe.

## Patch 9 — Device emulation

**Files:** [`browser-devices.js`](browser-devices.js),
[`browser-emulation.js`](browser-emulation.js),
[`browser-emulate.js`](browser-emulate.js) (added)

`browser-emulate.js` sets a persistent preference
(`~/.cache/browser-tools/emulation.json`) and applies it to the active tab:
`--list`, `<device>`, `--landscape`, `--ua <user-agent>`, `--ua reset`,
`--reset`. Presets: `iphone-se`, `iphone-14`, `pixel-7`, `galaxy-s20`.

A preset goes through raw CDP (`Emulation.setDeviceMetricsOverride`,
`setTouchEmulationEnabled`, `setUserAgentOverride`) instead of
`page.setUserAgent`, because Chromium rejects the partial `userAgentMetadata`
that a platform-only override produces. The `--ua` override goes through
`page.setUserAgent` and carries no platform, so it applies on top of a preset
without disturbing the preset metrics. The value `chrome` resolves to the
running browser with its `HeadlessChrome` product token replaced by `Chrome`.

`browser-nav.js`, `browser-eval.js`, `browser-screenshot.js`,
`browser-pick.js`, `browser-cookies.js`, `browser-content.js`, and
`browser-dismiss-cookies.js` re-apply the stored preference on each run, so a
`--new` tab or a reload keeps the emulated device and the user agent.
`browser-screenshot.js` also gains `--full-page` and
`--device <preset> [--landscape]`; a `--device` override applies to that
screenshot only.

## Patch 10 — Cookie-consent dismissal

**File:** [`browser-dismiss-cookies.js`](browser-dismiss-cookies.js) (added)

Accepts (default) or rejects (`--reject`) EU cookie-consent dialogs. It handles
the common CMPs (OneTrust, Google, YouTube, Cookiebot, Didomi, Quantcast,
Usercentrics, TrustArc, Klaro, BBC, Amazon, CookieYes), falls back to generic
consent containers and button text, and scans consent iframes when the top
document has no dialog.

## Patch 11 — Console and network logging

**Files:** [`browser-watch.js`](browser-watch.js),
[`browser-logs-tail.js`](browser-logs-tail.js),
[`browser-net-summary.js`](browser-net-summary.js) (added)

`browser-watch.js` attaches a CDP session to every page and records
`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`,
`Network.requestWillBeSent`, `Network.responseReceived`, and
`Network.loadingFailed` as JSONL under
`~/.cache/browser-tools/logs/YYYY-MM-DD/`. The start scripts launch it, and a
pid file keeps it single-instance. `browser-logs-tail.js` prints the newest log
(with `--follow`), and `browser-net-summary.js` prints status counts, top
hosts, and non-OK or failed responses. The watcher uses puppeteer sessions
rather than a separate `ws` CDP client, so no dependency is added.
