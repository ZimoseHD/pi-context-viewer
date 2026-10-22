/**
 * Context diff engine: compares two LLM calls' pi-internal contexts.
 *
 * Alignment is structural, not positional:
 * - toolResult messages align by toolCallId (stable across calls)
 * - user/assistant/custom messages align by content hash + timestamp
 * - system messages align by order and section keys (first = full loadout,
 *   later = patches)
 * - a compactionSummary message marks a compaction boundary: everything
 *   before it that disappeared is reported as "summarized", not "deleted"
 */

import type { AgentMessageRecord, LlmCall } from "./types.ts";

export type DiffOp =
	| { op: "same"; message: AgentMessageRecord; indexA?: number; indexB?: number }
	| { op: "added"; message: AgentMessageRecord; indexB: number }
	| { op: "removed"; message: AgentMessageRecord; indexA: number }
	| { op: "changed"; before: AgentMessageRecord; after: AgentMessageRecord; indexA: number; indexB: number; textDiff?: LineDiff[] }
	| { op: "summarized"; message: AgentMessageRecord; indexA: number };

export interface LineDiff {
	type: "add" | "remove" | "same";
	text: string;
	aLine?: number;
	bLine?: number;
}

export interface MessageDiff {
	ops: DiffOp[];
	stats: {
		added: number;
		removed: number;
		changed: number;
		summarized: number;
		same: number;
	};
	/** True when call B begins a compaction boundary (first call after a compaction). */
	compactionBoundary: boolean;
	/** System section changes between the two calls. */
	sectionChanges: Array<{ name: string; change: "added" | "removed" | "changed" }>;
	/** Tool loadout changes between the two calls. */
	toolChanges: { added: string[]; removed: string[] };
}

function messageKey(m: AgentMessageRecord): string {
	if (m.role === "toolResult" && m.toolCallId) return `tr:${m.toolCallId}`;
	if (m.role === "system") return "system"; // aligned separately by order
	if (typeof m.timestamp === "number") return `${m.role}:${m.timestamp}`;
	return `${m.role}:${hash(JSON.stringify(m.content ?? ""))}`;
}

function hash(text: string): string {
	// FNV-1a 32-bit; sufficient for change detection in-memory.
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b: any) => {
				if (b?.type === "text") return b.text ?? "";
				if (b?.type === "thinking") return b.thinking ?? "";
				if (b?.type === "toolCall") return `${b.name}(${JSON.stringify(b.arguments)})`;
				if (b?.type === "image") return `[image ${b.mimeType ?? ""}]`;
				return "";
			})
			.join("\n");
	}
	return "";
}

/** Myers-ish line diff via LCS on lines (zero-dependency, adequate sizes). */
export function lineDiff(aText: string, bText: string): LineDiff[] {
	const a = aText.split("\n");
	const b = bText.split("\n");
	const n = a.length;
	const m = b.length;
	// Guard against pathological sizes: cap at 4000 lines each side.
	if (n * m > 16_000_000) {
		return [
			{ type: "remove", text: aText.slice(0, 2000), aLine: 1 },
			{ type: "add", text: bText.slice(0, 2000), bLine: 1 },
		];
	}
	// LCS table
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops: LineDiff[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: "same", text: a[i], aLine: i + 1, bLine: j + 1 });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "remove", text: a[i], aLine: i + 1 });
			i++;
		} else {
			ops.push({ type: "add", text: b[j], bLine: j + 1 });
			j++;
		}
	}
	while (i < n) ops.push({ type: "remove", text: a[i], aLine: ++i });
	while (j < m) ops.push({ type: "add", text: b[j], bLine: ++j });
	return ops;
}

/** Collapse long runs of same lines into context windows. */
export function collapseSame(ops: LineDiff[], contextLines = 3): Array<LineDiff | { type: "skip"; count: number }> {
	const out: Array<LineDiff | { type: "skip"; count: number }> = [];
	let run: LineDiff[] = [];
	const flush = () => {
		if (run.length === 0) return;
		if (run.length <= contextLines * 2) {
			out.push(...run);
		} else {
			out.push(...run.slice(0, contextLines));
			out.push({ type: "skip", count: run.length - contextLines * 2 });
			out.push(...run.slice(-contextLines));
		}
		run = [];
	};
	for (const op of ops) {
		if (op.type === "same") run.push(op);
		else {
			flush();
			out.push(op);
		}
	}
	flush();
	return out;
}

function sectionMap(messages: AgentMessageRecord[]): Map<string, string> {
	// Replay system messages in order: first declares all sections, later patch.
	const map = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "system" || !m.sections) continue;
		for (const [name, value] of Object.entries(m.sections)) {
			if (value === null) map.delete(name);
			else map.set(name, value);
		}
	}
	return map;
}

function toolSet(messages: AgentMessageRecord[]): Set<string> {
	const set = new Set<string>();
	for (const m of messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) set.add(t.name);
		for (const t of m.toolsRemoved ?? []) set.delete(t.name);
	}
	return set;
}

export function diffCalls(a: LlmCall | undefined, b: LlmCall): MessageDiff {
	const ops: DiffOp[] = [];
	const aMessages = a?.piContext ?? [];
	const bMessages = b.piContext;

	const bHasCompaction = bMessages.some((m) => m.role === "compactionSummary");
	const compactionBoundary = Boolean(a) && bHasCompaction && !(a?.piContext ?? []).some((m) => m.role === "compactionSummary");

	// Index A by stable key; keep duplicates possible per key rare.
	const aIndex = new Map<string, number[]>();
	aMessages.forEach((m, i) => {
		const key = messageKey(m);
		const arr = aIndex.get(key) ?? [];
		arr.push(i);
		aIndex.set(key, arr);
	});
	const consumedA = new Set<number>();

	// First pass: aligned and added messages in B order.
	const bAligned: Array<{ b: number; a?: number }> = [];
	bMessages.forEach((m, j) => {
		const key = messageKey(m);
		const candidates = aIndex.get(key);
		const aPos = candidates?.find((i) => !consumedA.has(i));
		if (aPos !== undefined) {
			consumedA.add(aPos);
			bAligned.push({ b: j, a: aPos });
		} else {
			bAligned.push({ b: j });
		}
	});

	// Removed A messages (not consumed), sorted by position.
	const removed = aMessages
		.map((_, i) => i)
		.filter((i) => !consumedA.has(i));

	// Merge into a single op list, in B order, with removals placed by position.
	const removedQueue = [...removed].sort((x, y) => x - y);
	let merged: DiffOp[] = [];
	let lastA = -1;
	for (const { b: j, a: i } of bAligned) {
		// Flush removals that occurred before this aligned position in A.
		while (removedQueue.length > 0 && (i === undefined || removedQueue[0] < i)) {
			const r = removedQueue.shift()!;
			merged.push(removalOp(aMessages[r], r, compactionBoundary));
			lastA = r;
		}
		if (i === undefined) {
			merged.push({ op: "added", message: bMessages[j], indexB: j });
		} else {
			const before = aMessages[i];
			const after = bMessages[j];
			if (messagesEqual(before, after)) {
				merged.push({ op: "same", message: after, indexA: i, indexB: j });
			} else {
				merged.push({
					op: "changed",
					before,
					after,
					indexA: i,
					indexB: j,
					textDiff: lineDiff(describeMessage(before), describeMessage(after)),
				});
			}
			lastA = i;
		}
	}
	while (removedQueue.length > 0) {
		const r = removedQueue.shift()!;
		merged.push(removalOp(aMessages[r], r, compactionBoundary));
	}
	ops.push(...merged);

	// Section changes (system prompt evolution).
	const sectionsA = a ? sectionMap(aMessages) : new Map<string, string>();
	const sectionsB = sectionMap(bMessages);
	const sectionChanges: MessageDiff["sectionChanges"] = [];
	const names = new Set([...sectionsA.keys(), ...sectionsB.keys()]);
	for (const name of names) {
		const va = sectionsA.get(name);
		const vb = sectionsB.get(name);
		if (va === undefined && vb !== undefined) sectionChanges.push({ name, change: "added" });
		else if (va !== undefined && vb === undefined) sectionChanges.push({ name, change: "removed" });
		else if (va !== vb) sectionChanges.push({ name, change: "changed" });
	}

	// Tool loadout changes.
	const toolsA = a ? toolSet(aMessages) : new Set<string>();
	const toolsB = toolSet(bMessages);
	const toolChanges = {
		added: [...toolsB].filter((t) => !toolsA.has(t)),
		removed: [...toolsA].filter((t) => !toolsB.has(t)),
	};

	const stats = {
		added: ops.filter((o) => o.op === "added").length,
		removed: ops.filter((o) => o.op === "removed").length,
		changed: ops.filter((o) => o.op === "changed").length,
		summarized: ops.filter((o) => o.op === "summarized").length,
		same: ops.filter((o) => o.op === "same").length,
	};

	return { ops, stats, compactionBoundary, sectionChanges, toolChanges };
}

function removalOp(message: AgentMessageRecord, indexA: number, compactionBoundary: boolean): DiffOp {
	if (compactionBoundary) {
		// Messages that vanished across a compaction boundary were summarized,
		// not deleted — report them as such.
		return { op: "summarized", message, indexA };
	}
	return { op: "removed", message, indexA };
}

function messagesEqual(a: AgentMessageRecord, b: AgentMessageRecord): boolean {
	if (a.role !== b.role) return false;
	const ca = JSON.stringify(a.content ?? null);
	const cb = JSON.stringify(b.content ?? null);
	if (ca !== cb) return false;
	if (a.role === "system") {
		const sa = JSON.stringify(a.sections ?? null);
		const sb = JSON.stringify(b.sections ?? null);
		const ta = JSON.stringify(a.toolsAdded ?? null);
		const tb = JSON.stringify(b.toolsAdded ?? null);
		return sa === sb && ta === tb;
	}
	return true;
}

/** One-line description used for changed-message text diffs. */
export function describeMessage(m: AgentMessageRecord): string {
	if (m.role === "system") {
		const parts: string[] = [];
		for (const [name, value] of Object.entries(m.sections ?? {})) {
			parts.push(`### section: ${name}\n${value ?? "(removed)"}`);
		}
		for (const t of m.toolsAdded ?? []) parts.push(`### tool added: ${t.name}\n${t.description ?? ""}`);
		for (const t of m.toolsRemoved ?? []) parts.push(`### tool removed: ${t.name}`);
		return parts.join("\n\n");
	}
	return contentText(m.content);
}

/** Approximate token count (chars/4), labeled as an estimate in the UI. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
