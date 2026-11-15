window.__ModuleLoader__.load({
  id: '@local/dsh-study-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useIsoLayoutEffect = React.useLayoutEffect || React.useEffect;
    const SCROLL_STICK_THRESHOLD = 48;

    const HIGHLIGHT = 'dsh-study-note-v3';
    const STORAGE_PREFIX = 'dsh-study-notes/v1/';
    const SEAT_SELECTOR = '[data-chat-flow-key]';
    const NODE_SELECTOR = '[data-chat-node-key]';

    /**
     * 复用 DSH 主对话的 Markdown + KaTeX 渲染器（客户端 seed 模块）。
     * 它是内部共享模块，拿不到时回退纯文本气泡，绝不影响插件加载。
     */
    let MarkdownText = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      if (primitives && primitives.MarkdownText) MarkdownText = primitives.MarkdownText;
    } catch (_) {}

    /** ui-chat 同款中文 labels：代码块复制/工具条 + 脚注 */
    const MD_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
      },
      footnotes: '脚注',
    };

    /** 分支提问的错误分类 / 自动重试参数 */
    const ASK_MAX_RETRIES = 5;
    const ASK_RETRY_DELAY_MS = 5000;
    const TRANSIENT_RE = /TRANSPORT|transport|ECONN|ETIMEDOUT|network|fetch|timed? ?out|account read failed/i;

    /** 思考参数格式：[值, 显示名]；'none' = 不发送任何思考字段 */
    const THINKING_FORMATS = [
      ['none', '不发送'],
      ['deepseek', 'deepseek'],
      ['openai', 'openai'],
      ['qwen', 'qwen'],
      ['qwen-chat-template', 'qwen-chat-template'],
      ['zai', 'zai'],
      ['openrouter', 'openrouter'],
      ['together', 'together'],
      ['string-thinking', 'string-thinking'],
    ];

    function normalizeThinkingFormat(value) {
      const format = typeof value === 'string' ? value : '';
      return THINKING_FORMATS.some(([v]) => v === format) ? format : 'none';
    }

    /** 记忆：主对话窗口条数（10–15，默认 10） */
    const MEMORY_WINDOWS = [10, 11, 12, 13, 14, 15];
    const MEMORY_DEFAULT_WINDOW = 10;

    function normalizeMemoryWindow(value) {
      const num = typeof value === 'number' ? value : parseInt(value, 10);
      if (!Number.isFinite(num)) return MEMORY_DEFAULT_WINDOW;
      return Math.min(15, Math.max(10, Math.round(num)));
    }

    function formatDateTime(ts) {
      if (!ts) return '—';
      const date = new Date(ts);
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      );
    }

    /** 右侧栏 tab：类型 id / kind / 标签由 ui-sidebar-right 的官方扩展位登记 */
    const TAB_ID = '@local/dsh-study-notes';
    const TAB_KIND = 'study-notes';
    const TAB_TITLE = '学习笔记';

    /** id -> { id, sessionId, seatKey, nodeKey, startOffset, endOffset, exact, prefix, suffix, note, range } */
    const anchors = new Map();

    /** 当前会话（由 composer.dock 的桥组件发布） */
    const sessionStore = { id: null, listeners: new Set() };

    function setSession(id) {
      const next = id || null;
      if (sessionStore.id === next) return;
      sessionStore.id = next;
      for (const fn of sessionStore.listeners) {
        try {
          fn(next);
        } catch (_) {}
      }
    }

    function subscribeSession(fn) {
      sessionStore.listeners.add(fn);
      return () => sessionStore.listeners.delete(fn);
    }

    /** 主输入框动作：SessionBridge 从 composer.dock 的 inputActions 捕获；缺失时回注降级 */
    const composerStore = { inputActions: null };

    function setComposerInputActions(actions) {
      composerStore.inputActions = actions && typeof actions === 'object' ? actions : null;
    }

    function getComposerInputActions() {
      return composerStore.inputActions;
    }

    /** 回注主对话：内容前缀 / 默认方式 / 请求封装 */
    const REINJECT_PREFIX = '【学习笔记回注】';

    function normalizeReinjectMode(value) {
      return value === 'inject' ? 'inject' : 'draft';
    }

    function normalizeProviderMode(value) {
      return value === 'custom' ? 'custom' : 'native';
    }

    function newInjectionId() {
      return 'inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    async function fetchReinjectSummary(payload) {
      const res = await fetch('/study-notes/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data || {};
    }

    async function injectToMain(payload) {
      const res = await fetch('/study-notes/inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok) {
        const error = new Error((data && data.error) || 'HTTP ' + res.status);
        error.status = res.status;
        throw error;
      }
      return data || {};
    }

    /**
     * 右栏 tab 的视图状态：list（当前会话的笔记列表）| note（单条笔记的分支对话）。
     * tab body 在右栏 slot 里，浮层在 shell.overlay slot 里，跨 slot 不共享 React 树，
     * 所以“点高亮/问这个 → 打开 tab 并定位到这条笔记”靠这个模块级 store 交接。
     */
    const tabUi = { view: 'list', activeId: null, listeners: new Set() };

    function setTabUi(patch) {
      let changed = false;
      for (const key of Object.keys(patch)) {
        if (tabUi[key] === patch[key]) continue;
        tabUi[key] = patch[key];
        changed = true;
      }
      if (!changed) return;
      for (const fn of Array.from(tabUi.listeners)) {
        try {
          fn();
        } catch (_) {}
      }
    }

    function subscribeTabUi(fn) {
      tabUi.listeners.add(fn);
      return () => tabUi.listeners.delete(fn);
    }

    /** 当前会话里请求打开右栏 tab 的监听者（由 SessionBridge 注册，openTab 只在会话挂载后调用） */
    const tabOpenListeners = new Set();

    function subscribeTabOpen(fn) {
      tabOpenListeners.add(fn);
      return () => tabOpenListeners.delete(fn);
    }

    function requestTabOpen() {
      for (const fn of Array.from(tabOpenListeners)) {
        try {
          fn();
        } catch (_) {}
      }
    }

    /** 真正的 openTab，由 apply() 在 sidebarRight 服务就绪后填写 */
    let openNotesTab = () => {};

    /** apply() 保存的客户端 ctx（定位功能用 ctx.sessions.binding） */
    let pluginCtx = null;

    /** SessionBridge 上一次绑定的会话；只有真的换会话才把 tab 切回列表（避免 composer 重挂载丢视图） */
    let bridgedSessionId = null;

    /** 打开右栏并切到指定笔记；重复调用由 sidebarRight 的默认去重收敛到同一个 tab */
    function showNote(id) {
      setTabUi({ view: 'note', activeId: id });
      requestTabOpen();
    }

    function hasHighlightApi() {
      return (
        typeof window !== 'undefined' &&
        window.CSS &&
        window.CSS.highlights &&
        typeof window.Highlight === 'function'
      );
    }

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById('dsh-sn-style')) return;
      const el = document.createElement('style');
      el.id = 'dsh-sn-style';
      el.textContent =
        '::highlight(' +
        HIGHLIGHT +
        '){background-color:rgba(79,124,255,.22);text-decoration:underline;text-decoration-color:#4f7cff;text-decoration-thickness:2px;text-underline-offset:3px;}';
      document.head.appendChild(el);
    }

    function applyHighlights() {
      if (!hasHighlightApi()) return;
      ensureStyle();
      const ranges = [];
      for (const a of anchors.values()) {
        if (a.range && a.range.startContainer.isConnected) ranges.push(a.range);
      }
      if (ranges.length) window.CSS.highlights.set(HIGHLIGHT, new window.Highlight(...ranges));
      else window.CSS.highlights.delete(HIGHLIGHT);
    }

    // ── 存储：按会话隔离 ─────────────────────────────────────────────
    function storageKey(sessionId) {
      return STORAGE_PREFIX + sessionId;
    }

    function save() {
      const sid = sessionStore.id;
      if (!sid) return;
      try {
        const rows = [];
        for (const a of anchors.values()) {
          rows.push({
            id: a.id,
            seatKey: a.seatKey,
            nodeKey: a.nodeKey,
            startOffset: a.startOffset,
            endOffset: a.endOffset,
            exact: a.exact,
            prefix: a.prefix,
            suffix: a.suffix,
            note: a.note,
            messages: Array.isArray(a.messages) ? a.messages : [],
            lastReinject: a.lastReinject || null,
          });
        }
        localStorage.setItem(storageKey(sid), JSON.stringify(rows));
      } catch (_) {}
    }

    function loadForSession(sessionId) {
      try {
        const raw = localStorage.getItem(storageKey(sessionId));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    function anchorFromRow(sessionId, row) {
      return {
        id: row.id,
        sessionId,
        seatKey: row.seatKey || null,
        nodeKey: row.nodeKey || null,
        startOffset: typeof row.startOffset === 'number' ? row.startOffset : -1,
        endOffset: typeof row.endOffset === 'number' ? row.endOffset : -1,
        exact: row.exact,
        prefix: row.prefix || '',
        suffix: row.suffix || '',
        note: row.note || '',
        messages: Array.isArray(row.messages) ? row.messages : [],
        lastReinject: row.lastReinject && typeof row.lastReinject === 'object' ? row.lastReinject : null,
        range: null,
      };
    }

    /** 优先取内存里的锚点；右栏 body 先于浮层加载时，从存储里还原一份用于展示 */
    function resolveNote(sessionId, id) {
      const held = anchors.get(id);
      if (held && held.sessionId === sessionId) return held;
      if (!sessionId || !id) return null;
      const row = loadForSession(sessionId).find((item) => item && item.id === id && item.exact);
      return row ? anchorFromRow(sessionId, row) : null;
    }

    // ── 模型配置：沿用原有的 localStorage 键（apiKey 已迁出配置 schema）──
    const LEGACY_CFG_KEY = 'dsh-study-notes/model';

    function loadCfg() {
      const empty = {
        providerMode: 'native',
        baseURL: '',
        model: '',
        thinking: true,
        thinkingFormat: 'none',
        memory: false,
        memoryWindow: MEMORY_DEFAULT_WINDOW,
        reinjectMode: 'draft',
      };
      try {
        const raw = localStorage.getItem(LEGACY_CFG_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return empty;
        // 旧版明文 apiKey 不属于配置 schema：设置页会迁移到 Host 加密存储后删除
        return {
          providerMode: normalizeProviderMode(parsed.providerMode),
          baseURL: parsed.baseURL || '',
          model: parsed.model || '',
          thinking: parsed.thinking !== false,
          thinkingFormat: normalizeThinkingFormat(parsed.thinkingFormat),
          memory: parsed.memory === true,
          memoryWindow: normalizeMemoryWindow(parsed.memoryWindow),
          reinjectMode: normalizeReinjectMode(parsed.reinjectMode),
        };
      } catch (_) {
        return empty;
      }
    }

    function persistCfg(next) {
      try {
        localStorage.setItem('dsh-study-notes/model', JSON.stringify(next));
      } catch (_) {}
    }

    /** 全局设置（设置 → 学习笔记）与右栏 tab 的跨 slot 同步事件 */
    const CONFIG_EVENT = 'dsh-study-notes-config';

    function dispatchConfigChange() {
      try {
        if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
          window.dispatchEvent(new window.CustomEvent(CONFIG_EVENT));
        }
      } catch (_) {}
    }

    function subscribeConfigChange(fn) {
      try {
        window.addEventListener(CONFIG_EVENT, fn);
        return () => window.removeEventListener(CONFIG_EVENT, fn);
      } catch (_) {
        return () => {};
      }
    }

    // ── API Key 安全存储（Host 加密）：页面只拿 configured + 脱敏 preview ──
    const SECRET_API_PATH = '/study-notes/secret';

    async function fetchSecretStatus() {
      const res = await fetch(SECRET_API_PATH, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return {
        configured: !!(data && data.configured === true),
        preview: data && typeof data.preview === 'string' ? data.preview : '',
      };
    }

    async function postSecretKey(apiKey) {
      const res = await fetch(SECRET_API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data || {};
    }

    async function deleteSecretKey() {
      const res = await fetch(SECRET_API_PATH, { method: 'DELETE' });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data || {};
    }

    /** 旧版配置里残留的明文 apiKey（只用于一次性迁移，不进入 loadCfg） */
    function readLegacyApiKey() {
      try {
        const raw = localStorage.getItem(LEGACY_CFG_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
      } catch (_) {
        return '';
      }
    }

    function removeLegacyApiKey() {
      try {
        const raw = localStorage.getItem(LEGACY_CFG_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, 'apiKey')) {
          return false;
        }
        delete parsed.apiKey;
        localStorage.setItem(LEGACY_CFG_KEY, JSON.stringify(parsed));
        return true;
      } catch (_) {
        return false;
      }
    }

    /**
     * 旧版明文 apiKey 的一次性迁移（设置页打开或右栏 tab 挂载时触发，in-flight 去重）。
     * 成功：POST 到 Host 加密存储 + 从 localStorage 删除 + 广播 CONFIG_EVENT。
     * 失败：保留明文等设置页重试；设置页会明确警告并移除明文（见设置分区）。
     */
    let legacyMigrationInFlight = null;

    function migrateLegacyApiKeyOnce() {
      if (!readLegacyApiKey()) return Promise.resolve({ ok: true, migrated: false });
      if (legacyMigrationInFlight) return legacyMigrationInFlight;
      legacyMigrationInFlight = (async () => {
        try {
          const data = await postSecretKey(readLegacyApiKey());
          removeLegacyApiKey();
          dispatchConfigChange();
          return {
            ok: true,
            migrated: true,
            preview: data && typeof data.preview === 'string' ? data.preview : '',
          };
        } catch (error) {
          return { ok: false, migrated: false, error };
        } finally {
          legacyMigrationInFlight = null;
        }
      })();
      return legacyMigrationInFlight;
    }

    // ── 记忆查看/编辑：Host 的 /study-notes/memory 路由 ────────────────
    async function fetchMemoryState(sessionId) {
      const res = await fetch('/study-notes/memory?sessionId=' + encodeURIComponent(sessionId || ''));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function postMemory(payload) {
      const res = await fetch('/study-notes/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok || !data) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data;
    }

    // ── 文本映射与座位定位 ───────────────────────────────────────────
    function inPluginUi(node) {
      let el = node && (node.nodeType === 1 ? node : node.parentElement);
      while (el) {
        if (el.classList) {
          for (const c of el.classList) {
            if (c.indexOf('dsh-sn-') === 0) return true;
          }
        }
        el = el.parentElement;
      }
      return false;
    }

    function buildTextMap(root) {
      const rootEl = root && root.nodeType === 1 ? root : document.body;
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
          if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (inPluginUi(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const recs = [];
      let text = '';
      let n;
      while ((n = walker.nextNode())) {
        recs.push({ node: n, start: text.length });
        text += n.nodeValue;
      }
      return { text, recs };
    }

    function rangeFromOffsets(recs, start, end) {
      let sNode = null;
      let sOff = 0;
      let eNode = null;
      let eOff = 0;
      for (const rec of recs) {
        const len = rec.node.nodeValue.length;
        if (!sNode && start < rec.start + len) {
          sNode = rec.node;
          sOff = start - rec.start;
        }
        if (!eNode && end <= rec.start + len) {
          eNode = rec.node;
          eOff = end - rec.start;
          break;
        }
      }
      if (!sNode || !eNode) return null;
      const r = document.createRange();
      try {
        r.setStart(sNode, sOff);
        r.setEnd(eNode, eOff);
      } catch (_) {
        return null;
      }
      return r;
    }

    function offsetsOfRange(range, recs) {
      let start = -1;
      let end = -1;
      for (const rec of recs) {
        if (rec.node === range.startContainer) start = rec.start + range.startOffset;
        if (rec.node === range.endContainer) end = rec.start + range.endOffset;
      }
      if (start < 0 || end < 0) return null;
      return { start, end };
    }

    function closestSeat(node) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el) return null;
      return el.closest(SEAT_SELECTOR) || el.closest(NODE_SELECTOR) || null;
    }

    function seatKeys(seat) {
      if (!seat) return { seatKey: null, nodeKey: null };
      return {
        seatKey: seat.getAttribute('data-chat-flow-key'),
        nodeKey: seat.getAttribute('data-chat-node-key'),
      };
    }

    function findSeat(anchor) {
      if (anchor.seatKey) {
        const all = document.querySelectorAll(SEAT_SELECTOR);
        for (const el of all) {
          if (el.getAttribute('data-chat-flow-key') === anchor.seatKey) return el;
        }
      }
      if (anchor.nodeKey) {
        const all = document.querySelectorAll(NODE_SELECTOR);
        const cands = [];
        for (const el of all) {
          if (el.getAttribute('data-chat-node-key') === anchor.nodeKey) cands.push(el);
        }
        if (cands.length === 1) return cands[0];
        for (const el of cands) {
          const { text } = buildTextMap(el);
          if (anchor.exact && text.indexOf(anchor.exact) !== -1) return el;
        }
        if (cands.length) return cands[0];
      }
      return null;
    }

    function squeeze(s) {
      return s.replace(/\s+/g, '');
    }

    function squeezedMap(raw) {
      let sq = '';
      const map = [];
      for (let i = 0; i < raw.length; i++) {
        if (!/\s/.test(raw[i])) {
          sq += raw[i];
          map.push(i);
        }
      }
      return { sq, map };
    }

    function resolveAnchor(anchor) {
      const seat = findSeat(anchor);
      if (seat) {
        const { text, recs } = buildTextMap(seat);
        if (text) {
          if (
            anchor.exact &&
            anchor.startOffset >= 0 &&
            anchor.endOffset > anchor.startOffset &&
            text.slice(anchor.startOffset, anchor.endOffset) === anchor.exact
          ) {
            return rangeFromOffsets(recs, anchor.startOffset, anchor.endOffset);
          }
          if (anchor.exact) {
            const occ = [];
            let i = text.indexOf(anchor.exact);
            while (i !== -1) {
              occ.push(i);
              i = text.indexOf(anchor.exact, i + 1);
            }
            if (occ.length) {
              let best = -1;
              let bestScore = -Infinity;
              for (const s of occ) {
                let score = 0;
                if (anchor.prefix && text.slice(Math.max(0, s - anchor.prefix.length), s) === anchor.prefix) score += 2;
                const e = s + anchor.exact.length;
                if (anchor.suffix && text.slice(e, e + anchor.suffix.length) === anchor.suffix) score += 2;
                score -= Math.abs(s - (anchor.startOffset || 0)) / 1000;
                if (score > bestScore) {
                  bestScore = score;
                  best = s;
                }
              }
              if (best >= 0) return rangeFromOffsets(recs, best, best + anchor.exact.length);
            }
            const key = squeeze(anchor.exact);
            const { sq, map } = squeezedMap(text);
            const j = sq.indexOf(key);
            if (j !== -1) {
              const last = j + key.length - 1;
              return rangeFromOffsets(recs, map[j], map[last] + 1);
            }
          }
        }
      }
      // 最后兜底：如果 DOM 上没有座位属性，按文本回到全页搜索
      return locateFallback(anchor.exact);
    }

    // ── 兜底：全页文本搜索（仅在座位属性缺失时使用）───────────────────
    function findMainScroll() {
      let best = null;
      let bestArea = 0;
      const all = document.querySelectorAll('div,section,main,article');
      for (const el of all) {
        const st = getComputedStyle(el);
        if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 4) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      return best;
    }

    function locateFallback(text) {
      const key = squeeze(text || '');
      if (!key) return null;
      const main = findMainScroll() || document.body;
      const { text: raw, recs } = buildTextMap(main);
      const { sq, map } = squeezedMap(raw);
      const i = sq.indexOf(key);
      if (i < 0) return null;
      const last = i + key.length - 1;
      return rangeFromOffsets(recs, map[i], map[last] + 1);
    }

    // ── 其它 ─────────────────────────────────────────────────────────
    function editable(node) {
      let el = node && (node.nodeType === 1 ? node : node.parentElement);
      while (el) {
        if (el.isContentEditable) return true;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
        el = el.parentElement;
      }
      return false;
    }

    function caretAt(x, y) {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (!p) return null;
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
      return null;
    }

    function uid() {
      return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /** 复制文本：返回 Promise<boolean>；clipboard 可能异步 reject，失败时回退 execCommand */
    function copyText(t) {
      if (!t) return Promise.resolve(false);
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = t;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return Promise.resolve(ok !== false);
        } catch (_) {
          return Promise.resolve(false);
        }
      };
      try {
        if (!navigator || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          return fallback();
        }
        const pending = navigator.clipboard.writeText(t);
        if (pending && typeof pending.then === 'function') {
          return pending.then(
            () => true,
            () => fallback(),
          );
        }
        return Promise.resolve(true);
      } catch (_) {
        return fallback();
      }
    }

    // ── 定位到主对话：滚动 + 分页重试 + 闪烁（只依赖 data-* 属性契约）──
    const SCROLLER_SELECTOR = '[data-conversation-scroll]';
    const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]';
    const FLASH_HIGHLIGHT = 'dsh-study-note-flash';
    const FLASH_CLASS = 'dsh-sn-flash-outline';
    const LOCATE_MAX_PAGES = 8;
    const LOCATE_MAX_MS = 3000;

    function sessionBindingFor(sessionId) {
      if (!sessionId) return null;
      try {
        const sessions = pluginCtx && pluginCtx.sessions;
        if (!sessions || typeof sessions.binding !== 'function') return null;
        return sessions.binding(sessionId) || null;
      } catch (_) {
        return null;
      }
    }

    function sleepMs(ms) {
      return new Promise((resolve) => {
        try {
          window.setTimeout(resolve, ms);
        } catch (_) {
          setTimeout(resolve, ms);
        }
      });
    }

    function afterFrame(fn) {
      try {
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            try {
              fn();
            } catch (_) {}
          });
          return;
        }
      } catch (_) {}
      try {
        window.setTimeout(fn, 16);
      } catch (_) {}
    }

    function prefersReducedMotion() {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (_) {
        return false;
      }
    }

    function isElementVisible(el) {
      if (!el || typeof el.getClientRects !== 'function') return false;
      try {
        return el.getClientRects().length > 0;
      } catch (_) {
        return false;
      }
    }

    function findElementByAttribute(name, value) {
      if (!value) return null;
      try {
        const all = document.querySelectorAll('[' + name + ']');
        for (const el of all) {
          if (el.getAttribute(name) === value) return el;
        }
      } catch (_) {}
      return null;
    }

    function findVisibleByAttribute(name, value) {
      if (!value) return null;
      try {
        const all = document.querySelectorAll('[' + name + ']');
        for (const el of all) {
          if (el.getAttribute(name) === value && isElementVisible(el)) return el;
        }
      } catch (_) {}
      return null;
    }

    function visibleBand(scroller) {
      const rect = scroller.getBoundingClientRect();
      let bottom = rect.bottom;
      try {
        const composer = scroller.querySelector(COMPOSER_SEAT_SELECTOR);
        if (composer && typeof composer.getBoundingClientRect === 'function') {
          const composerRect = composer.getBoundingClientRect();
          if (composerRect && Number.isFinite(composerRect.top)) bottom = Math.min(bottom, composerRect.top);
        }
      } catch (_) {}
      return { top: rect.top + 8, bottom: bottom - 8 };
    }

    /** 把 Range 的第一个矩形滚动到可见带（已扣除 sticky composer）的中间 */
    function scrollRangeIntoBand(scroller, range) {
      if (!scroller || !range || typeof range.getClientRects !== 'function') return false;
      let rects = null;
      try {
        rects = range.getClientRects();
      } catch (_) {
        return false;
      }
      const first = rects && rects[0];
      if (!first) return false;
      const band = visibleBand(scroller);
      const target = band.top + (band.bottom - band.top - (first.height || 0)) / 2;
      const delta = first.top - target;
      if (Math.abs(delta) > 2) scroller.scrollTop += delta;
      return true;
    }

    function scrollElementIntoBand(scroller, el) {
      if (!scroller || !el || typeof el.getBoundingClientRect !== 'function') return false;
      const rect = el.getBoundingClientRect();
      if (!rect) return false;
      const band = visibleBand(scroller);
      const target = band.top + (band.bottom - band.top - (rect.height || 0)) / 2;
      const delta = rect.top - target;
      if (Math.abs(delta) > 2) scroller.scrollTop += delta;
      return true;
    }

    let flashSerial = 0;
    let flashClear = null;

    function clearFlashVisual() {
      if (!flashClear) return;
      try {
        flashClear();
      } catch (_) {}
      flashClear = null;
    }

    /** 同一时刻只允许一个闪烁；prefers-reduced-motion 时单次 1.2s */
    function flashRange(range, el) {
      clearFlashVisual();
      flashSerial += 1;
      const serial = flashSerial;
      const hasRange =
        hasHighlightApi() &&
        range &&
        range.startContainer &&
        range.startContainer.isConnected !== false &&
        (() => {
          try {
            return range.getClientRects().length > 0;
          } catch (_) {
            return false;
          }
        })();
      let paint = null;
      let clear = null;
      if (hasRange) {
        paint = () => {
          if (!range.startContainer || range.startContainer.isConnected === false) return false;
          try {
            window.CSS.highlights.set(FLASH_HIGHLIGHT, new window.Highlight(range));
            return true;
          } catch (_) {
            return false;
          }
        };
        clear = () => {
          if (!hasHighlightApi()) return;
          try {
            window.CSS.highlights.delete(FLASH_HIGHLIGHT);
          } catch (_) {}
        };
      } else if (el && el.classList) {
        paint = () => {
          try {
            el.classList.add(FLASH_CLASS);
            return true;
          } catch (_) {
            return false;
          }
        };
        clear = () => {
          try {
            el.classList.remove(FLASH_CLASS);
          } catch (_) {}
        };
      } else {
        return;
      }
      flashClear = clear;
      const finish = () => {
        if (serial === flashSerial) clearFlashVisual();
      };
      (async () => {
        if (prefersReducedMotion()) {
          if (!paint()) return finish();
          await sleepMs(1200);
          return finish();
        }
        if (!hasRange) {
          // 无 Highlight API / 零 rect：退化为一次性临时 outline ~1.5s
          if (!paint()) return finish();
          await sleepMs(1500);
          return finish();
        }
        for (let i = 0; i < 3; i += 1) {
          if (serial !== flashSerial) return;
          if (!paint()) break;
          await sleepMs(400);
          if (serial !== flashSerial) return;
          clear();
          if (i < 2) await sleepMs(250);
        }
        finish();
      })().catch(() => finish());
    }

    async function waitLoadingOlderIdle(session, deadline) {
      if (!session) return;
      for (let i = 0; i < 80; i += 1) {
        if (session.loadingOlder !== true || Date.now() > deadline) return;
        await sleepMs(25);
      }
    }

    /** 等待 [data-chat-flow] 附近 DOM 静默 ~120ms（上限兜底） */
    function waitDomQuiet(quietMs, maxMs) {
      return new Promise((resolve) => {
        let finished = false;
        let lastMutation = Date.now();
        const started = Date.now();
        let observer = null;
        let poll = 0;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (observer) {
            try {
              observer.disconnect();
            } catch (_) {}
          }
          if (poll) {
            try {
              window.clearInterval(poll);
            } catch (_) {}
          }
          resolve();
        };
        try {
          if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(() => {
              lastMutation = Date.now();
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }
        } catch (_) {
          observer = null;
        }
        try {
          poll = window.setInterval(() => {
            const now = Date.now();
            if (now - started >= maxMs || now - lastMutation >= quietMs) finish();
          }, 20);
        } catch (_) {
          finish();
        }
      });
    }

    /** 行被折叠/隐藏时的近似落点：nodeKey 行 → 同 turn 可见行 → 分组头（最后） */
    function locateFallbackTarget(anchor, seat) {
      const nodeRow = anchor && anchor.nodeKey ? findElementByAttribute('data-chat-node-key', anchor.nodeKey) : null;
      if (nodeRow && isElementVisible(nodeRow)) return { el: nodeRow, approximate: false };
      const turn =
        (nodeRow && nodeRow.getAttribute ? nodeRow.getAttribute('data-chat-turn') : '') ||
        (seat && seat.getAttribute ? seat.getAttribute('data-chat-turn') : '');
      if (turn) {
        const turnRow = findVisibleByAttribute('data-chat-turn', turn);
        if (turnRow) return { el: turnRow, approximate: true };
      }
      const groupSource = nodeRow || seat;
      const group = groupSource && groupSource.closest ? groupSource.closest('[data-chat-group-key]') : null;
      if (group) {
        if (isElementVisible(group)) return { el: group, approximate: true };
        const header = group.firstElementChild;
        if (header && isElementVisible(header)) return { el: header, approximate: true };
      }
      return null;
    }

    // ── 分支提问：错误分类与自动重试 ─────────────────────────────────
    function abortError() {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return err;
    }

    function isAbortError(e) {
      return !!(e && e.name === 'AbortError');
    }

    function sleepAbortable(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(abortError());
          return;
        }
        let timer = 0;
        const onAbort = () => {
          if (timer) window.clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(abortError());
        };
        timer = window.setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        if (signal) signal.addEventListener('abort', onAbort);
      });
    }

    function shortRaw(e) {
      const raw = String((e && e.message) || e || '未知错误')
        .replace(/\s+/g, ' ')
        .trim();
      return raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
    }

    function rawBodySnippet(e) {
      const body = String((e && e.body) || '')
        .replace(/\s+/g, ' ')
        .trim();
      return body.length > 100 ? body.slice(0, 100) + '…' : body;
    }

    /** 真实故障 → 简短中文原因；原始信息由调用方追加在括号里 */
    function askErrorReason(e) {
      const status = e && typeof e.status === 'number' ? e.status : 0;
      const raw = shortRaw(e);
      if (status === 401 || status === 403) return '模型鉴权失败（检查自定义 API Key 或账号状态）';
      if (status === 400) return '请求被拒绝：' + (rawBodySnippet(e) || raw);
      if (status === 404) return '接口不存在（检查 API 地址）';
      if (status === 429) return '请求过于频繁';
      if (status === 409 || status === 422) return '请求被拒绝：' + (rawBodySnippet(e) || raw);
      if (status >= 500) return '服务端故障：' + status;
      return raw;
    }

    /** 网络波动/网关错误可重试；真实故障或已经出字后一律不重试 */
    function isTransientAskError(e) {
      if (!e || isAbortError(e)) return false;
      if (e.hasContent) return false;
      const status = typeof e.status === 'number' ? e.status : 0;
      const text = String(e.message || '') + ' ' + String(e.body || '');
      if (status === 400 || status === 401 || status === 403 || status === 404) return false;
      if (status === 409 || status === 422 || status === 429) return false;
      if (status === 502 || status === 503 || status === 504) return true;
      if (status >= 500) return TRANSIENT_RE.test(text);
      if (status) return false;
      if (e.streamError) return TRANSIENT_RE.test(text);
      return e.name === 'TypeError' || TRANSIENT_RE.test(text);
    }

    /** 错误气泡 / 非 markdown：用纯文本渲染 */
    function isPlainAssistantMessage(m) {
      if (!m || m.role !== 'assistant') return true;
      if (m.error) return true;
      const text = String(m.text == null ? '' : m.text);
      return !text || text.indexOf('⚠️ ') === 0 || text === '（已停止）' || text === '（没有返回内容）';
    }

    /** 流式状态 / 截断提示参数 */
    const STALL_SECONDS = 15;
    const TRUNCATION_FINISH = new Set(['length', 'max_tokens', 'max-tokens', 'length_limit', 'truncated']);

    /** finish 原因是否意味着回答被单次输出上限截断（并非网络问题） */
    function isTruncatedAnswer(m) {
      if (!m || m.role !== 'assistant' || m.error) return false;
      const finish = String(m.finish == null ? '' : m.finish).toLowerCase();
      return TRUNCATION_FINISH.has(finish);
    }

    // ── 导出：Markdown / Word(.docx)，零依赖，纯客户端生成 ─────────────
    const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    function formatDate(d) {
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function noteTitle(a) {
      const first = String((a && a.exact) || '').trim().split('\n')[0].trim();
      return first.length > 42 ? first.slice(0, 42) + '…' : first || '未命名笔记';
    }

    function noteMessages(a) {
      return a && Array.isArray(a.messages) ? a.messages : [];
    }

    function xmlEscape(text) {
      return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }

    function buildMarkdown(notes, date) {
      const out = ['# 学习笔记', '', '导出日期：' + date + '　共 ' + notes.length + ' 条笔记', ''];
      notes.forEach((a, i) => {
        out.push('## ' + (i + 1) + '. ' + noteTitle(a));
        out.push('');
        out.push(
          String(a.exact || '')
            .split(/\r?\n/)
            .map((line) => '> ' + line)
            .join('\n'),
        );
        out.push('');
        const msgs = noteMessages(a);
        if (!msgs.length) {
          out.push('（暂无对话）');
          out.push('');
          return;
        }
        for (const m of msgs) {
          const label = m && m.role === 'user' ? '**我**：' : '**AI**：';
          out.push(label + String(m && m.text != null ? m.text : ''));
          out.push('');
        }
      });
      return out.join('\n');
    }

    function wRun(text, opts) {
      const o = opts || {};
      const props = (o.bold ? '<w:b/>' : '') + (o.italic ? '<w:i/>' : '');
      return (
        '<w:r>' +
        (props ? '<w:rPr>' + props + '</w:rPr>' : '') +
        '<w:t xml:space="preserve">' +
        xmlEscape(text) +
        '</w:t></w:r>'
      );
    }

    function wPara(runs, style) {
      return (
        '<w:p>' +
        (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') +
        runs +
        '</w:p>'
      );
    }

    function buildDocx(notes, date) {
      const paras = [];
      paras.push(wPara(wRun('学习笔记', { bold: true }), 'Title'));
      paras.push(wPara(wRun('导出日期：' + date + '　共 ' + notes.length + ' 条笔记')));
      notes.forEach((a, i) => {
        paras.push(wPara(wRun((i + 1) + '. ' + noteTitle(a), { bold: true }), 'Heading1'));
        for (const line of String(a.exact || '').split(/\r?\n/)) {
          paras.push(wPara(wRun(line, { italic: true }), 'Quote'));
        }
        const msgs = noteMessages(a);
        if (!msgs.length) paras.push(wPara(wRun('（暂无对话）')));
        for (const m of msgs) {
          const label = m && m.role === 'user' ? '我：' : 'AI：';
          paras.push(wPara(wRun(label, { bold: true }) + wRun(String(m && m.text != null ? m.text : ''))));
        }
      });
      const documentXml =
        XML_DECL +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        paras.join('') +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
      const stylesXml =
        XML_DECL +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>' +
        '</w:styles>';
      const contentTypesXml =
        XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '</Types>';
      const relsXml =
        XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>';
      const docRelsXml =
        XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>';
      return zipStore([
        { name: '[Content_Types].xml', data: utf8(contentTypesXml) },
        { name: '_rels/.rels', data: utf8(relsXml) },
        { name: 'word/document.xml', data: utf8(documentXml) },
        { name: 'word/styles.xml', data: utf8(stylesXml) },
        { name: 'word/_rels/document.xml.rels', data: utf8(docRelsXml) },
      ]);
    }

    function utf8(text) {
      return new TextEncoder().encode(String(text));
    }

    function concatBytes(parts) {
      let size = 0;
      for (const part of parts) size += part.length;
      const out = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    }

    /** 极简 ZIP 写入器（store 不压缩）：本地文件头 + 中央目录 + EOCD */
    function zipStore(files) {
      const now = new Date();
      const dosTime =
        ((now.getHours() & 31) << 11) |
        ((now.getMinutes() & 63) << 5) |
        (Math.floor(now.getSeconds() / 2) & 31);
      const dosDate =
        (((now.getFullYear() - 1980) & 127) << 9) |
        (((now.getMonth() + 1) & 15) << 5) |
        (now.getDate() & 31);
      const locals = [];
      const central = [];
      let offset = 0;
      for (const file of files) {
        const name = utf8(file.name);
        const data = file.data;
        const crc = crc32(data);
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);
        local.set(name, 30);
        locals.push(local, data);
        const dir = new Uint8Array(46 + name.length);
        const dv = new DataView(dir.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, dosTime, true);
        dv.setUint16(14, dosDate, true);
        dv.setUint32(16, crc, true);
        dv.setUint32(20, data.length, true);
        dv.setUint32(24, data.length, true);
        dv.setUint16(28, name.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, offset, true);
        dir.set(name, 46);
        central.push(dir);
        offset += local.length + data.length;
      }
      const centralSize = central.reduce((n, part) => n + part.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);
      return concatBytes(locals.concat(central, [end]));
    }

    const CRC_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      return table;
    })();

    function crc32(bytes) {
      let c = 0xffffffff;
      for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    }

    /** 返回是否成功触发下载（浏览器拦截/异常时返回 false，让调用方给出可见提示） */
    function downloadBlob(blob, filename) {
      let url = '';
      try {
        url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (_) {
        return false;
      } finally {
        if (url) {
          setTimeout(() => {
            try {
              URL.revokeObjectURL(url);
            } catch (_) {}
          }, 1000);
        }
      }
      return true;
    }

    /**
     * 导出范围：ids 为数组时严格只导出这些笔记（空数组 = 不导出任何笔记）；
     * ids 为 null/undefined 时才导出当前会话全部笔记。
     */
    function collectExportNotes(sessionId, ids) {
      const restricted = Array.isArray(ids);
      const wanted = restricted ? new Set(ids) : null;
      const out = [];
      const seen = new Set();
      for (const row of sessionId ? loadForSession(sessionId) : []) {
        if (!row || !row.id || !row.exact) continue;
        if (restricted && !wanted.has(row.id)) continue;
        const held = anchors.get(row.id);
        out.push(held && held.sessionId === sessionId ? held : row);
        seen.add(row.id);
      }
      for (const a of anchors.values()) {
        if (a.sessionId !== sessionId || !a.exact || seen.has(a.id)) continue;
        if (restricted && !wanted.has(a.id)) continue;
        out.push(a);
        seen.add(a.id);
      }
      return out;
    }

    /** 返回 { ok, count, reason }：empty=无可导出笔记，blocked=下载被浏览器拦截 */
    function exportNotesToFile(sessionId, ids, format) {
      const notes = collectExportNotes(sessionId, ids);
      if (!notes.length) return { ok: false, count: 0, reason: 'empty' };
      const date = formatDate(new Date());
      let downloaded = false;
      if (format === 'md') {
        const text = buildMarkdown(notes, date);
        downloaded = downloadBlob(
          new Blob([text], { type: 'text/markdown;charset=utf-8' }),
          '学习笔记-' + date + '.md',
        );
      } else {
        const bytes = buildDocx(notes, date);
        downloaded = downloadBlob(new Blob([bytes], { type: DOCX_TYPE }), '学习笔记-' + date + '.docx');
      }
      return downloaded ? { ok: true, count: notes.length } : { ok: false, count: notes.length, reason: 'blocked' };
    }

    const CSS = `
::highlight(${HIGHLIGHT}){
  background-color: rgba(79,124,255,.22);
  text-decoration: underline;
  text-decoration-color: #4f7cff;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
::highlight(${FLASH_HIGHLIGHT}){ background-color: rgba(79,124,255,.55); }
.dsh-sn-menu{
  position: fixed; z-index: 2147483000; pointer-events: auto;
  min-width: 140px; padding: 4px; border-radius: 10px; font-size: 13px; user-select: none;
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  background: var(--dsw-alias-bg-overlay);
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 34%, transparent);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
.dsh-sn-item{ padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.dsh-sn-item:hover{ background: var(--dsw-alias-bg-layer-2); }
.dsh-sn-tab{ position: relative; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; flex: 1 1 auto; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-sn-head{ display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-weight: 600; flex: none; }
.dsh-sn-head-left{ display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-sn-sub{ font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-actions{ display: flex; align-items: center; gap: 6px; }
.dsh-sn-btn{ border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.dsh-sn-btn:hover{ background: var(--dsw-alias-bg-layer-2); }
.dsh-sn-quote{ margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); max-height: 96px; overflow: auto; line-height: 1.5; white-space: pre-wrap; flex: none; }
.dsh-sn-ta{ margin: 10px 12px; padding: 8px 10px; min-height: 72px; resize: vertical; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; outline: none; }
.dsh-sn-hint{ padding: 0 12px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; }
.dsh-sn-body{ display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dsh-sn-transcript{ display: flex; flex-direction: column; gap: 8px; margin: 10px 12px; flex: 1 1 auto; min-height: 0; overflow: auto; }
.dsh-sn-msg{ padding: 8px 10px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dsh-sn-msg-user{ align-self: flex-end; background: var(--dsw-alias-bg-layer-2); }
.dsh-sn-msg-ai{ align-self: flex-start; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-sn-empty{ color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-sn-list{ display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px 12px; }
.dsh-sn-row{ display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 8px 10px; border-radius: 8px; cursor: pointer; text-align: left; color: inherit; font: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-sn-row:hover{ background: var(--dsw-alias-bg-layer-2); }
.dsh-sn-row-quote{ line-height: 1.5; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dsh-sn-row-meta{ font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-input{ display: flex; gap: 8px; margin: 10px 12px; align-items: flex-end; flex: none; }
.dsh-sn-input .dsh-sn-ta{ margin: 0; flex: 1; }
.dsh-sn-send{ border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; background: #4f7cff; color: #fff; font-size: 13px; }
.dsh-sn-send:hover{ opacity: .9; }
.dsh-sn-send:disabled{ opacity: .5; cursor: default; }
.dsh-sn-cfg{ display: flex; flex-direction: column; gap: 6px; margin: 10px 12px 0; flex: none; }
.dsh-sn-cfg-input{ padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 12px; outline: none; }
.dsh-sn-cfg-hint{ color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4; }
.dsh-sn-cfg-check{ display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-sn-cfg-window{ display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-cfg-window .dsh-sn-cfg-input{ flex: 1; font-size: 12px; }
.dsh-sn-mem{ display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.dsh-sn-mem-status{ font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; }
.dsh-sn-mem-ta{ width: 100%; box-sizing: border-box; min-height: 96px; resize: vertical; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 12px; line-height: 1.5; outline: none; }
.dsh-sn-mem-actions{ display: flex; gap: 6px; flex-wrap: wrap; }
.dsh-sn-mem-msg{ font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; }
.dsh-sn-confirm{ position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.35); }
.dsh-sn-dialog{ width: 280px; max-width: calc(100% - 32px); border-radius: 12px; padding: 16px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 16px 48px rgba(0,0,0,.3); font-size: 13px; }
.dsh-sn-dialog-title{ font-weight: 600; margin-bottom: 8px; }
.dsh-sn-dialog-body{ color: var(--dsw-alias-label-secondary); line-height: 1.5; margin-bottom: 14px; }
.dsh-sn-dialog-row{ display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sn-dialog .dsh-sn-btn{ padding: 6px 12px; font-size: 13px; }
.dsh-sn-danger{ color: #fff; background: var(--dsw-alias-state-error-primary); }
.dsh-sn-danger:hover{ opacity: .9; background: var(--dsw-alias-state-error-primary); }
.dsh-sn-reinjectbar{ display: flex; align-items: center; gap: 8px; margin: 8px 12px 0; flex-wrap: wrap; flex: none; }
.dsh-sn-reinject-dialog{ width: 360px; max-width: calc(100% - 24px); }
.dsh-sn-toast{ position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 9; max-width: calc(100% - 24px); padding: 6px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 20px rgba(0,0,0,.18); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-sn-flash-outline{ outline: 2px solid #4f7cff; outline-offset: 2px; border-radius: 6px; }
.dsh-sn-row-open{ flex: none; align-self: flex-start; padding: 2px 8px; font-size: 12px; }
.dsh-sn-list-wrap{ display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dsh-sn-listbar{ display: flex; align-items: center; gap: 6px; padding: 8px 12px 0; flex: none; flex-wrap: wrap; }
.dsh-sn-selbar{ display: flex; align-items: center; gap: 6px; padding: 6px 12px 0; flex: none; flex-wrap: wrap; }
.dsh-sn-exportbar{ display: flex; align-items: center; gap: 6px; padding: 6px 12px 0; flex: none; flex-wrap: wrap; }
.dsh-sn-listbar .dsh-sn-btn{ padding: 3px 8px; }
.dsh-sn-row-wrap{ display: flex; align-items: flex-start; gap: 8px; }
.dsh-sn-row-wrap .dsh-sn-row{ flex: 1 1 auto; min-width: 0; }
.dsh-sn-row-selected .dsh-sn-row{ border-color: rgba(79,124,255,.55); }
.dsh-sn-check{ flex: none; width: 14px; height: 14px; margin: 9px 0 0; accent-color: #4f7cff; cursor: pointer; }
.dsh-sn-feedback{ margin: 6px 12px 0; padding: 5px 10px; border-radius: 6px; font-size: 12px; flex: none; }
.dsh-sn-feedback-ok{ color: #4f7cff; background: rgba(79,124,255,.12); }
.dsh-sn-feedback-warn{ color: var(--dsw-alias-state-error-primary); background: rgba(0,0,0,.06); }
.dsh-sn-btn:disabled{ opacity: .45; cursor: default; }
.dsh-sn-btn:disabled:hover{ background: transparent; }
.dsh-sn-msg-md{ min-width: 0; max-width: 100%; white-space: normal; }
.dsh-sn-msg-md > div{ max-width: 100%; }
.dsh-sn-msg-md pre{ max-width: 100%; overflow: auto; }
.dsh-sn-msg-md table{ display: block; max-width: 100%; overflow: auto; }
.dsh-sn-msg-md img{ max-width: 100%; }
.dsh-sn-msg-md .katex-display{ max-width: 100%; overflow-x: auto; }
.dsh-sn-trunc{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: rgba(255,171,0,.12); border: 1px solid rgba(255,171,0,.45); }
.dsh-sn-trunc-text{ font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-sn-trunc-hint{ flex-basis: 100%; font-size: 11px; }
.dsh-sn-trunc-btn{ padding: 2px 10px; }
.dsh-sn-status{ display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 6px 10px; border-radius: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); flex: none; }
.dsh-sn-status-retry{ color: var(--dsw-alias-label-primary); border-color: rgba(79,124,255,.45); background: rgba(79,124,255,.10); }
.dsh-sn-status-stall{ border-color: rgba(255,171,0,.5); background: rgba(255,171,0,.10); }
.dsh-sn-spinner{ width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid rgba(79,124,255,.25); border-top-color: #4f7cff; animation: dsh-sn-spin .9s linear infinite; }
@keyframes dsh-sn-spin{ to{ transform: rotate(360deg); } }
.dsh-sn-foot{ flex: none; padding: 0 12px 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4; text-align: center; }
.dsh-sn-set{ display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-sn-set-group{ display: flex; flex-direction: column; gap: 8px; }
.dsh-sn-set-title{ font-weight: 600; font-size: 13px; }
.dsh-sn-set-desc, .dsh-sn-set-hint{ color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-sn-set-field{ display: flex; flex-direction: column; gap: 6px; }
.dsh-sn-set-label{ font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-sn-set-input{ width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 13px; outline: none; }
.dsh-sn-set-check{ display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.dsh-sn-set-row{ display: flex; align-items: center; gap: 8px; }
.dsh-sn-set-row .dsh-sn-set-input{ flex: 1; }
.dsh-sn-set-sep{ height: 1px; background: var(--dsw-alias-border-l1); }
.dsh-sn-set-keyrow{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-sn-set-keyrow .dsh-sn-set-input{ flex: 1; min-width: 180px; }
.dsh-sn-set-preview{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; padding: 4px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-sn-set-notice{ padding: 6px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: rgba(79,124,255,.10); border: 1px solid rgba(79,124,255,.35); }
.dsh-sn-set-notice-warn{ background: rgba(255,171,0,.12); border-color: rgba(255,171,0,.45); }
.dsh-sn-set-warn, .dsh-sn-warn{ color: var(--dsw-alias-state-error-primary); }
`;

    // 会话桥：挂在 session 作用域的 composer.dock，发布 sessionId / 捕获主输入框动作 / 会话内执行 openTab
    function SessionBridge(props) {
      React.useEffect(() => {
        setSession(props.sessionId);
        const next = props.sessionId || null;
        if (bridgedSessionId !== next) {
          bridgedSessionId = next;
          setTabUi({ view: 'list', activeId: null });
        }
      }, [props.sessionId]);
      React.useEffect(() => {
        setComposerInputActions(props.inputActions);
        return () => setComposerInputActions(null);
      }, [props.inputActions]);
      React.useEffect(() => subscribeTabOpen(() => openNotesTab()), []);
      return null;
    }

    function Overlay() {
      const [menu, setMenu] = React.useState(null);
      const [sessionId, setSessionIdState] = React.useState(sessionStore.id);
      const last = React.useRef(null);
      const menuRef = React.useRef(null);
      const reconcileTimer = React.useRef(0);

      menuRef.current = menu;

      const reconcileNow = React.useCallback(() => {
        for (const a of anchors.values()) {
          if (!a.range || !a.range.startContainer.isConnected) {
            a.range = resolveAnchor(a);
          }
        }
        applyHighlights();
      }, []);

      React.useEffect(() => subscribeSession((id) => setSessionIdState(id)), []);

      React.useEffect(() => {
        // 切会话：关菜单、清高亮、只加载当前会话的锚点
        setMenu(null);
        anchors.clear();
        if (hasHighlightApi()) window.CSS.highlights.delete(HIGHLIGHT);
        if (sessionId) {
          const rows = loadForSession(sessionId);
          for (const row of rows) {
            if (!row || !row.id || !row.exact) continue;
            anchors.set(row.id, anchorFromRow(sessionId, row));
          }
        }
        reconcileNow();
      }, [sessionId, reconcileNow]);

      React.useEffect(() => {
        function scheduleReconcile() {
          if (reconcileTimer.current) return;
          reconcileTimer.current = window.setTimeout(() => {
            reconcileTimer.current = 0;
            reconcileNow();
          }, 260);
        }

        const mo = new MutationObserver(() => scheduleReconcile());
        mo.observe(document.body, { childList: true, subtree: true });
        const onVis = () => scheduleReconcile();
        const onScroll = () => scheduleReconcile();
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('focus', onVis);
        document.addEventListener('scroll', onScroll, true);
        const iv = window.setInterval(() => {
          for (const a of anchors.values()) {
            if (!a.range || !a.range.startContainer.isConnected) {
              scheduleReconcile();
              break;
            }
          }
        }, 1200);
        return () => {
          mo.disconnect();
          document.removeEventListener('visibilitychange', onVis);
          window.removeEventListener('focus', onVis);
          document.removeEventListener('scroll', onScroll, true);
          clearInterval(iv);
          if (reconcileTimer.current) {
            clearTimeout(reconcileTimer.current);
            reconcileTimer.current = 0;
          }
        };
      }, [reconcileNow]);

      React.useEffect(() => {
        function onUp() {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const text = sel.toString().trim();
          if (!text || editable(sel.anchorNode)) return;
          last.current = { text, range: sel.getRangeAt(0).cloneRange(), at: Date.now() };
        }

        function onCtx(e) {
          let text = '';
          let snapshot = null;
          const sel = window.getSelection();
          if (sel && sel.rangeCount && !editable(sel.anchorNode)) {
            text = sel.toString().trim();
            if (text) snapshot = sel.getRangeAt(0).cloneRange();
          }
          if (!text && last.current && Date.now() - last.current.at < 5000) {
            text = last.current.text;
            snapshot = last.current.range;
          }
          if (!text || !snapshot) return;
          e.preventDefault();
          last.current = { text, range: snapshot, at: Date.now() };
          setMenu({ x: e.clientX, y: e.clientY });
        }

        function onDown(e) {
          if (e.button !== 0) return;
          if (menuRef.current && !(e.target.closest && e.target.closest('[data-dsh-sn-menu]'))) {
            setMenu(null);
          }
          if (e.target.closest && e.target.closest('[data-dsh-sn-menu]')) return;
          const r = caretAt(e.clientX, e.clientY);
          if (!r) return;
          for (const a of anchors.values()) {
            if (a.range && a.range.isPointInRange(r.startContainer, r.startOffset)) {
              showNote(a.id);
              return;
            }
          }
        }

        function onKey(e) {
          if (e.key === 'Escape') setMenu(null);
        }

        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('contextmenu', onCtx, true);
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mouseup', onUp, true);
          document.removeEventListener('contextmenu', onCtx, true);
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, []);

      const addAnchor = () => {
        const snap = last.current;
        setMenu(null);
        if (!snap) return;
        const sid = sessionStore.id;
        if (!sid) return;
        const seat = closestSeat(snap.range.startContainer);
        if (!seat) return;
        const { text, recs } = buildTextMap(seat);
        const off = offsetsOfRange(snap.range, recs);
        const start = off ? off.start : -1;
        const end = off ? off.end : -1;
        const exact = off && end > start ? text.slice(start, end) : snap.text;
        if (!exact) return;
        const keys = seatKeys(seat);
        for (const a of anchors.values()) {
          if (a.seatKey === keys.seatKey && a.exact === exact) {
            showNote(a.id);
            return;
          }
        }
        const id = uid();
        const anchor = {
          id,
          sessionId: sid,
          seatKey: keys.seatKey,
          nodeKey: keys.nodeKey,
          startOffset: start,
          endOffset: end,
          exact,
          prefix: start >= 0 ? text.slice(Math.max(0, start - 16), start) : '',
          suffix: end >= 0 ? text.slice(end, end + 16) : '',
          note: '',
          messages: [],
          lastReinject: null,
          range: null,
        };
        anchor.range = resolveAnchor(anchor) || snap.range.cloneRange();
        anchors.set(id, anchor);
        save();
        applyHighlights();
        showNote(id);
      };

      const copySel = () => {
        copyText(last.current && last.current.text);
        setMenu(null);
      };

      const menuEl = menu
        ? h(
            'div',
            {
              'data-dsh-sn-menu': '1',
              className: 'dsh-sn-menu',
              style: {
                left: Math.min(menu.x, window.innerWidth - 168) + 'px',
                top: Math.min(menu.y, window.innerHeight - 96) + 'px',
              },
              onMouseDown: (e) => e.stopPropagation(),
            },
            h('div', { className: 'dsh-sn-item', onClick: copySel }, '复制'),
            h('div', { className: 'dsh-sn-item', onClick: addAnchor }, '问这个'),
          )
        : null;

      // 浮层只保留高亮绘制 + 右键菜单 + 划选守卫；笔记 UI 全部在右侧栏 tab 里
      return h(React.Fragment, null, h('style', null, CSS), menuEl);
    }

    /**
     * DSH 设置页 → 「学习笔记」：模型来源（内置/自定义）+ 自定义 API 配置 + 记忆/回注。
     * API Key 由 Host 加密保存，页面只显示 configured + 脱敏 preview；旧版 localStorage
     * 里的明文 apiKey 在分区首次挂载时迁移到 /study-notes/secret 后删除。
     */
    function StudyNotesSettings() {
      const [cfg, setCfg] = React.useState(loadCfg);
      const [secretState, setSecretState] = React.useState({
        loading: true,
        configured: false,
        preview: '',
        error: '',
      });
      const [keyInput, setKeyInput] = React.useState('');
      const [secretBusy, setSecretBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const update = (patch) => {
        const next = Object.assign({}, cfg, patch);
        delete next.apiKey; // 配置 schema 不含明文 Key
        setCfg(next);
        persistCfg(next);
        dispatchConfigChange();
      };

      const refreshSecret = () => {
        setSecretState((prev) => Object.assign({}, prev, { loading: true, error: '' }));
        fetchSecretStatus()
          .then((data) => {
            setSecretState({ loading: false, configured: data.configured, preview: data.preview, error: '' });
          })
          .catch(() => {
            setSecretState({
              loading: false,
              configured: false,
              preview: '',
              error: '读取 Key 状态失败：请确认已完全重启 DSH 后重试',
            });
          });
      };

      React.useEffect(() => {
        let live = true;
        refreshSecret();
        migrateLegacyApiKeyOnce().then((result) => {
          if (!live || !result) return;
          if (result.migrated) {
            setSecretState({ loading: false, configured: true, preview: result.preview || '', error: '' });
            setNotice({
              kind: 'ok',
              text:
                'API Key 已迁移到加密存储' +
                (cfg.baseURL && cfg.model
                  ? '。如需继续使用自定义 API，请在上方「模型来源」中选择「使用自定义 API」。'
                  : '。'),
            });
          } else if (result.ok === false) {
            // 安全优先：迁移失败也把旧明文 apiKey 从 localStorage 移除，提示用户重启后重填
            removeLegacyApiKey();
            setNotice({
              kind: 'warn',
              text:
                'API Key 迁移失败：Host 不可用或尚未重启。旧明文 Key 已从本机配置移除，' +
                '请完全重启 DSH 后重新打开本设置页并保存 Key。新保存的 Key 绝不会写入明文。',
            });
          }
        });
        return () => {
          live = false;
        };
      }, []);

      const saveKey = async () => {
        const value = keyInput.trim();
        if (!value || secretBusy) return;
        setSecretBusy(true);
        setNotice(null);
        try {
          const data = await postSecretKey(value);
          setKeyInput(''); // 保存成功后立刻从内存/DOM 清除输入
          setSecretState({
            loading: false,
            configured: true,
            preview: data && typeof data.preview === 'string' ? data.preview : '',
            error: '',
          });
          setNotice({ kind: 'ok', text: 'Key 已保存到加密存储；页面只显示脱敏 preview。' });
          dispatchConfigChange();
        } catch (_) {
          setNotice({ kind: 'warn', text: 'Key 保存失败：请确认已完全重启 DSH 后重试（不会保存明文）。' });
        } finally {
          setSecretBusy(false);
        }
      };

      const removeKey = async () => {
        if (secretBusy) return;
        setSecretBusy(true);
        setNotice(null);
        try {
          await deleteSecretKey();
          setSecretState({ loading: false, configured: false, preview: '', error: '' });
          setNotice({ kind: 'ok', text: '已删除保存的 Key；如需更换请重新输入。' });
          dispatchConfigChange();
        } catch (_) {
          setNotice({ kind: 'warn', text: '删除失败：请确认已完全重启 DSH 后重试。' });
        } finally {
          setSecretBusy(false);
        }
      };

      const field = (label, input) =>
        h(
          'label',
          { className: 'dsh-sn-set-field' },
          h('span', { className: 'dsh-sn-set-label' }, label),
          input,
        );

      const secretConfigured = secretState.configured === true;
      const customMode = cfg.providerMode === 'custom';

      const customGroup = customMode
        ? [
            h('div', { className: 'dsh-sn-set-sep' }),
            h(
              'div',
              { className: 'dsh-sn-set-group' },
              h('div', { className: 'dsh-sn-set-title' }, '自定义 API'),
              h(
                'div',
                { className: 'dsh-sn-set-desc' },
                '仅「使用自定义 API」时生效；Key 由 Host 加密保存，页面只能看到脱敏 preview。',
              ),
              field(
                'API 地址',
                h('input', {
                  className: 'dsh-sn-set-input',
                  placeholder: '如 https://api.deepseek.com',
                  value: cfg.baseURL,
                  onChange: (e) => update({ baseURL: e.target.value }),
                }),
              ),
              field(
                '模型',
                h('input', {
                  className: 'dsh-sn-set-input',
                  placeholder: '如 deepseek-chat',
                  value: cfg.model,
                  onChange: (e) => update({ model: e.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'dsh-sn-set-field' },
                h('span', { className: 'dsh-sn-set-label' }, 'API Key'),
                secretState.loading
                  ? h('div', { className: 'dsh-sn-set-hint' }, '读取 Key 状态中…')
                  : secretState.error
                    ? h(
                        'div',
                        { className: 'dsh-sn-set-hint dsh-sn-set-warn' },
                        secretState.error + ' ',
                        h('button', { className: 'dsh-sn-btn', onClick: refreshSecret }, '重试'),
                      )
                    : secretConfigured
                      ? h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { className: 'dsh-sn-set-keyrow' },
                            h(
                              'span',
                              { className: 'dsh-sn-set-preview', 'data-dsh-sn-secret-preview': '1' },
                              secretState.preview || '已配置',
                            ),
                            h(
                              'button',
                              { className: 'dsh-sn-btn', disabled: secretBusy, onClick: removeKey },
                              '删除',
                            ),
                          ),
                          h(
                            'div',
                            { className: 'dsh-sn-set-hint' },
                            '出于安全，Key 保存后不可查看、不可修改；如需更换请删除后重新输入。',
                          ),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { className: 'dsh-sn-set-keyrow' },
                            h('input', {
                              className: 'dsh-sn-set-input',
                              type: 'password',
                              placeholder: '粘贴完整 API Key（保存后不可再查看）',
                              value: keyInput,
                              onChange: (e) => setKeyInput(e.target.value),
                            }),
                            h(
                              'button',
                              {
                                className: 'dsh-sn-btn',
                                disabled: secretBusy || !keyInput.trim(),
                                onClick: saveKey,
                              },
                              '保存',
                            ),
                          ),
                          h(
                            'div',
                            { className: 'dsh-sn-set-hint' },
                            '保存后只显示前 7 位与后 4 位；完整 Key 永远不会返回浏览器。',
                          ),
                        ),
              ),
            ),
          ]
        : [
            h(
              'div',
              { className: 'dsh-sn-set-hint' },
              '当前使用 DSH 内置模型，绝不会调用自定义 API；如需 OpenAI 兼容的自定义接口，可切换为「使用自定义 API」。',
            ),
          ];

      return h(
        'div',
        { className: 'dsh-sn-set', 'data-dsh-sn-settings': 'study-notes' },
        notice
          ? h(
              'div',
              {
                className:
                  'dsh-sn-set-notice' + (notice.kind === 'warn' ? ' dsh-sn-set-notice-warn' : ''),
              },
              notice.text,
            )
          : null,
        h(
          'div',
          { className: 'dsh-sn-set-group' },
          h('div', { className: 'dsh-sn-set-title' }, '模型来源'),
          field(
            '模型来源',
            h(
              'select',
              {
                className: 'dsh-sn-set-input',
                value: customMode ? 'custom' : 'native',
                onChange: (e) => update({ providerMode: normalizeProviderMode(e.target.value) }),
              },
              h('option', { value: 'native' }, '使用 DSH 内置模型（默认）'),
              h('option', { value: 'custom' }, '使用自定义 API'),
            ),
          ),
          h(
            'div',
            { className: 'dsh-sn-set-hint' },
            customMode
              ? '自定义模式只调用下面的 OpenAI 兼容接口，不会回退到 DSH 内置模型。'
              : 'DSH 内置模型模式不会使用任何自定义 API。',
          ),
        ),
        ...customGroup,
        h('div', { className: 'dsh-sn-set-sep' }),
        h(
          'div',
          { className: 'dsh-sn-set-group' },
          h('div', { className: 'dsh-sn-set-title' }, '模型'),
          h(
            'label',
            { className: 'dsh-sn-set-check' },
            h('input', {
              type: 'checkbox',
              checked: cfg.thinking !== false,
              onChange: (e) => update({ thinking: e.target.checked }),
            }),
            h('span', null, '思考'),
          ),
          h(
            'label',
            { className: 'dsh-sn-set-field' },
            h('span', { className: 'dsh-sn-set-label' }, '思考参数格式'),
            h(
              'select',
              {
                className: 'dsh-sn-set-input',
                value: normalizeThinkingFormat(cfg.thinkingFormat),
                onChange: (e) => update({ thinkingFormat: e.target.value }),
              },
              THINKING_FORMATS.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
          ),
          h(
            'div',
            { className: 'dsh-sn-set-hint' },
            '思考格式只对自定义 API 生效；使用 DSH 内置模型时由 DSH 自身控制。',
          ),
        ),
        h('div', { className: 'dsh-sn-set-sep' }),
        h(
          'div',
          { className: 'dsh-sn-set-group' },
          h('div', { className: 'dsh-sn-set-title' }, '记忆'),
          h(
            'label',
            { className: 'dsh-sn-set-check' },
            h('input', {
              type: 'checkbox',
              checked: cfg.memory === true,
              onChange: (e) => update({ memory: e.target.checked }),
            }),
            h('span', null, '开启记忆'),
          ),
          h(
            'label',
            { className: 'dsh-sn-set-field' },
            h('span', { className: 'dsh-sn-set-label' }, '主对话窗口条数'),
            h(
              'select',
              {
                className: 'dsh-sn-set-input',
                value: String(normalizeMemoryWindow(cfg.memoryWindow)),
                disabled: cfg.memory !== true,
                onChange: (e) => update({ memoryWindow: normalizeMemoryWindow(e.target.value) }),
              },
              MEMORY_WINDOWS.map((count) => h('option', { key: count, value: String(count) }, count + ' 条')),
            ),
          ),
          h(
            'div',
            { className: 'dsh-sn-set-hint' },
            '记忆默认关闭：开启后每次提问会附带主对话摘要 + 最近窗口条数的原始主对话（本机缓存、无 token 上限；首次提问只用最近原文）。',
          ),
        ),
        h('div', { className: 'dsh-sn-set-sep' }),
        h(
          'div',
          { className: 'dsh-sn-set-group' },
          h('div', { className: 'dsh-sn-set-title' }, '回注'),
          h(
            'label',
            { className: 'dsh-sn-set-field' },
            h('span', { className: 'dsh-sn-set-label' }, '回注方式'),
            h(
              'select',
              {
                className: 'dsh-sn-set-input',
                value: normalizeReinjectMode(cfg.reinjectMode),
                onChange: (e) => update({ reinjectMode: normalizeReinjectMode(e.target.value) }),
              },
              h('option', { value: 'draft' }, '预填草稿（默认）'),
              h('option', { value: 'inject' }, '直接注入'),
            ),
          ),
          h(
            'div',
            { className: 'dsh-sn-set-hint' },
            '回注方式只决定弹窗里的默认按钮：预填只写入主输入框、不发送；直接注入会作为一条【学习笔记回注】通知消息进入主对话，失败会自动改为预填。',
          ),
        ),
      );
    }

    // 右栏 tab：当前会话的笔记列表 ↔ 单条笔记的分支对话；全局配置在 设置 → 学习笔记
    function StudyNotesTab(props) {
      const sessionId = props.sessionId || sessionStore.id;
      const [, forceUi] = React.useState(0);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [askStatus, setAskStatus] = React.useState('');
      const [silentSec, setSilentSec] = React.useState(0);
      const [memoryOpen, setMemoryOpen] = React.useState(false);
      const [confirmId, setConfirmId] = React.useState(null);
      const [confirmBatch, setConfirmBatch] = React.useState(false);
      const [selected, setSelected] = React.useState(() => new Set());
      const [exportOpen, setExportOpen] = React.useState(false);
      const [exportHint, setExportHint] = React.useState(null);
      const [cfg, setCfg] = React.useState(loadCfg);
      const [secretState, setSecretState] = React.useState({
        loading: true,
        configured: false,
        preview: '',
        error: '',
      });
      const [memoryState, setMemoryState] = React.useState(null);
      const [memoryDraft, setMemoryDraft] = React.useState('');
      const [memoryBusy, setMemoryBusy] = React.useState(false);
      const [memoryMsg, setMemoryMsg] = React.useState('');
      const [reinjectOpen, setReinjectOpen] = React.useState(false);
      const [reinjectText, setReinjectText] = React.useState('');
      const [reinjectBusy, setReinjectBusy] = React.useState(false);
      const [reinjectMsg, setReinjectMsg] = React.useState('');
      const [toast, setToast] = React.useState('');
      const abortRef = React.useRef(null);
      const reinjectIdRef = React.useRef('');
      const toastTimer = React.useRef(0);
      const hintTimer = React.useRef(0);
      const locateInFlightRef = React.useRef(false);
      const transcriptRef = React.useRef(null);
      const stickRef = React.useRef(true);
      const forceScrollRef = React.useRef(false);
      const lastActivityRef = React.useRef(Date.now());

      React.useEffect(() => subscribeTabUi(() => forceUi((v) => (v + 1) | 0)), []);

      /** 设置页改动配置/Key 后广播 CONFIG_EVENT：重读配置 + Key 状态，无需刷新页面 */
      React.useEffect(() => {
        let live = true;
        const refreshSecret = () => {
          fetchSecretStatus()
            .then((data) => {
              if (!live) return;
              setSecretState({ loading: false, configured: data.configured, preview: data.preview, error: '' });
            })
            .catch(() => {
              if (live) setSecretState({ loading: false, configured: false, preview: '', error: 'Key 状态读取失败' });
            });
        };
        refreshSecret();
        const off = subscribeConfigChange(() => {
          setCfg(loadCfg());
          refreshSecret();
        });
        // 打开右栏也可触发旧明文 Key 迁移（不必等用户进设置页；与设置页共享 in-flight 去重）
        migrateLegacyApiKeyOnce().then((result) => {
          if (!live || !result || !result.migrated) return;
          refreshSecret();
        });
        return () => {
          live = false;
          off();
        };
      }, []);

      const rows = sessionId ? loadForSession(sessionId) : [];
      const notes = rows.filter((row) => row && row.id && row.exact);
      const noteId = tabUi.view === 'note' ? tabUi.activeId : null;
      const current = noteId ? resolveNote(sessionId, noteId) : null;
      const selectedNotes = notes.filter((row) => selected.has(row.id));
      const allSelected = notes.length > 0 && selectedNotes.length === notes.length;
      const providerMode = cfg.providerMode === 'custom' ? 'custom' : 'native';
      const customIncomplete =
        providerMode === 'custom' &&
        (!String(cfg.baseURL || '').trim() ||
          !String(cfg.model || '').trim() ||
          secretState.configured !== true);

      React.useEffect(() => {
        setConfirmId(null);
        setConfirmBatch(false);
        setDraft('');
        setAskStatus('');
        setSelected(new Set());
        setExportOpen(false);
        setExportHint(null);
        setReinjectOpen(false);
        setReinjectText('');
        setReinjectBusy(false);
        setReinjectMsg('');
        if (hintTimer.current) {
          window.clearTimeout(hintTimer.current);
          hintTimer.current = 0;
        }
      }, [noteId, sessionId]);

      React.useEffect(
        () => () => {
          if (hintTimer.current) window.clearTimeout(hintTimer.current);
          if (toastTimer.current) window.clearTimeout(toastTimer.current);
        },
        [],
      );

      /** 转录区自动滚动：进入/切换笔记时强制贴底；流式更新仅在用户仍贴底时跟随 */
      useIsoLayoutEffect(() => {
        stickRef.current = true;
        forceScrollRef.current = true;
      }, [noteId]);

      useIsoLayoutEffect(() => {
        const force = forceScrollRef.current;
        forceScrollRef.current = false;
        if (force) stickRef.current = true;
        if (!force && !stickRef.current) return;
        const el = transcriptRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });

      const handleTranscriptScroll = () => {
        const el = transcriptRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICK_THRESHOLD;
      };

      /** 流式 liveness：忙时每秒刷新一次“静默秒数”，空闲清空 */
      React.useEffect(() => {
        if (!busy) {
          setSilentSec(0);
          return undefined;
        }
        lastActivityRef.current = Date.now();
        setSilentSec(0);
        const iv = window.setInterval(() => {
          const sec = Math.floor((Date.now() - lastActivityRef.current) / 1000);
          setSilentSec(sec > 0 ? sec : 0);
        }, 1000);
        return () => window.clearInterval(iv);
      }, [busy]);

      /** 打开「记忆」面板且记忆开启时读取 Host 端摘要状态（失败给出友好提示，不影响提问） */
      React.useEffect(() => {
        if (!memoryOpen || cfg.memory !== true || !sessionId) return undefined;
        let live = true;
        setMemoryMsg('');
        fetchMemoryState(sessionId)
          .then((state) => {
            if (!live) return;
            setMemoryState(state);
            setMemoryDraft(state && state.digest ? state.digest : '');
          })
          .catch(() => {
            if (live) setMemoryMsg('摘要读取失败：Host 未更新或未重启');
          });
        return () => {
          live = false;
        };
      }, [memoryOpen, cfg.memory, sessionId]);

      const runMemoryAction = async (action) => {
        if (memoryBusy || cfg.memory !== true || !sessionId) return;
        setMemoryBusy(true);
        setMemoryMsg(action === 'rebuild' ? '正在重新生成摘要…' : '');
        try {
          const payload = { sessionId, action };
          if (action === 'save') payload.digest = memoryDraft;
          const data = await postMemory(payload);
          if (data.state) {
            setMemoryState(data.state);
            setMemoryDraft(data.state.digest || '');
          }
          setMemoryMsg(
            data.ok === false
              ? data.error || '操作未完成'
              : action === 'save'
                ? '已保存'
                : action === 'rebuild'
                  ? '已重新生成'
                  : '已清空',
          );
        } catch (e) {
          const reason = e && e.message ? e.message : '未知错误';
          setMemoryMsg(
            (action === 'save' ? '保存失败' : action === 'rebuild' ? '重新生成失败' : '清空失败') + '：' + reason,
          );
        } finally {
          setMemoryBusy(false);
        }
      };

      const memoryStatusText = () => {
        if (cfg.memory !== true) return '记忆已关闭';
        if (memoryBusy) return '处理中…';
        if (!memoryState) return '读取摘要中…';
        if (!memoryState.exists) {
          return '尚无摘要：提出第一个问题后自动生成（首次提问只用最近主对话）';
        }
        const gap = Math.max(0, (memoryState.seq || 0) - (memoryState.coveredSeq || 0));
        const parts = ['覆盖到 ' + gap + ' 条前'];
        if (memoryState.updatedAt) parts.push('更新于 ' + formatDateTime(memoryState.updatedAt));
        if (memoryState.edited) parts.push('已手改');
        if (memoryState.persisted) parts.push('已本地保存');
        if (memoryState.building) parts.push('后台更新中');
        return parts.join(' · ');
      };

      // ── 回注主对话：生成要点 → 预填草稿（默认）/ 直接注入（失败回退预填）──
      const showToast = (text) => {
        setToast(text);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => {
          toastTimer.current = 0;
          setToast('');
        }, 3200);
      };

      const reinjectFullText = () => {
        const text = String(reinjectText || '').trim();
        return text.indexOf(REINJECT_PREFIX) === 0 ? text : REINJECT_PREFIX + '\n' + text;
      };

      const rememberReinject = (anchor, text, mode) => {
        if (!anchor) return;
        const record = anchors.get(anchor.id) || anchor;
        record.lastReinject = { summary: text, at: Date.now(), mode: normalizeReinjectMode(mode) };
        if (!anchors.has(record.id) && sessionStore.id === record.sessionId) anchors.set(record.id, record);
        save();
      };

      const closeReinject = () => {
        setReinjectOpen(false);
        setReinjectText('');
        setReinjectBusy(false);
        setReinjectMsg('');
      };

      const summarizeReinject = async (anchor) => {
        setReinjectBusy(true);
        setReinjectMsg('');
        reinjectIdRef.current = newInjectionId();
        try {
          const data = await fetchReinjectSummary({
            sessionId: anchor.sessionId || sessionId || '',
            quote: anchor.exact,
            messages: (Array.isArray(anchor.messages) ? anchor.messages : []).map((m) => ({
              role: m.role,
              text: m.text,
            })),
          });
          const summary = String(data && data.summary ? data.summary : '').trim();
          if (!summary) throw new Error('摘要为空');
          setReinjectText(REINJECT_PREFIX + '\n' + summary);
        } catch (e) {
          const last = anchor.lastReinject && anchor.lastReinject.summary ? String(anchor.lastReinject.summary) : '';
          if (last) {
            setReinjectText(last.indexOf(REINJECT_PREFIX) === 0 ? last : REINJECT_PREFIX + '\n' + last);
            setReinjectMsg('摘要生成失败，已载入上次回注内容');
          } else {
            setReinjectText(REINJECT_PREFIX + '\n');
            setReinjectMsg('摘要生成失败：' + (e && e.message ? e.message : '未知错误'));
          }
        } finally {
          setReinjectBusy(false);
        }
      };

      const openReinject = () => {
        const anchor = current;
        if (!anchor) return;
        setReinjectOpen(true);
        setReinjectText(REINJECT_PREFIX + '\n');
        summarizeReinject(anchor);
      };

      const openReinjectLast = () => {
        const anchor = current;
        if (!anchor || !anchor.lastReinject || !anchor.lastReinject.summary) return;
        reinjectIdRef.current = newInjectionId();
        setReinjectOpen(true);
        setReinjectBusy(false);
        setReinjectMsg('');
        const last = String(anchor.lastReinject.summary);
        setReinjectText(last.indexOf(REINJECT_PREFIX) === 0 ? last : REINJECT_PREFIX + '\n' + last);
      };

      const finishReinject = (anchor, mode, text, toastText) => {
        rememberReinject(anchor, text, mode);
        closeReinject();
        forceUi((v) => (v + 1) | 0);
        showToast(
          toastText ||
            (mode === 'inject' ? '已注入主对话（可在主对话中展开查看）' : '已填入主输入框，请确认后发送'),
        );
      };

      const prefillReinject = (toastText) => {
        const anchor = current;
        if (!anchor) return;
        const text = reinjectFullText();
        const actions = getComposerInputActions();
        if (!actions || typeof actions.setDraft !== 'function') {
          setReinjectMsg('主输入框不可用：请手动复制以下内容');
          return;
        }
        try {
          actions.setDraft(text);
        } catch (_) {
          setReinjectMsg('主输入框不可用：请手动复制以下内容');
          return;
        }
        finishReinject(anchor, 'draft', text, toastText);
      };

      const deliverReinject = async () => {
        const anchor = current;
        if (!anchor || reinjectBusy) return;
        const text = reinjectFullText();
        setReinjectBusy(true);
        setReinjectMsg('');
        try {
          const data = await injectToMain({
            sessionId: anchor.sessionId || sessionId || '',
            text,
            noteId: anchor.id,
            injectionId: reinjectIdRef.current || newInjectionId(),
          });
          if (data && data.duplicate) {
            finishReinject(anchor, 'inject', text, '这条回注已注入过，未重复发送');
          } else {
            const durable = !!(data && data.durable);
            finishReinject(
              anchor,
              'inject',
              text,
              durable
                ? '已写入主对话（重启后仍保留，可在主对话中展开查看）'
                : '已排队到主对话，将在下一步生效（尚未落盘）',
            );
          }
        } catch (e) {
          const fallbackToast =
            e && e.status === 409 ? '会话不在运行中，已改为填入输入框' : '注入失败，已改为填入输入框';
          const actions = getComposerInputActions();
          if (actions && typeof actions.setDraft === 'function') {
            try {
              actions.setDraft(text);
              finishReinject(anchor, 'draft', text, fallbackToast);
            } catch (_) {
              setReinjectMsg('注入失败，且无法填入输入框：请手动复制');
            }
          } else {
            setReinjectMsg('注入失败，且无法填入输入框：请手动复制');
          }
        } finally {
          setReinjectBusy(false);
        }
      };

      // ── 定位到主对话：分页重试 + 滚动 + 闪烁 ─────────────────────────
      const locateAnchor = async (anchor) => {
        if (!anchor) return;
        // 会话桥可能尚未发布 sessionId：未知时不判不匹配，交给后续解析自然处理
        const knownSessionId =
          typeof sessionStore.id === 'string' && sessionStore.id.length > 0 ? sessionStore.id : null;
        if (knownSessionId && anchor.sessionId !== knownSessionId) {
          showToast('该笔记属于其他会话，请先切换会话');
          return;
        }
        if (busy || locateInFlightRef.current) return;
        locateInFlightRef.current = true;
        const startedAt = Date.now();
        const deadline = startedAt + LOCATE_MAX_MS;
        const handleMissingText = async () => {
          const copied = await copyText(anchor.exact);
          showToast(
            copied
              ? '原文已不在当前对话中（可能被编辑或已压缩）；已复制原文'
              : '原文已不在当前对话中（复制失败，请手动复制）',
          );
        };
        let paged = false;
        try {
          const binding = sessionBindingFor(anchor.sessionId);
          const session = binding && binding.session ? binding.session : null;
          let seat = findSeat(anchor);
          let range = seat ? resolveAnchor(anchor) : null;
          for (let page = 0; page < LOCATE_MAX_PAGES && !seat; page += 1) {
            if (Date.now() - startedAt > LOCATE_MAX_MS || Date.now() > deadline) break;
            const canPage =
              session &&
              session.hasMore === true &&
              session.loadingOlder !== true &&
              typeof session.loadOlder === 'function';
            if (!canPage) break;
            if (!paged) {
              showToast('正在加载更早的对话…');
              paged = true;
            }
            try {
              await session.loadOlder();
            } catch (_) {
              break;
            }
            if (Date.now() - startedAt > LOCATE_MAX_MS) break;
            await waitLoadingOlderIdle(session, deadline);
            await waitDomQuiet(120, 700);
            if (Date.now() - startedAt > LOCATE_MAX_MS) break;
            seat = findSeat(anchor);
            range = seat ? resolveAnchor(anchor) : null;
          }
          const scroller = (seat && seat.closest ? seat.closest(SCROLLER_SELECTOR) : null) || findMainScroll();
          if (!scroller) {
            showToast('请先切回对话视图，再进行定位');
            return;
          }
          if (!seat || !range) {
            await handleMissingText();
            return;
          }
          let rangeRects = null;
          try {
            rangeRects = range.getClientRects();
          } catch (_) {
            rangeRects = null;
          }
          if (rangeRects && rangeRects.length) {
            scrollRangeIntoBand(scroller, range);
            afterFrame(() => scrollRangeIntoBand(scroller, range));
            try {
              window.setTimeout(() => {
                if (range.startContainer && range.startContainer.isConnected !== false) {
                  scrollRangeIntoBand(scroller, range);
                }
              }, 300);
            } catch (_) {}
            flashRange(range, seat);
            return;
          }
          const fallback = locateFallbackTarget(anchor, seat);
          if (fallback && fallback.el && isElementVisible(fallback.el)) {
            scrollElementIntoBand(scroller, fallback.el);
            afterFrame(() => scrollElementIntoBand(scroller, fallback.el));
            try {
              window.setTimeout(() => {
                if (fallback.el.isConnected !== false) scrollElementIntoBand(scroller, fallback.el);
              }, 300);
            } catch (_) {}
            flashRange(null, fallback.el);
            if (fallback.approximate) showToast('已定位到该消息所在的折叠分组');
            return;
          }
          await handleMissingText();
        } finally {
          locateInFlightRef.current = false;
        }
      };

      const backToList = () => setTabUi({ view: 'list', activeId: null });

      const doDelete = () => {
        const id = confirmId;
        setConfirmId(null);
        if (!id) return;
        anchors.delete(id);
        save();
        applyHighlights();
        setTabUi({ view: 'list', activeId: null });
      };

      const doBatchDelete = () => {
        const ids = selectedNotes.map((row) => row.id);
        setConfirmBatch(false);
        if (!ids.length) return;
        for (const id of ids) anchors.delete(id);
        save();
        applyHighlights();
        setSelected(new Set());
      };

      const toggleSelect = (id) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const toggleSelectAll = () => {
        setSelected(allSelected ? new Set() : new Set(notes.map((row) => row.id)));
      };

      const flashExport = (kind, text) => {
        setExportHint({ kind, text });
        if (hintTimer.current) window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => {
          hintTimer.current = 0;
          setExportHint(null);
        }, 3000);
      };

      const runExport = (format, ids) => {
        const res = exportNotesToFile(sessionId, ids, format);
        if (res.ok) flashExport('ok', '已导出 ' + res.count + ' 条');
        else if (res.reason === 'blocked') flashExport('warn', '下载被浏览器拦截，请重试');
        else flashExport('warn', '没有可导出的笔记');
      };

      /** 列表：有选中导出选中，否则导出全部；详情：严格只导出当前笔记（[id] 或 []，绝不回退到全部） */
      const headerExportIds = () => {
        if (noteId) return current ? [current.id] : [];
        return selectedNotes.length ? selectedNotes.map((row) => row.id) : null;
      };

      const ask = async (presetQuestion) => {
        const a = current;
        const q = (presetQuestion != null ? String(presetQuestion) : draft).trim();
        if (!a || !q || busy) return;
        if (customIncomplete) {
          showToast('自定义 API 未配置完整');
          return;
        }
        setDraft('');
        setBusy(true);
        setAskStatus('');
        lastActivityRef.current = Date.now();
        setSilentSec(0);
        a.messages = Array.isArray(a.messages) ? a.messages : [];
        if (!anchors.has(a.id) && sessionStore.id === a.sessionId) anchors.set(a.id, a);
        const history = a.messages.slice();
        a.messages.push({ role: 'user', text: q });
        a.messages.push({ role: 'assistant', text: '', streaming: true, error: false });
        const aiIndex = a.messages.length - 1;
        const bubble = a.messages[aiIndex];
        stickRef.current = true;
        forceScrollRef.current = true;
        save();
        forceUi((v) => (v + 1) | 0);
        const ac = new AbortController();
        abortRef.current = ac;
        const payload = {
          quote: a.exact,
          context: '',
          question: q,
          history,
          sessionId: a.sessionId || sessionId || sessionStore.id || '',
          providerMode,
          ...(providerMode === 'custom' ? { baseURL: cfg.baseURL, model: cfg.model } : {}),
          thinking: cfg.thinking !== false,
          thinkingFormat: normalizeThinkingFormat(cfg.thinkingFormat),
          memory: cfg.memory === true,
          memoryWindow: normalizeMemoryWindow(cfg.memoryWindow),
        };
        let lastTransient = null;
        let attempt = 0;
        try {
          for (;;) {
            attempt += 1;
            if (attempt > 1) {
              setAskStatus(
                '网络波动，正在重试（' + (attempt - 1) + '/' + ASK_MAX_RETRIES + '），约 5 秒后重试…',
              );
              lastActivityRef.current = Date.now();
              setSilentSec(0);
              forceUi((v) => (v + 1) | 0);
              await sleepAbortable(ASK_RETRY_DELAY_MS, ac.signal);
              bubble.text = '';
              bubble.error = false;
              bubble.streaming = true;
              forceUi((v) => (v + 1) | 0);
            }
            let answer = '';
            try {
              const res = await fetch('/study-notes/ask', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: ac.signal,
              });
              if (!res.ok || !res.body) {
                const bodyText = await res.text().catch(() => '');
                const err = new Error('HTTP ' + res.status + (bodyText ? ': ' + bodyText.slice(0, 200) : ''));
                err.status = res.status;
                err.body = bodyText.slice(0, 400);
                throw err;
              }
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              let started = false;
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                buf += dec.decode(part.value, { stream: true });
                const chunks = buf.split('\n\n');
                buf = chunks.pop() || '';
                for (const piece of chunks) {
                  const line = piece.split('\n').find((l) => l.indexOf('data: ') === 0);
                  if (!line) continue;
                  let data;
                  try {
                    data = JSON.parse(line.slice(6));
                  } catch (_) {
                    continue;
                  }
                  if (data.delta) {
                    answer += data.delta;
                    started = true;
                    lastActivityRef.current = Date.now();
                    setSilentSec(0);
                    bubble.streaming = true;
                    bubble.text = answer;
                    forceUi((v) => (v + 1) | 0);
                  } else if (typeof data.finish === 'string' && data.finish) {
                    bubble.finish = data.finish;
                  } else if (data.error) {
                    const err = new Error(String(data.error));
                    err.streamError = true;
                    err.hasContent = started || answer.length > 0;
                    throw err;
                  }
                }
              }
              if (!answer) {
                bubble.text = '（没有返回内容）';
                bubble.error = true;
              }
              bubble.streaming = false;
              setAskStatus('');
              forceUi((v) => (v + 1) | 0);
              return;
            } catch (e) {
              if (isAbortError(e)) throw e;
              if (!e || typeof e !== 'object') throw e;
              if (e.hasContent === undefined) e.hasContent = !!(bubble.text || answer);
              if (!isTransientAskError(e)) {
                const reason = askErrorReason(e);
                const raw = shortRaw(e);
                const prefix = e.hasContent && bubble.text ? bubble.text.replace(/\s+$/, '') + '\n\n' : '';
                bubble.text = prefix + '⚠️ ' + reason + (raw && reason.indexOf(raw) === -1 ? '（' + raw + '）' : '');
                bubble.error = true;
                bubble.streaming = false;
                setAskStatus('');
                save();
                forceUi((v) => (v + 1) | 0);
                return;
              }
              lastTransient = e;
              bubble.text = '';
              bubble.error = false;
              bubble.streaming = true;
              forceUi((v) => (v + 1) | 0);
              if (attempt > ASK_MAX_RETRIES) {
                const reason = askErrorReason(lastTransient);
                const raw = shortRaw(lastTransient);
                bubble.text =
                  '网络异常，已重试 ' +
                  ASK_MAX_RETRIES +
                  ' 次仍失败：' +
                  reason +
                  (raw && reason.indexOf(raw) === -1 ? '（' + raw + '）' : '');
                bubble.error = true;
                bubble.streaming = false;
                setAskStatus('');
                save();
                forceUi((v) => (v + 1) | 0);
                return;
              }
            }
          }
        } catch (e) {
          if (isAbortError(e)) {
            bubble.streaming = false;
            bubble.error = false;
            if (!bubble.text) bubble.text = '（已停止）';
            setAskStatus('');
          } else {
            bubble.text = '⚠️ ' + (e && e.message ? e.message : String(e));
            bubble.error = true;
            bubble.streaming = false;
            setAskStatus('');
          }
        } finally {
          abortRef.current = null;
          if (!bubble.text) bubble.text = '（已停止）';
          save();
          forceUi((v) => (v + 1) | 0);
          setBusy(false);
        }
      };

      const stopAsk = () => {
        if (abortRef.current) abortRef.current.abort();
      };

      const listEl = h(
        'div',
        { className: 'dsh-sn-list-wrap' },
        h(
          'div',
          { className: 'dsh-sn-listbar' },
          notes.length
            ? h(
                'button',
                { className: 'dsh-sn-btn', onClick: toggleSelectAll },
                allSelected ? '取消全选' : '全选',
              )
            : null,
          h('span', { className: 'dsh-sn-sub' }, '已选 ' + selectedNotes.length + ' 条'),
        ),
        selectedNotes.length
          ? h(
              'div',
              { className: 'dsh-sn-selbar' },
              h(
                'button',
                {
                  className: 'dsh-sn-btn',
                  onClick: () => runExport('md', selectedNotes.map((row) => row.id)),
                },
                '导出 Markdown',
              ),
              h(
                'button',
                {
                  className: 'dsh-sn-btn',
                  onClick: () => runExport('docx', selectedNotes.map((row) => row.id)),
                },
                '导出 Word',
              ),
              h(
                'button',
                {
                  className: 'dsh-sn-btn dsh-sn-danger',
                  onClick: () => setConfirmBatch(true),
                },
                '删除选中',
              ),
            )
          : null,
        h(
          'div',
          { className: 'dsh-sn-list' },
          notes.length
            ? notes.map((row) =>
                h(
                  'div',
                  {
                    key: row.id,
                    className: 'dsh-sn-row-wrap' + (selected.has(row.id) ? ' dsh-sn-row-selected' : ''),
                  },
                  h('input', {
                    type: 'checkbox',
                    className: 'dsh-sn-check',
                    checked: selected.has(row.id),
                    'aria-label': '选择这条笔记',
                    onClick: (e) => e.stopPropagation(),
                    onChange: () => toggleSelect(row.id),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-sn-row',
                      disabled: busy,
                      onClick: () => {
                        if (busy) return;
                        const anchor = resolveNote(sessionId, row.id);
                        if (anchor) locateAnchor(anchor);
                      },
                    },
                    h('span', { className: 'dsh-sn-row-quote' }, row.exact),
                    h(
                      'span',
                      { className: 'dsh-sn-row-meta' },
                      (Array.isArray(row.messages) ? row.messages.length : 0) + ' 条消息',
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-sn-btn dsh-sn-row-open',
                      disabled: busy,
                      title: '打开笔记详情',
                      onClick: (e) => {
                        e.stopPropagation();
                        if (busy) return;
                        setTabUi({ view: 'note', activeId: row.id });
                      },
                    },
                    '打开',
                  ),
                ),
              )
            : h('div', { className: 'dsh-sn-empty' }, '还没有笔记。在对话中划选内容，右键选择「问这个」。'),
        ),
      );

      const renderBubble = (m, i) =>
        h(
          'div',
          {
            key: 'msg-' + i,
            className: 'dsh-sn-msg ' + (m.role === 'user' ? 'dsh-sn-msg-user' : 'dsh-sn-msg-ai'),
          },
          m.role === 'assistant' && !m.text
            ? '…'
            : m.role === 'assistant' && MarkdownText && !isPlainAssistantMessage(m)
              ? h(
                  'div',
                  { className: 'dsh-sn-msg-md' },
                  h(MarkdownText, {
                    text: m.text,
                    labels: MD_LABELS,
                    streaming: !!m.streaming,
                    omitHtml: true,
                    variant: 'body',
                  }),
                )
              : m.text,
        );

      const renderTruncation = (m, i) =>
        isTruncatedAnswer(m)
          ? h(
              'div',
              { key: 'trunc-' + i, className: 'dsh-sn-trunc' },
              h('span', { className: 'dsh-sn-trunc-text' }, '⚠ 回答可能被截断：已达到单次输出上限'),
              h(
                'button',
                {
                  className: 'dsh-sn-btn dsh-sn-trunc-btn',
                  disabled: busy,
                  onClick: () => {
                    if (!busy) ask('继续');
                  },
                },
                '继续',
              ),
              h(
                'span',
                { className: 'dsh-sn-trunc-hint' },
                '这不是网络或卡顿问题；点「继续」会让模型接着上文补完。',
              ),
            )
          : null;

      const transcriptEl = h(
        'div',
        { className: 'dsh-sn-transcript', ref: transcriptRef, onScroll: handleTranscriptScroll },
        current && Array.isArray(current.messages) && current.messages.length
          ? current.messages.map((m, i) =>
              h(React.Fragment, { key: 'turn-' + i }, renderBubble(m, i), renderTruncation(m, i)),
            )
          : h(
              'div',
              { className: 'dsh-sn-empty' },
              current ? '针对这段内容提问，分支不会进入主对话。' : '这条笔记已不存在，可能已被删除。',
            ),
      );

      const statusText = !busy
        ? ''
        : askStatus
          ? askStatus
          : silentSec >= STALL_SECONDS
            ? '已 ' + STALL_SECONDS + ' 秒无新内容，可能卡顿（可点停止后重试）'
            : '生成中…' +
              (cfg.memory === true ? ' · 已带主对话记忆' : '') +
              (silentSec >= 3 ? '（已 ' + silentSec + ' 秒无新内容）' : '');

      const statusEl = busy
        ? h(
            'div',
            {
              className:
                'dsh-sn-status' +
                (askStatus ? ' dsh-sn-status-retry' : '') +
                (!askStatus && silentSec >= STALL_SECONDS ? ' dsh-sn-status-stall' : ''),
            },
            h('span', { className: 'dsh-sn-spinner', 'aria-hidden': 'true' }),
            h('span', null, statusText),
          )
        : null;

      const detailEl = h(
        'div',
        { className: 'dsh-sn-body' },
        current ? h('div', { className: 'dsh-sn-quote' }, current.exact) : null,
        current
          ? h(
              'div',
              { className: 'dsh-sn-reinjectbar' },
              h('button', { className: 'dsh-sn-btn', onClick: openReinject }, '回注主对话'),
              current.lastReinject
                ? h(
                    'span',
                    { className: 'dsh-sn-sub' },
                    '上次回注 ' +
                      formatDateTime(current.lastReinject.at) +
                      (current.lastReinject.mode === 'inject' ? ' · 直接注入' : ' · 预填'),
                  )
                : null,
              current.lastReinject
                ? h('button', { className: 'dsh-sn-btn', onClick: openReinjectLast }, '再次回注')
                : null,
            )
          : null,
        transcriptEl,
        statusEl,
        customIncomplete
          ? h(
              'div',
              { className: 'dsh-sn-hint dsh-sn-warn' },
              '自定义 API 未配置完整：请在 设置 → 学习笔记 选择「使用自定义 API」，填写 API 地址、模型并保存 Key。',
            )
          : null,
        h(
          'div',
          { className: 'dsh-sn-input' },
          h('textarea', {
            className: 'dsh-sn-ta',
            value: draft,
            placeholder: '问这段内容…（Enter 发送，Shift+Enter 换行）',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            },
          }),
          busy
            ? h('button', { className: 'dsh-sn-send', onClick: stopAsk }, '停止')
            : h(
                'button',
                { className: 'dsh-sn-send', disabled: !current || customIncomplete, onClick: ask },
                '发送',
              ),
        ),
        h('div', { className: 'dsh-sn-hint' }, '分支对话不计入主上下文。'),
      );

      const exportEl = !exportOpen
        ? null
        : noteId && !current
          ? h(
              'div',
              { className: 'dsh-sn-exportbar' },
              h('span', { className: 'dsh-sn-sub' }, '这条笔记已不存在'),
              h('button', { className: 'dsh-sn-btn', onClick: () => setExportOpen(false) }, '取消'),
            )
          : h(
              'div',
              { className: 'dsh-sn-exportbar' },
              h(
                'span',
                { className: 'dsh-sn-sub' },
                noteId
                  ? '导出当前笔记：'
                  : selectedNotes.length
                    ? '导出选中的 ' + selectedNotes.length + ' 条：'
                    : '导出全部笔记：',
              ),
              h(
                'button',
                {
                  className: 'dsh-sn-btn',
                  onClick: () => {
                    setExportOpen(false);
                    runExport('md', headerExportIds());
                  },
                },
                'Markdown',
              ),
              h(
                'button',
                {
                  className: 'dsh-sn-btn',
                  onClick: () => {
                    setExportOpen(false);
                    runExport('docx', headerExportIds());
                  },
                },
                'Word',
              ),
              h('button', { className: 'dsh-sn-btn', onClick: () => setExportOpen(false) }, '取消'),
            );

      const hintEl = exportHint
        ? h(
            'div',
            {
              className:
                'dsh-sn-feedback ' + (exportHint.kind === 'ok' ? 'dsh-sn-feedback-ok' : 'dsh-sn-feedback-warn'),
            },
            exportHint.text,
          )
        : null;

      const confirmEl = confirmId || confirmBatch
        ? h(
            'div',
            { className: 'dsh-sn-confirm' },
            h(
              'div',
              { className: 'dsh-sn-dialog' },
              h(
                'div',
                { className: 'dsh-sn-dialog-title' },
                confirmBatch ? '删除选中的 ' + selectedNotes.length + ' 条笔记？' : '删除这条笔记？',
              ),
              h(
                'div',
                { className: 'dsh-sn-dialog-body' },
                confirmBatch
                  ? '这些划词锚点和对应笔记会被移除，且无法恢复。'
                  : '这条划词锚点和对应笔记会被移除，且无法恢复。',
              ),
              h(
                'div',
                { className: 'dsh-sn-dialog-row' },
                h(
                  'button',
                  {
                    className: 'dsh-sn-btn',
                    onClick: () => {
                      setConfirmId(null);
                      setConfirmBatch(false);
                    },
                  },
                  '取消',
                ),
                h(
                  'button',
                  {
                    className: 'dsh-sn-btn dsh-sn-danger',
                    onClick: confirmBatch ? doBatchDelete : doDelete,
                  },
                  '删除',
                ),
              ),
            ),
          )
        : null;

      const draftReinjectBtn = h(
        'button',
        {
          className: cfg.reinjectMode === 'draft' ? 'dsh-sn-send' : 'dsh-sn-btn',
          disabled: reinjectBusy,
          onClick: () => prefillReinject(),
        },
        '预填草稿',
      );
      const injectReinjectBtn = h(
        'button',
        {
          className: cfg.reinjectMode === 'inject' ? 'dsh-sn-send' : 'dsh-sn-btn',
          disabled: reinjectBusy,
          onClick: () => deliverReinject(),
        },
        '直接注入',
      );
      const deliveryButtons =
        cfg.reinjectMode === 'inject' ? [injectReinjectBtn, draftReinjectBtn] : [draftReinjectBtn, injectReinjectBtn];

      const memoryEl = !memoryOpen
        ? null
        : h(
            'div',
            { className: 'dsh-sn-confirm' },
            h(
              'div',
              { className: 'dsh-sn-dialog dsh-sn-reinject-dialog' },
              h('div', { className: 'dsh-sn-dialog-title' }, '会话记忆'),
              cfg.memory !== true
                ? h(
                    'div',
                    { className: 'dsh-sn-dialog-body' },
                    '记忆已在 设置 → 学习笔记 中关闭。可在「设置 → 学习笔记」开启后再查看本会话摘要。',
                  )
                : h(
                    React.Fragment,
                    null,
                    h('div', { className: 'dsh-sn-mem-status' }, memoryStatusText()),
                    h('textarea', {
                      className: 'dsh-sn-mem-ta',
                      value: memoryDraft,
                      disabled: memoryBusy,
                      placeholder: '摘要会显示在这里，可手动修改后保存',
                      onChange: (e) => setMemoryDraft(e.target.value),
                    }),
                    h(
                      'div',
                      { className: 'dsh-sn-mem-actions' },
                      h(
                        'button',
                        { className: 'dsh-sn-btn', disabled: memoryBusy, onClick: () => runMemoryAction('save') },
                        '保存',
                      ),
                      h(
                        'button',
                        { className: 'dsh-sn-btn', disabled: memoryBusy, onClick: () => runMemoryAction('rebuild') },
                        '重新生成',
                      ),
                      h(
                        'button',
                        { className: 'dsh-sn-btn', disabled: memoryBusy, onClick: () => runMemoryAction('clear') },
                        '清空',
                      ),
                    ),
                    memoryMsg ? h('div', { className: 'dsh-sn-mem-msg' }, memoryMsg) : null,
                    h(
                      'div',
                      { className: 'dsh-sn-set-hint' },
                      '摘要只保存在本机；「重新生成」会按当前主对话重新归纳。',
                    ),
                  ),
              h(
                'div',
                { className: 'dsh-sn-dialog-row' },
                h('button', { className: 'dsh-sn-btn', onClick: () => setMemoryOpen(false) }, '关闭'),
              ),
            ),
          );

      const reinjectEl = !reinjectOpen
        ? null
        : h(
            'div',
            { className: 'dsh-sn-confirm' },
            h(
              'div',
              { className: 'dsh-sn-dialog dsh-sn-reinject-dialog' },
              h('div', { className: 'dsh-sn-dialog-title' }, '回注主对话'),
              h(
                'div',
                { className: 'dsh-sn-dialog-body' },
                '把这条分支的要点回注到主对话，让主对话知道这里卡在哪里。',
              ),
              reinjectBusy ? h('div', { className: 'dsh-sn-mem-status' }, '正在生成回注摘要…') : null,
              h('textarea', {
                className: 'dsh-sn-mem-ta',
                value: reinjectText,
                disabled: reinjectBusy,
                placeholder: REINJECT_PREFIX,
                onChange: (e) => setReinjectText(e.target.value),
              }),
              reinjectMsg ? h('div', { className: 'dsh-sn-mem-msg' }, reinjectMsg) : null,
              h(
                'div',
                { className: 'dsh-sn-dialog-row' },
                h('button', { className: 'dsh-sn-btn', onClick: () => closeReinject() }, '取消'),
                ...deliveryButtons,
              ),
              h(
                'div',
                { className: 'dsh-sn-cfg-hint' },
                '预填只写入主输入框、不发送；直接注入会作为一条【学习笔记回注】通知消息进入主对话（空闲时立即落盘、重启仍保留；模型运行中则排队到下一步）。',
              ),
            ),
          );

      return h(
        'div',
        { className: 'dsh-sn-tab' },
        h(
          'div',
          { className: 'dsh-sn-head' },
          h(
            'div',
            { className: 'dsh-sn-head-left' },
            noteId ? h('button', { className: 'dsh-sn-btn', onClick: backToList }, '‹ 返回') : null,
            h('span', null, TAB_TITLE),
            noteId ? null : h('span', { className: 'dsh-sn-sub' }, notes.length + ' 条'),
          ),
          h(
            'div',
            { className: 'dsh-sn-actions' },
            noteId || notes.length
              ? h(
                  'button',
                  {
                    className: 'dsh-sn-btn',
                    disabled: noteId ? !current : false,
                    title: noteId && !current ? '这条笔记已不存在' : undefined,
                    onClick: () => setExportOpen((v) => !v),
                  },
                  '导出',
                )
              : null,
            noteId && current
              ? h(
                  'button',
                  {
                    className: 'dsh-sn-btn',
                    disabled: busy,
                    title: '在主对话中定位这条笔记的原文',
                    onClick: () => {
                      if (!busy) locateAnchor(current);
                    },
                  },
                  '定位',
                )
              : null,
            h(
              'button',
              {
                className: 'dsh-sn-btn',
                title: '查看/编辑本会话记忆摘要',
                onClick: () => setMemoryOpen((v) => !v),
              },
              '记忆',
            ),
            noteId ? h('button', { className: 'dsh-sn-btn', onClick: () => setConfirmId(noteId) }, '删除') : null,
          ),
        ),
        exportEl,
        hintEl,
        noteId ? detailEl : listEl,
        h('div', { className: 'dsh-sn-foot' }, '全局设置见 设置 → 学习笔记'),
        memoryEl,
        confirmEl,
        reinjectEl,
        toast ? h('div', { className: 'dsh-sn-toast' }, toast) : null,
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'],
      apply(ctx) {
        pluginCtx = ctx;
        openNotesTab = () => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND);
          } catch (_) {}
        };
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => TAB_TITLE,
              keepMounted: true,
              guide: [
                {
                  id: 'index',
                  order: 15,
                  title: () => TAB_TITLE,
                  description: () => '查看本会话的笔记索引与学习画像',
                },
              ],
            }),
          'study-notes: tab type',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, StudyNotesTab),
            ),
          'study-notes: tab body',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register({ name: 'shell.overlay', id: 'dsh-study-notes', order: 90 }, Overlay),
            ),
          'study-notes: overlay',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register(
                { name: 'conversation.composer.dock', id: 'dsh-study-notes.bridge', order: 50 },
                SessionBridge,
              ),
            ),
          'study-notes: session bridge',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'study-notes', order: 20, label: () => '学习笔记' },
                StudyNotesSettings,
              ),
            ),
          'study-notes: settings section',
        );
      },
    };
  },
});
