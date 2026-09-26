/**
 * session-store — session files, session names, and the active-session locks.
 *
 * Plain JavaScript with no pi imports, so the same code serves both sides:
 *
 *   - the prune-sessions experiment, inside the pi process
 *   - extras/pi-session-pick.mjs, run by the sandbox wrapper before pi starts
 *
 * Pi keeps no lock on the session it has open: it opens the JSONL file only to
 * append and closes it again. A session that is idle but open is therefore
 * invisible to the filesystem. Activity is tracked here instead, with one lock
 * file per pi process under <agentDir>/session-locks/<pid>.json. The wrapper
 * writes its lock before launching pi; a stale lock (dead pid) is removed when
 * the locks are read.
 *
 * A lock names its cwd and start time, and the session file when one was
 * chosen up front. A session file is attributed to a lock when the lock names
 * that file, or when the file was last written after the lock's process
 * started: an open session keeps a fresh mtime while it is used, and an idle
 * open session still carries an mtime from after its own process started.
 */

import {
	closeSync,
	createReadStream,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** Two clocks do not need to agree to the millisecond; this covers the gap. */
const SLACK_MS = 2000;

/**
 * The session directory pi derives from a working directory. Must match
 * getDefaultSessionDir in pi's session-manager.
 */
function sessionDirFor(agentDir, cwd) {
	const resolved = resolve(cwd);
	const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/** One session file on disk. */
function listSessionFiles(sessionDir) {
	let names;
	try {
		names = readdirSync(sessionDir);
	} catch {
		return [];
	}
	const files = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(sessionDir, name);
		try {
			files.push({ path, mtimeMs: statSync(path).mtimeMs });
		} catch {
			// Raced with a deletion; leave it out.
		}
	}
	return files;
}

/**
 * The display name of a session, from the last session_info entry, or
 * undefined when the session is unnamed. Read as a stream so a large session
 * costs one pass and no big string.
 */
export async function readSessionName(path) {
	let name;
	let input;
	try {
		input = createReadStream(path, { encoding: "utf8" });
	} catch {
		return undefined;
	}
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.includes('"session_info"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info") {
					name =
						typeof entry.name === "string" && entry.name !== ""
							? entry.name
							: undefined;
				}
			} catch {
				// A partial or corrupt line is not a name.
			}
		}
	} catch {
		return name;
	} finally {
		lines.close();
	}
	return name;
}

/** The cwd recorded in a session header, read from the first line only. */
export function readSessionCwd(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(8192);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, read).toString("utf8").split("\n")[0];
		const header = JSON.parse(firstLine);
		return typeof header.cwd === "string" ? resolve(header.cwd) : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Whether a process is alive. A permission error still means it exists. */
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** The directory holding one lock file per running pi process. */
function locksDir(agentDir) {
	return join(agentDir, "session-locks");
}

function lockPath(agentDir, pid) {
	return join(locksDir(agentDir), `${pid}.json`);
}

function removeQuietly(path) {
	try {
		rmSync(path, { force: true });
	} catch {
		// A lock that cannot be removed is retried on the next read.
	}
}

/**
 * Every lock that counts as live.
 *
 * On the host (the wrapper and its picker), a dead process id proves the lock
 * is stale, and the lock is deleted. Inside the sandbox, pi runs in a private
 * pid namespace, so the host pid of another pi is meaningless and the pid
 * check would misfire: there, `assumeLive` treats every lock as live and
 * deletes nothing. Stale locks are then cleared by the next run on the host.
 *
 * @param {string} agentDir
 * @param {{ assumeLive?: boolean }} [options]
 */
export function readLiveLocks(agentDir, options = {}) {
	let names;
	try {
		names = readdirSync(locksDir(agentDir));
	} catch {
		return [];
	}
	const locks = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(locksDir(agentDir), name);
		let lock;
		try {
			lock = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			if (!options.assumeLive) removeQuietly(path);
			continue;
		}
		if (typeof lock?.pid !== "number") continue;
		if (!options.assumeLive && !isAlive(lock.pid)) {
			removeQuietly(path);
			continue;
		}
		locks.push(lock);
	}
	return locks;
}

/** Write (or refresh) this process's lock. */
export function writeLock(agentDir, lock) {
	try {
		mkdirSync(locksDir(agentDir), { recursive: true });
		writeFileSync(lockPath(agentDir, lock.pid), `${JSON.stringify(lock)}\n`);
	} catch {
		// A lock is an optimization; a read-only agent directory stays usable.
	}
}

/**
 * Whether a session file belongs to a live process. When `cwd` is given, only
 * locks from that directory count; without it, any lock can claim the file, so
 * a caller that cannot read the cwd stays on the safe side.
 */
export function isAttributed(path, mtimeMs, locks, cwd) {
	const wanted = cwd === undefined ? undefined : resolve(cwd);
	for (const lock of locks) {
		if (typeof lock?.pid !== "number") continue;
		if (wanted !== undefined && resolve(lock.cwd ?? "") !== wanted) continue;
		if (lock.sessionFile === path) return true;
		if (
			typeof lock.startedAtMs === "number" &&
			mtimeMs >= lock.startedAtMs - SLACK_MS
		) {
			return true;
		}
	}
	return false;
}

/**
 * Pick a session to resume in `cwd`: the most recently used named session that
 * no live process holds, else the most recently used session that no live
 * process holds, else null.
 */
export async function pickSession({ agentDir, cwd, excludePath }) {
	const locks = readLiveLocks(agentDir);
	const files = listSessionFiles(sessionDirFor(agentDir, cwd));
	const candidates = [];
	for (const file of files) {
		if (excludePath !== undefined && file.path === excludePath) continue;
		if (isAttributed(file.path, file.mtimeMs, locks, cwd)) continue;
		candidates.push(file);
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const candidate of candidates) {
		if (await readSessionName(candidate.path)) return candidate.path;
	}
	return candidates.length > 0 ? candidates[0].path : null;
}
