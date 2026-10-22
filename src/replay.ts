/**
 * Session replay: reconstruct per-LLM-call contexts from pi session JSONL files.
 *
 * Historical sessions predate (or never ran with) the live capture extension,
 * so no sidecar trace or provider payload exists for them. The session file,
 * however, records the full entry tree — replaying it the same way pi's
 * buildContextEntries/buildSessionProjection/buildSessionContext do yields the
 * model-visible context at each assistant message.
 *
 * Capture level is labeled "session_replay" — an honest reconstruction, not a
 * live capture. Provider payloads are NOT recoverable from session files.
 */

import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { makePreview } from "./store.ts";
import { sha256Hex, type AgentMessageRecord, type CompactionRecord, type LlmCall, type ToolCallRecord } from "./types.ts";

export interface SessionFileSummary {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	startedAt: string;
	updatedAt: string;
	/** Approximate call count from the header scan pass; exact after replay. */
	assistantCount: number;
}

export interface ReplayedSession {
	sessionId: string;
	calls: LlmCall[];
	toolCalls: ToolCallRecord[];
	compactions: CompactionRecord[];
}

export function sessionsDir(): string {
	const override = process.env.PI_SESSIONS_DIR;
	return override ?? join(homedir(), ".pi", "agent", "sessions");
}

/** Scan session files; header + quick assistant count without full parse. */
export function listSessionFiles(limit = 200): SessionFileSummary[] {
	const dir = sessionsDir();
	if (!existsSync(dir)) return [];
	const out: SessionFileSummary[] = [];
	for (const sub of readdirSync(dir)) {
		const subPath = join(dir, sub);
		let entries: string[] = [];
		try {
			entries = readdirSync(subPath);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(subPath, name);
			try {
				const stat = statSync(file);
				if (!stat.isFile()) continue;
				const summary = scanHeader(file, stat.mtimeMs);
				if (summary) out.push(summary);
			} catch {
				// unreadable file: skip
			}
		}
	}
	out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return out.slice(0, limit);
}

function scanHeader(file: string, mtimeMs: number): SessionFileSummary | undefined {
	let header: any;
	let assistantCount = 0;
	const text = readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!header && entry.type === "session") header = entry;
		if (entry.type === "message" && entry.message?.role === "assistant") assistantCount++;
	}
	if (!header?.id) return undefined;
	return {
		sessionId: String(header.id),
		sessionFile: file,
		cwd: header.cwd ?? "",
		startedAt: header.timestamp ?? new Date(mtimeMs).toISOString(),
		updatedAt: new Date(mtimeMs).toISOString(),
		assistantCount,
	};
}

// ---------- replay engine ----------

const PROJECT_INSTRUCTIONS_RE = /<project_instructions\s+path="([^"]+)"/g;

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b: any) => {
				if (b?.type === "text") return b.text ?? "";
				if (b?.type === "thinking") return b.thinking ?? "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function provenanceFor(message: any, toolInputs: Map<string, { name: string; input: any }>): AgentMessageRecord["provenance"] {
	switch (message.role) {
		case "system": {
			const sections = message.sections ?? {};
			const paths: string[] = [];
			if (typeof sections.project_context === "string") {
				for (const m of sections.project_context.matchAll(PROJECT_INSTRUCTIONS_RE)) paths.push(m[1]);
			}
			const sectionNames = Object.keys(sections);
			if (paths.length > 0) return { kind: "project_instructions", label: paths.join(", "), paths };
			if (typeof sections.skills === "string" && sections.skills.length > 0) {
				return { kind: "skills", label: `system sections: ${sectionNames.join(", ")}`, sectionNames };
			}
			return { kind: "system_prompt", label: `system sections: ${sectionNames.join(", ")}`, sectionNames };
		}
		case "toolResult": {
			const tc = toolInputs.get(message.toolCallId);
			if (tc) {
				const detail = typeof tc.input?.path === "string" ? tc.input.path : typeof tc.input?.command === "string" ? tc.input.command : "";
				return {
					kind: "tool_result",
					label: detail ? `${tc.name} ${detail}` : tc.name,
					path: typeof tc.input?.path === "string" ? tc.input.path : undefined,
					toolCallId: message.toolCallId,
				};
			}
			return { kind: "tool_result", label: message.toolName ?? "tool result", toolCallId: message.toolCallId };
		}
		case "user":
			return { kind: "user", label: "user message" };
		case "assistant":
			return { kind: "assistant", label: "assistant response" };
		case "compactionSummary":
			return { kind: "compaction_summary", label: "compaction summary" };
		case "custom":
			return { kind: "custom_message", label: `extension: ${message.customType}`, customType: message.customType };
		default:
			return undefined;
	}
}

function toRecord(message: any, toolInputs: Map<string, { name: string; input: any }>): AgentMessageRecord {
	const record: AgentMessageRecord = {
		role: message.role,
		// compactionSummary/branchSummary carry `summary`, not `content`
		content: message.content !== undefined ? message.content : message.summary !== undefined ? message.summary : undefined,
	};
	if (message.role === "system") {
		if (message.sections) record.sections = message.sections;
		if (Array.isArray(message.toolsAdded)) {
			record.toolsAdded = message.toolsAdded.map((t: any) => ({ name: t.name, description: t.description }));
		}
		if (Array.isArray(message.toolsRemoved)) {
			record.toolsRemoved = message.toolsRemoved.map((t: any) => ({ name: t.name }));
		}
	}
	if (message.role === "toolResult") {
		record.toolCallId = message.toolCallId;
		record.toolName = message.toolName;
	}
	if (typeof message.timestamp === "number") record.timestamp = message.timestamp;
	const prov = provenanceFor(message, toolInputs);
	if (prov) record.provenance = prov;
	return record;
}

interface ReplayedCallDraft {
	seq: number;
	assistant: any;
	context: AgentMessageRecord[];
}

/**
 * Replay the active branch of a session file into per-call LLM calls.
 *
 * Semantics follow pi's context building:
 * - branch = walk from the last entry up parentId links to the root
 * - a compaction entry rebuilds context: [checkpoint system message,
 *   compactionSummary, non-system entries from firstKeptEntryId up to the
 *   compaction, then everything after it]
 * - context_edit applies immediately to the target message in the running
 *   context (latest edit on the branch wins)
 * - each assistant message snapshots the context before it as one LLM call
 */
export function replaySessionFile(file: string): ReplayedSession | undefined {
	const entries: any[] = [];
	const byId = new Map<string, any>();
	const text = readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed);
			entries.push(entry);
			if (entry.id) byId.set(entry.id, entry);
		} catch {
			continue; // torn tail line
		}
	}
	const header = entries.find((e) => e.type === "session");
	if (!header?.id) return undefined;

	// Active branch: last entry → root via parentId.
	const branch: any[] = [];
	let cursor = entries[entries.length - 1];
	const seen = new Set<string>();
	while (cursor) {
		if (seen.has(cursor.id ?? "")) break;
		seen.add(cursor.id ?? "");
		branch.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	branch.reverse();

	// Rebuild chronological context, snapshotting before each assistant message.
	const context: AgentMessageRecord[] = [];
	const rawMessages: any[] = []; // parallel raw messages for edit application
	const toolInputs = new Map<string, { name: string; input: any }>();
	const toolResults = new Map<string, any>();
	const calls: ReplayedCallDraft[] = [];
	const compactions: CompactionRecord[] = [];

	/** Apply a compaction entry: rebuild context from its checkpoint. */
	const applyCompaction = (compaction: any) => {
		const keptId = compaction.firstKeptEntryId;
		const keptIndex = branch.findIndex((e) => e.id === keptId);
		// Entries from firstKeptEntryId up to (not including) the compaction.
		const keptRange = keptIndex >= 0 ? branch.slice(keptIndex, branch.indexOf(compaction)) : [];
		const rebuiltRaw: any[] = [];
		if (compaction.systemMessage) rebuiltRaw.push(compaction.systemMessage);
		rebuiltRaw.push({
			role: "compactionSummary",
			summary: compaction.summary,
			tokensBefore: compaction.tokensBefore,
			timestamp: new Date(compaction.timestamp).getTime(),
		});
		for (const e of keptRange) {
			if (e.type === "message" && e.message?.role !== "system") rebuiltRaw.push(e.message);
		}
		// Replace running context; post-compaction entries continue appending.
		rawMessages.length = 0;
		context.length = 0;
		for (const raw of rebuiltRaw) {
			rawMessages.push(raw);
			context.push(toRecord(raw, toolInputs));
		}
	};

	const applyEdit = (edit: any) => {
		const idx = rawMessages.findIndex((m, i) => {
			// Match by toolCallId for tool results, else by identity of raw entry message.
			const marker = rawMarkers.get(i);
			return marker === edit.targetId;
		});
		if (idx === -1) return;
		if (edit.replacement === null) {
			rawMessages.splice(idx, 1);
			context.splice(idx, 1);
			return;
		}
		const raw = rawMessages[idx];
		const replacement = edit.replacement;
		if (typeof replacement === "string") {
			const newRaw = { ...raw, content: [{ type: "text", text: replacement }] };
			rawMessages[idx] = newRaw;
			context[idx] = toRecord(newRaw, toolInputs);
		} else if (replacement && typeof replacement === "object") {
			const newRaw = { ...raw, ...replacement };
			rawMessages[idx] = newRaw;
			context[idx] = toRecord(newRaw, toolInputs);
		}
	};

	// Marker: which session entry (id) each raw message came from, for edits.
	const rawMarkers = new Map<number, string>();
	const pushMessage = (message: any, entryId: string) => {
		rawMarkers.set(rawMessages.length, entryId);
		rawMessages.push(message);
		context.push(toRecord(message, toolInputs));
	};

	let seq = 0;
	for (const entry of branch) {
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "assistant") {
					calls.push({ seq: seq++, assistant: message, context: context.slice() });
					// Record tool calls issued by this assistant message.
					for (const block of message.content ?? []) {
						if (block?.type === "toolCall") {
							toolInputs.set(block.id, { name: block.name, input: block.arguments });
						}
					}
					pushMessage(message, entry.id);
				} else {
					pushMessage(message, entry.id);
					if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
				}
				break;
			}
			case "compaction": {
				compactions.push({
					entryId: entry.id,
					reason: "unknown", // not stored in session entries
					willRetry: false,
					tokensBefore: entry.tokensBefore ?? 0,
					firstKeptEntryId: entry.firstKeptEntryId ?? null,
					isSplitTurn: false, // not stored in session entries
					summarizedRoles: [],
					summary: String(entry.summary ?? ""),
					systemMessageSectionNames: entry.systemMessage?.sections ? Object.keys(entry.systemMessage.sections) : null,
					at: entry.timestamp,
				});
				applyCompaction(entry);
				break;
			}
			case "context_edit":
				applyEdit(entry);
				break;
			case "custom_message":
				pushMessage(
					{
						role: "custom",
						customType: entry.customType,
						content: entry.content,
						display: entry.display,
						timestamp: new Date(entry.timestamp).getTime(),
					},
					entry.id,
				);
				break;
			case "branch_summary":
				pushMessage(
					{
						role: "branchSummary",
						summary: entry.summary,
						fromId: entry.fromId,
						timestamp: new Date(entry.timestamp).getTime(),
					},
					entry.id,
				);
				break;
			default:
				// usage, custom, label, model_change, thinking_level_change, session:
				// not part of the model context.
				break;
		}
	}

	// Tool call records: input from assistant blocks, results from toolResult messages.
	const startedAt = header.timestamp;
	const toolCalls: ToolCallRecord[] = [];
	for (const [id, tc] of toolInputs) {
		const result = toolResults.get(id);
		const text = result ? textOfContent(result.content) : "";
		toolCalls.push({
			toolCallId: id,
			toolName: tc.name,
			input: tc.input,
			startedAt: startedAt,
			endedAt: result ? startedAt : undefined,
			resultPreview: result ? makePreview(text) : undefined,
			isError: result?.isError,
			contentSha256: sha256Hex(text),
			contentLength: text.length,
		});
	}

	const callsOut: LlmCall[] = calls.map((draft) => {
		const a = draft.assistant;
		const call: LlmCall = {
			seq: draft.seq,
			callId: `replay-${header.id}-${draft.seq}`,
			startedAt: a.timestamp ? new Date(a.timestamp).toISOString() : startedAt,
			completedAt: a.timestamp ? new Date(a.timestamp).toISOString() : undefined,
			turnIndex: undefined, // turn indices are not stored per message
			model: a.model ? { provider: a.provider ?? "unknown", id: a.model, api: a.api } : undefined,
			piEstimatedTokens: undefined, // no historical getContextUsage
			providerInputTokens: a.usage?.input,
			providerCacheReadTokens: a.usage?.cacheRead,
			providerCacheWriteTokens: a.usage?.cacheWrite,
			providerOutputTokens: a.usage?.output,
			status: a.stopReason === "error" || a.stopReason === "aborted" ? "error" : "success",
			error: a.stopReason === "error" ? a.errorMessage ?? a.stopReason : undefined,
			piContext: draft.context,
			providerPayloads: [], // payloads are not stored in session files
			toolCallIds: (a.content ?? []).filter((b: any) => b?.type === "toolCall").map((b: any) => b.id),
		};
		return call;
	});

	return { sessionId: String(header.id), calls: callsOut, toolCalls, compactions };
}

// ---------- replay cache ----------

const replayCache = new Map<string, { mtimeMs: number; session: ReplayedSession }>();
const REPLAY_CACHE_LIMIT = 8;

export function replaySessionCached(file: string): ReplayedSession | undefined {
	const stat = statSync(file);
	const cached = replayCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.session;
	const session = replaySessionFile(file);
	if (!session) return undefined;
	if (replayCache.size >= REPLAY_CACHE_LIMIT) {
		const oldest = replayCache.keys().next().value;
		if (oldest) replayCache.delete(oldest);
	}
	replayCache.set(file, { mtimeMs: stat.mtimeMs, session });
	return session;
}
