/**
 * session-store — the display name of a session file.
 *
 * Plain JavaScript with no pi imports, so the prune-sessions experiment reads a
 * session name without pulling in the extension API.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
