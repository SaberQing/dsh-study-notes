# 安装与卸载

## 环境要求

- DSH desktop **`0.2.2-rc.1`**（其他版本未验证）
- 无需 `npm install`；插件无第三方依赖

## 安装方式一：插件管理器（推荐）

在 DSH 中打开插件管理器（或直接对 DSH 说“用 plugin_manager 安装这个插件”），指向本目录的**绝对路径**：

```text
plugin_manager install_bundle  <本目录绝对路径>
```

安装后**完全退出 DSH 再启动**（Host 代码只在启动时加载）。

## 安装方式二：手动挂载

1. 把本仓库放到一个固定目录（不要放在临时目录）；
2. 编辑 DSH profile 的 `package.json`（Windows 默认 `%USERPROFILE%\.dsh\profiles\desktop\package.json`）：

```json
{
  "dependencies": {
    "@local/dsh-study-notes": "link:<本目录绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "...", "@local/dsh-study-notes"]
    }
  }
}
```

3. **完全退出 DSH 再启动**。

## 验证安装

- 右侧栏标签条点「+」→ 开始页出现「学习笔记」卡片；
- 设置页（Settings）左侧出现「学习笔记」分区；
- 在对话里划词 → 右键菜单出现「问这个」。

> 若只看到部分入口：先确认是否**完全重启**了 DSH（不是刷新页面）。

## 卸载

1. 从 profile 的 `bundles` 与 `dependencies` 中移除 `@local/dsh-study-notes`；
2. 删除本目录；
3. 完全重启 DSH。

可选清理本地数据：

- 笔记/分支问答/设置：浏览器 localStorage（键前缀 `dsh-study-notes/`）；
- 学习摘要与密钥：`%USERPROFILE%\.dsh\study-notes\`（Windows）或 `$DSH_HOME/study-notes/`。

## 常见问题

**右栏没有“学习笔记”标签？**
先点标签条「+」打开开始页，再进入；若设置页也没有分区，说明插件未加载，检查 profile 的 bundles 并完全重启。

**保存 Key 后只显示前 7 位与后 4 位，怎么看完整 Key？**
这是设计如此：完整 Key 不返回浏览器，不能查看/修改；如需更换请删除后重新输入。

**自定义 API 提示“未配置完整”？**
在设置 → 学习笔记 中确认：模型来源 = 使用自定义 API、API 地址、模型、已保存 Key 四项齐全。

**定位对不准/找不到原文？**
旧消息可能需要先加载更早对话；若原文已被编辑/压缩，会提示“原文已不在当前对话中”并复制原文。
