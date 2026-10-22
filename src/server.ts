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
		return json(res, {
			calls: calls.map((c) => ({
				...c,
				// The full context can be large; the detail endpoint serves it.
				piContext: undefined,
				piContextCount: c.piContext.length,
			})),
			toolCalls,
			compactions,
		});
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
		return json(res, diffCalls(aCall, bCall));
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
