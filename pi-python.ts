/**
 * pi-python — a `python` tool that runs Python 3 without shell quoting.
 *
 * The model passes raw source in `code`. It is spawned as
 * `python3 -c <code>` with the source as one argv entry, so no shell ever
 * parses it and nothing in the source needs escaping or fences. The run starts
 * in the session working directory unless `cwd` names another directory.
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
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	getAgentDir,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_KEEP_LINES = 50; // lines kept from each end of truncated output
const DEFAULT_TIMEOUT_SECONDS = 10; // code run is killed after this long
const MAX_TIMEOUT_SECONDS = 2147483647 / 1000; // 32-bit setTimeout ceiling
const VENV_DIRECTORY_NAME = "python-venv"; // venv lives under pi's agent dir
const VENV_PYTHON_PATH = join("bin", "python3"); // interpreter inside the venv

function truncateOutput(output: string, keepLines: number): string {
	const lines = output ? output.split("\n") : [];
	if (
		lines.length <= keepLines * 2 &&
		Buffer.byteLength(output) <= DEFAULT_MAX_BYTES
	) {
		return output;
	}

	const file = join(tmpdir(), `pi-python-${randomUUID()}.log`);
	writeFileSync(file, output);

	// Few lines but too many bytes: cut at the byte budget. truncateHead is
	// line-oriented and returns nothing when the first line alone exceeds it, so
	// slice the encoded bytes; stream mode drops a character split by the cut.
	if (lines.length <= keepLines * 2) {
		const bytes = Buffer.from(output, "utf8");
		const kept = new TextDecoder("utf-8").decode(
			bytes.subarray(0, DEFAULT_MAX_BYTES),
			{
				stream: true,
			},
		);
		const omitted = bytes.length - Buffer.byteLength(kept, "utf8");
		return `${kept}\n[... ${omitted} bytes truncated; full output: ${file} ...]`;
	}

	const head = truncateHead(output, {
		maxLines: keepLines,
		maxBytes: DEFAULT_MAX_BYTES / 2,
	});
	const tail = truncateTail(output, {
		maxLines: keepLines,
		maxBytes: DEFAULT_MAX_BYTES / 2,
	});
	const omitted = lines.length - head.outputLines - tail.outputLines;
	return `${head.content}\n[... ${omitted} lines truncated; full output: ${file} ...]\n${tail.content}`;
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return [result.stdout, result.stderr]
		.filter((stream) => stream.trim())
		.join("\n")
		.trim();
}

function resolveTimeoutSeconds(timeout: number | undefined): number {
	if (timeout === undefined) {
		return DEFAULT_TIMEOUT_SECONDS;
	}
	if (!Number.isFinite(timeout)) {
		throw new Error("python: timeout must be a finite number of seconds");
	}
	if (timeout <= 0) {
		throw new Error("python: timeout must be greater than zero");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`python: timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
	return timeout;
}

function resolveWorkingDirectory(
	requestedDirectory: string | undefined,
	sessionDirectory: string,
): string {
	if (sessionDirectory.length === 0) {
		throw new Error("python: session working directory is empty");
	}
	if (requestedDirectory === undefined) {
		return sessionDirectory;
	}
	const trimmedDirectory = requestedDirectory.trim();
	if (trimmedDirectory.length === 0) {
		throw new Error("python: cwd is empty");
	}
	const absoluteDirectory = resolve(sessionDirectory, trimmedDirectory);
	const stats = statSync(absoluteDirectory, { throwIfNoEntry: false });
	if (stats === undefined) {
		throw new Error(`python: cwd does not exist: ${absoluteDirectory}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`python: cwd is not a directory: ${absoluteDirectory}`);
	}
	return absoluteDirectory;
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
	if (result.killed) {
		throw new Error("python: venv creation aborted");
	}
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
	if (result.killed) {
		throw new Error("python: pip install aborted");
	}
	if (result.code === 0) {
		return `Installed pip packages: ${packages.join(", ")}`;
	}
	const output = truncateOutput(combinedOutput(result), DEFAULT_KEEP_LINES);
	throw new Error(`python: pip install failed\n${output}`);
}

export default function (pi: ExtensionAPI) {
	let lastCode: string | undefined;
	let lastWorkingDirectory: string | undefined;

	pi.registerTool({
		name: "python",
		label: "Python",
		description:
			"Execute Python 3 code. Pass the program as raw source in `code`: it is " +
			"handed to the interpreter as a single argument, so no shell quoting or " +
			"escaping is needed and no code fences are wanted. Runs with a fresh " +
			"interpreter each call; state does not persist between calls. By default " +
			"the run starts in the session working directory; pass `cwd` to start " +
			"elsewhere. Packages named in `pip` are installed with pip " +
			"into a virtual environment shared by every pi session before the code " +
			"runs; the environment is created on first use, and later calls run " +
			"inside it. Assume the packages you need are available: if the code fails " +
			"with a missing module, call again with `pip` naming the missing " +
			"packages and " +
			"`retry_previous: true` to install them and re-run the same code, instead " +
			"of resending the source. `retry_previous` re-runs the last program and " +
			"requires `code` to be omitted. The code run is killed after " +
			`${DEFAULT_TIMEOUT_SECONDS} seconds unless \`timeout\` (in seconds) says ` +
			"otherwise; `pip` installs are not bounded by that timeout. Returns " +
			"combined stdout/stderr. By " +
			"default each end of very long output is cut to 50 lines; raise keepLines " +
			"to keep more per end.",
		promptSnippet:
			"Execute Python 3 with no shell quoting and shared pip installs",
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
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the run. A relative path resolves against the session working directory. Defaults to the session working directory and must be an existing directory.",
				}),
			),
			keepLines: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"Lines kept from each end before truncating; defaults to 50. Dropped lines are replaced by a marker naming the count and a temp file with the full output.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds for the code run before it is killed; defaults to ${DEFAULT_TIMEOUT_SECONDS}. Must be a positive finite number. Does not bound \`pip\` installs.`,
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
					throw new Error(
						"python: code is required unless retry_previous is true",
					);
				}
				source = params.code;
			}
			lastCode = source;

			const requestedWorkingDirectory =
				params.cwd ?? (retryPrevious ? lastWorkingDirectory : undefined);
			const workingDirectory = resolveWorkingDirectory(
				requestedWorkingDirectory,
				ctx.cwd,
			);
			lastWorkingDirectory = workingDirectory;

			const packages = params.pip ?? [];
			const venvDirectory = globalVenvDirectory();
			let installNote = "";
			if (packages.length > 0) {
				await ensureVenv(pi, venvDirectory, signal);
				installNote = await installPackages(
					pi,
					venvDirectory,
					packages,
					signal,
				);
			}
			const venvInterpreter = venvPython(venvDirectory);
			const interpreter = existsSync(venvInterpreter)
				? venvInterpreter
				: "python3";
			const timeoutSeconds = resolveTimeoutSeconds(params.timeout);

			const result = await pi.exec(interpreter, ["-c", source], {
				cwd: workingDirectory,
				signal,
				timeout: timeoutSeconds * 1000,
			});

			const output = combinedOutput(result);
			const sections = [installNote, output].filter(
				(section) => section.length > 0,
			);
			const text =
				truncateOutput(
					sections.join("\n"),
					params.keepLines ?? DEFAULT_KEEP_LINES,
				) || "(no output)";

			if (result.killed) {
				if (signal?.aborted) {
					throw new Error(`python: aborted\n\n${text}`);
				}
				throw new Error(
					`python: timed out after ${timeoutSeconds}s\n\n${text}`,
				);
			}
			if (result.code !== 0) {
				throw new Error(`${text}\n\n[exit code ${result.code}]`);
			}
			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.code },
			};
		},
	});
}
