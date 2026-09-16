---
name: web-search
description: Free, keyless web search and page fetching through Exa's hosted MCP server — no API key, no account, no sign-in — plus `web-read`, a local, unmetered reader that turns a URL into LLM-friendly markdown. Use when you need real-time web search, current news/facts, or clean markdown from URLs, especially when no EXA_API_KEY is configured, when the user asks how to use Exa without a key, or when a search tool that costs credits should be avoided.
license: ISC
---

# web-search

[Exa](https://exa.ai) runs a hosted MCP server that serves a **keyless free
tier**: no account, no sign-in, no API key. This skill wraps that tier with two
POSIX `sh` scripts: [`web-read`](web-read) reads a URL you already have as
LLM-friendly markdown, and [`exa.sh`](exa.sh) searches and fetches through
Exa's MCP server, plus the unauthenticated x402/MPP price probe on `api.exa.ai`.

Exa's keyless tier is free but rate-limited: **3 queries/second and 150
calls/day** per IP. Budget those; batch URLs into a single `fetch` call.
`web-read` talks to the target site directly, so it is neither metered nor
limited by Exa.

`{baseDir}` is this skill's directory.

## Commands

```bash
{baseDir}/exa.sh search   "<query>" [options]        # web_search_exa
{baseDir}/exa.sh fetch    <url> [url ...] [options]  # web_fetch_exa  (batches)
{baseDir}/exa.sh advanced "<query>" [options]        # web_search_advanced_exa
{baseDir}/exa.sh tools                               # list the keyless tools
{baseDir}/exa.sh pricing                             # x402/MPP prices, no wallet
{baseDir}/exa.sh raw      <tool> '<json args>'       # call any tool directly
```

Common options: `-n/--num N`, `-O/--objective "..."`, `-c/--max-chars N`,
`-o/--out FILE`, `-j/--json` (raw JSON-RPC result), `-t/--timeout SEC`,
`-h/--help`.

`advanced` adds `--type`, `--category`, `--include-domains`,
`--exclude-domains`, `--start-published`, `--end-published`, `--include-text`,
`--exclude-text`, `--location`, `--max-age-hours`, `--highlights`,
`--summaries [Q]`, `--subpages`. Run `exa.sh --help` for the full list.

## Reading a known URL: `web-read`

When you already have a URL, read it with `web-read` instead of a raw `curl`.
It returns LLM-friendly markdown and reports on **stderr** which of three
sources it used, so stdout stays clean for the model.

```bash
{baseDir}/web-read [options] <url>
```

Options must come **before** the URL: `[options] <url>`, not `<url>
[options]`. `web-read --save <url>` works; `<url> --save` treats `--save` as a
second URL and fails with `✗ request failed: …/--save`.

1. **Content negotiation** — the site answers `Accept: text/markdown` with
   markdown (Cloudflare, Anthropic, Mintlify, ...).
2. **A markdown alternate** — a `<link rel="alternate" type="text/markdown">`,
   the URL with `.md` appended or its extension replaced (the
   [llms.txt](https://llmstxt.org/) convention), or an `llms.txt` entry that
   links the page's markdown.
3. **Cleaned HTML** — script/style/nav/header/footer/aside/form/svg/comments
   are dropped, then `html2text` (or `lynx`, `w3m`, `pandoc`) converts the rest
   to markdown.

The provenance line names the branch and the URL it resolved to, e.g.
`↳ … — markdown · content negotiation`,
`↳ … — markdown · .md variant: https://…/index.md`,
`↳ … — markdown · llms.txt entry: https://…/page.md.txt`, or
`↳ … — html · cleaned with html2text`.

Options: `--save` (write a temp file and print its path), `-o FILE` (write to
a chosen file), `-c N` (cap at N characters), `--raw` (print the response body
untouched), `--html` (skip discovery, clean HTML), `--no-clean` (keep
boilerplate), `--full` (prefer `llms-full.txt`), `-j` (JSON envelope), `-q`
(quiet), `-t SEC` (timeout).

For anything longer than a screenful, don't let it land in context — save it
and query the file:

```bash
f=$({baseDir}/web-read --save "$url")   # prints one path on stdout
rg -n -i 'pattern' "$f"
head -40 "$f"
```

The content stays in the temp file; only the path and the `↳ … — <strategy>`
provenance line reach the model.

Use it for **reading a page's content**. When you need the **raw** response —
exact bytes, custom headers, a specific method, an authenticated API — use
shell tools (`curl`, `jq`, ...) or `exa.sh fetch` directly instead.

## Output discipline

Tool stdout lands directly in the model's context, and Exa results are large
(full highlights per result). Do not dump them.

```bash
# Write to a file, then query the file.
{baseDir}/exa.sh search "rust async runtime comparison" -n 10 -o "${TMPDIR:-/tmp}/exa.txt"
rg -n -i 'tokio|async-std|smol' "${TMPDIR:-/tmp}/exa.txt"
wc -l "${TMPDIR:-/tmp}/exa.txt"

# Need structure? Skip the text formatter and use jq on the raw envelope.
{baseDir}/exa.sh search "rust async" -n 5 -j | jq -r '.result.content[0].text' | head -40

# web_search_advanced_exa already returns JSON *as its text*. Pipe it to jq.
{baseDir}/exa.sh advanced "seed rounds" --category news -o "${TMPDIR:-/tmp}/a.json"
jq -r '.results[] | .url' "${TMPDIR:-/tmp}/a.json"
```

`-o FILE` writes the result to the file and prints only a one-line
`✓ wrote …` note to stderr. Prefer it over printing, then grep/jq the file.

## Choosing a tool

- **`web-read`** — you already have a URL and want the page's content. Local,
  free, and unlimited; try it before `fetch`. One URL per call (loop for more).
- **`search`** — default. Natural-language query, returns highlights and content
  for the top results. The query should describe the *ideal page*, not
  keywords, and pass `-O/--objective` when you need a specific fact ranked
  first, e.g. `-O "prefer the project's own documentation"`.
- **`advanced`** — same engine plus filters: domains, categories, date ranges,
  text filters, summaries, subpages. Returns JSON. Use it for news windows
  (`--start-published`), site-restricted search (`--include-domains`), or
  people/company lookups (`--category people|company`).
- **`fetch`** — many URLs at once, or a page `web-read` could not get (JS-only
  content). Batch them in one call: `exa.sh fetch url1 url2 url3 -c 5000 -o
  /tmp/pages.md`. Costs one call, not three. Prefer `web-read` for single URLs.

## Authentication and limits

- Keyless is the default and needs nothing.
- If `EXA_API_KEY` is set in the environment, `exa.sh` sends it as `x-api-key`
  and requests bill against that Exa account with its own (higher) limits. The
  script works either way — never print, echo, or grep a key.
- `agent_run` (Exa Agent) is **not** available keyless: the server answers
  `MCP error -32602: Tool agent_run not found`. It requires OAuth or an API key.
- OAuth sign-in (`https://mcp.exa.ai/mcp?login`) and API keys both leave the
  free tier. That is out of scope for this skill.

## Paying without an account

`exa.sh pricing` sends an unauthenticated request to `https://api.exa.ai/search`
and decodes the `402 Payment Required` headers. It tells you the current
per-request price and the supported networks (Base, Solana, plus MPP via
Tempo) without a wallet. Actually paying needs a signing client — see
<https://exa.ai/docs/reference/x402-guide> — so it is not implemented here.

Unauthenticated discovery probes are limited to 5 per IP per minute.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `EXA_MCP_URL` | `https://mcp.exa.ai/mcp` | MCP endpoint |
| `EXA_MCP_TOOLS` | `web_search_exa,web_fetch_exa,web_search_advanced_exa` | Tools to expose |
| `EXA_API_KEY` | *(unset)* | Optional; switches off the free tier |
| `EXA_API_BASE` | `https://api.exa.ai` | REST base used by `pricing` |
| `EXA_TIMEOUT` | `60` | Default curl timeout in seconds |
| `WEBREAD_TIMEOUT` | `60` | `web-read` curl timeout in seconds |
| `WEBREAD_UA` | `web-read/1.0 (+…)` | `web-read` User-Agent header |

## Gotchas

- The MCP endpoint replies with `text/event-stream` (`event: message` +
  `data: {...}`), not plain JSON. `exa.sh` unwraps it; a hand-rolled `curl`
  will not.
- `web_search_exa` documents `objective` as required. `exa.sh` defaults it to
  the query when `-O` is omitted.
- Exhausted the daily budget? Calls fail with an MCP error, not a `429` you can
  retry through. Fall back to another source or wait for the window to reset.
- `web-read` parses `[options] <url>`, so options go first. Putting a flag
after the URL makes it a second URL and errors with `request failed:
https://--save` (or whichever flag it was).
- Requires a POSIX shell (`sh`) and `curl`. `exa.sh` also needs `jq`.
  `web-read` cleans HTML with `awk` and converts it with the first of
  `html2text`, `lynx`, `w3m`, or `pandoc` it finds (falling back to a crude
  tag-strip), and only needs `jq` for `--json`. Both scripts avoid bashisms on
  purpose (`#!/usr/bin/env sh`, no arrays, no `[[ ]]`, no `local`, no
  `pipefail`) so they run under `dash`, `ash`, `bash`, and `ksh`.
