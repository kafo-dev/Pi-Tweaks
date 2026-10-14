/**
 * move-host — an experimental `/move-host` command that moves a running
 * session to another host at the next safe turn.
 *
 * Hypothesis: a session is a file, so the machine that runs it can change
 * without losing the conversation; the only things a host lacks are the
 * working tree and the transcript.
 *
 * `/move-host [user@]host[:port] [--force]` names the destination. The
 * destination may be an SSH alias from `~/.ssh/config` — whose entry may carry
 * its own `Port` and `User` — or a `[user@]host[:port]` form for a host
 * without a config entry. An empty or malformed argument, a non-TUI run, a
 * session without a file, and a target without `tmux` are refused.
 *
 * The session stops at the next safe boundary and resumes there:
 *
 *   - issued while idle, the move runs at once and no turn follows;
 *   - issued while a turn streams, the move waits for the first `turn_end`
 *     that carries tool results, aborts the run, and resumes with a prompt
 *     that continues the interrupted work;
 *   - a run that settles first moves without a prompt.
 *
 * The working directory's contents copy to the same absolute path on the
 * target, minus the regenerable directories in the `exclude` list. A populated
 * target path is refused unless `--force` is given. A move started from the
 * home directory copies no files, because both hosts call it `/home/<user>` and
 * hold different configuration there.
 *
 * The transcript copies to the target's session store and starts inside a
 * detached `tmux` session, so it outlives the SSH child and the source pi's
 * exit. Reattach with the printed `ssh <host> -t tmux attach -t pi-move-<id>`.
 * The copied session carries a `custom` marker, and in the settled case a
 * `custom_message` notice; a failure leaves the source session untouched and
 * running.
 *
 * Config, under `experiment-move-host` in `pi-tweaks.json`:
 *
 *   {
 *     "experiment-move-host": {
 *       "enabled": true,
 *       "exclude": ["node_modules", "dist"]
 *     }
 *   }
 *
 * `exclude` replaces the default list of dependency and build-output
 * directories: `node_modules`, `.venv`, `venv`, `__pycache__`, `.mypy_cache`,
 * `.pytest_cache`, `.ruff_cache`, `dist`, `build`, `target`, `coverage`,
 * `.next`, `.nuxt`, `.turbo`, `.cache`. An empty array copies everything.
 * `.git` stays, because it holds history rather than build output.
 *
 * A private SSH key is unreadable inside the `extras/pi` sandbox, which hides
 * `$HOME` and binds no `~/.ssh`; add an `ro ~/.ssh` line to
 * `~/.pi/wrapper-config.txt` for a sandboxed run.
 *
 * See the Experiment README and pi-tweaks-config.ts.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildMovedTranscript,
	markerEntries,
	sessionSlug,
} from "../../lib/move-session.mjs";
import {
	isExperimentEnabled,
	readSection,
	stringArrayValue,
} from "../../lib/pi-tweaks-config";

const EXTENSION = "experiment-move-host";

/** Remote directory for the tarball, the launcher, and their cleanup. */
const REMOTE_TMP = "/tmp";

/** The largest TCP port number. */
const PORT_MAX = 65535;

/** A host, user, or alias ssh accepts without a config entry. */
const NAME = /^[A-Za-z0-9._-]+$/;

/** A port, as digits. */
const PORT = /^[0-9]+$/;

/** Directory names the tarball leaves out; the config section overrides them. */
const DEFAULT_EXCLUDES = [
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".cache",
];

/** Where a move sends the session and what it may overwrite. */
type Target = {
	/** Login user, absent when the SSH config supplies one. */
	user?: string;
	/** SSH alias, host name, or address. */
	host: string;
	/** TCP port, absent when the SSH config supplies one. */
	port?: string;
	/** Whether to copy over a populated target directory. */
	force: boolean;
	/** The argument as typed, for notifications and the marker. */
	label: string;
};

/** How the source session ends before it moves. */
type MoveMode = "continue" | "settled";

/** The active model, present when one is configured. */
type ActiveModel = NonNullable<ExtensionContext["model"]>;

/** Parse `/move-host [user@]host[:port] [--force]`, or say what is wrong. */
function parseTarget(args: string): Target | { error: string } {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "");
	let force = false;
	const positional: string[] = [];
	for (const token of tokens) {
		if (token === "--force") {
			force = true;
		} else if (token.startsWith("--")) {
			return { error: `unknown option ${JSON.stringify(token)}` };
		} else {
			positional.push(token);
		}
	}
	if (positional.length === 0) return { error: "no host given" };
	if (positional.length > 1) {
		return { error: `unexpected argument ${JSON.stringify(positional[1])}` };
	}

	let rest = positional[0];
	let user: string | undefined;
	const at = rest.indexOf("@");
	if (at !== -1) {
		user = rest.slice(0, at);
		rest = rest.slice(at + 1);
		if (!NAME.test(user)) {
			return { error: `invalid user ${JSON.stringify(user)}` };
		}
	}

	let host = rest;
	let port: string | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon !== -1) {
		const suffix = rest.slice(colon + 1);
		if (!PORT.test(suffix)) {
			return { error: `invalid port ${JSON.stringify(suffix)}` };
		}
		const value = Number(suffix);
		if (value < 1 || value > PORT_MAX) {
			return { error: `port out of range: ${suffix}` };
		}
		port = suffix;
		host = rest.slice(0, colon);
	}
	if (!NAME.test(host)) {
		return { error: `invalid host ${JSON.stringify(host)}` };
	}
	return { user, host, port, force, label: positional[0] };
}

/** The `ssh`/`scp` destination, with the user when one was given. */
function remoteHost(target: Target): string {
	return target.user === undefined
		? target.host
		: `${target.user}@${target.host}`;
}

/** `ssh` with its port and destination, ready for a remote command. */
function sshBase(target: Target): string[] {
	const args = ["-T", "-o", "LogLevel=ERROR"];
	if (target.port !== undefined) args.push("-p", target.port);
	args.push(remoteHost(target));
	return args;
}

/**
 * Run one command on the target. Every word is single-quoted, because ssh
 * hands the remote command to the target's login shell, which need not be
 * POSIX sh: a path with a space would split into two arguments otherwise.
 * Never rejects; the exit code is the result.
 */
function ssh(
	pi: ExtensionAPI,
	target: Target,
	command: string[],
): Promise<ExecResult> {
	return pi.exec("ssh", [
		...sshBase(target),
		...command.map((word) => shQuote(word)),
	]);
}

/**
 * Run a POSIX shell script on the target. The script travels as one quoted
 * word, so the login shell only starts `sh`; a shell builtin such as
 * `command -v` then runs under a parser that treats it as one.
 */
function sshScript(
	pi: ExtensionAPI,
	target: Target,
	script: string,
): Promise<ExecResult> {
	return pi.exec("ssh", [
		...sshBase(target),
		shQuote("sh"),
		shQuote("-c"),
		shQuote(script),
	]);
}

/** Copy one local file to an absolute path on the target. */
function scp(
	pi: ExtensionAPI,
	target: Target,
	local: string,
	remote: string,
): Promise<ExecResult> {
	const args: string[] = ["-o", "LogLevel=ERROR"];
	if (target.port !== undefined) args.push("-P", target.port);
	args.push(local, `${remoteHost(target)}:${remote}`);
	return pi.exec("scp", args);
}

/** The message of a failed command, naming what failed. */
function failure(what: string, result: ExecResult): string {
	const detail =
		result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
	return `${what}: ${detail}`;
}

/** A POSIX single-quoted shell word, safe for any value. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Warn when the target cannot authenticate the active model. A missing or
 * unready check is a warning, not a refusal: the target may hold a credential
 * the check does not see.
 */
async function credentialWarning(
	pi: ExtensionAPI,
	target: Target,
	model: ActiveModel,
): Promise<string | undefined> {
	const reference = `${model.provider}/${model.id}`;
	const result = await ssh(pi, target, [
		"pi",
		"auth",
		"check",
		"--model",
		reference,
		"--json",
		"--no-refresh",
	]);
	let status: unknown;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		status =
			typeof parsed === "object" && parsed !== null && "status" in parsed
				? (parsed as { status: unknown }).status
				: undefined;
	} catch {
		status = undefined;
	}
	if (result.code === 0 && status === "ready") return undefined;
	const reason =
		typeof status === "string"
			? status
			: result.stderr.trim() || `exit code ${result.code}`;
	return `move-host: ${target.label} is not ready for ${reference} (${reason}); continuing`;
}

/** Refuse a target where the resumed session could not run detached. */
async function requireTmux(pi: ExtensionAPI, target: Target): Promise<void> {
	const result = await sshScript(pi, target, "command -v tmux || exit 42");
	if (result.code === 0 && result.stdout.trim() !== "") return;
	if (result.code === 42) {
		throw new Error(
			`move-host: ${target.label} has no tmux; the moved session cannot run detached`,
		);
	}
	throw new Error(failure(`move-host: cannot reach ${target.label}`, result));
}

/** The directory names the tarball leaves out, read at move time. */
function configuredExcludes(): string[] {
	return stringArrayValue(readSection(EXTENSION), "exclude", DEFAULT_EXCLUDES);
}

/**
 * Copy the working directory to the same absolute path on the target, minus
 * the configured regenerable directories. The home directory is skipped: both
 * hosts call it `/home/<user>` and hold different files, so mirroring one over
 * the other would destroy the target's configuration.
 */
async function copyProject(
	pi: ExtensionAPI,
	target: Target,
	ctx: ExtensionContext,
	tmpDir: string,
	moveId: string,
): Promise<void> {
	const cwd = ctx.cwd;
	if (cwd === homedir()) return;
	if (!cwd.startsWith("/")) {
		throw new Error(`move-host: the working directory ${cwd} is not absolute`);
	}

	const tarball = join(tmpDir, "project.tgz");
	const packed = await pi.exec("tar", [
		"-C",
		cwd,
		...configuredExcludes().map((name) => `--exclude=${name}`),
		"-czf",
		tarball,
		".",
	]);
	if (packed.code !== 0) {
		throw new Error(failure("move-host: tar failed", packed));
	}

	const probe = await ssh(pi, target, [
		"find",
		cwd,
		"-mindepth",
		"1",
		"-maxdepth",
		"1",
		"-print",
		"-quit",
	]);
	if (probe.code === 0 && probe.stdout.trim() !== "" && !target.force) {
		throw new Error(
			`move-host: ${target.label}:${cwd} is not empty; rerun with --force to copy over it`,
		);
	}

	const mkdir = await ssh(pi, target, ["mkdir", "-p", cwd]);
	if (mkdir.code !== 0) {
		throw new Error(failure("move-host: mkdir failed", mkdir));
	}

	const remoteTarball = `${REMOTE_TMP}/pi-move-${moveId}.tgz`;
	const copied = await scp(pi, target, tarball, remoteTarball);
	if (copied.code !== 0) {
		throw new Error(failure("move-host: scp failed", copied));
	}
	const extracted = await ssh(pi, target, [
		"tar",
		"-xzf",
		remoteTarball,
		"-C",
		cwd,
	]);
	await ssh(pi, target, ["rm", "-f", remoteTarball]);
	if (extracted.code !== 0) {
		throw new Error(failure("move-host: tar extract failed", extracted));
	}
}

/** Where the target keeps sessions, from its environment. */
async function remoteAgentDir(
	pi: ExtensionAPI,
	target: Target,
): Promise<string> {
	const configured = await ssh(pi, target, ["printenv", "PI_CODING_AGENT_DIR"]);
	if (configured.code === 0 && configured.stdout.trim() !== "") {
		return configured.stdout.trim();
	}
	const home = await ssh(pi, target, ["printenv", "HOME"]);
	if (home.code !== 0 || home.stdout.trim() === "") {
		throw new Error(
			failure(`move-host: cannot read $HOME on ${target.label}`, home),
		);
	}
	return join(home.stdout.trim(), ".pi", "agent");
}

/** A session file name, matching pi's timestamp-plus-id form. */
function sessionFileName(sessionId: string): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/**
 * Write the transcript into the target's session store so `/resume` lists it,
 * and return its absolute path on the target.
 */
async function sendTranscript(
	pi: ExtensionAPI,
	target: Target,
	ctx: ExtensionContext,
	transcript: string,
	tmpDir: string,
): Promise<string> {
	const agentDir = await remoteAgentDir(pi, target);
	const remoteDir = `${agentDir}/sessions/${sessionSlug(ctx.cwd)}`;
	const remotePath = `${remoteDir}/${sessionFileName(ctx.sessionManager.getSessionId())}`;

	const localPath = join(tmpDir, "session.jsonl");
	writeFileSync(localPath, transcript);

	const mkdir = await ssh(pi, target, ["mkdir", "-p", remoteDir]);
	if (mkdir.code !== 0) {
		throw new Error(
			failure("move-host: cannot create the session directory", mkdir),
		);
	}
	const copied = await scp(pi, target, localPath, remotePath);
	if (copied.code !== 0) {
		throw new Error(failure("move-host: cannot copy the transcript", copied));
	}
	return remotePath;
}

/**
 * Write a launcher for the target, copy it over, and run it. The launcher
 * starts `pi` on the copied transcript inside a detached tmux session, so the
 * resumed session outlives the SSH child and the source pi's exit. A
 * `continue` move passes the notice as a positional prompt that runs the turn
 * the abort interrupted; a `settled` move passes none and runs no turn.
 */
async function launch(
	pi: ExtensionAPI,
	target: Target,
	ctx: ExtensionContext,
	remoteSessionPath: string,
	notice: string | undefined,
	moveId: string,
	tmpDir: string,
): Promise<void> {
	const sessionName = `pi-move-${moveId}`;
	const command = [
		"tmux",
		"new-session",
		"-d",
		"-s",
		sessionName,
		"-c",
		ctx.cwd,
		"pi",
		"--session",
		remoteSessionPath,
	];
	if (notice !== undefined) command.push(notice);

	const script = [
		"#!/bin/sh",
		"set -eu",
		"if ! command -v tmux >/dev/null 2>&1; then",
		'\techo "move-host: tmux is not installed on this host" >&2',
		"\texit 1",
		"fi",
		"if ! command -v pi >/dev/null 2>&1; then",
		'\techo "move-host: pi is not on PATH on this host" >&2',
		"\texit 1",
		"fi",
		command.map(shQuote).join(" "),
		"",
	].join("\n");

	const localPath = join(tmpDir, "launch.sh");
	writeFileSync(localPath, script, { mode: 0o755 });
	const remotePath = `${REMOTE_TMP}/pi-move-${moveId}.sh`;
	const copied = await scp(pi, target, localPath, remotePath);
	if (copied.code !== 0) {
		throw new Error(failure("move-host: cannot copy the launcher", copied));
	}
	const started = await ssh(pi, target, ["sh", remotePath]);
	await ssh(pi, target, ["rm", "-f", remotePath]);
	if (started.code !== 0) {
		throw new Error(
			failure(
				`move-host: ${target.label} could not start the session`,
				started,
			),
		);
	}
}

/** What the moved session is told about the move. */
function noticeText(
	from: string,
	to: string,
	cwd: string,
	mode: MoveMode,
): string {
	const here = `This session moved from ${from} to ${to}; the working directory was copied to ${cwd} on ${to}.`;
	if (mode === "continue") {
		return `${here} Continue the interrupted work from where it stopped.`;
	}
	return `${here} No turn runs here automatically; send a prompt to continue.`;
}

/** The command that reattaches to the moved session. */
function attachHint(target: Target, moveId: string): string {
	const port = target.port === undefined ? "" : `-p ${target.port} `;
	return `ssh ${port}${remoteHost(target)} -t tmux attach -t pi-move-${moveId}`;
}

/** Run one move. Returns true on success; the caller then shuts the source down. */
async function performMove(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: Target,
	mode: MoveMode,
): Promise<boolean> {
	const moveId = randomUUID().slice(0, 8);
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-move-"));
	try {
		const manager = ctx.sessionManager;
		const header = manager.getHeader();
		if (header === null) {
			throw new Error("move-host: this session has no header to copy");
		}
		const from = hostname();
		const at = new Date().toISOString();
		const notice = noticeText(from, target.label, ctx.cwd, mode);
		const transcript = buildMovedTranscript({
			header,
			entries: manager.getEntries(),
			leafId: manager.getLeafId(),
			markers: markerEntries({
				from,
				to: target.label,
				mode,
				at,
				notice: mode === "settled" ? notice : undefined,
			}),
		});

		await requireTmux(pi, target);
		if (ctx.model !== undefined) {
			const warning = await credentialWarning(pi, target, ctx.model);
			if (warning !== undefined) ctx.ui.notify(warning, "warning");
		}
		await copyProject(pi, target, ctx, tmpDir, moveId);
		const remoteSessionPath = await sendTranscript(
			pi,
			target,
			ctx,
			transcript,
			tmpDir,
		);
		await launch(
			pi,
			target,
			ctx,
			remoteSessionPath,
			mode === "continue" ? notice : undefined,
			moveId,
			tmpDir,
		);

		ctx.ui.notify(
			`move-host: moved to ${target.label}.\n  ${attachHint(target, moveId)}`,
			"info",
		);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(message, "error");
		return false;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

export default function moveHost(pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	/** The move a command queued while a run streams, if any. */
	let pending: Target | undefined;
	/** Guards against a second trigger while a move runs. */
	let moving = false;

	/** Run a move, shut the source down on success, and clear the guard on failure. */
	async function finish(
		ctx: ExtensionContext,
		target: Target,
		mode: MoveMode,
	): Promise<void> {
		const moved = await performMove(pi, ctx, target, mode);
		if (moved) {
			ctx.shutdown();
		} else {
			moving = false;
		}
	}

	pi.on("turn_end", async (event, ctx) => {
		if (pending === undefined || moving) return;
		if (event.toolResults.length === 0) return;
		const target = pending;
		pending = undefined;
		moving = true;
		ctx.abort();
		await finish(ctx, target, "continue");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pending === undefined || moving) return;
		const target = pending;
		pending = undefined;
		moving = true;
		await finish(ctx, target, "settled");
	});

	pi.registerCommand("move-host", {
		description: "Move this session to another host at the next safe turn",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"move-host: the move needs an interactive (TUI) session",
					"warning",
				);
				return;
			}
			const parsed = parseTarget(args);
			if ("error" in parsed) {
				ctx.ui.notify(`move-host: ${parsed.error}`, "warning");
				return;
			}
			if (ctx.sessionManager.getSessionFile() === undefined) {
				ctx.ui.notify("move-host: this session has no file to copy", "warning");
				return;
			}
			if (pending !== undefined || moving) {
				ctx.ui.notify("move-host: a move is already in progress", "warning");
				return;
			}
			if (ctx.isIdle()) {
				moving = true;
				await finish(ctx, parsed, "settled");
				return;
			}
			pending = parsed;
			ctx.ui.notify(
				`move-host: the session stops at the next tool boundary and resumes on ${parsed.label}`,
				"info",
			);
		},
	});
}
