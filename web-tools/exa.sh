#!/usr/bin/env sh
# SPDX-License-Identifier: ISC
#
# exa.sh — use Exa's free, keyless web search and page fetching.
#
# Exa's hosted MCP server (https://mcp.exa.ai/mcp) serves a keyless free tier:
# no account, no sign-in, no API key. This script wraps that tier's tools plus
# the unauthenticated x402/MPP price probe on api.exa.ai.
#
# Keyless limits (per the Exa docs): 3 queries/second, 150 calls/day per IP.
#
# If $EXA_API_KEY is set it is sent as `x-api-key`, so the same commands then
# bill against your Exa account instead of the free tier.
#
# Portable POSIX sh (dash, ash, bash, ksh): no arrays, no `[[ ]]`, no `local`.
# Helper variables are prefixed with `_` and shared, which is safe because every
# helper that sets one is called through `$(...)` and therefore runs in its own
# subshell, and the cmd_* functions are never nested.
#
# Requires: a POSIX sh, curl, jq.
#
# `shellcheck -s sh` is clean. The three optional checks below are declined on
# purpose, so that `shellcheck -s sh --enable=all` stays a usable gate:
#   SC2250  "put braces around variable references" — style churn only; there
#           are no ${var}suffix concatenations in this script.
#   SC2310  "set -e is disabled in this condition" — intended: the price probe
#           and the isError probes are expected to fail and are handled inline.
#   SC2312  "this command substitution masks a pipeline status" — unavoidable
#           for `printf | head`/`jq` in POSIX sh, which has no pipefail; every
#           such pipeline ends in the command whose status actually matters.
# shellcheck disable=SC2250,SC2310,SC2312

set -eu

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MCP_URL=${EXA_MCP_URL:-https://mcp.exa.ai/mcp}
API_BASE=${EXA_API_BASE:-https://api.exa.ai}
TIMEOUT=${EXA_TIMEOUT:-60}
API_KEY=${EXA_API_KEY:-}

# Tools Exa exposes on the keyless tier. `web_search_advanced_exa` is opt-in,
# so it has to be named explicitly. (`agent_run` is NOT keyless.)
MCP_TOOLS=${EXA_MCP_TOOLS:-web_search_exa,web_fetch_exa,web_search_advanced_exa}

# Scratch space for the price probe; removed on exit.
TMPDIR_EXA=$(mktemp -d "${TMPDIR:-/tmp}/exa.XXXXXX") ||
	{ echo "✗ could not create a temp directory" >&2; exit 1; }
trap 'rm -rf "$TMPDIR_EXA"' EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

need() {
	command -v "$1" >/dev/null 2>&1 ||
		die "missing dependency: $1 — ${2-install it with your package manager}"
}

# Echo the value of an option, or die if it was omitted.
val() {
	[ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
	printf '%s' "$2"
}

# Same, but require non-negative digits, so jq never sees a bad --argjson.
num() {
	case ${2-} in
	'') die "$1 needs a value" ;;
	*[!0-9]*) die "$1 needs a number, got: $2" ;;
	*) ;;
	esac
	printf '%s' "$2"
}

# Diagnostic helpers. They exist so that the pipelines live here rather than
# inside a `$(...)`, where their status would be masked (shellcheck SC2312).
peek() { printf '%s' "$1" | head -c 200; }
bytes() { wc -c <"$1" | tr -d ' '; }
is_error() { printf '%s' "$1" | jq -r '.result.isError // false'; }
first_line() { head -n 1 "$1" | tr -d '\r'; }

# "a.org, b.org ," -> ["a.org","b.org"]
csv_json() {
	jq -nc --arg s "$1" '$s | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

base64_decode() {
	if base64 --decode </dev/null >/dev/null 2>&1; then
		base64 --decode
	elif base64 -D </dev/null >/dev/null 2>&1; then
		base64 -D
	else
		die "no working base64 decoder found"
	fi
}

# Append ?tools=... to the MCP URL, tolerating an existing query string.
endpoint() {
	if [ -z "$MCP_TOOLS" ]; then
		printf '%s' "$MCP_URL"
	else
		case $MCP_URL in
		*\?*) printf '%s&tools=%s' "$MCP_URL" "$MCP_TOOLS" ;;
		*) printf '%s?tools=%s' "$MCP_URL" "$MCP_TOOLS" ;;
		esac
	fi
}

# POST one JSON-RPC message and print the unwrapped JSON-RPC envelope.
# The MCP endpoint speaks the Streamable HTTP transport: it replies with
# text/event-stream (`event: message` + `data: {...}`), but we also accept a
# plain application/json body in case that ever changes.
mcp_raw() {
	_payload=$1
	_url=$(endpoint)

	# No arrays in POSIX sh, so build curl's arguments as positional params.
	set -- -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'
	if [ -n "$API_KEY" ]; then
		set -- "$@" -H "x-api-key: $API_KEY"
	fi

	_body=$(curl -sS --max-time "$TIMEOUT" -X POST "$_url" "$@" --data-binary "$_payload") ||
		die "request to $_url failed"

	case $_body in
	\{*) printf '%s' "$_body" ;;
	*)
		_data=$(printf '%s\n' "$_body" | sed -n 's/^data: //p' | tail -n 1)
		[ -n "$_data" ] ||
			die "unexpected reply from $_url: $(peek "$_body")"
		printf '%s' "$_data"
		;;
	esac
}

# Join every text block of a tool result.
envelope_text() {
	printf '%s' "$1" | jq -r '[.result.content[]? | select(.type == "text") | .text] | join("\n")'
}

# A JSON-RPC error, or a tool-level isError, becomes a non-zero exit.
envelope_check() {
	_err=$(printf '%s' "$1" | jq -r '.error.message // empty')
	[ -z "$_err" ] || die "MCP error: $_err"
	if [ "$(is_error "$1")" = "true" ]; then
		_txt=$(envelope_text "$1")
		[ -n "$_txt" ] || _txt="tool call failed"
		die "$_txt"
	fi
}

# Call a tool and print its JSON-RPC envelope.
mcp_call() {
	_tool=$1
	_args=$2
	_payload=$(jq -nc --arg t "$_tool" --argjson a "$_args" \
		'{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $t, arguments: $a}}') ||
		die "could not build the request for $_tool"
	_env=$(mcp_raw "$_payload")
	envelope_check "$_env"
	printf '%s' "$_env"
}

# print_envelope <json-flag> <out-file> <envelope>
print_envelope() {
	_as_json=$1
	_out=$2
	_env=$3

	[ -n "$_env" ] || die "empty reply"
	printf '%s' "$_env" | jq -e . >/dev/null 2>&1 ||
		die "reply was not JSON: $(peek "$_env")"

	if [ "$_as_json" -eq 1 ]; then
		_text=$(printf '%s' "$_env" | jq .)
	else
		_text=$(envelope_text "$_env")
	fi

	if [ -n "$_out" ]; then
		printf '%s\n' "$_text" >"$_out"
		note "✓ wrote $_out ($(bytes "$_out") bytes)"
	else
		printf '%s\n' "$_text"
	fi
}

usage() {
	cat <<'EOF'
exa.sh — Exa's free, keyless web search and page fetching.

Usage:
  exa.sh search   "<query>" [options]        Search the web (web_search_exa)
  exa.sh fetch    <url> [url ...] [options]  Read pages (web_fetch_exa)
  exa.sh advanced "<query>" [options]        Search with filters (web_search_advanced_exa)
  exa.sh tools                               List the keyless tools
  exa.sh pricing                             Probe x402/MPP pay-per-request prices
  exa.sh raw      <tool> '<json args>'       Call any tool with raw JSON arguments

Common options:
  -j, --json            Print the raw JSON-RPC result instead of the text
  -o, --out FILE        Write the result to FILE (a note goes to stderr)
  -t, --timeout SEC     curl timeout in seconds (default: 60)
  -h, --help            Show this help

search / advanced options:
  -n, --num N           Number of results (default: 10)
  -O, --objective "..." Ranking objective; search defaults it to the query
  -c, --max-chars N     Max characters of extracted text per result

advanced-only options:
      --type TYPE           auto | fast | instant
      --category CAT        company | publication | news | pdf | github |
                            personal site | people | financial report
      --include-domains A,B Only these domains
      --exclude-domains A,B Drop these domains
      --start-published D   Published on/after YYYY-MM-DD
      --end-published D     Published on/before YYYY-MM-DD
      --start-crawled D     Crawled on/after YYYY-MM-DD
      --end-crawled D       Crawled on/before YYYY-MM-DD
      --include-text S      Only results containing all strings (comma-separated)
      --exclude-text S      Drop results containing any string (comma-separated)
      --location CC         Two-letter country code, e.g. US, GB, DE
      --max-age-hours N     Freshness: 0 = always fetch fresh, N = cache max age
      --highlights          Enable highlights
      --summaries [Q]       Enable summaries, optionally focused on query Q
      --subpages N          Crawl N subpages per result (1-10)

fetch options:
  -c, --max-chars N     Max characters per page (default: 3000)

Environment:
  EXA_API_KEY     Optional. Sent as x-api-key; switches off the free tier.
  EXA_MCP_URL     MCP endpoint (default: https://mcp.exa.ai/mcp)
  EXA_MCP_TOOLS   Tools to expose (default: all three keyless tools)
  EXA_API_BASE    REST base used by `pricing` (default: https://api.exa.ai)
  EXA_TIMEOUT     Default curl timeout in seconds

Free-tier limits: 3 queries/second, 150 calls/day. Output discipline: prefer
`-o file` and grep the file rather than dumping everything into a transcript.

Examples:
  exa.sh search "rust async runtime comparison 2026"
  exa.sh search "who maintains ripgrep" -n 3 -O "prefer the project's repo"
  exa.sh fetch https://example.com https://exa.ai/docs -o /tmp/pages.txt
  exa.sh advanced "seed funding announcements" --category news \
      --start-published 2026-01-01 --include-domains techcrunch.com
  exa.sh pricing
EOF
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

cmd_search() {
	_query=''
	_objective=''
	_num=10
	_as_json=0
	_out=''

	while [ $# -gt 0 ]; do
		case $1 in
		-n | --num) _num=$(num "$1" "${2-}"); shift 2 ;;
		-O | --objective) _objective=$(val "$1" "${2-}"); shift 2 ;;
		-j | --json) _as_json=1; shift ;;
		-o | --out) _out=$(val "$1" "${2-}"); shift 2 ;;
		-t | --timeout) TIMEOUT=$(num "$1" "${2-}"); shift 2 ;;
		-h | --help) usage; exit 0 ;;
		-*) die "unknown option: $1 (see --help)" ;;
		*)
			_query="${_query:+$_query }$1"
			shift
			;;
		esac
	done
	[ -n "$_query" ] || die "search needs a query (see --help)"
	[ -n "$_objective" ] || _objective=$_query

	_args=$(jq -nc --arg q "$_query" --arg o "$_objective" --argjson n "$_num" \
		'{query: $q, objective: $o, numResults: $n}') ||
		die "could not build the request (is --num a number?)"
	_env=$(mcp_call web_search_exa "$_args")
	print_envelope "$_as_json" "$_out" "$_env"
}

cmd_fetch() {
	_urls=''
	_maxchars=3000
	_as_json=0
	_out=''

	while [ $# -gt 0 ]; do
		case $1 in
		-c | --max-chars) _maxchars=$(num "$1" "${2-}"); shift 2 ;;
		-j | --json) _as_json=1; shift ;;
		-o | --out) _out=$(val "$1" "${2-}"); shift 2 ;;
		-t | --timeout) TIMEOUT=$(num "$1" "${2-}"); shift 2 ;;
		-h | --help) usage; exit 0 ;;
		-*) die "unknown option: $1 (see --help)" ;;
		*)
			# Newline-separated so URLs with spaces or commas survive; the
			# empties are filtered out when the JSON array is built.
			if [ -z "$_urls" ]; then
				_urls=$1
			else
				_urls="$_urls
$1"
			fi
			shift
			;;
		esac
	done
	[ -n "$_urls" ] || die "fetch needs at least one URL (see --help)"

	_urls_json=$(printf '%s\n' "$_urls" | jq -Rsc 'split("\n") | map(select(length > 0))') ||
		die "could not build the URL list"
	_args=$(jq -nc --argjson u "$_urls_json" --argjson c "$_maxchars" \
		'{urls: $u, maxCharacters: $c}') ||
		die "could not build the request (is --max-chars a number?)"
	_env=$(mcp_call web_fetch_exa "$_args")
	print_envelope "$_as_json" "$_out" "$_env"
}

cmd_advanced() {
	_query=''
	_num=10
	_type=''
	_category=''
	_include=''
	_exclude=''
	_sp=''
	_ep=''
	_sc=''
	_ec=''
	_inc_text=''
	_exc_text=''
	_loc=''
	_max_age=-1
	_max_chars=0
	_highlights=0
	_summaries=0
	_summary_query=''
	_subpages=0
	_as_json=0
	_out=''

	while [ $# -gt 0 ]; do
		case $1 in
		-n | --num) _num=$(num "$1" "${2-}"); shift 2 ;;
		--type) _type=$(val "$1" "${2-}"); shift 2 ;;
		--category) _category=$(val "$1" "${2-}"); shift 2 ;;
		--include-domains) _include=$(val "$1" "${2-}"); shift 2 ;;
		--exclude-domains) _exclude=$(val "$1" "${2-}"); shift 2 ;;
		--start-published) _sp=$(val "$1" "${2-}"); shift 2 ;;
		--end-published) _ep=$(val "$1" "${2-}"); shift 2 ;;
		--start-crawled) _sc=$(val "$1" "${2-}"); shift 2 ;;
		--end-crawled) _ec=$(val "$1" "${2-}"); shift 2 ;;
		--include-text) _inc_text=$(val "$1" "${2-}"); shift 2 ;;
		--exclude-text) _exc_text=$(val "$1" "${2-}"); shift 2 ;;
		--location) _loc=$(val "$1" "${2-}"); shift 2 ;;
		--max-age-hours) _max_age=$(num "$1" "${2-}"); shift 2 ;;
		-c | --max-chars) _max_chars=$(num "$1" "${2-}"); shift 2 ;;
		--highlights) _highlights=1; shift ;;
		--no-highlights) _highlights=0; shift ;;
		--summaries)
			_summaries=1
			shift
			if [ $# -gt 0 ]; then
				case $1 in
				-*) ;;
				*)
					_summary_query=$1
					shift
					;;
				esac
			fi
			;;
		--subpages) _subpages=$(num "$1" "${2-}"); shift 2 ;;
		-j | --json) _as_json=1; shift ;;
		-o | --out) _out=$(val "$1" "${2-}"); shift 2 ;;
		-t | --timeout) TIMEOUT=$(num "$1" "${2-}"); shift 2 ;;
		-h | --help) usage; exit 0 ;;
		-*) die "unknown option: $1 (see --help)" ;;
		*)
			_query="${_query:+$_query }$1"
			shift
			;;
		esac
	done
	[ -n "$_query" ] || die "advanced needs a query (see --help)"

	if [ "$_highlights" -eq 1 ]; then _hl=true; else _hl=false; fi
	if [ "$_summaries" -eq 1 ]; then _sum=true; else _sum=false; fi

	# Built up front: inside the `jq ... || die` list below, command
	# substitution would run with `set -e` disabled (shellcheck SC2310).
	_include_json=$(csv_json "$_include")
	_exclude_json=$(csv_json "$_exclude")
	_inc_text_json=$(csv_json "$_inc_text")
	_exc_text_json=$(csv_json "$_exc_text")

	_args=$(jq -nc \
		--arg query "$_query" \
		--argjson num "$_num" \
		--arg type "$_type" \
		--arg category "$_category" \
		--argjson include "$_include_json" \
		--argjson exclude "$_exclude_json" \
		--arg sp "$_sp" \
		--arg ep "$_ep" \
		--arg sc "$_sc" \
		--arg ec "$_ec" \
		--argjson inc_text "$_inc_text_json" \
		--argjson exc_text "$_exc_text_json" \
		--arg loc "$_loc" \
		--argjson max_age "$_max_age" \
		--argjson max_chars "$_max_chars" \
		--argjson highlights "$_hl" \
		--argjson summaries "$_sum" \
		--arg summary_query "$_summary_query" \
		--argjson subpages "$_subpages" '
		{query: $query}
		+ (if $num > 0             then {numResults: $num}                else {} end)
		+ (if $type != ""          then {type: $type}                    else {} end)
		+ (if $category != ""      then {category: $category}            else {} end)
		+ (if ($include|length) > 0 then {includeDomains: $include}      else {} end)
		+ (if ($exclude|length) > 0 then {excludeDomains: $exclude}      else {} end)
		+ (if $sp != ""            then {startPublishedDate: $sp}        else {} end)
		+ (if $ep != ""            then {endPublishedDate: $ep}          else {} end)
		+ (if $sc != ""            then {startCrawlDate: $sc}            else {} end)
		+ (if $ec != ""            then {endCrawlDate: $ec}              else {} end)
		+ (if ($inc_text|length) > 0 then {includeText: $inc_text}       else {} end)
		+ (if ($exc_text|length) > 0 then {excludeText: $exc_text}       else {} end)
		+ (if $loc != ""           then {userLocation: $loc}             else {} end)
		+ (if $max_age >= 0        then {maxAgeHours: $max_age}          else {} end)
		+ (if $max_chars > 0       then {textMaxCharacters: $max_chars}  else {} end)
		+ (if $highlights          then {enableHighlights: true}         else {} end)
		+ (if $summaries           then {enableSummary: true}            else {} end)
		+ (if $summary_query != "" then {summaryQuery: $summary_query}   else {} end)
		+ (if $subpages > 0        then {subpages: $subpages}            else {} end)
	') || die "could not build the request (check the numeric options)"
	_env=$(mcp_call web_search_advanced_exa "$_args")
	print_envelope "$_as_json" "$_out" "$_env"
}

cmd_tools() {
	_env=$(mcp_raw '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
	printf '%s' "$_env" | jq -e . >/dev/null 2>&1 ||
		die "reply was not JSON: $(peek "$_env")"
	envelope_check "$_env"
	printf '%s' "$_env" |
		jq -r '.result.tools[] | "\(.name)\t\((.description // "") | split("\n")[0])"'
}

cmd_pricing() {
	_hdr=$TMPDIR_EXA/hdr
	_body=$TMPDIR_EXA/body

	set -- -H 'Content-Type: application/json' -H 'Accept: application/json'
	if [ -n "$API_KEY" ]; then
		set -- "$@" -H "x-api-key: $API_KEY"
	fi

	curl -sS --max-time "$TIMEOUT" -D "$_hdr" -o "$_body" -X POST "$API_BASE/search" \
		"$@" --data-binary '{"query":"test query","numResults":3}' ||
		die "price probe failed"

	_status=$(first_line "$_hdr")

	if [ -n "$API_KEY" ] && [ "${_status#*402}" = "$_status" ]; then
		note "an API key is set, so x402 is bypassed: $_status"
		return 0
	fi

	# awk (not grep) so an empty match is not an error under `set -e`.
	_pr=$(tr -d '\r' <"$_hdr" |
		awk 'tolower($0) ~ /^payment-required:/ { sub(/^[^:]*:[ \t]*/, ""); print; exit }')
	[ -n "$_pr" ] || die "no PAYMENT-REQUIRED header in the reply: $_status"

	printf '%s\n' "$_status"
	printf 'Pay-per-request (x402), no API key needed:\n'
	printf '%s' "$_pr" | base64_decode | jq -r '
		"  x402 v\(.x402Version)",
		(.accepts[] | "  \(.network)\t$\((.amount | tonumber) / 1000000)\t\(.asset)")'

	_www=$(tr -d '\r' <"$_hdr" |
		awk 'tolower($0) ~ /^www-authenticate:/ { sub(/^[^:]*:[ \t]*/, ""); print; exit }')
	if [ -n "$_www" ]; then
		_method=$(printf '%s' "$_www" | sed -n 's/.*method="\([^"]*\)".*/\1/p')
		[ -n "$_method" ] && printf '  also advertised via MPP (method=%s)\n' "$_method"
	fi
	return 0
}

cmd_raw() {
	[ $# -ge 2 ] || die "raw needs a tool name and a JSON arguments object (see --help)"
	_tool=$1
	_args=$2
	printf '%s' "$_args" | jq -e 'type == "object"' >/dev/null 2>&1 ||
		die "arguments must be a JSON object"
	_env=$(mcp_call "$_tool" "$_args")
	print_envelope 0 "" "$_env"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${1:-}" in
search) shift; cmd_search "$@" ;;
fetch) shift; cmd_fetch "$@" ;;
advanced) shift; cmd_advanced "$@" ;;
tools) shift; cmd_tools "$@" ;;
pricing) shift; cmd_pricing "$@" ;;
raw) shift; cmd_raw "$@" ;;
-h | --help | help) usage ;;
"") usage; exit 1 ;;
*) die "unknown command: $1 (see --help)" ;;
esac
