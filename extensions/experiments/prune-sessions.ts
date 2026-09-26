/**
 * prune-sessions — move old, unnamed, unused sessions to the trash.
 *
 * A session is removed from the session store when all of these hold:
 *
 *   - it was last written more than `olderThanDays` ago (default 90, about
 *     three months); the file mtime is the last time pi appended an entry, so
 *     it is the last use, not the creation time
 *   - it has no name; a session named with `/name` (or `--name`) is kept
 *     forever
 *   - no live pi process holds it, according to the locks written by the
 *     sandbox wrapper (see lib/session-store.mjs)
 *
 * The file is moved to the XDG trash, not deleted. `gio trash` is not used:
 * the XDG trash spec is small enough to write directly, and this keeps the
 * extension free of an external tool.
 *
 * Config, under `experiment-prune-sessions` in `pi-tweaks.json`:
 *
 *   {
 *     "experiment-prune-sessions": {
 *       "enabled": true,
 *       "disableAutoPruning": false,
 *       "olderThanDays": 90,
 *       "pruneIntervalHours": 24
 *     }
 *   }
 *
 * The experiment is off until `enabled` is the boolean true. With
 * `disableAutoPruning` false (the default), a round runs in the background
 * five seconds after startup, at most once per `pruneIntervalHours`; it never
 * blocks startup. `/pi-tweaks prune-sessions [--dry-run]` runs a round on
 * demand.
 *
 * The XDG trash lives at `$XDG_DATA_HOME/Trash` (default
 * `~/.local/share/Trash`). It is outside the paths the sandbox binds
 * read-write, so add `~/.local/share/Trash` to `rw-paths.txt` before
 * auto-pruning can move anything from a sandboxed pi; a failed move is
 * reported and nothing is lost.
 */

import type { Dirent } from "node:fs";
import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	isExperimentEnabled,
	numberValue,
	readSection,
} from "../../lib/pi-tweaks-config";
import {
	isAttributed,
	readLiveLocks,
	readSessionCwd,
	readSessionName,
} from "../../lib/session-store.mjs";

const EXTENSION = "experiment-prune-sessions";

/** Default age before an unnamed session is trashed. */
const DEFAULT_OLDER_THAN_DAYS = 90;

/** Default gap between background rounds. */
const DEFAULT_PRUNE_INTERVAL_HOURS = 24;

/** How long to stay quiet after startup before a background round. */
const AUTO_PRUNE_DELAY_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

type RoundResult = {
	/** Session files seen in the store. */
	scanned: number;
	/** Files old enough to be considered. */
	candidates: number;
	/** Files moved to the trash, or that would be in a dry run. */
	trashed: string[];
	/** Files kept because they carry a name. */
	named: number;
	/** Files kept because a live process may be using them. */
	active: number;
	/** Problems that stopped a file from being moved. */
	errors: string[];
};

/** The last time an automatic round ran, kept beside the agent directory. */
function stateFile(agentDir: string): string {
	return join(agentDir, "prune-sessions-state.json");
}

function readLastRunMs(agentDir: string): number {
	try {
		const parsed = JSON.parse(readFileSync(stateFile(agentDir), "utf8"));
		return typeof parsed?.lastRunMs === "number" ? parsed.lastRunMs : 0;
	} catch {
		return 0;
	}
}

function writeLastRunMs(agentDir: string, value: number) {
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			stateFile(agentDir),
			`${JSON.stringify({ lastRunMs: value })}\n`,
		);
	} catch {
		// A read-only agent directory only means rounds run again next start.
	}
}

/** Percent-encode a path for the Path key of a .trashinfo file. */
function encodeTrashPath(path: string): string {
	return path.replace(
		/[^A-Za-z0-9\-_.!~*'()/]/g,
		(char) =>
			`%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

/**
 * Move one file to the XDG trash and write its .trashinfo record. Throws on
 * failure; the caller turns that into a report line.
 */
function trashXdg(path: string) {
	const dataHome =
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	const filesDir = join(dataHome, "Trash", "files");
	const infoDir = join(dataHome, "Trash", "info");
	mkdirSync(filesDir, { recursive: true });
	mkdirSync(infoDir, { recursive: true });

	const name = basename(path);
	let destination = join(filesDir, name);
	let suffix = 1;
	while (true) {
		try {
			statSync(destination);
		} catch {
			break;
		}
		destination = join(filesDir, `${name}.${suffix}`);
		suffix += 1;
	}

	const infoPath = join(infoDir, `${basename(destination)}.trashinfo`);
	writeFileSync(
		infoPath,
		`[Trash Info]\nPath=${encodeTrashPath(resolve(path))}\nDeletionDate=${new Date().toISOString()}\n`,
	);
	try {
		try {
			renameSync(path, destination);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "EXDEV") throw error;
			copyFileSync(path, destination);
			unlinkSync(path);
		}
	} catch (error) {
		rmSync(infoPath, { force: true });
		throw error;
	}
}

/** Every `*.jsonl` file below the sessions directory, at any depth. */
function collectSessionFiles(root: string): string[] {
	const found: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			found.push(...collectSessionFiles(path));
		} else if (entry.name.endsWith(".jsonl")) {
			found.push(path);
		}
	}
	return found;
}

type RoundOptions = {
	agentDir: string;
	olderThanDays: number;
	dryRun: boolean;
	currentSessionFile?: string;
};

/** One pruning round. Never throws; problems land in `errors`. */
async function runRound(options: RoundOptions): Promise<RoundResult> {
	const { agentDir, olderThanDays, dryRun, currentSessionFile } = options;
	const cutoff = Date.now() - olderThanDays * DAY_MS;
	// Inside the sandbox the host pid of another pi cannot be checked, so
	// every lock counts as live; the wrapper clears stale locks on the host.
	const locks = readLiveLocks(agentDir, { assumeLive: true });
	const result: RoundResult = {
		scanned: 0,
		candidates: 0,
		trashed: [],
		named: 0,
		active: 0,
		errors: [],
	};

	for (const path of collectSessionFiles(join(agentDir, "sessions"))) {
		result.scanned += 1;
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs >= cutoff) continue;
		result.candidates += 1;

		if (path === currentSessionFile) {
			result.active += 1;
			continue;
		}
		if (await readSessionName(path)) {
			result.named += 1;
			continue;
		}
		const cwd = readSessionCwd(path);
		if (isAttributed(path, mtimeMs, locks, cwd)) {
			result.active += 1;
			continue;
		}

		if (dryRun) {
			result.trashed.push(path);
			continue;
		}
		try {
			trashXdg(path);
			result.trashed.push(path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push(`${path}: ${message}`);
		}
	}
	return result;
}

function describeRound(result: RoundResult, dryRun: boolean): string {
	if (result.scanned === 0) return "prune-sessions: no session files found";
	const verb = dryRun ? "would move" : "moved";
	const lines = [
		`prune-sessions: scanned ${result.scanned}, candidates ${result.candidates}`,
		`${verb} ${result.trashed.length}; kept ${result.named} named, ${result.active} in use`,
	];
	for (const path of result.trashed.slice(0, 10)) lines.push(`  ${path}`);
	if (result.trashed.length > 10) {
		lines.push(`  … ${result.trashed.length - 10} more`);
	}
	for (const error of result.errors.slice(0, 5)) lines.push(`error: ${error}`);
	return lines.join("\n");
}

/** Settings read at call time, so a manual round sees the current file. */
function currentSettings() {
	const section = readSection(EXTENSION);
	return {
		olderThanDays: numberValue(
			section,
			"olderThanDays",
			DEFAULT_OLDER_THAN_DAYS,
			{
				positive: true,
			},
		),
		pruneIntervalHours: numberValue(
			section,
			"pruneIntervalHours",
			DEFAULT_PRUNE_INTERVAL_HOURS,
			{ positive: true },
		),
		disableAutoPruning: section?.disableAutoPruning === true,
	};
}

/**
 * The `/pi-tweaks prune-sessions` subcommand. `--dry-run` reports without
 * moving anything.
 */
export async function runPruneSessions(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const dryRun = args.trim().split(/\s+/).includes("--dry-run");
	const settings = currentSettings();
	try {
		const result = await runRound({
			agentDir: getAgentDir(),
			olderThanDays: settings.olderThanDays,
			dryRun,
			currentSessionFile: ctx.sessionManager.getSessionFile(),
		});
		ctx.ui.notify(describeRound(result, dryRun), "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`prune-sessions: ${message}`, "error");
	}
}

/** Run one background round when the interval has elapsed. */
async function autoPrune(ctx: ExtensionContext) {
	const agentDir = getAgentDir();
	const settings = currentSettings();
	const lastRunMs = readLastRunMs(agentDir);
	if (Date.now() - lastRunMs < settings.pruneIntervalHours * 60 * 60 * 1000) {
		return;
	}
	writeLastRunMs(agentDir, Date.now());
	const result = await runRound({
		agentDir,
		olderThanDays: settings.olderThanDays,
		dryRun: false,
		currentSessionFile: ctx.sessionManager.getSessionFile(),
	});
	if (result.trashed.length > 0 || result.errors.length > 0) {
		ctx.ui.notify(describeRound(result, false), "info");
	}
}

export default function (pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;
	const settings = currentSettings();

	let timer: NodeJS.Timeout | undefined;
	if (!settings.disableAutoPruning) {
		pi.on("session_start", (event, ctx) => {
			if (event.reason !== "startup") return;
			timer = setTimeout(() => {
				autoPrune(ctx).catch(() => {});
			}, AUTO_PRUNE_DELAY_MS);
			timer.unref?.();
		});
	}
	pi.on("session_shutdown", () => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
