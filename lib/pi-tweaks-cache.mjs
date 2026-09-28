/**
 * pi-tweaks-cache — where Pi-Tweaks keeps its runtime state.
 *
 * These files are neither configuration nor part of the agent directory: pi
 * rewrites them while it runs, and deleting one costs nothing but a repeat of
 * the work it recorded. They live under `$XDG_CACHE_HOME/pi-tweaks` (default
 * `~/.cache/pi-tweaks`):
 *
 *   - `session-locks/<pid>.json`, one lock per running pi process
 *   - `prune-sessions-state.json`, the time of the last automatic prune round
 *
 * The sandbox wrapper (extras/pi) binds the cache directory read-write on
 * every run, so a sandboxed pi can write here while its agent directory stays
 * out of reach. Plain JavaScript with no pi imports, so both the extensions
 * and the host-side picker can use it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The Pi-Tweaks cache directory. The caller creates it when writing. */
export function cacheDir() {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "pi-tweaks");
}
