---
name: web-search
description: Free, keyless web search and page fetching through Exa's hosted MCP server — no API key, no account, no sign-in. Use when you need real-time web search, current news/facts, or clean markdown from URLs, especially when no EXA_API_KEY is configured, when the user asks how to use Exa without a key, or when a search tool that costs credits should be avoided.
license: ISC
---

# web-search

[Exa](https://exa.ai) runs a hosted MCP server that serves a **keyless free
tier**: no account, no sign-in, no API key. This skill wraps that tier with one
POSIX `sh` script, `exa.sh`, plus the unauthenticated x402/MPP price probe on
`api.exa.ai`.

Everything here is free but rate-limited: **3 queries/second and 150 calls/day**
per IP. Budget your calls; batch URLs into a single `fetch` call.

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

- **`search`** — default. Natural-language query, returns highlights and content
  for the top results. The query should describe the *ideal page*, not
  keywords, and pass `-O/--objective` when you need a specific fact ranked
  first, e.g. `-O "prefer the project's own documentation"`.
- **`advanced`** — same engine plus filters: domains, categories, date ranges,
  text filters, summaries, subpages. Returns JSON. Use it for news windows
  (`--start-published`), site-restricted search (`--include-domains`), or
  people/company lookups (`--category people|company`).
- **`fetch`** — you already have URLs. Batch them in one call:
  `exa.sh fetch url1 url2 url3 -c 5000 -o /tmp/pages.md`. Costs one call, not
  three.

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

## Gotchas

- The MCP endpoint replies with `text/event-stream` (`event: message` +
  `data: {...}`), not plain JSON. `exa.sh` unwraps it; a hand-rolled `curl`
  will not.
- `web_search_exa` documents `objective` as required. `exa.sh` defaults it to
  the query when `-O` is omitted.
- Exhausted the daily budget? Calls fail with an MCP error, not a `429` you can
  retry through. Fall back to another source or wait for the window to reset.
- Requires a POSIX shell (`sh`), `curl`, and `jq`. The script avoids bashisms
  on purpose (`#!/usr/bin/env sh`, no arrays, no `[[ ]]`, no `local`, no
  `pipefail`) so it runs under `dash`, `ash`, `bash`, and `ksh`.
