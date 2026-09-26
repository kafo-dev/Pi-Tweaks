#!/usr/bin/env node
/**
 * pi-session-pick — record this pi process as active, and optionally pick the
 * session it should resume.
 *
 * Called by extras/pi before it execs pi, so the process id that ends up
 * running pi is the one written into the lock. The lock lets other runs skip a
 * session that is still open, which `pi -c` cannot do: `-c` always takes the
 * most recent session, even when another pi already has it.
 *
 * Modes:
 *   --pick                 print the session to resume, one path per line, or
 *                          nothing when every session is in use and the new
 *                          session should be created
 *   --session-file <path>  lock an explicitly chosen session without picking
 *   neither                lock only; used for `-c`, `--resume`, `--session`,
 *                          and the other explicit session flags
 *
 * The lock is written in every mode, even when the wrapper does not pick, so
 * the prune-sessions experiment can see which sessions are in use.
 */

import { pickSession, writeLock } from "../lib/session-store.mjs";

function parseArgs(argv) {
	const options = { pick: false, sessionFile: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--pick") {
			options.pick = true;
		} else if (argument === "--session-file") {
			options.sessionFile = argv[index + 1];
			index += 1;
		} else if (argument.startsWith("--session-file=")) {
			options.sessionFile = argument.slice("--session-file=".length);
		} else if (argument === "--agent-dir") {
			options.agentDir = argv[index + 1];
			index += 1;
		} else if (argument.startsWith("--agent-dir=")) {
			options.agentDir = argument.slice("--agent-dir=".length);
		} else if (argument === "--cwd") {
			options.cwd = argv[index + 1];
			index += 1;
		} else if (argument.startsWith("--cwd=")) {
			options.cwd = argument.slice("--cwd=".length);
		} else if (argument === "--pid") {
			options.pid = Number(argv[index + 1]);
			index += 1;
		} else if (argument.startsWith("--pid=")) {
			options.pid = Number(argument.slice("--pid=".length));
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
if (
	options.agentDir === undefined ||
	options.cwd === undefined ||
	!Number.isInteger(options.pid)
) {
	process.stderr.write(
		"pi-session-pick: --agent-dir, --cwd, and --pid are required\n",
	);
	process.exit(1);
}

const lock = {
	pid: options.pid,
	cwd: options.cwd,
	startedAtMs: Date.now(),
	sessionFile: options.sessionFile ?? null,
};
writeLock(options.agentDir, lock);

if (!options.pick) process.exit(0);

const picked = await pickSession({
	agentDir: options.agentDir,
	cwd: options.cwd,
	excludePath: options.sessionFile,
});
if (picked) {
	writeLock(options.agentDir, { ...lock, sessionFile: picked });
	process.stdout.write(`${picked}\n`);
}
