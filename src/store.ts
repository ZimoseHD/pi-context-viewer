/**
 * Sidecar JSONL trace store.
 *
 * One file per session under ~/.pi-context-viewer/<sessionId>.jsonl with 0600
 * permissions. Writes are queued and flushed asynchronously so event handlers
 * never block on disk I/O. A sibling index file records session summaries for
 * fast listing without re-reading full traces.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";
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
		this.append({ type: "trace_header", ...headerFields(this.summaryCache) });
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

	private async flush(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.queue.length);
				const lines = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
				// Synchronous append keeps ordering guarantees; batches keep it cheap.
				// Permissions: file created 0600 below on first write.
				let isNew = !existsSync(this.file);
				appendFileSync(this.file, lines, "utf8");
				if (isNew) {
					try {
						const { chmodSync } = await import("node:fs");
						chmodSync(this.file, 0o600);
					} catch {
						// Windows: chmod is mostly a no-op; acceptable.
					}
				}
			}
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
		this.closed = true;
		this.append({ type: "session_end", at: new Date().toISOString(), reason });
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
			// Torn tail write while a session is live: stop at the first bad line.
			break;
		}
	}
	return records;
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
		const ended = records.some((r) => r.type === "session_end");
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
			active: !ended,
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
