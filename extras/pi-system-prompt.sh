#!/usr/bin/sh

# Dump the system prompt that pi would send for the current directory.
#
# No usable model call happens: the script fires pi once, unsandboxed (BWRAP=0),
# against a model id that should not exist and a throwaway API key. Pi builds
# the provider payload first, and an extension hook on before_provider_request
# writes the prompt and the payload before the request leaves the machine. The
# provider then rejects the call, and nothing is billed.
#
# Usage:
#   pi-system-prompt.sh                  # system prompt -> stdout
#   pi-system-prompt.sh -o FILE          # system prompt -> FILE
#   pi-system-prompt.sh --payload [-o FILE] # serialized provider payload
#   pi-system-prompt.sh --both DIR       # both files into DIR
#
# Env:
#   PI_BIN      pi executable (default: pi)
#   PI_ARGS     extra pi flags, word-split (e.g. PI_ARGS=--approve to trust the
#               project's own extensions, skills, and AGENTS.md)
#   WORK        scratch dir for the throwaway extension (default: mktemp -d)
#   BWRAP       1 keeps the sandbox wrapper (default 0: the child sees /tmp,
#               and the wrapper drops its sandbox note from the prompt)
#   PROVIDER/MODEL/DUMMY_API_KEY  the deliberately failing call
#   TIMEOUT     seconds before giving up (default 120, 0 disables)
set -eu

PI_BIN="${PI_BIN:-pi}"
OUT=""
MODE="text"
BOTH_DIR=""
KEEP=""

usage() {
	sed -n '3,/^set -eu$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	-o | --output)
		OUT="${2:?--output needs a path}"
		shift 2
		;;
	--payload)
		MODE="payload"
		shift
		;;
	--both)
		BOTH_DIR="${2:?--both needs a directory}"
		shift 2
		;;
	--keep)
		KEEP=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "unknown argument: $1 (try --help)" >&2
		exit 2
		;;
	esac
done

command -v "$PI_BIN" >/dev/null || {
	echo "pi-system-prompt: '$PI_BIN' not found on PATH" >&2
	exit 127
}

WORK="$(mktemp -d "${WORK:-${TMPDIR:-/tmp}}/pi-system-prompt.XXXXXX")" ||
	{
		echo "pi-system-prompt: cannot create a scratch dir; set WORK=" >&2
		exit 1
	}

cleanup() {
	if [ -n "$KEEP" ]; then
		echo "kept: $WORK" >&2
	else
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT

EXT="$WORK/hook.ts"
cat >"$EXT" <<'TS'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// The only hook: the payload exists here, and every before_agent_start
	// rewrite and context injection has already been folded into the prompt.
	pi.on("before_provider_request", async (event, ctx) => {
		const dir = process.env.PI_PROMPT_DUMP_DIR;
		if (!dir) throw new Error("PI_PROMPT_DUMP_DIR is not set");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "system-prompt.md"), ctx.getSystemPrompt() + "\n", "utf8");
		writeFileSync(
			join(dir, "provider-payload.json"),
			JSON.stringify(event.payload, null, 2) + "\n",
			"utf8",
		);
	});
}
TS

export PI_PROMPT_DUMP_DIR="$WORK/out"
mkdir -p "$PI_PROMPT_DUMP_DIR"

PROVIDER="${PROVIDER:-openai}"
MODEL="${MODEL:-pi-system-prompt-dump-nonexistent}"
DUMMY_API_KEY="${DUMMY_API_KEY:-sk-pi-system-prompt-dump}"

# Extra flags from PI_ARGS word-split into the argument list, the way the shell
# splits an unquoted expansion. Globbing stays off so a wildcard in a flag stays
# literal. An unset PI_ARGS is made empty first, because `set -u` is on.
PI_ARGS="${PI_ARGS:-}"
set -f
# shellcheck disable=SC2086
set -- "$PI_BIN" \
	--print --no-session -e "$EXT" \
	--provider "$PROVIDER" --model "$MODEL" --api-key "$DUMMY_API_KEY" \
	$PI_ARGS "system prompt dump"
set +f

if [ "${TIMEOUT:-120}" != 0 ] && command -v timeout >/dev/null; then
	set -- timeout "${TIMEOUT:-120}" "$@"
fi

BWRAP="${BWRAP:-0}" "$@" >"$WORK/pi-out.log" 2>"$WORK/pi-err.log" || true

PROMPT="$PI_PROMPT_DUMP_DIR/system-prompt.md"
PAYLOAD="$PI_PROMPT_DUMP_DIR/provider-payload.json"
if [ ! -s "$PROMPT" ]; then
	echo "pi-system-prompt: the hook wrote no dump. pi said:" >&2
	sed 's/^/  /' "$WORK/pi-err.log" >&2
	exit 1
fi

emit() {
	if [ -n "$2" ]; then
		cp "$1" "$2"
		echo "wrote $2 ($(wc -c <"$2") bytes)" >&2
	else
		cat "$1"
	fi
}

if [ -n "$BOTH_DIR" ]; then
	mkdir -p "$BOTH_DIR"
	cp "$PROMPT" "$BOTH_DIR/system-prompt.md"
	cp "$PAYLOAD" "$BOTH_DIR/provider-payload.json"
	echo "wrote system-prompt.md and provider-payload.json into $BOTH_DIR" >&2
elif [ "$MODE" = payload ]; then
	emit "$PAYLOAD" "$OUT"
else
	emit "$PROMPT" "$OUT"
fi
