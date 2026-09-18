/**
 * pi-stop — `/stop` aborts the running turn, an alias for Escape.
 *
 * pi's TUI handles Escape before extensions see the input, so an extension
 * cannot call that handler; `ctx.abort()` is the same abort. Commands are
 * dispatched before pi decides whether an input is a steering message, so
 * `/stop` works while the agent is still streaming.
 *
 * `/stop` also emits `turn-aborted` on the shared event bus, so pi-notify can
 * skip the alert for the settle it causes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stop", {
		description: "Abort the current turn (same as Escape)",
		handler: (_args, ctx) => {
			if (ctx.isIdle()) {
				ctx.ui.notify("Nothing is running", "info");
				return;
			}
			// Emit before `ctx.abort()` so pi-notify has the flag when the turn
			// settles.
			pi.events.emit("turn-aborted");
			ctx.abort();
			ctx.ui.notify("Stopping", "info");
		},
	});
}
