# web-tools

Free, keyless web search and page fetching through [Exa](https://exa.ai)'s
hosted MCP server — no API key, no account, no sign-in.

Exa serves a **keyless free tier** at `https://mcp.exa.ai/mcp`, limited to
**3 queries/second and 150 calls/day** per IP. This skill wraps every tool that
tier exposes in a single POSIX `sh` script, [`exa.sh`](exa.sh), and adds a probe
for Exa's pay-per-request (x402/MPP) pricing on `api.exa.ai`.

It also ships [`web-read`](web-read), a local reader that turns a URL you
already have into LLM-friendly markdown. It prefers what the site itself
publishes — content negotiation, a `.md` alternate, or an `llms.txt` entry —
and only cleans HTML as a last resort. It talks to the target site directly,
so it does not touch Exa's quota.

The skill instructions live in [`SKILL.md`](SKILL.md).

## Requirements

`sh` and `curl`. `exa.sh` also needs `jq`.

`web-read` cleans HTML with `awk` and converts it with the first of
`html2text`, `lynx`, `w3m`, or `pandoc` it finds (falling back to a crude
tag-strip); `jq` is only needed for its `--json` mode.

Both scripts are portable POSIX shell — `#!/usr/bin/env sh`, no arrays, no
`[[ ]]`, no `local`, no `pipefail` — and run under `dash` (Debian/Ubuntu
`/bin/sh`), BusyBox `ash`, `bash`, and `ksh`.

```bash
shellcheck -s sh exa.sh web-read                 # no findings
shellcheck -s sh --enable=all exa.sh web-read    # no findings
```

The optional checks they decline are listed with reasons in a comment at the
top of each script (`exa.sh`: `SC2250`, `SC2310`, `SC2312`; `web-read` adds
`SC2249`).

## Usage

### `web-read` — read one URL as markdown

```bash
./web-read <url> [options]
```

Sources are tried in order, and the branch taken is reported on stderr:

1. **Content negotiation** — `Accept: text/markdown`.
2. **A markdown alternate** — `<link rel="alternate" type="text/markdown">`,
   the URL with `.md` appended or its extension replaced (the
   [llms.txt](https://llmstxt.org/) convention), or a matching `llms.txt`
   entry.
3. **Cleaned HTML** — boilerplate elements stripped, then converted to
   markdown `html2text`/`lynx`/`w3m`/`pandoc`.

```bash
./web-read https://developers.cloudflare.com/
# ↳ … — markdown · content negotiation

./web-read https://llmstxt.org/index.html
# ↳ … — markdown · .md variant: https://llmstxt.org/index.md

./web-read https://ai.google.dev/gemini-api/docs/text-generation
# ↳ … — markdown · llms.txt entry: https://ai.google.dev/gemini-api/docs/text-generation.md.txt

./web-read https://en.wikipedia.org/wiki/Readability
# ↳ … — html · cleaned with html2text
```

Options: `--save` (write a temp file, print its path), `-o FILE`,
`-c/--max-chars N`, `--raw` (untouched body), `--html` (skip discovery),
`--no-clean`, `--full` (prefer `llms-full.txt`), `-j/--json`, `-q/--quiet`,
`-t/--timeout SEC`, `-h/--help`.

To keep a long page out of context, save it and query the file:

```bash
f=$(./web-read --save https://en.wikipedia.org/wiki/Readability)
rg -n -i 'readability' "$f"
head -40 "$f"
```

Use `curl` (or `exa.sh fetch`) instead when you need the raw response, custom
headers, or an authenticated API.

### `exa.sh` — search and fetch through Exa

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
| Local URL reading (`web-read`) | yes, unmetered | `web-read <url>` |
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
| `WEBREAD_TIMEOUT` | `60` |
| `WEBREAD_UA` | `web-read/1.0 (+…)` |

## Upstream docs

- MCP server and auth modes: <https://exa.ai/docs/get-started/exa-mcp>
- Billing and rate limits: <https://exa.ai/docs/admin/billing>
- x402 pay-per-request: <https://exa.ai/docs/reference/x402-guide>
- Full documentation index: <https://exa.ai/docs/llms.txt>

## License

ISC — see the repository root [`LICENSE`](../../LICENSE). Unlike
[`browser-tools/`](../browser-tools/), this directory is not derived from
upstream code and carries no separate license.
