# web-search

Free, keyless web search and page fetching through [Exa](https://exa.ai)'s
hosted MCP server — no API key, no account, no sign-in.

Exa serves a **keyless free tier** at `https://mcp.exa.ai/mcp`, limited to
**3 queries/second and 150 calls/day** per IP. This skill wraps every tool that
tier exposes in a single POSIX `sh` script, [`exa.sh`](exa.sh), and adds a probe
for Exa's pay-per-request (x402/MPP) pricing on `api.exa.ai`.

The skill instructions live in [`SKILL.md`](SKILL.md).

## Requirements

`sh`, `curl`, and `jq`. No npm install, no Node.js.

The script is portable POSIX shell — `#!/usr/bin/env sh`, no arrays, no
`[[ ]]`, no `local`, no `pipefail` — and runs under `dash` (Debian/Ubuntu
`/bin/sh`), BusyBox `ash`, `bash`, and `ksh`.

```bash
shellcheck -s sh exa.sh                 # no findings
shellcheck -s sh --enable=all exa.sh    # no findings
```

The three optional checks it declines (`SC2250`, `SC2310`, `SC2312`) are listed
with reasons in a comment at the top of the script.

## Usage

```bash
./exa.sh search "<query>" [options]        # web_search_exa
./exa.sh fetch <url> [url ...] [options]   # web_fetch_exa (batches URLs)
./exa.sh advanced "<query>" [options]      # web_search_advanced_exa
./exa.sh tools                             # list the keyless tools
./exa.sh pricing                           # x402/MPP prices, no wallet
./exa.sh raw <tool> '<json args>'          # call any tool with raw JSON
```

Common options: `-n/--num N`, `-O/--objective "..."`, `-c/--max-chars N`,
`-o/--out FILE`, `-j/--json`, `-t/--timeout SEC`. `exa.sh --help` documents the
`advanced` filters (domains, categories, date ranges, summaries, subpages).

Examples:

```bash
./exa.sh search "rust async runtime comparison 2026" -n 5
./exa.sh search "who maintains ripgrep" -n 3 -O "prefer the project's own repo"
./exa.sh fetch https://example.com https://exa.ai/docs -c 5000 -o /tmp/pages.md
./exa.sh advanced "seed funding announcements" --category news \
    --start-published 2026-01-01 --include-domains techcrunch.com \
    -o /tmp/rounds.json
./exa.sh pricing
```

Results go to stdout. With `-o FILE` the result is written to the file and only
a one-line `✓ wrote …` note goes to stderr — see the output-discipline section
of [`SKILL.md`](SKILL.md).

## What is free, and what is not

| Capability | Free without a key? | How |
|---|---|---|
| `web_search_exa` | yes | `exa.sh search` |
| `web_fetch_exa` | yes | `exa.sh fetch` |
| `web_search_advanced_exa` | yes (opt-in tool) | `exa.sh advanced` |
| x402/MPP price discovery | yes | `exa.sh pricing` |
| x402/MPP paid requests | pay per request, still no key | needs a signing client (not implemented) |
| `agent_run` (Exa Agent) | **no** | requires OAuth or an API key |
| REST `/search`, `/contents` with an API key | free credits, but a key | set `EXA_API_KEY` |

Setting `EXA_API_KEY` in the environment makes `exa.sh` send it as `x-api-key`,
so the same commands bill against an Exa account instead of the free tier.

## Authentication and secrets

The script reads `EXA_API_KEY` but never prints it, and none of its output
includes it. Keep it that way: check for presence with
`[ -n "${EXA_API_KEY:-}" ]`, not by echoing.

## Environment

| Variable | Default |
|---|---|
| `EXA_MCP_URL` | `https://mcp.exa.ai/mcp` |
| `EXA_MCP_TOOLS` | `web_search_exa,web_fetch_exa,web_search_advanced_exa` |
| `EXA_API_KEY` | *(unset)* |
| `EXA_API_BASE` | `https://api.exa.ai` |
| `EXA_TIMEOUT` | `60` |

## Upstream docs

- MCP server and auth modes: <https://exa.ai/docs/get-started/exa-mcp>
- Billing and rate limits: <https://exa.ai/docs/admin/billing>
- x402 pay-per-request: <https://exa.ai/docs/reference/x402-guide>
- Full documentation index: <https://exa.ai/docs/llms.txt>

## License

ISC — see the repository root [`LICENSE`](../LICENSE). Unlike
[`browser-tools/`](../browser-tools/), this directory is not derived from
upstream code and carries no separate license.
