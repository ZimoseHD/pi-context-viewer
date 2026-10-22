/**
 * pi-context-viewer — Pi extension entry point.
 *
 * Captures full per-LLM-call context, provider payloads, tool activity, and
 * compaction boundaries into a local sidecar trace, and serves a read-only
 * web viewer on 127.0.0.1.
 *
 * Usage in pi:
 *   pi --extension /path/to/pi-context-viewer
 *   /context-view            — show status + open URL
 *   /context-view off        — stop the viewer server (capture continues)
 *
 * Environment:
 *   PI_CONTEXT_VIEWER_PORT   — port (default 7860; next free port is used if busy)
 *   PI_CONTEXT_VIEWER_DIR    — trace directory (default ~/.pi-context-viewer)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Collector } from "./collector.ts";
import { TraceStore, traceDir, traceFileFor } from "./store.ts";
import { createViewerServer, type ViewerServer } from "./server.ts";
import type { SessionSummary } from "./types.ts";

const startedAt = new Date().toISOString();

export default function contextViewer(pi: ExtensionAPI) {
	let store: TraceStore | undefined;
	let collector: Collector | undefined;
	let server: ViewerServer | undefined;
	let currentSessionId: string | undefined;
	let serverStopped = false;
	let lastUrl = "";

	function ensureServer(): void {
		if (server || serverStopped) return;
		try {
			server = createViewerServer((url) => {
				lastUrl = url;
				pi.events?.emit?.("viewer-ready", { url });
			});
		} catch (err) {
			pi.events?.emit?.("viewer-error", { error: String(err) });
		}
	}

	function ensureStore(ctx: { cwd: string; sessionManager: any; model?: any }): TraceStore {
		// Session replacement (/new, /resume, /fork) tears the extension runtime
		// down and calls session_start again, so one store per runtime is fine;
		// but guard against duplicated session_start anyway.
		if (store) return store;
		const sessionId = ctx.sessionManager.getSessionId();
		currentSessionId = sessionId;
		const parentSessionId = process.env.PI_SUBAGENT_PARENT_SESSION || undefined;
		const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
		store = new TraceStore(sessionId, (): SessionSummary => ({
			sessionId,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			startedAt,
			updatedAt: startedAt,
			callCount: 0,
			...(parentSessionId ? { parentSessionId } : {}),
			...(isSubagent ? { isSubagent: true } : {}),
		}));
		collector = new Collector(store, () => {
			server?.notify(sessionId);
		});
		ensureServer();
		return store;
	}

	pi.on("session_start", (event, ctx) => {
		ensureStore(ctx);
		collector!.onSessionStart(event, ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		collector?.onTurnStart(event, ctx);
	});

	pi.on("context_with_system", (event, ctx) => {
		if (!collector) ensureStore(ctx);
		collector!.onContextWithSystem(event, ctx);
		return undefined;
	});

	pi.on("before_provider_request", (event) => {
		collector?.onBeforeProviderRequest(event);
		return undefined;
	});

	pi.on("after_provider_response", () => {
		collector?.onAfterProviderResponse();
	});

	pi.on("message_end", (event) => {
		collector?.onMessageEnd(event);
	});

	pi.on("tool_call", (event) => {
		collector?.onToolCall(event);
		return undefined;
	});

	pi.on("tool_result", (event) => {
		collector?.onToolResult(event);
		return undefined;
	});

	pi.on("turn_end", (event) => {
		collector?.onTurnEnd(event);
	});

	pi.on("session_before_compact", (event) => {
		collector?.onBeforeCompact(event);
	});

	pi.on("session_compact", (event) => {
		collector?.onCompact(event);
	});

	pi.on("session_compact_failed", () => {
		collector?.onCompactFailed();
	});

	pi.on("session_shutdown", (event) => {
		collector?.onShutdown(event.reason);
		server?.close();
		server = undefined;
	});

	pi.registerCommand("context-view", {
		description: "Context Explorer web viewer (status / open / off)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") {
				server?.close();
				server = undefined;
				serverStopped = true;
				ctx.ui.notify("Context Explorer server stopped (capture continues)", "info");
				return;
			}
			if (serverStopped) {
				serverStopped = false;
				ensureServer();
			} else {
				ensureServer();
			}
			const url = lastUrl || `http://127.0.0.1:${server?.port ?? 7860}/`;
			if (currentSessionId) {
				ctx.ui.notify(
					`Context Explorer: ${url} — trace: ${traceFileFor(currentSessionId)}`,
					"info",
				);
			} else {
				ctx.ui.notify(`Context Explorer: ${url} — traces in ${traceDir()}`, "info");
			}
		},
	});
}
