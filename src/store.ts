/**
 * Sidecar JSONL trace store.
 *
 * One file per session under ~/.pi-context-viewer/<sessionId>.jsonl with 0600
 * permissions. Writes are queued and flushed asynchronously so event handlers
 * never block on disk I/O. A sibling index file records session summaries for
 * fast listing without re-reading full traces.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setSha256Impl, type LlmCall, type SessionSummary, type TraceRecord } from "./types.ts";

setSha256Impl((data) => createHash("sha256").update(data, "utf8").digest("hex"));

export function traceDir(): string {
	const override = process.env.PI_CONTEXT_VIEWER_DIR;
	return override ?? join(homedir(), ".pi-context-viewer");
}

export function traceFileFor(sessionId: string): string {
	return join(traceDir(), `${sessionId}.jsonl`);
}

const PREVIEW_LIMIT = 300;

export function makePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > PREVIEW_LIMIT ? `${oneLine.slice(0, PREVIEW_LIMIT)}…` : oneLine;
}

export class TraceStore {
	private queue: TraceRecord[] = [];
	private flushing = false;
	private closed = false;
	private readonly file: string;
	private summaryCache?: SessionSummary;

	constructor(
		private readonly sessionId: string,
		seed: (store: TraceStore) => SessionSummary,
	) {
		this.file = traceFileFor(sessionId);
		mkdirSync(traceDir(), { recursive: true });
		// Restrict the directory to the current user when it was just created (POSIX).
		try {
			const stat = statSync(traceDir());
			if (!stat.isDirectory()) throw new Error("trace path is not a directory");
		} catch {
			// ignore; mkdirSync above already created it
		}
		this.summaryCache = seed(this);
		if (!existsSync(this.file)) {
			// New trace; the header is written once per file.
			this.append({ type: "trace_header", ...headerFields(this.summaryCache) });
		}
		// A resumed session (same --session-id in a later pi process) continues
		// the existing file: llm_call seq numbers continue from the last one.
	}

	/** Append a record; disk write happens asynchronously. */
	append(record: TraceRecord): void {
		if (this.closed) return;
		this.queue.push(record);
		this.updateSummary(record);
		void this.flush();
	}

	/** Update the in-memory summary after each appended record. */
	private updateSummary(record: TraceRecord): void {
		const s = this.summaryCache;
		if (!s) return;
		switch (record.type) {
			case "llm_call":
				s.callCount = Math.max(s.callCount, record.call.seq + 1);
				s.lastModel = record.call.model ?? s.lastModel;
				break;
			case "compaction":
				break;
			default:
				break;
		}
		s.updatedAt = new Date().toISOString();
	}

	private flushFailed = false;

	private async flush(): Promise<void> {
		if (this.flushing || this.flushFailed) return;
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.queue.length);
				const lines = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
				// Synchronous append keeps ordering guarantees; batches keep it cheap.
				let isNew = !existsSync(this.file);
				// Note 14: set restrictive mode before the first write rather than
				// after, so the file is never world-readable even briefly.
				if (isNew) {
					try {
						const { chmodSync, writeFileSync } = await import("node:fs");
						writeFileSync(this.file, "", { mode: 0o600 });
						chmodSync(this.file, 0o600);
						isNew = false;
					} catch {
						// Windows: chmod is mostly a no-op; acceptable.
					}
				}
				appendFileSync(this.file, lines, "utf8");
			}
		} catch (err) {
			// A trace write must never take down the host pi process (Major 4):
			// stop retrying and keep the failure contained.
			this.flushFailed = true;
			this.queue.length = 0;
			console.error("[pi-context-viewer] trace write failed; capture disabled:", err instanceof Error ? err.message : String(err));
		} finally {
			this.flushing = false;
		}
		if (this.queue.length > 0) void this.flush();
	}

	summary(): SessionSummary {
		return { ...this.summaryCache!, active: true };
	}

	close(reason: string): void {
		if (this.closed) return;
		// Append the end record before flipping the guard: append() refuses
		// writes once closed.
		this.append({ type: "session_end", at: new Date().toISOString(), reason });
		this.closed = true;
}
}

function headerFields(s: SessionSummary) {
	return {
		sessionId: s.sessionId,
		sessionFile: s.sessionFile,
		cwd: s.cwd,
		startedAt: s.startedAt,
		schemaVersion: 1,
		...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
		...(s.isSubagent ? { isSubagent: true } : {}),
	};
}

/** Read all records of a finished or in-progress session trace. */
export function readTrace(sessionId: string): TraceRecord[] {
	const file = traceFileFor(sessionId);
	if (!existsSync(file)) return [];
	const lines = readFileSync(file, "utf8").split("\n");
	const records: TraceRecord[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as TraceRecord);
		} catch {
			// Torn tail write while a session is live: each JSONL line is
			// self-contained, so skip the bad line and keep reading (a torn
			// line must not permanently hide the records after it).
			continue;
		}
	}
	return records;
}

/** Fast header-only scan: reads only the first line of each trace file. */
export function listSessionHeaders(): Array<{ sessionId: string; startedAt: string; parentSessionId?: string; isSubagent?: boolean }> {
	const dir = traceDir();
	if (!existsSync(dir)) return [];
	const out: Array<{ sessionId: string; startedAt: string; parentSessionId?: string; isSubagent?: boolean }> = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const first = readFirstLine(join(dir, name));
			if (!first) continue;
			const header = JSON.parse(first);
			if (header?.type !== "trace_header") continue;
			out.push({
				sessionId: header.sessionId,
				startedAt: header.startedAt,
				...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
				...(header.isSubagent ? { isSubagent: true } : {}),
			});
		} catch {
			// unreadable or torn first line: skip
		}
	}
	return out;
}

function readFirstLine(file: string): string | undefined {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(4096);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const text = buf.toString("utf8", 0, n);
		const idx = text.indexOf("\n");
		return idx === -1 ? text.trim() : text.slice(0, idx);
	} finally {
		closeSync(fd);
	}
}

/** List all known sessions by scanning the trace directory. */
export function listSessions(): SessionSummary[] {
	const dir = traceDir();
	if (!existsSync(dir)) return [];
	const summaries: SessionSummary[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const sessionId = name.slice(0, -6);
		const records = readTrace(sessionId);
		const header = records.find((r): r is Extract<TraceRecord, { type: "trace_header" }> => r.type === "trace_header");
		if (!header) continue;
		const calls = records.filter((r): r is Extract<TraceRecord, { type: "llm_call" }> => r.type === "llm_call");
		const lastCall = calls[calls.length - 1];
		const ended = records[records.length - 1]?.type === "session_end";
		// "active" means: no session_end AND recent file activity. A crashed or
		// long-dead process leaves no session_end; stale traces fall back to
		// inactive after the mtime window so the UI does not show ghosts.
		let active = !ended;
		if (active) {
			try {
				active = Date.now() - statSync(join(dir, name)).mtimeMs < 15 * 60_000;
			} catch {
				active = false;
			}
		}
		summaries.push({
			sessionId,
			cwd: header.cwd,
			sessionFile: header.sessionFile,
			startedAt: header.startedAt,
			updatedAt: ended
				? (records[records.length - 1] as { at?: string }).at ?? header.startedAt
				: new Date().toISOString(),
			callCount: calls.length,
			lastModel: lastCall?.call.model,
			parentSessionId: header.parentSessionId,
			isSubagent: header.isSubagent,
			active,
		});
	}
	summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return summaries;
}

/** Extract LLM calls (complete view) from a trace record list. */
export function callsFromRecords(records: TraceRecord[]): LlmCall[] {
	return records
		.filter((r): r is Extract<TraceRecord, { type: "llm_call" }> => r.type === "llm_call")
		.map((r) => r.call);
}

/** Resume context for a session: last llm_call seq and prior tool-call records. */
export function resumeContext(sessionId: string): { lastSeq: number; toolCalls: import("./types.ts").ToolCallRecord[] } {
	const records = readTrace(sessionId);
	let lastSeq = -1;
	const toolCalls: import("./types.ts").ToolCallRecord[] = [];
	for (const r of records) {
		if (r.type === "llm_call" && r.call.seq > lastSeq) lastSeq = r.call.seq;
		if (r.type === "tool_call_started") toolCalls.push(r.call);
	}
	return { lastSeq, toolCalls };
}
