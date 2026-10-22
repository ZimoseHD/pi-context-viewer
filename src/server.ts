/**
 * Local HTTP server: static UI + JSON API + SSE live updates.
 * Binds 127.0.0.1 only. No external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { callsFromRecords, listSessions, readTrace } from "./store.ts";
import { diffCalls } from "./diff.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

export interface ViewerServer {
	port: number;
	close(): void;
	notify(sessionId: string): void;
}

const sseClients = new Set<{
	res: ServerResponse;
	sessionId: string | null;
}>();

export function createViewerServer(onStarted?: (url: string) => void, portHint?: number): ViewerServer {
	const webDir = join(fileURLToPath(new URL(".", import.meta.url)), "web");

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		handle(req, res, url, webDir).catch((err) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		});
	});

	const preferredPort = portHint ?? Number(process.env.PI_CONTEXT_VIEWER_PORT ?? 7860);
	const MAX_PORT_ATTEMPTS = 20;

	function listen(port: number, attempt: number): void {
		server.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
				listen(port + 1, attempt + 1);
			} else {
				// Never crash the host pi process over the viewer.
				onStarted?.("");
			}
		});
		server.listen(port, "127.0.0.1", () => {
			onStarted?.(`http://127.0.0.1:${(server.address() as any)?.port ?? port}/`);
		});
	}
	listen(preferredPort, 0);

	function notify(sessionId: string): void {
		const payload = `event: update\ndata: ${JSON.stringify({ sessionId, at: new Date().toISOString() })}\n\n`;
		for (const client of sseClients) {
			if (client.sessionId === null || client.sessionId === sessionId) {
				client.res.write(payload);
			}
		}
	}

	return {
		get port() {
			return (server.address() as any)?.port ?? preferredPort;
		},
		notify,
		close() {
			for (const client of sseClients) client.res.end();
			sseClients.clear();
			server.close();
		},
	};
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL, webDir: string): Promise<void> {
	const path = url.pathname;

	if (path === "/events") {
		// SSE stream; optional ?sessionId= filter.
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write("retry: 3000\n\n");
		const client = { res, sessionId: url.searchParams.get("sessionId") };
		sseClients.add(client);
		req.on("close", () => sseClients.delete(client));
		return;
	}

	if (path === "/api/sessions") {
		return json(res, listSessions());
	}

	const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const records = readTrace(sessionMatch[1]);
		if (records.length === 0) return json(res, { error: "not found" }, 404);
		const calls = callsFromRecords(records);
		const toolCalls = records.flatMap((r) => (r.type === "tool_call_started" ? [r.call] : []));
		const compactions = records.flatMap((r) => (r.type === "compaction" ? [r.compaction] : []));
		// Subagent children: sessions whose trace header points at this one.
		const children = listSessions()
			.filter((s) => s.parentSessionId === sessionMatch[1])
			.map((s) => ({ sessionId: s.sessionId, startedAt: s.startedAt, callCount: s.callCount, isSubagent: s.isSubagent }));
		return json(res, {
			calls: calls.map((c) => ({
				...c,
				// The full context can be large; the detail endpoint serves it.
				piContext: undefined,
				piContextCount: c.piContext.length,
			})),
			toolCalls,
			compactions,
			children,
		});
	}

	const tokensMatch = path.match(/^\/api\/sessions\/([^/]+)\/tokens$/);
	if (tokensMatch) {
		const records = readTrace(tokensMatch[1]);
		const calls = callsFromRecords(records);
		if (calls.length === 0) return json(res, { error: "not found" }, 404);
		return json(res, tokenBreakdown(calls));
	}

	const insightsMatch = path.match(/^\/api\/sessions\/([^/]+)\/insights$/);
	if (insightsMatch) {
		const records = readTrace(insightsMatch[1]);
		if (records.length === 0) return json(res, { error: "not found" }, 404);
		return json(res, buildInsights(records));
	}

	const callMatch = path.match(/^\/api\/sessions\/([^/]+)\/calls\/(\d+)$/);
	if (callMatch) {
		const records = readTrace(callMatch[1]);
		const calls = callsFromRecords(records);
		const call = calls.find((c) => c.seq === Number(callMatch[2]));
		if (!call) return json(res, { error: "not found" }, 404);
		return json(res, call);
	}

	const diffMatch = path.match(/^\/api\/sessions\/([^/]+)\/diff\/(\d+)(?:\/(\d+))?$/);
	if (diffMatch) {
		const records = readTrace(diffMatch[1]);
		const calls = callsFromRecords(records);
		const bSeq = Number(diffMatch[2]);
		const aSeq = Number(diffMatch[3] ?? bSeq - 1);
		const bCall = calls.find((c) => c.seq === bSeq);
		if (!bCall) return json(res, { error: "not found" }, 404);
		// A must be strictly before B; otherwise diff against an empty context.
		const aCall = aSeq < bSeq ? calls.find((c) => c.seq === aSeq) : undefined;
		const messageDiff = diffCalls(aCall, bCall);
		// Provider-payload-level changes (final request shapes): tool list and
		// system text differences between the two calls' last payloads.
		const payloadChanges = payloadDiff(aCall, bCall);
		return json(res, { ...messageDiff, payloadChanges });
	}

	// Static files under src/web.
	const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
	const file = join(webDir, safePath === "/" || safePath === "\\" ? "index.html" : safePath);
	if (!file.startsWith(webDir) || !existsSync(file) || !statSync(file).isFile()) {
		// SPA fallback to index.html
		const index = join(webDir, "index.html");
		if (existsSync(index)) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			createReadStream(index).pipe(res);
			return;
		}
		return json(res, { error: "not found" }, 404);
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(res);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

// ---------- analysis helpers (M3) ----------

import type { LlmCall } from "./types.ts";

/** Provider-payload-level diff between two calls' final payloads. */
function payloadDiff(a: LlmCall | undefined, b: LlmCall): {
	systemChanged: boolean;
	toolsAdded: string[];
	toolsRemoved: string[];
	messageCountDelta: number | null;
} {
	const pa = a?.providerPayloads[a.providerPayloads.length - 1]?.payload as any;
	const pb = b.providerPayloads[b.providerPayloads.length - 1]?.payload as any;
	if (!pa || !pb) {
		return { systemChanged: false, toolsAdded: [], toolsRemoved: [], messageCountDelta: null };
	}
	const sysText = (p: any): string =>
		typeof p?.system === "string" ? p.system : Array.isArray(p?.system) ? p.system.map((s: any) => s?.text ?? "").join("\n") : "";
	const toolNames = (p: any): string[] => Array.isArray(p?.tools) ? p.tools.map((t: any) => t?.name ?? "?") : [];
	const aTools = new Set(toolNames(pa));
	const bTools = new Set(toolNames(pb));
	const aMsgCount = Array.isArray(pa?.messages) ? pa.messages.length : null;
	const bMsgCount = Array.isArray(pb?.messages) ? pb.messages.length : null;
	return {
		systemChanged: sysText(pa) !== sysText(pb),
		toolsAdded: [...bTools].filter((t) => !aTools.has(t)),
		toolsRemoved: [...aTools].filter((t) => !bTools.has(t)),
		messageCountDelta: aMsgCount != null && bMsgCount != null ? bMsgCount - aMsgCount : null,
	};
}

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/** Per-call and per-role token breakdown. All estimates are labeled as such. */
function tokenBreakdown(calls: LlmCall[]): {
	perCall: Array<{
		seq: number;
		providerInput: number | null;
		providerOutput: number | null;
		piEstimate: number | null;
		byRole: Array<{ role: string; estimate: number; actual?: number }>;
	}>;
	totals: { byRole: Array<{ key: string; estimate: number }>; byProvenance: Array<{ key: string; estimate: number }> };
} {
	const roleTotals = new Map<string, number>();
	const provTotals = new Map<string, number>();
	const perCall = calls.map((c) => {
		const byRole = new Map<string, number>();
		for (const m of c.piContext) {
			const text = JSON.stringify(m.content ?? "") + JSON.stringify(m.sections ?? {});
			const est = Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
			byRole.set(m.role, (byRole.get(m.role) ?? 0) + est);
			roleTotals.set(m.role, (roleTotals.get(m.role) ?? 0) + est);
			const kind = m.provenance?.kind ?? "unknown";
			provTotals.set(kind, (provTotals.get(kind) ?? 0) + est);
		}
		return {
			seq: c.seq,
			providerInput: c.providerInputTokens != null
				? c.providerInputTokens + (c.providerCacheReadTokens ?? 0) + (c.providerCacheWriteTokens ?? 0)
				: null,
			providerOutput: c.providerOutputTokens ?? null,
			piEstimate: c.piEstimatedTokens ?? null,
			byRole: [...byRole.entries()].map(([role, estimate]) => ({ role, estimate })),
		};
	});
	const mapToSorted = (m: Map<string, number>) =>
		[...m.entries()].map(([k, v]) => ({ key: k, estimate: v })).sort((x, y) => y.estimate - x.estimate);
	return {
		perCall,
		totals: {
			byRole: mapToSorted(roleTotals),
			byProvenance: mapToSorted(provTotals),
		},
	};
}

/**
 * Objective context-insight signals computed from trace evidence:
 * - duplicate tool calls (same tool + same path/command)
 * - tool-result persistence (in how many later calls the result stays present)
 * - oversized tool results
 * - compaction impact
 * No causal claims: presence counts are facts, relevance is not inferred.
 */
function buildInsights(records: import("./types.ts").TraceRecord[]): {
	duplicates: Array<{ toolName: string; signature: string; count: number; kind: string }>;
	persistence: Array<{ toolName: string; label: string; presentInCalls: number; totalCallsAfter: number }>;
	largeToolResults: Array<{ toolName: string; label: string; contentLength: number }>;
	compactions: Array<{ reason: string; tokensBefore: number; summarizedMessages: number; at: string }>;
} {
	const calls = callsFromRecords(records);
	const toolCalls = records.flatMap((r) => (r.type === "tool_call_started" ? [r.call] : []));
	const toolFinished = new Map(records.flatMap((r) => (r.type === "tool_call_finished" ? [[r.toolCallId, r] as const] : [])));

	// 1. Duplicate tool calls by (toolName, path/command).
	const seen = new Map<string, { toolName: string; signature: string; count: number; kind: string }>();
	for (const tc of toolCalls) {
		const input = tc.input as any;
		const signature = typeof input?.path === "string" ? input.path : typeof input?.command === "string" ? input.command : JSON.stringify(tc.input);
		const key = `${tc.toolName}:${signature}`;
		const entry = seen.get(key) ?? { toolName: tc.toolName, signature, count: 0, kind: typeof input?.path === "string" ? "file" : "command" };
		entry.count += 1;
		seen.set(key, entry);
	}
	const duplicates = [...seen.values()].filter((d) => d.count > 1).sort((a, b) => b.count - a.count);

	// 2. Persistence: for each tool call, count later calls whose piContext still
	//    contains a toolResult with that toolCallId. Objective presence only.
	const persistence: Array<{ toolName: string; label: string; presentInCalls: number; totalCallsAfter: number }> = [];
	for (const tc of toolCalls) {
		const callSeq = calls.findIndex((c) => c.toolCallIds.includes(tc.toolCallId));
		if (callSeq === -1) continue;
		const later = calls.slice(callSeq + 1);
		const present = later.filter((c) => c.piContext.some((m) => m.role === "toolResult" && m.toolCallId === tc.toolCallId)).length;
		const input = tc.input as any;
		const label = typeof input?.path === "string" ? input.path : typeof input?.command === "string" ? input.command : "";
		persistence.push({ toolName: tc.toolName, label: label || tc.toolName, presentInCalls: present, totalCallsAfter: later.length });
	}
	persistence.sort((a, b) => b.presentInCalls - a.presentInCalls);

	// 3. Large tool results (contentLength from the finished record).
	const largeToolResults = [];
	for (const tc of toolCalls) {
		const fin = toolFinished.get(tc.toolCallId);
		if (fin && fin.contentLength > 50_000) {
			const input = tc.input as any;
			largeToolResults.push({
				toolName: tc.toolName,
				label: typeof input?.path === "string" ? input.path : typeof input?.command === "string" ? input.command : tc.toolName,
				contentLength: fin.contentLength,
			});
		}
	}
	largeToolResults.sort((a, b) => b.contentLength - a.contentLength);

	// 4. Compaction impact.
	const compactions = records.flatMap((r) =>
		r.type === "compaction"
			? [{
					reason: r.compaction.reason,
					tokensBefore: r.compaction.tokensBefore,
					summarizedMessages: r.compaction.summarizedRoles.length,
					at: r.compaction.at,
				}]
			: [],
	);

	return { duplicates, persistence, largeToolResults, compactions };
}
