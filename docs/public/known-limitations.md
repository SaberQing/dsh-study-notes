# 已知限制与兼容性

## 兼容性

- 仅在 **DSH desktop `0.2.2-rc.3`** 上验证；插件依赖 DSH 的扩展位与部分内部接口，DSH 升级后可能需要适配；
- 无第三方依赖，不使用构建步骤；
- Windows 上 API Key 使用 DPAPI 保护；macOS/Linux 回退 AES-256-GCM（密钥文件 0600）。

## 依赖的 DSH 接口（升级风险点）

- 右栏标签页扩展位（`sidebarRightTabs.register` + `sidebar.right.pane.tab`）；
- 设置页分区 `settings.section`；
- `ctx.agents.get(sessionId)` / `agent.session.deriveMessages()`（记忆摘要）；
- `agent.inject` / `agent.followup` / `session.append`（回注）；
- 对话 DOM 约定：`[data-conversation-scroll]`、`[data-composer-seat]`、`[data-chat-flow-key]`、`[data-chat-node-key]`、`data-chat-turn`（定位）；
- 会话压缩检查点 `<compacted-summary>`（记忆摘要去重）。

任一接口变更都可能导致对应功能失效，但通常不会影响其他功能。

## 功能限制

- **直接注入**：主对话空闲时才持久落盘；生成中会排队，提示“尚未落盘”，若此时重启可能丢失；
- **定位到对话**：旧消息需要先分页加载（最多约 8 页 / 3 秒）；消息被压缩/编辑后可能找不到原文，会提示并复制引用；
- **折叠消息**：只能定位到折叠分组/分组头，并提示近似位置；
- **右栏宽度 < 768px**：按 DSH 设计变为全屏抽屉，不再挤压主对话；
- **记忆摘要**：未设 token 上限（按设计优先完整性），长会话摘要会变长，可在右栏「记忆」中手动精简；
- **回注摘要 / 记忆摘要**使用 DSH 内置模型，不随“模型来源”切换；
- **正文中的单 `$...$` 行内公式不渲染**（DSH 渲染器只支持 `\(...\)`、`$$...$$`、`\[...\]`）；
- 界面目前为中文；
- 摘要文件不会自动清理（每个会话一个文件）。

## 数据限制

- 笔记与分支问答存于浏览器 localStorage，清除站点数据会丢失（建议定期导出 Markdown）；
- 摘要文件存于 `~/.dsh/study-notes/`，v1 无自动清理；
- 删除笔记不会自动删除对应摘要文件（摘要按会话而非按笔记）。

## 未验证/可能不稳的场景

- 多个 DSH 窗口同时操作同一会话；
- 极长会话（数千条消息）下的分页定位与摘要刷新；
- 非官方 OpenAI 兼容网关对思考参数（`reasoning_effort`/`thinking`/`enable_thinking` 等）的兼容性差异；
- DSH 升级后的首次运行。
