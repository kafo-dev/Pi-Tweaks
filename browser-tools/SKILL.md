---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chrome running on `:9222` with remote debugging enabled.

## Output Discipline

Every tool here writes its stdout straight into your context, and raw page or
search output is large. Keep it small.

### Redirect to a file, then query the file

Don't print output you're going to filter anyway. Write it to a scratch file
(e.g. under `${TMPDIR:-/tmp}`) and search or parse the file:

```bash
{baseDir}/browser-eval.js 'JSON.stringify([...document.querySelectorAll("a")].map(a=>({t:a.innerText,h:a.href})))' > "${TMPDIR:-/tmp}/links.json"
rg -i wikipedia "${TMPDIR:-/tmp}/links.json"      # or grep -i
jq -r '.[] | select(.h|test("wikipedia")) | .h' "${TMPDIR:-/tmp}/links.json"   # if jq is available
```

### Return the smallest useful value

Shape the result inside the page; don't dump the DOM or `document.body.innerText`.

```bash
# just the matching hrefs, or just a count
{baseDir}/browser-eval.js 'JSON.stringify([...document.querySelectorAll("a")].map(a=>a.href).filter(h=>/wikipedia/.test(h)))'
{baseDir}/browser-eval.js 'document.querySelectorAll("a").length'
```

If you must inspect text, filter it before it reaches you:

```bash
{baseDir}/browser-eval.js 'document.body.innerText' > "${TMPDIR:-/tmp}/page.txt"
rg -n -i 'poppy|puppy' "${TMPDIR:-/tmp}/page.txt"    # or grep -n
head -40 "${TMPDIR:-/tmp}/page.txt"
```

### Screenshots are the most expensive output

Images cost more context than text. Use `browser-screenshot.js` only for a real
visual check (layout, canvas, rendering). For "what's on the page", parse the
DOM or filter `innerText` instead.

### Chain steps in one shell call

Filtering in the shell is free; printing is not. Suppress narration output when
you only need the side effect:

```bash
{baseDir}/browser-nav.js "https://example.com" >/dev/null 2>&1
{baseDir}/browser-eval.js '[...document.querySelectorAll("a")].map(a=>a.href).filter(h=>/wikipedia/.test(h))[0]'
```

### Prefer standard filters

Use whichever text/JSON filters are available on the system (`rg`/`grep`,
`jq`, `head`, `tail`, `wc`, `sed`, `awk`, `sort -u`, ...). Count or slice
before printing:

```bash
wc -l "${TMPDIR:-/tmp}/page.txt"
rg -c 'pattern' "${TMPDIR:-/tmp}/page.txt"
jq length "${TMPDIR:-/tmp}/links.json"
```

## Setup

Dependencies are installed automatically when this skill is installed as part of
the Pi-Tweaks pi package. For a manual checkout, run `npm install` in the
repository root (the parent directory of `{baseDir}`).

## Start Chrome

macOS (upstream script):

```bash
{baseDir}/browser-start.js              # Fresh profile
{baseDir}/browser-start.js --profile    # Copy user's profile (cookies, logins)
```

Linux (this fork):

```bash
{baseDir}/browser-start-linux.js                       # Default agent profile
{baseDir}/browser-start-linux.js --profile             # Seed it from a real profile
{baseDir}/browser-start-linux.js --list-profiles       # List profiles in the agent profile
{baseDir}/browser-start-linux.js --profile-directory "Profile 1"
```

Launch Chrome with remote debugging on `:9222`. The Linux script auto-detects
Chromium (override with `$CHROME_BIN`) and uses a dedicated, persistent
user-data-dir at `~/.cache/browser-tools`, separate from your normal browser.
`--profile` seeds that user-data-dir from the user's real browser profile; it
does not change which profile the agent opens.

### Always use the cached agent profile

By default the script opens the `Default` profile inside
`~/.cache/browser-tools` and passes `--profile-directory` explicitly. **Prefer
this profile** for everything, and only switch when the user explicitly asks
for a different one.

#### First run: ask before seeding

If `~/.cache/browser-tools` does not exist yet, the agent profile is fresh.
Do **not** silently pass `--profile`: seeding copies the user's real browser
profile — cookies, logins, extensions and all — into the agent profile. They
may want the agent to stay separate and log in there on its own, or to seed
from a different profile than the one that is auto-detected.

Ask the user which they want before starting:

- **Start clean** — run `{baseDir}/browser-start-linux.js`; the agent profile
  is empty and the user logs in to it separately.
- **Seed from a real profile** — run
  `{baseDir}/browser-start-linux.js --profile`. The source browser is
  auto-detected; set `$BROWSER_PROFILE` to pick another one. To open a profile
  other than `Default` inside the seeded copy, use `--profile-directory`
  (list the options first).

Use `{baseDir}/browser-start-linux.js --list-profiles` to see what already
exists; "(none yet)" means the agent profile has never been launched.

Chrome shows a profile picker when it is not told which profile to open. A
picker leaves no `page` target, so the first tool call fails with `✗ No active
tab found`. Choosing **Guest** is worse: guest windows refuse to open new tabs
over CDP, so `browser-nav.js --new` fails with `Protocol error
(Target.createTarget): Failed to open a new tab`.

When the user does ask for another profile, never guess and never let the
picker appear:

1. Run `{baseDir}/browser-start-linux.js --list-profiles` to get the directory
   names and display names inside `~/.cache/browser-tools`.
2. Show the list to the user and ask which profile to use.
3. Start it with `--profile-directory "<directory>"` (or set
   `$BROWSER_PROFILE_DIR`).

If Chrome is already serving `:9222`, the start script reuses it and cannot
change its profile. A stale instance left on Guest (or on the picker) keeps
failing: close that Chrome, then start again with the intended profile.

## Navigate

```bash
{baseDir}/browser-nav.js https://example.com
{baseDir}/browser-nav.js https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing current tab.

## Evaluate JavaScript

```bash
{baseDir}/browser-eval.js 'document.title'
{baseDir}/browser-eval.js 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
{baseDir}/browser-screenshot.js
```

Capture current viewport and return temporary file path. Use this to visually inspect page state or verify UI changes.

## Pick Elements

```bash
{baseDir}/browser-pick.js "Click the submit button"
```

**IMPORTANT**: Use this tool when the user wants to select specific DOM elements on the page. This launches an interactive picker that lets the user click elements to select them. The user can select multiple elements (Cmd/Ctrl+Click) and press Enter when done. The tool returns CSS selectors for the selected elements.

Common use cases:
- User says "I want to click that button" → Use this tool to let them select it
- User says "extract data from these items" → Use this tool to let them select the elements
- When you need specific selectors but the page structure is complex or ambiguous

## Cookies

```bash
{baseDir}/browser-cookies.js
```

Display all cookies for the current tab including domain, path, httpOnly, and secure flags. Use this to debug authentication issues or inspect session state.

## Extract Page Content

```bash
{baseDir}/browser-content.js https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion. Works on pages with JavaScript content (waits for page to load).

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution

## Gotchas

- These scripts act on the **last page** (`(await b.pages()).at(-1)`). If the only
  open tab is a `chrome-extension://` page (e.g. an extension dashboard),
  `browser.pages()` can come back empty and you'll see `✗ No active tab found`.
  Navigate a normal page first:
  `{baseDir}/browser-nav.js https://example.com`.
- The same `✗ No active tab found` appears when Chrome is stuck on its profile
  picker, and `--new` fails outright on the Guest profile. See
  [Always use the cached agent profile](#always-use-the-cached-agent-profile).
- `browser-eval.js` prints objects and arrays as `key: value` lines. Return
  `JSON.stringify(...)` when you plan to pipe the result into a JSON tool.

---

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** take screenshots to see page state. **Do** parse the DOM directly:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000)

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

### Complex Scripts in Single Calls

Wrap everything in an IIFE to run multi-statement code:

```javascript
(function() {
  // Multiple operations
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');
  
  // Interactions
  buttons[0].click();
  
  // Return results
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

### Batch Interactions

**Don't** make separate calls for each click. **Do** batch them:

```javascript
(function() {
  const actions = ["btn1", "btn2", "btn3"];
  actions.forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

### Typing/Input Sequences

```javascript
(function() {
  const text = "HELLO";
  for (const char of text) {
    document.getElementById("key-" + char).click();
  }
  document.getElementById("submit").click();
  return "Submitted: " + text;
})()
```

### Reading App/Game State

Extract structured state in one call:

```javascript
(function() {
  const state = {
    score: document.querySelector('.score')?.textContent,
    status: document.querySelector('.status')?.className,
    items: Array.from(document.querySelectorAll('.item')).map(el => ({
      text: el.textContent,
      active: el.classList.contains('active')
    }))
  };
  return JSON.stringify(state, null, 2);
})()
```

### Waiting for Updates

If DOM updates after actions, add a small delay with bash:

```bash
sleep 0.5 && {baseDir}/browser-eval.js '...'
```

### Investigate Before Interacting

Always start by understanding the page structure:

```javascript
(function() {
  return {
    title: document.title,
    forms: document.forms.length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    mainContent: document.body.innerHTML.slice(0, 3000)
  };
})()
```

Then target specific elements based on what you find.
