# 隐私与数据安全

## 数据存放位置

| 数据 | 位置 | 加密 |
|---|---|---|
| 笔记、分支问答、回注摘要、设置 | 浏览器 localStorage（键前缀 `dsh-study-notes/`） | 否（本地同用户可读） |
| 学习上下文摘要（每会话） | `~/.dsh/study-notes/<sessionId>.json`（或 `$DSH_HOME/study-notes/`） | 是（DPAPI / AES-256-GCM） |
| 自定义 API Key | `~/.dsh/study-notes/secrets.json` | 是（DPAPI / AES-256-GCM） |

以上数据都只在本机，不上传、不跨设备同步。

## API Key 的处理

- 保存：设置页把 Key POST 给本机 Host（loopback），Host 立即加密写入 `secrets.json`，**不再保存明文**；
- 加密：Windows 使用 **DPAPI（CurrentUser）**，只有当前 Windows 用户能解密；其他平台回退 AES-256-GCM，密钥文件仅当前用户可读（0600）；
- 展示：页面只能拿到 `configured` 与脱敏 preview（前 7 位 + 后 4 位）；**完整 Key 永不返回浏览器**；
- 使用：调用自定义 API 时由 Host 解密后直接发往你配置的地址，请求体与日志均不包含明文；
- 修改：不支持查看/修改，只能「删除」后重新输入；
- 迁移：旧版本存在 localStorage 的明文 Key 会在打开设置时自动迁移到加密存储并从 localStorage 删除；迁移失败时会移除明文并提示重填。

## 网络请求

- 分支问答 / 摘要：DSH 内置模型路由，或你选择的自定义 OpenAI 兼容接口（HTTPS，由你配置地址）；
- 其他请求仅发往本机 Host（`/study-notes/*`），不经过第三方。

## 浏览器 localStorage 的局限

笔记与分支内容为便于浏览器直接读取，未做应用层加密；能访问你 Windows 账户下浏览器数据的本机程序可能读取它们。若内容敏感：

- 使用系统账户/锁屏保护；
- 或在使用后通过列表「删除选中」清理，并清理浏览器站点数据。

## 遥测

本插件不包含任何遥测、统计或崩溃上报。

## 建议

- 自定义 API Key 建议使用专用/限额度 Key；
- 不要把含敏感信息的会话数据导出后分享；
- 定期检查 `~/.dsh/study-notes/` 是否还有不再需要的摘要文件（v1 不会自动清理）。
