# dsh-study-notes

English | [中文](README.md)

> Select text in a DSH conversation and ask about it in an isolated branch in the right sidebar — your main conversation context stays clean, and you can always jump back to the question later.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-study-notes.svg?label=npm&color=blue)](https://www.npmjs.com/package/dsh-study-notes)

> **Status: 0.1.0-beta** — published on npm as [`dsh-study-notes`](https://www.npmjs.com/package/dsh-study-notes); self-tested on DSH desktop `0.2.2-rc.3`; built on DSH extension points, so a DSH upgrade may require updates.

## Why

When learning with an AI, questions about a passage usually go one of two ways:

- Ask in the **main conversation** — context grows, gets diluted, and becomes messy;
- **Start a new chat** — context is lost, you re-explain everything, and the old question is hard to find.

dsh-study-notes separates these questions: select text → right-click "问这个" → an independent branch opens in the right sidebar, **never entering the main conversation context**. The selection stays highlighted; click it later (or a row in the notes index) to return to that branch.

## Features

- **Isolated branch Q&A**: its own context, streaming answers, stop support; optional main-conversation memory.
- **Persistent highlights**: per-session; survive session switches, page refresh, and DSH restart.
- **Notes index and locate**: right-sidebar "学习笔记" index + start-page (Guide) entry; click a row to **scroll the main conversation to the anchor and flash it**; older messages are paged in automatically; when the original text is gone, the plugin tells you and copies the quote.
- **Optional branch memory (off by default)**: a digest of the main conversation + the last 10–15 messages; lazy refresh; persisted locally in encrypted form; the digest can be viewed, edited, rebuilt, and cleared.
- **Reinject to the main conversation**: compress the branch into 3–5 bullets and send it back either as a **prefilled draft** or as a **direct injection** (a collapsed "Context injection" row in the main conversation, durably kept).
- **Rendering**: Markdown, code blocks, tables, KaTeX math; truncation notice + "continue"; retry/stall status; auto-scroll.
- **Management**: batch delete, Markdown / Word (.docx) export, single-note export.
- **Model controls**: thinking toggle, no output-length cap; choose the DSH native model or an explicitly selected custom OpenAI-compatible API.
- **Privacy**: the API key is encrypted on the Host (DPAPI on Windows, AES-256-GCM fallback); the UI only shows the first 7 and last 4 characters — no viewing or editing, only delete and re-enter.

## Requirements

- DSH desktop **`0.2.2-rc.3`** (other versions untested)
- No extra Node dependencies; strongest API-key protection on Windows (DPAPI)

## Install

**Option A — npm package (recommended)**

Published on npm as **`dsh-study-notes`** (the author-maintained `latest` tag currently points to `0.1.0-beta.1`). Install it from the DSH plugin manager by package name, or ask DSH to run:

```text
plugin_manager install_bundle  dsh-study-notes
```

Pin an exact version with `dsh-study-notes@0.1.0-beta.1`. Then **fully quit and restart DSH** (Host code loads only at startup).

**Option B — local directory (development / offline)**

1. Put this repository in a stable directory.
2. Install that directory:

```text
plugin_manager install_bundle  <absolute path to this directory>
```

> Local-directory installation is for development or offline use: the development package name is `@local/dsh-study-notes`; `npm run build:npm` produces the `dist-npm/` package published as `dsh-study-notes`.

**Option C — manual profile wiring (not recommended)**

1. Add the plugin to your DSH profile `package.json` dependencies (adjust the path):

```json
{
  "dependencies": {
    "@local/dsh-study-notes": "link:<absolute path to this directory>"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "@local/dsh-study-notes"]
    }
  }
}
```

2. **Fully quit and restart DSH** (Host code loads only at startup; refreshing the page is not enough).

See [docs/public/installation.md](docs/public/installation.md) (Chinese) for detailed steps, uninstall, and FAQ.

## Quick start

1. Select text in a conversation → right-click → "问这个".
2. The right sidebar opens "学习笔记" with that branch; ask your question.
3. Click the highlight or a row in the index to come back to it later.
4. Clicking a row locates the anchor in the main conversation (scroll + flash); the "打开" button on the row opens the branch detail.
5. Global settings live in **Settings → 学习笔记** (model source, thinking, memory, reinject mode, API key).

## Settings (Settings → 学习笔记)

| Setting | Default | Description |
|---|---|---|
| Model source | DSH native model | Native / custom OpenAI-compatible API (explicit choice, no mutual fallback) |
| Thinking | On | Native follows DSH; custom API can pick a parameter format |
| Memory | Off | When on, branch questions include the main-conversation digest + the last N messages |
| Main-conversation window | 10 | 10–15 messages |
| Reinject mode | Prefill draft | Prefill draft (no auto-send) / direct injection |

## Privacy and security

- Notes, branches, digests, and settings stay **on this machine** (browser localStorage + `~/.dsh/study-notes/`);
- **API key**: encrypted at rest on the Host; the browser only receives a masked preview; request bodies never contain the key;
- No data is sent to third parties except the model requests you configure.
- Full details in [docs/public/privacy.md](docs/public/privacy.md) (Chinese).

## Known limitations

- Depends on DSH extension points and some internal interfaces (right-sidebar tab, `settings.section`, `agent.inject`/`session.append`, message derivation, conversation DOM `data-*` attributes) — **a DSH upgrade may break functionality**;
- "Direct injection" is durable only when the main conversation is idle; while a turn is generating it is queued and marked as "not yet persisted";
- Locating depends on conversation DOM conventions; older messages must be paged in;
- Notes and branch Q&A live in browser localStorage and are **not encrypted** (readable by local processes of the same user; use OS account isolation or clear the data if needed);
- Below 768 px the right sidebar becomes a full-screen drawer, following DSH behavior;
- UI is Chinese; memory and reinject summaries use the DSH native model.

See [docs/public/known-limitations.md](docs/public/known-limitations.md) (Chinese) for the full list.

## Project structure

```
package.json      DSH bundle / client manifest
cordis.patch.yml  plugin mount
index.js          Host: LLM routes, digest/memory/reinject/key routes
client.js         Client: right-tab, highlights, index, locate, settings section, export
locale/           localized strings
icon.svg          icon
```

- No build step: `client.js` is a hand-written `window.__ModuleLoader__` bundle;
- Host changes require a full DSH restart; client changes only need a page refresh.

## License

[MIT](LICENSE) © 2026 SaberQing

## Disclaimer

This is an independently developed third-party plugin, not affiliated with DeepSeek. When using a custom API, check your provider's terms and costs yourself.
