/**
 * Event collector: turns pi extension events into ordered trace records with
 * provenance. One collector per session runtime.
 *
 * Event order (verified against pi 1.4.0):
 *   session_start
 *   [before_agent_start]
 *   per turn: turn_start -> context_with_system -> before_provider_request
 *             -> message_end(assistant) -> tool_call/tool_result... -> turn_end
 *   session_before_compact -> session_compact (outside the turn flow)
 *   session_shutdown
 */

import { randomUUID } from "node:crypto";
import type {
	AfterProviderResponseEvent,
	BeforeProviderRequestEvent,
	ContextWithSystemEvent,
	ExtensionContext,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { makePreview, TraceStore } from "./store.ts";
import { sha256Hex, type AgentMessageRecord, type CompactionRecord, type LlmCall, type Provenance, type ToolCallRecord } from "./types.ts";

/** Matches <project_instructions path="..."> inside the project_context section. */
const PROJECT_INSTRUCTIONS_RE = /<project_instructions\s+path="([^"]+)"/g;

function nowIso(): string {
	return new Date().toISOString();
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block: any) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text" && typeof block.text === "string") return block.text;
				if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function toolResultText(event: ToolResultEvent): string {
	return textOfContent((event as any).content);
}

/** Provenance for a single message in the captured context. */
function provenanceFor(message: any, toolCalls: Map<string, ToolCallRecord>): Provenance | undefined {
	switch (message.role) {
		case "system": {
			const sections = message.sections ?? {};
			const paths: string[] = [];
			const sectionNames = Object.keys(sections);
			if (typeof sections.project_context === "string") {
				for (const m of sections.project_context.matchAll(PROJECT_INSTRUCTIONS_RE)) paths.push(m[1]);
			}
			if (paths.length > 0) {
				return { kind: "project_instructions", label: paths.join(", "), paths };
			}
			const hasSkills = typeof sections.skills === "string" && sections.skills.length > 0;
			if (hasSkills) {
				return { kind: "skills", label: `system sections: ${sectionNames.join(", ")}`, sectionNames };
			}
			return { kind: "system_prompt", label: `system sections: ${sectionNames.join(", ")}`, sectionNames };
		}
		case "toolResult": {
			const tc = toolCalls.get(message.toolCallId);
			if (tc) {
				const input = tc.input as any;
				const detail =
					typeof input?.path === "string" ? input.path : typeof input?.command === "string" ? input.command : "";
				return {
					kind: "tool_result",
					label: detail ? `${tc.toolName} ${detail}` : tc.toolName,
					path: typeof input?.path === "string" ? input.path : undefined,
					toolCallId: tc.toolCallId,
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

function toAgentMessageRecord(message: any, toolCalls: Map<string, ToolCallRecord>): AgentMessageRecord {
	const record: AgentMessageRecord = { role: message.role, content: message.content };
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
	const provenance = provenanceFor(message, toolCalls);
	if (provenance) record.provenance = provenance;
	return record;
}

export class Collector {
	private store: TraceStore;
	private activeCall: LlmCall | undefined;
	private seq = 0;
	private turnIndex: number | undefined;
	private toolCalls = new Map<string, ToolCallRecord>();
	/** toolCallIds produced by the assistant message of the active call. */
	private activeCallToolCalls: string[] = [];
	private onEvent?: () => void;

	constructor(store: TraceStore, onEvent?: () => void, startSeq = -1) {
		this.store = store;
		this.onEvent = onEvent;
		this.seq = startSeq + 1;
	}

	private emit(): void {
		this.onEvent?.();
	}

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.store.append({
			type: "session_start",
			at: nowIso(),
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			cwd: ctx.cwd,
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: (ctx.model as any).api } : undefined,
		});
		this.emit();
	}

	onTurnStart(event: TurnStartEvent, ctx: ExtensionContext): void {
		this.turnIndex = event.turnIndex;
		// A new turn invalidates any unfinished call (e.g. aborted mid-stream).
		if (this.activeCall && this.activeCall.status === "running") {
			this.activeCall.status = "error";
			this.activeCall.error = "superseded by next turn";
			this.activeCall.completedAt = nowIso();
			this.store.append({ type: "llm_call", at: nowIso(), call: this.activeCall });
			this.activeCall = undefined;
		}
		this.emit();
	}

	/** Full pi-internal context snapshot (system messages included). */
	onContextWithSystem(event: ContextWithSystemEvent, ctx: ExtensionContext): void {
		if (this.activeCall) {
			// Should not happen (turn_start resets), but keep traces honest.
			this.activeCall.status = "error";
			this.activeCall.error = "superseded by next context";
			this.store.append({ type: "llm_call", at: nowIso(), call: this.activeCall });
		}
		const call: LlmCall = {
			seq: this.seq++,
			callId: randomUUID(),
			startedAt: nowIso(),
			status: "running",
			turnIndex: this.turnIndex,
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: (ctx.model as any).api } : undefined,
			piEstimatedTokens: ctx.getContextUsage()?.tokens ?? undefined,
			piContext: (event.messages as any[]).map((m) => toAgentMessageRecord(m, this.toolCalls)),
			providerPayloads: [],
			toolCallIds: [],
		};
		this.activeCall = call;
		this.activeCallToolCalls = [];
		// The llm_call record is appended when the call completes (message_end),
		// so provider payloads and tool calls land on the same record.
		this.emit();
	}

	onBeforeProviderRequest(event: BeforeProviderRequestEvent): void {
		const call = this.activeCall;
		if (!call) return; // e.g. compaction summarization call bypasses agent hooks
		call.providerPayloads.push({
			attempt: call.providerPayloads.length + 1,
			at: nowIso(),
			payload: structuredClone(event.payload),
		});
		this.emit();
	}

	onAfterProviderResponse(): void {
		this.emit();
	}

	onMessageEnd(event: MessageEndEvent): void {
		const message = event.message as any;
		if (message.role !== "assistant" || !this.activeCall) return;
		const call = this.activeCall;
		if (message.usage) {
			call.providerInputTokens = message.usage.input;
			call.providerCacheReadTokens = message.usage.cacheRead;
			call.providerCacheWriteTokens = message.usage.cacheWrite;
			call.providerOutputTokens = message.usage.output;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			call.status = "error";
			call.error = message.errorMessage ?? message.stopReason;
		} else {
			call.status = "success";
		}
		call.completedAt = nowIso();
		// Collect tool calls issued by this assistant message.
		for (const block of message.content ?? []) {
			if (block?.type === "toolCall") this.activeCallToolCalls.push(block.id);
		}
		call.toolCallIds = [...this.activeCallToolCalls];
		this.store.append({ type: "llm_call", at: nowIso(), call });
		this.activeCall = undefined;
		this.emit();
	}

	onToolCall(event: ToolCallEvent, at = nowIso()): void {
		const record: ToolCallRecord = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: structuredClone((event as any).input ?? {}),
			startedAt: at,
		};
		this.toolCalls.set(record.toolCallId, record);
		this.store.append({ type: "tool_call_started", at, call: record });
		this.emit();
	}

	onToolResult(event: ToolResultEvent): void {
		const text = toolResultText(event);
		const contentLength = text.length;
		const finished = {
			type: "tool_call_finished" as const,
			at: nowIso(),
			toolCallId: event.toolCallId,
			endedAt: nowIso(),
			isError: Boolean((event as any).isError),
			contentSha256: sha256Hex(text),
			contentLength,
			resultPreview: makePreview(text),
		};
		const known = this.toolCalls.get(event.toolCallId);
		if (known) {
			known.isError = finished.isError;
			known.contentSha256 = finished.contentSha256;
			known.contentLength = finished.contentLength;
			known.resultPreview = finished.resultPreview;
			known.endedAt = finished.endedAt;
		}
		this.store.append(finished);
		this.emit();
	}

	onTurnEnd(event: TurnEndEvent): void {
		// Turn ended; if the assistant response never completed (aborted run),
		// close out the call so the timeline stays honest.
		if (this.activeCall && this.activeCall.status === "running") {
			this.activeCall.status = "error";
			this.activeCall.error = "turn ended without assistant response";
			this.activeCall.completedAt = nowIso();
			this.store.append({ type: "llm_call", at: nowIso(), call: this.activeCall });
			this.activeCall = undefined;
		}
		this.emit();
	}

	onBeforeCompact(event: SessionBeforeCompactEvent): void {
		// preparation data is captured; the summarization LLM call itself is not
		// observable through agent hooks (documented limitation).
		this.pendingCompact = {
			entryId: "",
			reason: event.reason,
			willRetry: event.willRetry,
			tokensBefore: (event.preparation as any).tokensBefore,
			firstKeptEntryId: (event.preparation as any).firstKeptEntryId ?? null,
			isSplitTurn: Boolean((event.preparation as any).isSplitTurn),
			summarizedRoles: ((event.preparation as any).messagesToSummarize ?? []).map((m: any) => m.role),
			summary: "",
			systemMessageSectionNames: null,
			at: nowIso(),
		};
		this.emit();
	}

	private pendingCompact: CompactionRecord | undefined;

	onCompact(event: SessionCompactEvent): void {
		const entry = event.compactionEntry as any;
		const record: CompactionRecord = {
			entryId: entry.id,
			reason: this.pendingCompact?.reason ?? event.reason,
			willRetry: this.pendingCompact?.willRetry ?? event.willRetry,
			tokensBefore: this.pendingCompact?.tokensBefore ?? entry.tokensBefore,
			firstKeptEntryId: entry.firstKeptEntryId,
			isSplitTurn: this.pendingCompact?.isSplitTurn ?? false,
			summarizedRoles: this.pendingCompact?.summarizedRoles ?? [],
			summary: String(entry.summary ?? ""),
			systemMessageSectionNames: entry.systemMessage?.sections ? Object.keys(entry.systemMessage.sections) : null,
			at: nowIso(),
		};
		this.pendingCompact = undefined;
		this.store.append({ type: "compaction", at: nowIso(), compaction: record });
		this.emit();
	}

	onCompactFailed(): void {
		this.pendingCompact = undefined;
		this.emit();
	}

	onShutdown(reason: string): void {
		if (this.activeCall) {
			this.activeCall.status = "error";
			this.activeCall.error = `session shutdown (${reason})`;
			this.activeCall.completedAt = nowIso();
			this.store.append({ type: "llm_call", at: nowIso(), call: this.activeCall });
			this.activeCall = undefined;
		}
		this.store.close(reason);
		this.emit();
	}
}
