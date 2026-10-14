/**
 * move-session — the transcript a move writes on the other host.
 *
 * A moved session is a fresh copy of the original JSONL file with marker
 * entries appended. The copy carries the header and every tree entry in file
 * order, so entries the source file has buffered in memory but not written yet
 * travel too. The markers chain from the current leaf, so the copied file's
 * last entry is the last marker and pi resumes exactly where the move
 * happened.
 *
 * Plain JavaScript with no pi imports, mirroring lib/session-store.mjs, so the
 * move-host experiment can be exercised without the extension API.
 */

import { randomUUID } from "node:crypto";

/** customType of every entry a move writes. */
export const MOVE_TYPE = "move-host";

/** Ids to draw before falling back to a full UUID. */
const ID_ATTEMPTS = 100;

/**
 * The session directory name pi gives a working directory: the leading
 * separator goes, every `/`, `\`, and `:` becomes `-`, and the result sits
 * between two `--`. `/home/user/project` becomes `--home-user-project--`.
 */
export function sessionSlug(cwd) {
	if (typeof cwd !== "string" || cwd === "") {
		throw new Error("sessionSlug: cwd must be a non-empty string");
	}
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** An 8-hex-char id, retried while `taken` holds it. */
function uniqueId(taken) {
	for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
		const id = randomUUID().slice(0, 8);
		if (!taken.has(id)) return id;
	}
	return randomUUID();
}

/**
 * The entries a move appends: a `custom` marker that records the move, and —
 * when `notice` is given — a `custom_message` that carries the notice into the
 * LLM context and the transcript. A `settled` move passes the notice here
 * because it runs no turn; a `continue` move leaves the notice to the
 * positional prompt and adds only the marker.
 */
export function markerEntries({ from, to, mode, at, notice }) {
	if (typeof from !== "string" || from === "") {
		throw new Error("markerEntries: from must be a non-empty string");
	}
	if (typeof to !== "string" || to === "") {
		throw new Error("markerEntries: to must be a non-empty string");
	}
	if (typeof at !== "string" || at === "") {
		throw new Error("markerEntries: at must be a non-empty string");
	}
	if (mode !== "continue" && mode !== "settled") {
		throw new Error(`markerEntries: unknown mode ${JSON.stringify(mode)}`);
	}

	const entries = [
		{
			type: "custom",
			customType: MOVE_TYPE,
			timestamp: at,
			data: { from, to, mode, at },
		},
	];
	if (notice !== undefined) {
		entries.push({
			type: "custom_message",
			customType: MOVE_TYPE,
			timestamp: at,
			content: notice,
			display: true,
		});
	}
	return entries;
}

/**
 * The JSONL text of a moved session: the header, every entry in file order,
 * then the markers chained from `leafId`. Each marker gets an id and a
 * `parentId`, so the last marker is the copied file's leaf.
 */
export function buildMovedTranscript({ header, entries, leafId, markers }) {
	if (header === null || header === undefined) {
		throw new Error("buildMovedTranscript: a session header is required");
	}
	if (!Array.isArray(entries)) {
		throw new Error("buildMovedTranscript: entries must be an array");
	}
	if (!Array.isArray(markers)) {
		throw new Error("buildMovedTranscript: markers must be an array");
	}
	if (leafId !== null && typeof leafId !== "string") {
		throw new Error("buildMovedTranscript: leafId must be a string or null");
	}

	const taken = new Set();
	for (const entry of entries) {
		if (typeof entry.id === "string") taken.add(entry.id);
	}

	const lines = [JSON.stringify(header)];
	for (const entry of entries) lines.push(JSON.stringify(entry));

	let parentId = leafId;
	for (const marker of markers) {
		const id = uniqueId(taken);
		taken.add(id);
		lines.push(JSON.stringify({ ...marker, id, parentId }));
		parentId = id;
	}
	return `${lines.join("\n")}\n`;
}
