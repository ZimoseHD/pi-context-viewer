/* Pi Context Explorer — frontend app (no build step, no dependencies). */
"use strict";

const state = {
	sessions: [],
	sessionId: null,
	sessionData: null, // { calls, toolCalls, compactions }
	selectedSeq: null,
	mode: "view", // view | diff | payload
	diffA: null,
	diffB: null,
	expanded: new Set(), // message keys expanded in viewer
	search: "",
	sse: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------- utilities ----------

async function api(path) {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json();
}

function fmtTokens(n) {
	if (n == null) return "—";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function fmtTime(iso) {
	if (!iso) return "";
	try {
		return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	} catch {
		return iso;
	}
}

function esc(text) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function highlight(text, query) {
	if (!query) return esc(text);
	const safe = esc(text);
	// Highlight on escaped text, matching escaped query.
	const q = esc(query);
	const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (b?.type === "text") return b.text ?? "";
				if (b?.type === "thinking") return b.thinking ?? "";
				if (b?.type === "toolCall") return `${b.name}(${JSON.stringify(b.arguments)})`;
				if (b?.type === "image") return `[image ${b.mimeType ?? ""}]`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function messageLabel(m) {
	if (m.role === "system") {
		const names = m.sections ? Object.keys(m.sections) : [];
		const tools = m.toolsAdded?.length ? ` +${m.toolsAdded.length} tools` : "";
		return `system: ${names.join(", ") || "prompt"}${tools}`;
	}
	if (m.role === "toolResult") {
		return m.provenance?.label || `${m.toolName ?? "tool"} #${m.toolCallId?.slice(-6)}`;
	}
	if (m.role === "compactionSummary") return "compaction summary";
	if (m.role === "custom") return `${m.provenance?.label ?? "custom message"}`;
	const text = contentText(m.content).replace(/\s+/g, " ").trim();
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function estimateTokensOfText(text) {
	return Math.ceil(text.length / 4);
}

// ---------- sessions sidebar ----------

async function loadSessions() {
	state.sessions = await api("/api/sessions");
	renderSessions();
}

function renderSessions() {
	const list = $("#session-list");
	if (state.sessions.length === 0) {
		list.innerHTML = `<div class="empty">暂无 trace。<br>在 pi 中运行任务即可开始捕获。</div>`;
		return;
	}
	list.innerHTML = "";
	for (const s of state.sessions) {
		const el = document.createElement("div");
		el.className = `session-item${s.sessionId === state.sessionId ? " active" : ""}`;
		const tags = [
			s.active ? `<span class="tag active">live</span>` : "",
			s.isSubagent ? `<span class="tag subagent">subagent</span>` : "",
		].join("");
		const shortId = s.sessionId.slice(0, 8);
		const modelName = s.lastModel ? s.lastModel.id.split("/").pop() : "";
		el.innerHTML = `
			<div class="sid">${shortId}${tags}</div>
			<div class="meta">${esc(s.cwd.split("/").pop() || s.cwd)} · ${s.callCount} calls · ${esc(modelName)}</div>
			<div class="meta">${fmtTime(s.updatedAt)}</div>`;
		el.onclick = () => selectSession(s.sessionId);
		list.appendChild(el);
	}
}

// ---------- session + timeline ----------

async function selectSession(sessionId) {
	if (state.sse) {
		state.sse.close();
		state.sse = null;
	}
	state.sessionId = sessionId;
	state.selectedSeq = null;
	state.diffA = null;
	state.diffB = null;
	await loadSession();
	renderSessions();
	subscribeEvents();
}

async function loadSession() {
	const data = await api(`/api/sessions/${state.sessionId}`);
	state.sessionData = data;
	renderTimeline();
	renderSessionMeta();
	if (state.selectedSeq == null) {
		const last = data.calls[data.calls.length - 1];
		if (last) selectCall(last.seq, { keepDiff: true });
	} else {
		selectCall(state.selectedSeq, { keepDiff: true });
	}
}

function renderSessionMeta() {
	const meta = $("#session-meta");
	if (!state.sessionData) {
		meta.innerHTML = "";
		return;
	}
}

function renderTimeline() {
	const timeline = $("#timeline");
	timeline.innerHTML = "";
	if (!state.sessionData) return;

	// Compose a merged chronological list: llm calls + compaction markers.
	// Compaction records don't carry a seq; place them before the first call
	// that follows (approximation: after the call whose completion precedes it).
	const items = [];
	for (const call of state.sessionData.calls) {
		items.push({ kind: "call", call });
	}
	for (const comp of state.sessionData.compactions) {
		items.push({ kind: "compaction", comp });
	}
	// Sort by time: compaction `at`, call `startedAt`.
	items.sort((a, b) => {
		const ta = a.kind === "call" ? a.call.startedAt : a.comp.at;
		const tb = b.kind === "call" ? b.call.startedAt : b.comp.at;
		return ta < tb ? -1 : ta > tb ? 1 : 0;
	});

	for (const item of items) {
		if (item.kind === "compaction") {
			const el = document.createElement("div");
			el.className = "timeline-marker";
			el.textContent = `✂ compaction (${item.comp.reason}) · ${item.comp.tokensBefore} tokens 前`;
			el.title = item.comp.summary;
			timeline.appendChild(el);
			continue;
		}
		const call = item.call;
		const el = document.createElement("div");
		el.className = `timeline-item${call.seq === state.selectedSeq ? " selected" : ""}`;
		const model = call.model?.id.split("/").pop() ?? "?";
		const tools = call.toolCallIds
			.map((id) => state.sessionData.toolCalls.find((t) => t.toolCallId === id)?.toolName ?? id)
			.join(" ");
		const usage =
			call.providerInputTokens != null
				? `in ${fmtTokens(call.providerInputTokens + (call.providerCacheReadTokens ?? 0) + (call.providerCacheWriteTokens ?? 0))}`
				: call.piEstimatedTokens != null
					? `est ${fmtTokens(call.piEstimatedTokens)}`
					: "";
		el.innerHTML = `
			<div class="seq">#${call.seq}</div>
			<div class="body">
				<div class="line1">
					<span class="status-dot ${call.status}"></span>
					<span class="model">${esc(model)}</span>
					<span class="turn">turn ${call.turnIndex ?? "—"}</span>
					<span class="tokens">${usage}</span>
				</div>
				<div class="tools">${esc(tools)}</div>
			</div>`;
		el.onclick = () => selectCall(call.seq);
		timeline.appendChild(el);
	}
}

function selectCall(seq, opts = {}) {
	state.selectedSeq = seq;
	if (state.mode === "diff") {
		if (!opts.keepDiff || state.diffB == null) {
			state.diffB = seq;
			state.diffA = Math.max(0, seq - 1);
		}
	}
	renderTimeline();
	renderViewer();
	// detail pane is filled by renderViewer
}

// ---------- viewer: context mode ----------

async function renderViewer() {
	const viewer = $("#viewer");
	const mode = state.mode;
	$("#diff-controls").classList.toggle("hidden", mode !== "diff");

	if (!state.sessionData) {
		viewer.innerHTML = `<div class="empty">选择左侧任意一个会话。</div>`;
		$("#detail").innerHTML = "";
		return;
	}
	if (state.selectedSeq == null && mode !== "tokens" && mode !== "insights") {
		viewer.innerHTML = `<div class="empty">选择左侧任意一次 LLM 调用。</div>`;
		$("#detail").innerHTML = "";
		return;
	}

	if (mode === "view") await renderContextMode(viewer);
	else if (mode === "diff") await renderDiffMode(viewer);
	else if (mode === "payload") await renderPayloadMode(viewer);
	else if (mode === "tokens") await renderTokensMode(viewer);
	else await renderInsightsMode(viewer);
}

async function renderContextMode(viewer) {
	const call = await api(`/api/sessions/${state.sessionId}/calls/${state.selectedSeq}`);
	viewer.innerHTML = "";
	let idx = 0;
	for (const m of call.piContext) {
		viewer.appendChild(renderMessage(m, idx++));
	}
	renderDetailForCall(call, null);
}

function messageKey(m, idx) {
	return `${m.role}:${m.toolCallId ?? ""}:${m.timestamp ?? ""}:${idx}`;
}

function renderMessage(m, idx, opts = {}) {
	const el = document.createElement("div");
	el.className = `msg role-${m.role}`;
	const key = opts.key ?? messageKey(m, idx);
	const expanded = state.expanded.has(key);

	const head = document.createElement("div");
	head.className = "msg-head";
	const prov = m.provenance;
	const provChip = prov
		? `<span class="prov-chip" data-kind="${prov.kind}" title="${esc(prov.label)}">${esc(prov.kind)}</span>`
		: "";
	head.innerHTML = `
		<span class="role-badge">${esc(m.role)}</span>
		<span class="msg-label">${esc(messageLabel(m))}</span>
		${provChip}
		<span class="caret">${expanded ? "▾" : "▸"}</span>`;
	head.onclick = () => {
		if (state.expanded.has(key)) state.expanded.delete(key);
		else state.expanded.add(key);
		renderViewer();
	};
	el.appendChild(head);

	if (expanded) {
		const body = document.createElement("div");
		body.className = "msg-body";
		if (m.role === "system" && m.sections) {
			for (const [name, value] of Object.entries(m.sections)) {
				const sec = document.createElement("div");
				sec.className = "msg-section";
				sec.innerHTML = `<div class="msg-section-title">${esc(name)}</div>`;
				const pre = document.createElement("pre");
				pre.innerHTML = highlight(value ?? "(removed)", state.search);
				sec.appendChild(pre);
				body.appendChild(sec);
			}
			if (m.toolsAdded?.length) {
				const sec = document.createElement("div");
				sec.className = "msg-section";
				sec.innerHTML = `<div class="msg-section-title">tools added (${m.toolsAdded.length})</div>`;
				const pre = document.createElement("pre");
				pre.innerHTML = m.toolsAdded
					.map((t) => highlight(`${t.name}: ${t.description ?? ""}`, state.search))
					.join("\n\n");
				sec.appendChild(pre);
				body.appendChild(sec);
			}
			if (m.toolsRemoved?.length) {
				const sec = document.createElement("div");
				sec.className = "msg-section";
				sec.innerHTML = `<div class="msg-section-title">tools removed</div><pre>${esc(m.toolsRemoved.map((t) => t.name).join(", "))}</pre>`;
				body.appendChild(sec);
			}
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			const pre = document.createElement("pre");
			pre.innerHTML = highlight(contentText(m.content), state.search);
			body.appendChild(pre);
		} else {
			const pre = document.createElement("pre");
			pre.innerHTML = highlight(contentText(m.content), state.search);
			body.appendChild(pre);
		}
		el.appendChild(body);
	}
	return el;
}

const DISPLAY_CAP = 100_000;

/** Cap huge text for smooth rendering; full text stays available via the API. */
function renderCappedText(text) {
	if (text.length <= DISPLAY_CAP) return highlight(text, state.search);
	return highlight(text.slice(0, DISPLAY_CAP), state.search) +
		`\n… [已截断显示前 ${DISPLAY_CAP} 字符 / 共 ${text.length} 字符，完整内容通过 API 可取]`;
}

// ---------- viewer: tokens mode ----------

async function renderTokensMode(viewer) {
	const t = await api(`/api/sessions/${state.sessionId}/tokens`);
	viewer.innerHTML = "";
	const wrap = document.createElement("div");
	wrap.className = "tokens-wrap";
	const note = document.createElement("div");
	note.className = "detail-note";
	note.innerHTML = `按角色/来源的估算值 = 字符数/4（标 ≈）；provider 数值为真实 usage。估算仅用于构成比例参考。`;
	wrap.appendChild(note);

	const table = document.createElement("table");
	table.className = "tokens-table";
	table.innerHTML = `
		<thead><tr><th>#</th><th>provider input</th><th>output</th><th>pi 估算</th><th>角色构成（估算）</th></tr></thead>
		<tbody>${t.perCall.map((c) => `
			<tr class="tokens-row" data-seq="${c.seq}">
				<td>#${c.seq}</td>
				<td>${c.providerInput ?? "—"}</td>
				<td>${c.providerOutput ?? "—"}</td>
				<td class="estimate">${c.piEstimate ?? "—"}</td>
				<td>${c.byRole.map((r) => `${esc(r.role)} ${fmtTokens(r.estimate)}≈`).join(" · ")}</td>
			</tr>`).join("")}
		</tbody>`;
	wrap.appendChild(table);

	const totals = document.createElement("div");
	totals.className = "tokens-totals";
	totals.innerHTML = `<h3>全部调用累计（估算口径）</h3>
		<div>按角色：${t.totals.byRole.map((r) => `${esc(r.key)} ${fmtTokens(r.estimate)}≈`).join(" · ")}</div>
		<div>按来源：${t.totals.byProvenance.map((r) => `${esc(r.key)} ${fmtTokens(r.estimate)}≈`).join(" · ")}</div>`;
	wrap.appendChild(totals);
	viewer.appendChild(wrap);
	viewer.querySelectorAll(".tokens-row").forEach((row) => {
		row.onclick = () => {
			document.querySelector('[data-mode="view"]').click();
			selectCall(Number(row.dataset.seq));
		};
	});
	renderDetailForCall(null, {});
	$("#detail").innerHTML = `<h3>Tokens 模式</h3><div class="note">provider = 真实 usage；≈ = 字符/4 估算。点击行跳转对应调用。</div>`;
}

// ---------- viewer: insights mode ----------

async function renderInsightsMode(viewer) {
	const ins = await api(`/api/sessions/${state.sessionId}/insights`);
	viewer.innerHTML = "";
	const wrap = document.createElement("div");
	wrap.className = "insights-wrap";

	const section = (title, note, itemsHtml) => {
		if (!itemsHtml) return "";
		const sec = document.createElement("div");
		sec.className = "insight-section";
		sec.innerHTML = `<h3>${title}</h3><div class="detail-note">${note}</div>${itemsHtml}`;
		return sec;
	};

	wrap.appendChild(section("重复的工具调用", "客观事实：同工具同参数出现多次（如重复读取同一文件）。",
		ins.duplicates.map((d) => `<div class="kv"><span class="k">${esc(d.toolName)}</span><span class="v">${esc(d.signature)} ×${d.count}</span></div>`).join("")));
	wrap.appendChild(section("工具结果在场时长", "客观事实：该结果在后续 N/M 次调用中仍存在于上下文（不构成因果判断）。",
		ins.persistence.map((p) => `<div class="kv"><span class="k">${esc(p.toolName)}</span><span class="v">${esc(p.label)} — ${p.presentInCalls}/${p.totalCallsAfter} 次在场</span></div>`).join("")));
	wrap.appendChild(section("大型工具结果", "客观事实：结果内容超过 50KB。",
		ins.largeToolResults.map((l) => `<div class="kv"><span class="k">${esc(l.toolName)}</span><span class="v">${esc(l.label)} — ${(l.contentLength / 1024).toFixed(0)}KB</span></div>`).join("")));
	wrap.appendChild(section("Compaction 影响", "客观事实：每次压缩的规模与被摘要消息数。",
		ins.compactions.map((c) => `<div class="kv"><span class="k">${esc(c.reason)}</span><span class="v">${fmtTime(c.at)} — ${c.tokensBefore} tokens 前 · ${c.summarizedMessages} 条消息被摘要</span></div>`).join("")));

	if (!wrap.children.length) {
		viewer.innerHTML = `<div class="empty">本会话暂无可计算的洞察信号。</div>`;
		return;
	}
	viewer.appendChild(wrap);
	renderDetailForCall(null, {});
	$("#detail").innerHTML = `<h3>Insights 模式</h3><div class="note">全部条目基于 trace 事件的可验证计数；"是否相关/是否影响行为"属推测，不在事实列表中断言。</div>`;
}

// ---------- viewer: diff mode ----------

async function renderDiffMode(viewer) {
	const b = state.diffB ?? state.selectedSeq;
	const a = state.diffA;
	$("#diff-a").value = a;
	$("#diff-b").value = b;
	const diff = await api(`/api/sessions/${state.sessionId}/diff/${b}/${a}`);
	viewer.innerHTML = "";

	$("#diff-summary").textContent =
		`+${diff.stats.added} −${diff.stats.removed} ~${diff.stats.changed} ✂${diff.stats.summarized} =${diff.stats.same}`;

	if (diff.compactionBoundary) {
		const banner = document.createElement("div");
		banner.className = "compaction-banner";
		banner.textContent = "✂ Compaction 边界：以下消失的消息被摘要（compactionSummary 取代了它们），并非被删除。";
		viewer.appendChild(banner);
	}
	if (diff.sectionChanges.length > 0) {
		for (const sc of diff.sectionChanges) {
			const row = document.createElement("div");
			row.className = "section-change-row";
			row.innerHTML = `<span class="op-badge ${sc.change}">${sc.change}</span> system section: ${esc(sc.name)}`;
			viewer.appendChild(row);
		}
	}
	if (diff.toolChanges.added.length || diff.toolChanges.removed.length) {
		const row = document.createElement("div");
		row.className = "section-change-row";
		const parts = [];
		if (diff.toolChanges.added.length) parts.push(`+ tools: ${diff.toolChanges.added.join(", ")}`);
		if (diff.toolChanges.removed.length) parts.push(`− tools: ${diff.toolChanges.removed.join(", ")}`);
		row.innerHTML = `<span class="op-badge changed">tools</span> ${esc(parts.join(" · "))}`;
		viewer.appendChild(row);
	}
	if (diff.payloadChanges && (diff.payloadChanges.systemChanged || diff.payloadChanges.toolsAdded.length || diff.payloadChanges.toolsRemoved.length)) {
		const pc = diff.payloadChanges;
		const row = document.createElement("div");
		row.className = "section-change-row";
		const parts = [];
		if (pc.systemChanged) parts.push("system 文本变化");
		if (pc.toolsAdded.length) parts.push(`payload tools +: ${pc.toolsAdded.join(", ")}`);
		if (pc.toolsRemoved.length) parts.push(`payload tools −: ${pc.toolsRemoved.join(", ")}`);
		if (pc.messageCountDelta != null) parts.push(`payload messages ${pc.messageCountDelta >= 0 ? "+" : ""}${pc.messageCountDelta}`);
		row.innerHTML = `<span class="op-badge changed" style="color: var(--cyan)">payload</span> ${esc(parts.join(" · "))}`;
		viewer.appendChild(row);
	}

	let idx = 0;
	for (const op of diff.ops) {
		const el = document.createElement("div");
		el.className = "diff-op";
		if (op.op === "same") {
			const head = document.createElement("div");
			head.className = "msg-head";
			head.innerHTML = `
				<span class="op-badge same">=</span>
				<span class="role-badge">${esc(op.message.role)}</span>
				<span class="msg-label">${esc(messageLabel(op.message))}</span>
				<span class="caret">▸</span>`;
			head.onclick = () => {
				head.nextElementSibling?.classList.toggle("hidden");
				head.querySelector(".caret").textContent =
					head.nextElementSibling?.classList.contains("hidden") ? "▸" : "▾";
			};
			el.appendChild(head);
			const body = document.createElement("div");
			body.className = "msg-body hidden";
			const pre = document.createElement("pre");
			pre.innerHTML = highlight(describeAnyMessage(op.message), state.search);
			body.appendChild(pre);
			el.appendChild(body);
		} else if (op.op === "changed") {
			const head = document.createElement("div");
			head.className = "msg-head";
			head.innerHTML = `
				<span class="op-badge changed">~</span>
				<span class="role-badge">${esc(op.after.role)}</span>
				<span class="msg-label">${esc(messageLabel(op.after))}</span>
				<span class="caret">▾</span>`;
			el.appendChild(head);
			const body = document.createElement("div");
			body.className = "msg-body";
			const wrap = document.createElement("div");
			wrap.className = "diff-text";
			let lastType = null;
			let run = [];
			const flushRun = () => {
				if (run.length === 0) return;
				const div = document.createElement("span");
				div.className = `line-${lastType}`;
				div.innerHTML = highlight(run.join("\n"), state.search);
				wrap.appendChild(div);
				run = [];
			};
			for (const line of op.textDiff ?? []) {
				if (line.type !== lastType) {
					flushRun();
					lastType = line.type;
				}
				run.push(line.text);
			}
			flushRun();
			body.appendChild(wrap);
			el.appendChild(body);
		} else {
			const head = document.createElement("div");
			head.className = "msg-head";
			const badge =
				op.op === "added" ? `<span class="op-badge added">+</span>` :
				op.op === "removed" ? `<span class="op-badge removed">−</span>` :
				`<span class="op-badge summarized">✂</span>`;
			const m = op.op === "added" ? op.message : op.message;
			head.innerHTML = `
				${badge}
				<span class="role-badge">${esc(m.role)}</span>
				<span class="msg-label">${esc(messageLabel(m))}</span>
				${m.provenance ? `<span class="prov-chip" data-kind="${m.provenance.kind}" title="${esc(m.provenance.label)}">${esc(m.provenance.kind)}</span>` : ""}
				<span class="caret">▾</span>`;
			el.appendChild(head);
			const body = document.createElement("div");
			body.className = "msg-body";
			const pre = document.createElement("pre");
			const text = describeAnyMessage(m);
			// Long added tool results: cap the inline text for smooth rendering.
			pre.innerHTML = highlight(text.length > 4000 ? `${text.slice(0, 4000)}\n… (截断显示，完整内容见 Context 模式)` : text, state.search);
			body.appendChild(pre);
			if (m.role === "toolResult" && m.provenance?.toolCallId) {
				body.appendChild(toolCallBlock(m.provenance.toolCallId));
			}
			el.appendChild(body);
		}
		viewer.appendChild(el);
		idx++;
	}

	// Detail pane for diff mode
	const callB = state.sessionData.calls.find((c) => c.seq === b);
	renderDetailForCall(callB, { diff });
}

function describeAnyMessage(m) {
	if (m.role === "system") {
		const parts = [];
		for (const [name, value] of Object.entries(m.sections ?? {})) {
			parts.push(`### section: ${name}\n${value ?? "(removed)"}`);
		}
		for (const t of m.toolsAdded ?? []) parts.push(`### tool added: ${t.name}\n${t.description ?? ""}`);
		for (const t of m.toolsRemoved ?? []) parts.push(`### tool removed: ${t.name}`);
		return parts.join("\n\n");
	}
	return contentText(m.content);
}

function toolCallBlock(toolCallId) {
	const tc = state.sessionData?.toolCalls.find((t) => t.toolCallId === toolCallId);
	const div = document.createElement("div");
	div.className = "tool-call-block";
	if (tc) {
		div.innerHTML = `→ ${esc(tc.toolName)} <span class="args">${esc(JSON.stringify(tc.input))}</span>`;
	} else {
		div.textContent = `→ ${toolCallId} (调用记录不在本会话 trace 中)`;
	}
	return div;
}

// ---------- viewer: payload mode ----------

async function renderPayloadMode(viewer) {
	const call = await api(`/api/sessions/${state.sessionId}/calls/${state.selectedSeq}`);
	viewer.innerHTML = "";
	if (!call.providerPayloads?.length) {
		viewer.innerHTML = `<div class="empty">该调用未捕获 Provider Payload（例如 compaction 的摘要请求不走 agent 钩子）。</div>`;
	} else {
		for (const p of call.providerPayloads) {
			const el = document.createElement("div");
			el.className = "msg";
			const head = document.createElement("div");
			head.className = "msg-head";
			head.innerHTML = `
				<span class="role-badge" style="color: var(--cyan)">payload #${p.attempt}</span>
				<span class="msg-label">最终发送体 · ${fmtTime(p.at)}</span>
				<span class="caret">▾</span>`;
			head.onclick = () => {
				const body = head.nextElementSibling;
				body.classList.toggle("hidden");
				head.querySelector(".caret").textContent = body.classList.contains("hidden") ? "▸" : "▾";
			};
			el.appendChild(head);
			const body = document.createElement("div");
			body.className = "msg-body";
			const pre = document.createElement("pre");
			pre.innerHTML = highlight(JSON.stringify(p.payload, null, 2), state.search);
			body.appendChild(pre);
			el.appendChild(body);
			viewer.appendChild(el);
		}
	}
	renderDetailForCall(call, { level: "provider_payload" });
}

// ---------- detail pane ----------

function renderDetailForCall(call, opts = {}) {
	const detail = $("#detail");
	if (!call) {
		detail.innerHTML = "";
		return;
	}
	const parts = [];
	parts.push(`<h3>调用</h3>`);
	parts.push(`<div class="kv"><span class="k">seq</span><span class="v">#${call.seq}</span></div>`);
	parts.push(`<div class="kv"><span class="k">模型</span><span class="v">${esc(call.model ? `${call.model.provider}/${call.model.id}` : "—")}</span></div>`);
	parts.push(`<div class="kv"><span class="k">turn</span><span class="v">${call.turnIndex ?? "—"}</span></div>`);
	parts.push(`<div class="kv"><span class="k">状态</span><span class="v">${esc(call.status)}</span></div>`);
	parts.push(`<div class="kv"><span class="k">时间</span><span class="v">${fmtTime(call.startedAt)}</span></div>`);

	parts.push(`<h3>捕获层级</h3>`);
	parts.push(`<div class="note">Context 视图 = <code>context_with_system</code>（Pi 内部最终上下文，含 system）</div>`);
	parts.push(`<div class="note">Payload 视图 = <code>before_provider_request</code>（最终发送体）</div>`);

	parts.push(`<h3>Tokens</h3>`);
	if (call.providerInputTokens != null) {
		const inAll = call.providerInputTokens + (call.providerCacheReadTokens ?? 0) + (call.providerCacheWriteTokens ?? 0);
		parts.push(`<div class="kv"><span class="k">provider input</span><span class="v">${inAll}</span></div>`);
		if (call.providerCacheReadTokens) parts.push(`<div class="kv"><span class="k">cache read</span><span class="v">${call.providerCacheReadTokens}</span></div>`);
		if (call.providerCacheWriteTokens) parts.push(`<div class="kv"><span class="k">cache write</span><span class="v">${call.providerCacheWriteTokens}</span></div>`);
		parts.push(`<div class="kv"><span class="k">output</span><span class="v">${call.providerOutputTokens ?? "—"}</span></div>`);
	}
	if (call.piEstimatedTokens != null) {
		parts.push(`<div class="kv"><span class="k">pi 估算</span><span class="v estimate">${call.piEstimatedTokens}</span></div>`);
	}
	parts.push(`<div class="kv"><span class="k">消息数</span><span class="v">${call.piContextCount ?? call.piContext?.length ?? "—"}</span></div>`);

	if (call.toolCallIds?.length) {
		parts.push(`<h3>本次调用发起的工具</h3>`);
		for (const id of call.toolCallIds) {
			const tc = state.sessionData?.toolCalls.find((t) => t.toolCallId === id);
			if (tc) {
				parts.push(`<div class="kv"><span class="k">${esc(tc.toolName)}</span><span class="v">${esc(JSON.stringify(tc.input).slice(0, 120))}</span></div>`);
			}
		}
	}

	if (state.sessionData?.children?.length) {
		parts.push(`<h3>Subagent 子会话</h3>`);
		for (const ch of state.sessionData.children) {
			parts.push(`<div class="kv"><span class="k">${esc(ch.sessionId.slice(0, 8))}</span><span class="v"><a href="#" class="child-link" data-sid="${esc(ch.sessionId)}">${ch.callCount} calls · 查看 →</a></span></div>`);
		}
		parts.push(`<div class="note">父子关系来自子进程环境变量（确定性）；对应哪次 subagent 工具调用按时间推断。</div>`);
	}

	if (opts.diff) {
		const d = opts.diff;
		parts.push(`<h3>Diff 概览</h3>`);
		parts.push(`<div class="kv"><span class="k">新增</span><span class="v" style="color: var(--green)">+${d.stats.added}</span></div>`);
		parts.push(`<div class="kv"><span class="k">删除</span><span class="v" style="color: var(--red)">−${d.stats.removed}</span></div>`);
		parts.push(`<div class="kv"><span class="k">修改</span><span class="v" style="color: var(--yellow)">~${d.stats.changed}</span></div>`);
		parts.push(`<div class="kv"><span class="k">被摘要</span><span class="v" style="color: var(--purple)">✂${d.stats.summarized}</span></div>`);
		parts.push(`<div class="kv"><span class="k">未变化</span><span class="v">=${d.stats.same}</span></div>`);
	}

	detail.innerHTML = parts.join("");
}

// ---------- live updates ----------

function subscribeEvents() {
	if (!state.sessionId) return;
	const sse = new EventSource(`/events?sessionId=${encodeURIComponent(state.sessionId)}`);
	sse.addEventListener("update", async (ev) => {
		const data = JSON.parse(ev.data);
		// Refresh session list occasionally and the open session always.
		await loadSession();
		await loadSessions();
	});
	sse.onerror = () => {
		// EventSource auto-reconnects.
	};
	state.sse = sse;
}

// ---------- wire up ----------

document.querySelectorAll(".mode-switch button").forEach((btn) => {
	btn.onclick = () => {
		document.querySelectorAll(".mode-switch button").forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		state.mode = btn.dataset.mode;
		if (state.mode === "diff") {
			if (state.diffB == null && state.selectedSeq != null) {
				state.diffB = state.selectedSeq;
				state.diffA = Math.max(0, state.selectedSeq - 1);
			}
		}
		renderViewer();
	};
});

$("#diff-a").onchange = () => {
	state.diffA = Math.max(0, Number($("#diff-a").value) || 0);
	renderViewer();
};
$("#diff-b").onchange = () => {
	state.diffB = Math.max(0, Number($("#diff-b").value) || 0);
	renderViewer();
};

let searchTimer = null;
$("#search").oninput = () => {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		state.search = $("#search").value.trim();
		renderViewer();
	}, 200);
};

$("#refresh-sessions").onclick = loadSessions;

document.addEventListener("click", (ev) => {
	const link = ev.target.closest?.(".child-link");
	if (link) {
		ev.preventDefault();
		selectSession(link.dataset.sid);
	}
});

loadSessions();
