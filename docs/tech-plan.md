# Pi Context Explorer — 技术方案（Phase 1 调研结论）

基于 Pi 1.4.0 真实源码阅读 + 4 轮探针实测（`/tmp/pcv-test`、`/tmp/pcv-compact2/3`，事件证据在 `.probe/*.jsonl`）。

## 1. 能捕获什么（已验证）

| 捕获层 | Hook | 内容 | 置信度 |
|---|---|---|---|
| **Pi 内部完整上下文** | `context_with_system` | 完整 `AgentMessage[]`：system（含 `sections` 8 个命名段 + `toolsAdded` 完整工具定义含 parameters schema）+ user/assistant/toolResult/compactionSummary… | 实测确认 |
| **最终 Provider Payload** | `before_provider_request` | `event.payload` 即发送体（anthropic-messages：`{model, messages, max_tokens, stream, system:[…], tools:[…]}`，含 `cache_control`） | 实测确认 |
| **工具调用/结果** | `tool_call` / `tool_result` / `tool_execution_*` | `toolCallId`、`input`（如 `read{path}`）、`content`、`isError`、`details` | 实测确认 |
| **Compaction** | `session_before_compact` + `session_compact` | `preparation`（firstKeptEntryId / isSplitTurn / tokensBefore / messagesToSummarize / turnPrefixMessages / fileOps）+ 生成的 `summary` + `systemMessage` 完整检查点 | 实测确认（threshold 场景，含 split-turn） |
| **调用元数据** | `turn_start/end`、`message_end`、`after_provider_response` | turnIndex、usage、stopReason、model、状态码 | 实测确认 |
| **会话标识** | `session_start` | `sessionId`、`sessionFile`、`cwd`、`reason` | 实测确认 |

Hook 顺序（实测稳定）：`turn_start → message_end(system) → message_end(user) → context_with_system → before_provider_request → message_end(assistant) → tool_call ⇄ tool_result → turn_end`。

## 2. 来源追踪（Provenance）规则——全部基于可验证事件

| 来源 | 判定方式 | 可靠性 |
|---|---|---|
| AGENTS.md / 项目指令 | system 消息 `sections.project_context` 内的 `<project_instructions path="…">` 标签，路径直接解析 | 确定 |
| System Prompt 各段 | system 消息 `sections` 的键名（preamble/tools/rules/docs/skills/cwd/自定义段） | 确定 |
| Skills | `sections.skills`（发布清单注入）+ `before_agent_start.systemPromptOptions.skills`；Skill 被读取时表现为 `read` 工具调用 | 确定（注入）/事件关联（读取） |
| 工具定义 | system 消息 `toolsAdded`/`toolsRemoved`（首个 system 声明全集，后续为增量 patch） | 确定 |
| 文件读取 / Shell 输出 | `tool_call.toolName` + `input.path`/`input.command`，经 `toolCallId` 关联到上下文中的 toolResult 消息 | 确定 |
| Subagent 返回 | `subagent` 工具的 toolResult；父子关联靠 `PI_SUBAGENT_PARENT_SESSION` 环境变量 + 独立 sessionFile | 确定（边界）/不假定子上下文进入主 Agent |
| Memory 检索 | 表现为具体工具调用（如 grep/read memory 文件）→ 按工具事件归因 | 确定（按事件，不按臆测） |
| 其他 Extension 注入 | `custom_message` 条目（`customType` 标明来源扩展） | 确定 |
| 无法判定 | 标记 Unknown | — |

Diff 归因链：新增消息 → 若为 toolResult，取 `toolCallId` 反查 `tool_call`（工具名+参数）→ 若为 system patch，取 section 名与 `toolsAdded` → 其余 Unknown。

## 3. Diff 策略（核心功能）

不按数组位置比较。三层对齐：
1. **消息级**：按稳定键对齐——toolResult 用 `toolCallId`；assistant/user 用内容哈希 + 时间戳；system patch 按出现顺序与 section 键。
2. **结构识别**：compactionSummary 出现 = 压缩边界（展示"被摘要区间"而非误报"大量删除"）；system patch（`sections` 增量）≠ 全量 system 变化；`toolsAdded/Removed` 单独成行。
3. **文本级**：消息内容变化时行级 diff（自实现 Myers/LCS，零依赖），长 toolResult 折叠 + 展开细看。

对 Provider Payload 层同样提供 diff（tools 数组、system 文本、cache_control 变化）。

## 4. 架构

```
pi 进程
└── extension（本项目，TypeScript，jiti 直载）
    ├── 采集：context_with_system / before_provider_request / tool_* / session_* 事件
    ├── 归因：toolCallId → tool_call 映射；system section 解析
    ├── 存储：sidecar JSONL（~/.pi-context-viewer/<sessionId>.jsonl，0600）
    └── HTTP 服务：127.0.0.1:7860（可配），静态 UI + JSON API + SSE 实时推送
```

- **不写入** Pi 原生 session JSONL；不用 `appendEntry`（避免污染会话）；纯监听。
- 每事件 `structuredClone` 后异步入队写盘，处理程序返回 `undefined`（零改动，实测安全）。
- UI：单页原生 JS（无构建步骤），三栏布局（左 Timeline / 中 Viewer+Diff / 右 Provenance+Tokens）。
- 会话列表 = 扫描 sidecar 目录 + 当前活跃 session（内存态即时可见）。

## 5. 已确认的限制（必须向用户标注）

1. **Compaction 的摘要 LLM 调用不可捕获 payload**：`completeSimple` 直连 provider，不经过 Agent 的 `onPayload` 链（源码 `compaction.js:487`）。捕获层只有 `preparation` 输入与结果 summary，**不声称有该次请求的 payload**。
2. **Subagent 子进程的 LLM 调用**：子进程是独立 pi 实例，本扩展在每个子进程内同样加载并各自写 sidecar（靠 `PI_SUBAGENT_PARENT_SESSION` 建立父子关系）。主 Agent 侧只展示实际返回的工具结果，不假定子上下文进入主 Agent。
3. **Provider 报告口径差异**：本地代理不报 cache token 时 `calculateContextTokens` 偏小；UI 中 Pi 估算 / provider usage 双口径并列展示。
4. **`context_with_system` 是"扩展可见的最终上下文"**：若其他扩展在同钩子后置位修改，顺序取决于加载序；`before_provider_request.payload` 才是最终请求体，两层都存并在 UI 明确标注层级。
5. **手动 `ctx.compact()` 会先 abort 当前运行**（源码确认）：采集扩展不主动调用 compact；验证用 fixture 触发 auto-threshold。
6. **`-p`/RPC 模式无 UI 但事件齐全**（实测 print 模式全链路捕获正常）。

## 6. 验证 Fixture（已就绪）

- `/tmp/pcv-test`：AGENTS.md + 文件读取（基础链路）✅ 已跑通
- `/tmp/pcv-compact3`：`.pi/settings.json{reserveTokens:999000, keepRecentTokens:100}` + 大文件读取 → 稳定触发 threshold compaction（含 split-turn）✅ 已跑通
- Subagent：`PI_SUBAGENT_CHILD/PARENT_SESSION` 环境变量方案已确认，Phase 4 实测。

## 7. 分阶段交付

- **M2 MVP**：extension 采集 + sidecar + HTTP/SSE + UI（Timeline / 全文 Viewer / 相邻 Diff / toolCallId 溯源）
- **M3**：任意两次调用 Diff、system patch/compaction 结构化视图、来源面板、token 双口径
- **M4**：真实场景验证矩阵（AGENTS.md / 大 ToolResult / Memory 工具 / Compaction / Subagent / 分支切换）
