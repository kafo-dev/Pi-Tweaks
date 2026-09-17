/**
 * pi-exit — `/exit` as an alias for pi's built-in `/quit`.
 *
 * pi's TUI handles `/quit` before extensions see the input, so an extension
 * command cannot call that handler; `ctx.shutdown()` is the same graceful
 * exit (deferred until the agent is idle, emits `session_shutdown`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi (alias for /quit)",
		handler: (_args, ctx) => ctx.shutdown(),
	});
}
