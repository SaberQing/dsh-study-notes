# Changelog

All notable changes to this project are documented here. This project follows semver; beta versions may change behavior between releases.

## [0.1.0-beta.1] - 2026-11-15

First public beta.

### Added

- Right-sidebar "学习笔记" tab: select text → right-click「问这个」→ isolated branch Q&A that never enters the main conversation context.
- Persistent per-session highlights (CSS Custom Highlight API) with restore after session switch, refresh, and DSH restart.
- Notes index with open/detail switching; click a row to scroll the main conversation to the anchor and flash it (paged history loading, folded-row and missing-text fallbacks).
- Start-page (Guide) entry that opens the notes index.
- Optional branch memory: main-conversation digest + last 10–15 messages, lazy refresh (≥5 new messages, max once per question, ≥60s), editable digest with save/rebuild/clear, persisted across restarts.
- Reinject to main conversation: generate a short summary, preview/edit, then prefill the composer or inject a durable collapsed "Context injection" row (session.append when idle; queued when a turn is running).
- Markdown and KaTeX rendering of branch answers.
- Error classification and automatic retry (transient: up to 5 retries, 5 s apart; faults: immediate readable reason), stop support, truncation marker with "continue", stall and retry status pill, sticky auto-scroll.
- Batch selection and delete; Markdown and Word (.docx, zero-dependency ZIP) export.
- Model controls: unlimited output length (adapter defaults), thinking on/off toggle and per-provider thinking-format mapping for custom OpenAI-compatible APIs.
- Settings moved to **Settings → 学习笔记**: provider mode (DSH native vs custom API), thinking, memory, reinject mode.
- API key security: Host-side encrypted storage (`~/.dsh/study-notes/secrets.json`; DPAPI on Windows, AES-256-GCM fallback), masked preview only (first 7 + last 4), no view/edit, delete-and-re-enter only; legacy plaintext keys migrate automatically.
- Memory digest files encrypted at rest with the same wrapper.

### Known issues

- Depends on DSH extension points/internal interfaces; DSH upgrades may require updates.
- Direct injection is durable only when the main conversation is idle.
- Locate-to-conversation depends on conversation DOM conventions; old messages require history paging.
- Notes/branches remain unencrypted in browser localStorage.
- Memory and reinject summaries still use the DSH native model.
