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
 * Packages named in `pip` are installed into a virtual environment shared by
 * every pi session (under pi's agent directory) before the code runs, and every
 * later call runs inside that environment. `retry_previous` re-runs the last
 * program, so the model can install a missing package and retry without
 * resending the source.
 *
 * Output larger than `keepLines` lines at each end is cut to the first and last
 * `keepLines` lines, with the count of dropped lines and the path of a temp file
 * holding the full output shown in a marker between them.
 */

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	getAgentDir,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_KEEP_LINES = 50; // lines kept from each end of truncated output
const VENV_DIRECTORY_NAME = "python-venv"; // venv lives under pi's agent dir
const VENV_PYTHON_PATH = join("bin", "python3"); // interpreter inside the venv

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

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return [result.stdout, result.stderr]
		.filter((stream) => stream.trim())
		.join("\n")
		.trim();
}

function globalVenvDirectory(): string {
	const agentDirectory = getAgentDir();
	if (!agentDirectory) {
		throw new Error("python: pi agent directory is empty");
	}
	return join(agentDirectory, VENV_DIRECTORY_NAME);
}

function venvPython(venvDirectory: string): string {
	return join(venvDirectory, VENV_PYTHON_PATH);
}

async function ensureVenv(
	pi: ExtensionAPI,
	venvDirectory: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (existsSync(venvPython(venvDirectory))) {
		return;
	}
	const result = await pi.exec(
		"python3",
		["-m", "venv", "--system-site-packages", venvDirectory],
		{ signal },
	);
	if (result.code !== 0) {
		const output = truncateOutput(combinedOutput(result), DEFAULT_KEEP_LINES);
		throw new Error(`python: failed to create venv\n${output}`);
	}
}

async function installPackages(
	pi: ExtensionAPI,
	venvDirectory: string,
	packages: string[],
	signal: AbortSignal | undefined,
): Promise<string> {
	const result = await pi.exec(
		venvPython(venvDirectory),
		["-m", "pip", "install", ...packages],
		{ signal },
	);
	if (result.code === 0) {
		return `Installed pip packages: ${packages.join(", ")}`;
	}
	const output = truncateOutput(combinedOutput(result), DEFAULT_KEEP_LINES);
	throw new Error(`python: pip install failed\n${output}`);
}

export default function (pi: ExtensionAPI) {
	let lastCode: string | undefined;

	pi.registerTool({
		name: "python",
		label: "Python",
		description:
			"Execute Python 3 code. Pass the program as raw source in `code`: it is " +
			"handed to the interpreter as a single argument, so no shell quoting or " +
			"escaping is needed and no code fences are wanted. Runs in the session " +
			"working directory with a fresh interpreter each call; state does not " +
			"persist between calls. Packages named in `pip` are installed with pip " +
			"into a virtual environment shared by every pi session before the code " +
			"runs; the environment is created on first use, and later calls run " +
			"inside it. Assume the packages you need are available: if the code fails " +
			"with a missing module, call again with `pip` naming the missing " +
			"packages and " +
			"`retry_previous: true` to install them and re-run the same code, instead " +
			"of resending the source. `retry_previous` re-runs the last program and " +
			"requires `code` to be omitted. Returns combined stdout/stderr. By " +
			"default each end of very long output is cut to 50 lines; raise keepLines " +
			"to keep more per end.",
		promptSnippet: "Execute Python 3 with no shell quoting and shared pip installs",
		promptGuidelines: [
			"Use python to run Python snippets instead of piping source through bash, which requires shell quoting.",
			"When python code fails with ModuleNotFoundError, call python again with pip naming the missing packages and retry_previous true instead of resending the code.",
		],
		parameters: Type.Object({
			code: Type.Optional(
				Type.String({
					description:
						"Python source, verbatim. Omit when retry_previous is true.",
				}),
			),
			pip: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Packages to install with pip into the shared virtual environment before running the code.",
				}),
			),
			retry_previous: Type.Optional(
				Type.Boolean({
					description:
						"Re-run the code from the previous python call instead of sending it again. Requires `code` to be omitted.",
				}),
			),
			keepLines: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Lines kept from each end before truncating; defaults to 50. Dropped lines are replaced by a marker naming the count and a temp file with the full output.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const retryPrevious = params.retry_previous === true;
			if (retryPrevious && params.code !== undefined) {
				throw new Error("python: send code or retry_previous, not both");
			}
			let source: string;
			if (retryPrevious) {
				if (lastCode === undefined) {
					throw new Error(
						"python: retry_previous is set but no previous code ran in this session",
					);
				}
				source = lastCode;
			} else {
				if (params.code === undefined) {
					throw new Error("python: code is required unless retry_previous is true");
				}
				source = params.code;
			}
			lastCode = source;

			const packages = params.pip ?? [];
			const venvDirectory = globalVenvDirectory();
			let installNote = "";
			if (packages.length > 0) {
				await ensureVenv(pi, venvDirectory, signal);
				installNote = await installPackages(pi, venvDirectory, packages, signal);
			}
			const venvInterpreter = venvPython(venvDirectory);
			const interpreter = existsSync(venvInterpreter) ? venvInterpreter : "python3";

			const result = await pi.exec(interpreter, ["-c", source], {
				cwd: ctx.cwd,
				signal,
			});

			const output = combinedOutput(result);
			const sections = [installNote, output].filter((section) => section.length > 0);
			const text =
				truncateOutput(sections.join("\n"), params.keepLines ?? DEFAULT_KEEP_LINES) ||
				"(no output)";

			if (result.code !== 0) {
				throw new Error(`${text}\n\n[exit code ${result.code}]`);
			}
			return { content: [{ type: "text", text }], details: { exitCode: result.code } };
		},
	});
}
