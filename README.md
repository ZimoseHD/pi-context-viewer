# pi-context-viewer

Pi Coding Agent 扩展：在浏览器中审阅每次 LLM Call 的**完整上下文**、逐次 **Diff**、**来源溯源**与执行时间线。运行期间实时更新，本地只读，不修改 Pi 原生 session。

```
pi 执行任务 → 自动捕获每次调用上下文 → 浏览器查看完整内容 → 相邻/任意两次 Diff → 定位工具调用证据
```

## 安装与使用

```bash
# 临时使用
pi --extension /path/to/pi-context-viewer

# 或加入全局扩展目录后正常启动 pi
# 会话内命令：
/context-view          # 显示状态与查看地址
/context-view off      # 关闭查看服务（采集继续）
```

打开 `http://127.0.0.1:7860`（被占用时自动 +1，最多尝试 20 个端口）。

- 左栏：Session 列表（含 subagent 会话标记）
- 中栏：LLM Call 时间线 → Context / **Diff** / Provider Payload 三种视图
- 右栏：来源（provenance）、捕获层级、双口径 token

## 捕获层级（如实标注）

| 层 | Hook | 内容 |
|---|---|---|
| Pi 内部上下文 | `context_with_system` | 完整消息列表，含 system sections（preamble/tools/rules/docs/project_context/skills/cwd）与工具定义 |
| 最终发送体 | `before_provider_request` | Provider 实际请求 payload |
| 工具事件 | `tool_call` / `tool_result` | toolCallId、参数（文件路径/命令）、结果摘要 |
| 压缩边界 | `session_before_compact` / `session_compact` | 摘要范围、split-turn、tokensBefore、systemMessage 检查点 |

已知限制（详见 `docs/tech-plan.md` §5）：compaction 摘要请求本身不走 agent 钩子，无 payload；subagent 上下文不进入主 Agent，仅按返回结果归因。

## 存储与隐私

- Trace 位置：`~/.pi-context-viewer/<sessionId>.jsonl`（`0600`，目录默认 `0700`）
- 仅监听 `127.0.0.1`；不向模型注入任何内容；不写 Pi 原生 session 文件
- 清理：删除 `~/.pi-context-viewer/` 即可；如不想被项目 Git 跟踪，trace 默认在用户主目录而非项目目录

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_CONTEXT_VIEWER_PORT` | `7860` | 起始端口（占用自动 +1） |
| `PI_CONTEXT_VIEWER_DIR` | `~/.pi-context-viewer` | trace 目录 |

## 开发

```bash
npm install
npm run check          # tsc --noEmit
node scripts/dev-server.mjs   # 不启动 pi，仅查看已有 trace
```

无构建步骤：服务端 TypeScript 由 pi 的 jiti 直载；前端为原生 JS/CSS。

## 路线图

- [x] M2 MVP：采集 + 三栏 UI + 相邻 Diff + toolCallId 溯源（#1）
- [ ] M3：任意两次 Diff、subagent 关联视图、token 面板（#2）
- [ ] M4：真实场景验证矩阵（#3）
