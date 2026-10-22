/** Sidecar trace record types shared by collector, store, and server. */

export const TRACE_SCHEMA_VERSION = 1;

export type CaptureLevel = "pi_context" | "provider_payload";

export interface TraceModel {
	provider: string;
	id: string;
	api?: string;
}

export interface ToolCallRecord {
	toolCallId: string;
	toolName: string;
	input: unknown;
	startedAt: string;
	endedAt?: string;
	/** Short excerpt of the result content, for timeline display. */
	resultPreview?: string;
	isError?: boolean;
	contentSha256?: string;
	contentLength?: number;
}

export interface CompactionRecord {
	entryId: string;
	reason: string;
	willRetry: boolean;
	tokensBefore: number;
	firstKeptEntryId: string | null;
	isSplitTurn: boolean;
	/** Roles of the messages that were summarized, e.g. ["user"]. */
	summarizedRoles: string[];
	summary: string;
	systemMessageSectionNames: string[] | null;
	at: string;
}

export interface LlmCall {
	/** Sequential index of this LLM call within the session (0-based). */
	seq: number;
	callId: string;
	startedAt: string;
	completedAt?: string;
	error?: string;
	turnIndex?: number;
	model?: TraceModel;
	/** Estimated tokens via pi's own meter, captured at request time. */
	piEstimatedTokens?: number;
	providerInputTokens?: number;
	providerCacheReadTokens?: number;
	providerCacheWriteTokens?: number;
	providerOutputTokens?: number;
	status: "running" | "success" | "error";
	/** Full pi-internal context: system messages with sections + all agent messages. */
	piContext: AgentMessageRecord[];
	/** Final provider request payload, keyed by attempt. */
	providerPayloads: Array<{ attempt: number; at: string; payload: unknown }>;
	/** Tool calls issued by the assistant response of this call. */
	toolCallIds: string[];
}

export interface AgentMessageRecord {
	role: string;
	/** Message content normalized to a JSON-safe value (string or block array). */
	content: unknown;
	/** For system messages: named prompt sections, when present. */
	sections?: Record<string, string | null>;
	/** For system messages: tool definitions added/removed by this patch. */
	toolsAdded?: Array<{ name: string; description?: string }>;
	toolsRemoved?: Array<{ name: string }>;
	/** For toolResult messages. */
	toolCallId?: string;
	toolName?: string;
	/** For assistant messages. */
	timestamp?: number;
	/** Provenance assigned by the collector. */
	provenance?: Provenance;
}

export type ProvenanceKind =
	| "system_prompt"
	| "project_instructions"
	| "skills"
	| "tool_result"
	| "user"
	| "assistant"
	| "compaction_summary"
	| "custom_message"
	| "unknown";

export interface Provenance {
	kind: ProvenanceKind;
	/** Human-readable source label, e.g. "read /path/to/file" or "AGENTS.md". */
	label: string;
	/** File path when the source is a file or file-reading tool. */
	path?: string;
	/** Tool call id when the block originates from a tool result. */
	toolCallId?: string;
	/** Names of AGENTS.md-style files parsed out of the project_context section. */
	paths?: string[];
	/** Section names when the block is a system prompt section patch. */
	sectionNames?: string[];
	/** Custom message type when injected by an extension. */
	customType?: string;
}

export type TraceRecord =
	| { type: "trace_header"; sessionId: string; sessionFile?: string; cwd: string; startedAt: string; schemaVersion: number; parentSessionId?: string; isSubagent?: boolean }
	| { type: "session_start"; at: string; reason: string; sessionId: string; sessionFile?: string; cwd: string; model?: TraceModel }
	| { type: "llm_call"; at: string; call: LlmCall }
	| { type: "tool_call_started"; at: string; call: ToolCallRecord }
	| { type: "tool_call_finished"; at: string; toolCallId: string; endedAt: string; isError: boolean; contentSha256: string; contentLength: number; resultPreview: string }
	| { type: "compaction"; at: string; compaction: CompactionRecord }
	| { type: "session_end"; at: string; reason: string };

export interface SessionSummary {
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	startedAt: string;
	updatedAt: string;
	callCount: number;
	lastModel?: TraceModel;
	parentSessionId?: string;
	isSubagent?: boolean;
	/** Set while the extension process holding this session is still running. */
	active?: boolean;
}

export function sha256Hex(data: string): string {
	// Filled by store.ts at runtime (avoids importing node:crypto in type-only module consumers).
	return _sha256Impl?.(data) ?? "";
}

let _sha256Impl: ((data: string) => string) | undefined;
export function setSha256Impl(impl: (data: string) => string): void {
	_sha256Impl = impl;
}
