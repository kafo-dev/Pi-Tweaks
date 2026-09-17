/**
 * pi-python — a `python` tool that runs Python 3 without shell quoting.
 *
 * The model passes raw source in `code`. It is spawned as
 * `python3 -c <code>` with the source as one argv entry, so no shell ever
 * parses it and nothing in the source needs escaping or fences. The session
 * working directory is the cwd.
 *
 * Each call is a fresh interpreter: definitions and imports do not carry over
 * between calls.
 *
 * Output larger than `keepLines` lines at each end is cut to the first and last
 * `keepLines` lines, with the count of dropped lines and the path of a temp file
 * holding the full output shown in a marker between them.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_KEEP_LINES = 50; // lines kept from each end of truncated output

function truncateOutput(output: string, keepLines: number): string {
	const lines = output ? output.split("\n") : [];
	if (lines.length <= keepLines * 2 && Buffer.byteLength(output) <= DEFAULT_MAX_BYTES) {
		return output;
	}

	const file = join(tmpdir(), `pi-python-${randomUUID()}.log`);
	writeFileSync(file, output);

	// Few lines but too many bytes: cut at the byte budget. truncateHead is
	// line-oriented and returns nothing when the first line alone exceeds it, so
	// slice the encoded bytes; stream mode drops a character split by the cut.
	if (lines.length <= keepLines * 2) {
		const bytes = Buffer.from(output, "utf8");
		const kept = new TextDecoder("utf-8").decode(bytes.subarray(0, DEFAULT_MAX_BYTES), {
			stream: true,
		});
		const omitted = bytes.length - Buffer.byteLength(kept, "utf8");
		return `${kept}\n[... ${omitted} bytes truncated; full output: ${file} ...]`;
	}

	const head = truncateHead(output, { maxLines: keepLines, maxBytes: DEFAULT_MAX_BYTES / 2 });
	const tail = truncateTail(output, { maxLines: keepLines, maxBytes: DEFAULT_MAX_BYTES / 2 });
	const omitted = lines.length - head.outputLines - tail.outputLines;
	return `${head.content}\n[... ${omitted} lines truncated; full output: ${file} ...]\n${tail.content}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "python",
		label: "Python",
		description:
			"Execute Python 3 code. Pass the program as raw source in `code`: it is " +
			"handed to python3 as a single argument, so no shell quoting or escaping is " +
			"needed and no code fences are wanted. Runs in the session working directory " +
			"with a fresh interpreter each call; state does not persist between calls. " +
			"Returns combined stdout/stderr. By default each end of very long output is " +
			"cut to 50 lines; raise keepLines to keep more per end.",
		promptSnippet: "Execute Python 3 code with no shell quoting",
		promptGuidelines: [
			"Use python to run Python snippets instead of piping source through bash, which requires shell quoting.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Python source, verbatim" }),
			keepLines: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Lines kept from each end before truncating; defaults to 50. Dropped lines are replaced by a marker naming the count and a temp file with the full output.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await pi.exec("python3", ["-c", params.code], {
				cwd: ctx.cwd,
				signal,
			});

			const output = [result.stdout, result.stderr]
				.filter((stream) => stream.trim())
				.join("\n")
				.trim();
			const text = truncateOutput(output, params.keepLines ?? DEFAULT_KEEP_LINES) || "(no output)";

			if (result.code !== 0) {
				throw new Error(`${text}\n\n[exit code ${result.code}]`);
			}
			return { content: [{ type: "text", text }], details: { exitCode: result.code } };
		},
	});
}
