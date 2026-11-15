# dsh-study-notes

> Select text in a DSH conversation and ask about it in an isolated branch in the right sidebar — your main conversation context stays clean, and you can always jump back to the question later.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Status: 0.1.0-beta** — works and self-tested on DSH desktop `0.2.2-rc.1`; built on DSH extension points, so a DSH upgrade may require updates.

## Why

When learning with an AI, questions about a passage usually go one of two ways:

- Ask in the **main conversation** — context grows, gets diluted, and becomes messy;
- **Start a new chat** — context is lost, you re-explain everything, and the old question is hard to find.

dsh-study-notes separates these questions: select text → right-click "问这个" → an independent branch opens in the right sidebar, **never entering the main conversation context**. The selection stays highlighted; click it later (or a row in the notes index) to return to that branch.

## Features

- Isolated branch Q&A with streaming, stop, and optional main-conversation memory.
- Persistent highlights, per-session; survive session switches, refresh, and restart.
- Notes index + start-page entry; click a row to **scroll the main conversation to the anchor and flash it**; paged history loading; graceful fallback when the original text is gone.
- Optional branch memory: editable digest + last 10–15 messages; lazy refresh; encrypted at rest.
- Reinject branch summaries into the main conversation: prefill draft, or a durable collapsed "Context injection" row.
- Markdown/KaTeX rendering, truncation notice + continue, retry/stall indicators, auto-scroll.
- Batch delete; Markdown / Word (.docx) export.
- Thinking toggle, no output-length cap; choose DSH native model or an explicit custom OpenAI-compatible API.
- API keys are encrypted on the Host (DPAPI on Windows, AES-256-GCM fallback); the UI only shows first 7 + last 4 characters.

## Requirements

- DSH desktop **`0.2.2-rc.1`** (other versions untested)
- No extra Node dependencies; strongest key protection on Windows (DPAPI)

## Install

Install as a local DSH bundle. Put this repository in a stable directory, then either:

**Option A — plugin manager (recommended)**

```text
plugin_manager install_bundle  <absolute path to this directory>
```

**Option B — manual profile wiring**

Add the plugin to your DSH profile `package.json` dependencies (`"@local/dsh-study-notes": "link:<absolute path>"`) and to `dsh.profile.bundles`, then **fully quit and restart DSH** (Host code loads only at startup).

See [docs/public/installation.md](docs/public/installation.md) (Chinese) for details and uninstall steps.

## Quick start

1. Select text in a conversation → right-click → "问这个".
2. The right sidebar opens the note and its branch; ask away.
3. Click the highlight or an index row to come back to it later.
4. Settings live in **Settings → 学习笔记**.

## Privacy

All notes, branches, and digests stay local. API keys are encrypted on the Host and never returned to the browser. See [docs/public/privacy.md](docs/public/privacy.md) (Chinese).

## Known limitations

Depends on DSH extension points and some internal interfaces (right-sidebar tab, `settings.section`, `agent.inject`/`session.append`, message derivation, conversation DOM `data-*` attributes); a DSH upgrade may break behavior. Direct injection is durable only when the main conversation is idle. Notes live in browser localStorage and are not encrypted. UI is Chinese; memory/reinject summaries use the DSH native model.

## License

[MIT](LICENSE) © 2026 SaberQing
