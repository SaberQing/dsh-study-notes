/**
 * Host half of dsh-study-notes: a loopback route that answers branch questions
 * with an isolated model call, so a branch never enters the session log.
 */
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';

const PREFIX = '/study-notes';
const MEMORY_PATH = PREFIX + '/memory';
const SECRET_PATH = PREFIX + '/secret';
const MAX_BODY = 256 * 1024;
let lastRoute = null;

/**
 * 可注入 IO 层：默认绑定 Node 内置模块；验证脚本通过 __test__.setIO 注入
 * fake fs / spawn / crypto / platform，Host 运行时不会使用该入口。
 */
const DEFAULT_IO = {
  fs: nodeFs,
  spawn,
  crypto: { randomBytes, createCipheriv, createDecipheriv },
  platform: process.platform,
};
let io = DEFAULT_IO;

/** 学习上下文记忆（v1）：只做内存缓存；摘要无 token 上限，靠 prompt 约束完整性 */
const MEMORY_MIN_DELTA = 5;
const MEMORY_REFRESH_MIN_MS = 60 * 1000;
const MEMORY_DEFAULT_WINDOW = 10;
const MEMORY_MIN_WINDOW = 10;
const MEMORY_MAX_WINDOW = 15;
const MEMORY_FALLBACK_WINDOW = 40;
const memoryStore = new Map();

/** 摘要持久化（v2）：每会话一个 JSON；DSH_HOME 优先，否则 ~/.dsh/study-notes（懒建目录） */
const MEMORY_FILE_VERSION = 1;

function memoryRootDir() {
  const base = process.env.DSH_HOME ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
  return path.join(base, 'study-notes');
}

function memoryFilePath(sessionId) {
  return path.join(memoryRootDir(), encodeURIComponent(sessionId) + '.json');
}

/** 原子-ish 写字符串到目标文件（同目录 temp + rename；Windows 重试 + copy 兜底） */
async function writeFileAtomic(target, content, mode) {
  await io.fs.mkdir(path.dirname(target), { recursive: true });
  const temp =
    target + '.' + process.pid + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    await io.fs.writeFile(temp, content, mode ? { encoding: 'utf8', mode } : 'utf8');
    try {
      if (mode) await io.fs.chmod(temp, mode);
    } catch (_) {}
    let renamed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
      try {
        await io.fs.rename(temp, target);
        renamed = true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    if (!renamed) {
      // rename 持续失败时退化为覆盖复制（非原子但仍尽力持久化）
      try {
        await io.fs.copyFile(temp, target);
        await io.fs.rm(temp, { force: true });
        renamed = true;
      } catch (_) {}
    }
    if (!renamed) throw lastError || new Error('rename failed');
  } catch (error) {
    try {
      await io.fs.rm(temp, { force: true });
    } catch (_) {}
    throw error;
  }
}

// ── 加密封装：API Key 与摘要文件共用（Windows DPAPI / AES-256-GCM 兜底）──
const SECRET_FILE_VERSION = 1;
const SECRET_MAX_LENGTH = 512;

const DPAPI_PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$t=[Console]::In.ReadToEnd().Trim();',
  '$b=[Convert]::FromBase64String($t);',
  '$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
].join(' ');

const DPAPI_UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$t=[Console]::In.ReadToEnd().Trim();',
  '$p=[Convert]::FromBase64String($t);',
  '$b=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($b))',
].join(' ');

function secretsFilePath() {
  return path.join(memoryRootDir(), 'secrets.json');
}

function aesKeyFilePath() {
  return path.join(memoryRootDir(), 'secrets.key');
}

function isEncryptedEnvelope(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    value.version === SECRET_FILE_VERSION &&
    (value.method === 'dpapi' || value.method === 'aes-gcm') &&
    typeof value.data === 'string' &&
    value.data.length > 0
  );
}

/** 前 7 位 + •••• + 后 4 位；短 Key 只露首尾 2 位，极短全掩码 */
function keyPreview(key) {
  const text = typeof key === 'string' ? key : '';
  if (!text) return '';
  if (text.length >= 15) return text.slice(0, 7) + '••••' + text.slice(-4);
  if (text.length >= 6) return text.slice(0, 2) + '••••' + text.slice(-2);
  return '••••';
}

/** 通过 stdin（绝不 argv）执行 PowerShell；超时 8s；错误信息不带输入内容 */
function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let timer = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (child && typeof child.kill === 'function') child.kill();
      } catch (_) {}
      fn(value);
    };
    try {
      child = io.spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (_) {
      reject(new Error('powershell unavailable'));
      return;
    }
    timer = setTimeout(() => finish(reject, new Error('powershell timeout')), 8000);
    let out = '';
    try {
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(reject, new Error('powershell failed')));
      child.on('close', (code) => {
        if (code === 0 && out.trim()) finish(resolve, out.trim());
        else finish(reject, new Error('powershell exit ' + code));
      });
      child.stdin.on('error', () => {});
      child.stdin.write(input);
      child.stdin.end();
    } catch (_) {
      finish(reject, new Error('powershell failed'));
    }
  });
}

async function dpapiProtect(text) {
  const out = await runPowerShell(DPAPI_PROTECT_SCRIPT, Buffer.from(String(text), 'utf8').toString('base64'));
  if (!/^[A-Za-z0-9+/=]+$/.test(out)) throw new Error('dpapi output invalid');
  return out;
}

async function dpapiUnprotect(data) {
  const out = await runPowerShell(DPAPI_UNPROTECT_SCRIPT, data);
  if (!/^[A-Za-z0-9+/=]+$/.test(out)) throw new Error('dpapi output invalid');
  const plain = Buffer.from(out, 'base64').toString('utf8');
  if (!plain) throw new Error('dpapi plaintext empty');
  return plain;
}

async function loadOrCreateAesKey() {
  const file = aesKeyFilePath();
  try {
    const raw = await io.fs.readFile(file, 'utf8');
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length === 32) return key;
  } catch (_) {}
  const key = io.crypto.randomBytes(32);
  await io.fs.mkdir(memoryRootDir(), { recursive: true });
  await writeFileAtomic(file, key.toString('base64'), 0o600);
  try {
    await io.fs.chmod(file, 0o600);
  } catch (_) {}
  return key;
}

/** 加密文本 → {version:1, method, data}；两种手段都失败返回 null（由调用方决定回退） */
async function encryptText(text) {
  const plain = String(text == null ? '' : text);
  if (io.platform === 'win32') {
    try {
      return { version: SECRET_FILE_VERSION, method: 'dpapi', data: await dpapiProtect(plain) };
    } catch (_) {
      // DPAPI 不可用：落回 AES-256-GCM
    }
  }
  try {
    const key = await loadOrCreateAesKey();
    const iv = io.crypto.randomBytes(12);
    const cipher = io.crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: SECRET_FILE_VERSION,
      method: 'aes-gcm',
      data: Buffer.concat([iv, tag, data]).toString('base64'),
    };
  } catch (_) {
    return null;
  }
}

/** 解密信封；失败返回 null（绝不抛出含明文的错误） */
async function decryptText(envelope) {
  if (!isEncryptedEnvelope(envelope)) return null;
  try {
    if (envelope.method === 'dpapi') return await dpapiUnprotect(envelope.data);
    const raw = Buffer.from(envelope.data, 'base64');
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const key = await loadOrCreateAesKey();
    const decipher = io.crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

// ── API Key 安全存储：前端永远拿不到完整 Key ─────────────────────────
let secretCache;

async function readSecretsEnvelope() {
  try {
    const raw = await io.fs.readFile(secretsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return isEncryptedEnvelope(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function loadApiKey() {
  if (secretCache !== undefined) return secretCache;
  const envelope = await readSecretsEnvelope();
  if (!envelope) {
    secretCache = null;
    return null;
  }
  const plain = await decryptText(envelope);
  if (!plain) {
    secretCache = null;
    return null;
  }
  let value = null;
  try {
    const parsed = JSON.parse(plain);
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) value = parsed.apiKey.trim();
  } catch (_) {
    value = plain.trim() || null;
  }
  secretCache = value;
  return secretCache;
}

async function saveApiKey(apiKey) {
  const key = String(apiKey == null ? '' : apiKey).trim();
  if (!key) return false;
  const envelope = await encryptText(JSON.stringify({ apiKey: key, updatedAt: Date.now() }));
  if (!envelope) return false; // 绝不退化为明文存 Key
  try {
    await writeFileAtomic(secretsFilePath(), JSON.stringify(envelope), 0o600);
    try {
      await io.fs.chmod(secretsFilePath(), 0o600);
    } catch (_) {}
    secretCache = key;
    return true;
  } catch (_) {
    return false;
  }
}

async function deleteApiKey() {
  secretCache = null;
  try {
    await io.fs.rm(secretsFilePath(), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** 摘要文件原子写：content 为序列化后的字符串（密文信封或明文 JSON） */
async function writeMemoryFileAtomic(sessionId, content) {
  await io.fs.mkdir(memoryRootDir(), { recursive: true });
  await writeFileAtomic(memoryFilePath(sessionId), content);
}

async function removeMemoryFile(sessionId) {
  try {
    await io.fs.rm(memoryFilePath(sessionId), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

const MEMORY_SUMMARY_SYSTEM = [
  '你是学习上下文摘要器：把主对话压缩成一份供「分支提问」使用的学习上下文摘要。',
  '只压缩、不推断：没有依据的信息不要编造；保留术语原文与数字。',
  '尽可能完整保留信息：宁可多写，也不要漏掉关键结论、术语与定义、数字、用户纠正与偏好；不要复述无关细节。',
  '用要点列表逐项输出；输出必须使用以下结构，每一项没有内容时写「（无）」：',
  '主题',
  '已确认结论',
  '关键术语与定义',
  '未解决或待确认',
  '用户偏好与指令',
  '只输出摘要正文，不要解释你的过程。',
].join('\n');

/** 回注摘要：把一条分支问答压成 3–5 条要点，让主对话知道用户卡在哪 */
const REINJECT_SUMMARY_SYSTEM = [
  '你是学习笔记的「回注摘要器」：把一条分支提问整理成给主对话看的短摘要。',
  '只基于给定的「选中片段」与「分支问答」，不推断、不补充没有出现的内容。',
  '用 3–5 条要点覆盖：用户在此处的疑问 / 已澄清的结论 / 仍不确定或想继续追问的点。',
  '简短、忠实，保留术语原文；用「- 」开头的要点列表输出；不要解释过程，不要加标题前缀。',
].join('\n');

/** 回注去重：sessionId -> Set(injectionId) */
const injectionStore = new Map();

/** 自定义 OpenAI 兼容接口的思考参数格式（与 pi-ai compat.thinkingFormat 对齐） */
const THINKING_FORMATS = [
  'none',
  'deepseek',
  'openai',
  'qwen',
  'qwen-chat-template',
  'zai',
  'openrouter',
  'together',
  'string-thinking',
];

function normalizeThinkingFormat(value) {
  const format = typeof value === 'string' ? value.trim() : '';
  return THINKING_FORMATS.indexOf(format) !== -1 ? format : 'none';
}

/**
 * 自定义接口的思考参数映射。默认 'none' 不发送任何字段（严格网关会拒绝未知字段）。
 * 字段取值按 pi-ai compat.thinkingFormat 的线上实测值。
 */
function customThinkingFields(thinking, thinkingFormat) {
  const format = normalizeThinkingFormat(thinkingFormat);
  const on = thinking === true;
  if (format === 'none') return {};
  if (format === 'deepseek') return { thinking: { type: on ? 'enabled' : 'disabled' } };
  if (format === 'openai') return on ? { reasoning_effort: 'high' } : {};
  if (format === 'qwen') return { enable_thinking: on };
  if (format === 'qwen-chat-template') {
    return { chat_template_kwargs: { enable_thinking: on, preserve_thinking: true } };
  }
  if (format === 'zai') {
    return { thinking: on ? { type: 'enabled', clear_thinking: false } : { type: 'disabled' } };
  }
  if (format === 'openrouter') return { reasoning: { effort: on ? 'high' : 'none' } };
  if (format === 'together') return { reasoning: { enabled: on } };
  if (format === 'string-thinking') return { thinking: on ? 'high' : 'none' };
  return {};
}

/**
 * 原生路径的 capability-aware 思考控制（prepareCall 第三个参数）。
 * 非推理模型原样返回 controls，避免 UNSUPPORTED_REASONING_EFFORT。
 */
function configureThinkingControls(controls, info, thinking) {
  const base = controls && typeof controls === 'object' ? controls : {};
  const reasoning = info && info.reasoning;
  if (!reasoning) return base;
  if (thinking !== true) return Object.assign({}, base, { reasoningEffort: 'off' });
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const levels = efforts
    .map((e) => (e && typeof e.id === 'string' ? e.id : ''))
    .filter((id) => id && id !== 'off');
  const def = reasoning.defaultEffort;
  const on = def && def !== 'off' ? def : levels[levels.length - 1];
  return on ? Object.assign({}, base, { reasoningEffort: on }) : base;
}

/** 把可能残留的思考能力错误映射成可读文案 */
function friendlyModelError(message) {
  const text = String(message || '');
  return /UNSUPPORTED_REASONING_EFFORT/i.test(text) ? '该模型不支持思考设置' : message;
}

// ── 学习上下文记忆（v1）：主对话摘要 + 最近 N 条原文 ──────────────────
function normalizeMemoryWindow(value) {
  const num = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(num)) return MEMORY_DEFAULT_WINDOW;
  return Math.min(MEMORY_MAX_WINDOW, Math.max(MEMORY_MIN_WINDOW, Math.round(num)));
}

function memoryRecord(sessionId) {
  const held = memoryStore.get(sessionId);
  if (held) return held;
  const record = {
    digest: '',
    coveredSeq: 0,
    coveredMessageId: null,
    updatedAt: 0,
    edited: false,
    refreshes: 0,
    lastAttemptAt: 0,
    building: false,
    loaded: false,
    loading: null,
    persisted: false,
  };
  memoryStore.set(sessionId, record);
  return record;
}

/**
 * 懒加载磁盘摘要：会话第一次被使用时调用一次；文件缺失/损坏/无权限都静默回退内存模式。
 * 并发的调用共享同一个 loading Promise。
 */
function ensureMemoryLoaded(sessionId) {
  if (!sessionId) return Promise.resolve(null);
  const record = memoryRecord(sessionId);
  if (record.loaded) return Promise.resolve(record);
  if (record.loading) return record.loading;
  record.loading = (async () => {
    try {
      const raw = await io.fs.readFile(memoryFilePath(sessionId), 'utf8');
      let parsed = JSON.parse(raw);
      if (isEncryptedEnvelope(parsed)) {
        const plain = await decryptText(parsed);
        if (plain == null) throw new Error('digest decrypt failed');
        parsed = JSON.parse(plain);
      }
      if (parsed && typeof parsed === 'object' && parsed.sessionId === sessionId) {
        record.persisted = true;
        // 内存里已有更新的数据时不覆盖（例如加载与保存并发）
        if (!record.digest && !record.updatedAt) {
          record.digest = typeof parsed.digest === 'string' ? parsed.digest : '';
          record.coveredSeq = Number.isFinite(parsed.coveredSeq) ? parsed.coveredSeq : 0;
          record.coveredMessageId =
            typeof parsed.coveredMessageId === 'string' ? parsed.coveredMessageId : null;
          record.updatedAt = Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
          record.edited = parsed.edited === true;
          record.refreshes = Number.isFinite(parsed.refreshes) ? parsed.refreshes : 0;
        }
      }
    } catch (_) {
      // 文件缺失 / 损坏 / 无权限：静默回退内存模式
    } finally {
      record.loaded = true;
      record.loading = null;
    }
    return record;
  })();
  return record.loading;
}

/** 把当前会话的摘要记录写盘（原子-ish）；失败静默，不阻塞请求 */
async function persistMemory(sessionId) {
  const record = memoryStore.get(sessionId);
  if (!record) return false;
  const payload = {
    version: MEMORY_FILE_VERSION,
    sessionId,
    digest: record.digest || '',
    coveredSeq: record.coveredSeq || 0,
    coveredMessageId: record.coveredMessageId || null,
    updatedAt: record.updatedAt || 0,
    edited: record.edited === true,
    refreshes: record.refreshes || 0,
  };
  try {
    const json = JSON.stringify(payload);
    const envelope = await encryptText(json);
    // 加密失败时回退明文，绝不丢摘要（读取侧兼容明文旧文件）
    await writeMemoryFileAtomic(sessionId, envelope ? JSON.stringify(envelope) : json);
    record.persisted = true;
    return true;
  } catch (_) {
    return false;
  }
}

/** 活跃会话（Host 侧）；没有 live agent 时返回 null，调用方静默降级 */
function sessionFor(host, sessionId) {
  if (!sessionId) return null;
  try {
    const agents = host.get('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null;
    const session = agent && agent.session;
    return session && typeof session.deriveMessages === 'function' ? session : null;
  } catch (_) {
    return null;
  }
}

/** Message -> 纯文本（只取 user/assistant 的 text 块；跳过 reasoning/tool/图片等） */
function textOfMessage(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return '';
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 主对话的模型可见面（已含压缩后的 surface），只保留可读的 user/assistant 文本 */
function surfaceSnapshot(session) {
  let raw = [];
  try {
    raw = session.deriveMessages();
  } catch (_) {
    raw = [];
  }
  const messages = [];
  let lastId = null;
  for (const message of Array.isArray(raw) ? raw : []) {
    const text = textOfMessage(message);
    if (!text) continue;
    messages.push({
      id: message.id || null,
      role: message.role,
      sourceKind: message.source && message.source.kind ? message.source.kind : '',
      text,
    });
    if (message.id) lastId = message.id;
  }
  let checkpointIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.sourceKind === 'compact-checkpoint' || message.text.indexOf('<compacted-summary>') !== -1) {
      checkpointIndex = i;
      break;
    }
  }
  const seq = typeof session.seq === 'number' ? session.seq : 0;
  return { seq, messages, lastId, checkpointIndex };
}

/** 压缩检查点：`<compacted-summary>` 内是 LLM 摘要；没有标签就返回全文 */
function checkpointTextOf(text) {
  const start = text.indexOf('<compacted-summary>');
  const end = text.lastIndexOf('</compacted-summary>');
  if (start !== -1 && end > start) {
    return text.slice(start + '<compacted-summary>'.length, end).trim();
  }
  return String(text || '').trim();
}

/** 注入用的两条 system 段落：摘要 + 最近主对话原文（摘要不截断） */
function memorySections(plan) {
  if (!plan) return [];
  const sections = [];
  if (plan.digest) {
    sections.push('【学习上下文摘要】（来自主对话，自动压缩，可能不完整）\n' + plan.digest);
  }
  if (plan.window && plan.window.length) {
    const lines = plan.window.map((m) => (m.role === 'user' ? '用户：' : '助手：') + m.text);
    sections.push('【最近主对话】（最近 ' + plan.window.length + ' 条，旧→新）\n' + lines.join('\n'));
  }
  return sections;
}

function renderMemoryPrompt(previous, checkpoint, messages) {
  const parts = [];
  if (previous) parts.push('【已有摘要】（可能含用户手改，保留其中仍成立的结论与措辞）\n' + previous);
  if (checkpoint) parts.push('【会话压缩检查点】（长程背景，已确认的事实，不要改写或重复压缩）\n' + checkpoint);
  parts.push(
    (previous || checkpoint ? '【新增主对话】\n' : '【需要总结的主对话】\n') +
      messages.map((m) => (m.role === 'user' ? '用户：' : '助手：') + m.text).join('\n'),
  );
  parts.push(
    previous || checkpoint
      ? '请把上面的新增内容合并进已有摘要/检查点，输出更新后的完整学习上下文摘要。'
      : '请把上面的主对话压缩成一份学习上下文摘要。',
  );
  return parts.join('\n\n');
}

/** 增量/重建的摘要输入；返回 null 表示没有可总结的新内容 */
function buildMemoryInput(snapshot, record, rebuild) {
  const messages = snapshot.messages;
  if (!messages.length) return null;
  const hasCheckpoint = snapshot.checkpointIndex >= 0;
  const checkpoint = hasCheckpoint ? checkpointTextOf(messages[snapshot.checkpointIndex].text) : '';
  if (rebuild) {
    const tail = hasCheckpoint
      ? messages.slice(snapshot.checkpointIndex + 1)
      : messages.slice(-MEMORY_FALLBACK_WINDOW);
    if (!tail.length && !checkpoint) return null;
    return renderMemoryPrompt('', checkpoint, tail);
  }
  if (!record.digest) {
    return renderMemoryPrompt('', checkpoint, messages.slice(-MEMORY_FALLBACK_WINDOW));
  }
  let delta = null;
  if (hasCheckpoint) {
    delta = messages.slice(snapshot.checkpointIndex + 1);
  } else if (record.coveredMessageId) {
    const at = messages.findIndex((m) => m.id === record.coveredMessageId);
    if (at !== -1) delta = messages.slice(at + 1);
  }
  if (delta === null) delta = messages.slice(-MEMORY_FALLBACK_WINDOW);
  if (!delta.length) return null;
  // 压缩检查点本身就是长程摘要：未被手改时用它作新基准，不再叠加旧摘要；
  // 用户手改过则以手改摘要为准（手改必须存活到下次显式重建）。
  const previous = hasCheckpoint && record.edited !== true ? '' : record.digest;
  return renderMemoryPrompt(previous, checkpoint, delta);
}

/** 提问时的记忆计划：raw window + 已有摘要；needsRefresh = 需要回答后异步生成/刷新 */
function planMemory(host, sessionId, windowSize, route) {
  if (!sessionId) return null;
  const session = sessionFor(host, sessionId);
  if (!session) return null;
  const snapshot = surfaceSnapshot(session);
  if (!snapshot.messages.length) return null;
  const record = memoryStore.get(sessionId) || null;
  const delta = record ? snapshot.seq - (record.coveredSeq || 0) : 0;
  return {
    sessionId,
    route,
    seq: snapshot.seq,
    window: snapshot.messages.slice(-windowSize),
    digest: record && record.digest ? record.digest : '',
    needsRefresh: !record || !record.digest || delta >= MEMORY_MIN_DELTA,
  };
}

function memoryStateOf(host, sessionId) {
  const record = sessionId ? memoryStore.get(sessionId) : null;
  const session = sessionId ? sessionFor(host, sessionId) : null;
  return {
    exists: !!(record && record.digest),
    digest: record && record.digest ? record.digest : '',
    coveredSeq: record ? record.coveredSeq || 0 : 0,
    updatedAt: record ? record.updatedAt || 0 : 0,
    edited: !!(record && record.edited),
    seq: session && typeof session.seq === 'number' ? session.seq : 0,
    building: !!(record && record.building),
    persisted: !!(record && record.persisted),
    storage: record && record.persisted ? 'file' : 'memory',
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function parseQuery(url) {
  const raw = String(url || '');
  const at = raw.indexOf('?');
  if (at === -1) return {};
  const out = {};
  for (const pair of raw.slice(at + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    if (!key) continue;
    out[key] = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
  }
  return out;
}

/** 与回答相同的路由解析：当前会话 → 默认选择 → 上一次成功的路由 */
function resolveRoute(host, sessionId) {
  const modelSvc = host.get('agentDefaultModel');
  let selection = null;
  try {
    selection = modelSvc && typeof modelSvc.currentSelection === 'function' ? modelSvc.currentSelection() : null;
  } catch (_) {
    selection = null;
  }
  const agents = host.get('agents');
  let agent = null;
  try {
    agent = sessionId && agents && typeof agents.get === 'function' ? agents.get(sessionId) : null;
  } catch (_) {
    agent = null;
  }
  let route = null;
  try {
    const info =
      agent && agent.session && typeof agent.session.requestContext === 'function'
        ? agent.session.requestContext()
        : null;
    if (info && info.provider && info.model) route = { provider: info.provider, model: info.model };
  } catch (_) {}
  if (!route && selection && selection.provider && selection.model) {
    route = { provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort) route.reasoningEffort = selection.reasoningEffort;
  }
  if (!route) route = lastRoute;
  return { route, agent, selection };
}

/** 摘要调用：能力允许时关掉思考；不设 maxTokens 上限 */
function memoryConfigure(controls, info) {
  const base = controls && typeof controls === 'object' ? controls : {};
  const reasoning = info && info.reasoning;
  if (!reasoning) return base;
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const hasOff = efforts.some((entry) => entry && entry.id === 'off');
  return hasOff ? Object.assign({}, base, { reasoningEffort: 'off' }) : base;
}

async function summarizeMemory(host, route, content) {
  const llm = host.get('llm');
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('llm unavailable');
  if (!route || !route.provider || !route.model) throw new Error('no model route available');
  const call = await llm.prepareCall({ provider: route.provider, model: route.model }, undefined, memoryConfigure);
  const messages = [{ role: 'user', content: [{ type: 'text', text: content }] }];
  const options = Object.assign({}, call.config, { messages, system: MEMORY_SUMMARY_SYSTEM });
  const iterator = call.stream(options)[Symbol.asyncIterator]();
  let digest = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = next.value;
    if (!chunk) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') digest += chunk.text;
    else if (chunk.type === 'finish') {
      const reason = chunk.reason || {};
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new Error((reason.failure && reason.failure.message) || 'memory summarization failed');
      }
      break;
    }
  }
  return digest.trim();
}

/** 成功后写回 + 落盘；失败保留旧摘要（绝不阻塞回答） */
async function refreshMemory(host, sessionId, route, rebuild) {
  const record = memoryRecord(sessionId);
  if (record.building) return record;
  record.building = true;
  record.lastAttemptAt = Date.now();
  try {
    await ensureMemoryLoaded(sessionId);
    const session = sessionFor(host, sessionId);
    if (!session || !route) return record;
    const snapshot = surfaceSnapshot(session);
    const content = buildMemoryInput(snapshot, record, rebuild === true);
    if (!content) {
      if (snapshot.seq > (record.coveredSeq || 0)) record.coveredSeq = snapshot.seq;
      return record;
    }
    const digest = await summarizeMemory(host, route, content);
    if (!digest) return record;
    record.digest = digest;
    record.coveredSeq = snapshot.seq;
    record.coveredMessageId = snapshot.lastId || record.coveredMessageId || null;
    record.updatedAt = Date.now();
    record.refreshes = (record.refreshes || 0) + 1;
    if (rebuild === true) record.edited = false;
    await persistMemory(sessionId);
    return record;
  } catch (_) {
    return record;
  } finally {
    record.building = false;
  }
}

/** 回答完成后再刷新：每题最多一次，同会话至少间隔 60 秒 */
function scheduleMemoryRefresh(host, plan) {
  if (!plan || !plan.needsRefresh) return;
  const held = memoryStore.get(plan.sessionId);
  if (held && (held.building || Date.now() - (held.lastAttemptAt || 0) < MEMORY_REFRESH_MIN_MS)) return;
  refreshMemory(host, plan.sessionId, plan.route, false).catch(() => {});
}

async function handleMemory(host, req, res) {
  const url = req.url || '';
  if (req.method === 'GET') {
    const sessionId = parseQuery(url).sessionId || '';
    if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' });
    await ensureMemoryLoaded(sessionId);
    return sendJson(res, 200, memoryStateOf(host, sessionId));
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, e && e.status ? e.status : 400, { error: 'invalid request body' });
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' });
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'save') {
    const digest = typeof body.digest === 'string' ? body.digest.trim() : '';
    await ensureMemoryLoaded(sessionId);
    const record = memoryRecord(sessionId);
    record.digest = digest;
    record.edited = true;
    record.updatedAt = Date.now();
    const session = sessionFor(host, sessionId);
    if (!record.coveredSeq && session) {
      const snapshot = surfaceSnapshot(session);
      record.coveredSeq = snapshot.seq;
      record.coveredMessageId = snapshot.lastId || null;
    }
    await persistMemory(sessionId);
    return sendJson(res, 200, { ok: true, state: memoryStateOf(host, sessionId) });
  }
  if (action === 'clear') {
    memoryStore.delete(sessionId);
    await removeMemoryFile(sessionId);
    return sendJson(res, 200, { ok: true, state: memoryStateOf(host, sessionId) });
  }
  if (action === 'rebuild') {
    if (!sessionFor(host, sessionId)) {
      return sendJson(res, 409, { error: '当前会话不在运行中，无法重建摘要' });
    }
    const { route } = resolveRoute(host, sessionId);
    if (!route) return sendJson(res, 503, { error: '没有可用的模型路由' });
    const record = await refreshMemory(host, sessionId, route, true);
    if (!record.digest) return sendJson(res, 200, { ok: false, error: '没有可总结的主对话内容' });
    return sendJson(res, 200, { ok: true, state: memoryStateOf(host, sessionId) });
  }
  return sendJson(res, 400, { error: 'unknown action' });
}

// ── API Key 安全路由：GET 只回 preview；POST 加密保存；DELETE 删除 ────
async function handleSecret(host, req, res) {
  if (req.method === 'GET') {
    const key = await loadApiKey();
    return sendJson(res, 200, { configured: !!key, preview: key ? keyPreview(key) : '' });
  }
  if (req.method === 'DELETE') {
    await deleteApiKey();
    return sendJson(res, 200, { ok: true, configured: false, preview: '' });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, e && e.status ? e.status : 400, { error: 'invalid request body' });
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) return sendJson(res, 400, { error: '缺少 apiKey' });
  if (apiKey.length > SECRET_MAX_LENGTH) return sendJson(res, 400, { error: 'apiKey 过长' });
  const saved = await saveApiKey(apiKey);
  if (!saved) return sendJson(res, 500, { error: '密钥保存失败' });
  return sendJson(res, 200, { ok: true, configured: true, preview: keyPreview(apiKey) });
}

// ── 回注主对话：摘要生成 + Agent inbox 注入 ──────────────────────────
function freshUuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) {}
  return 'sn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function branchTurnText(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.text !== 'string' || !message.text.trim()) continue;
    lines.push((message.role === 'user' ? '用户：' : '助手：') + message.text.trim());
  }
  return lines.join('\n');
}

function reinjectPrompt(quote, messages) {
  const turns = branchTurnText(messages);
  return '【选中片段】\n' + quote + '\n\n【分支问答】\n' + (turns || '（无）');
}

async function summarizeReinject(host, route, quote, messages) {
  const llm = host.get('llm');
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('llm unavailable');
  if (!route || !route.provider || !route.model) throw new Error('no model route available');
  const call = await llm.prepareCall({ provider: route.provider, model: route.model }, undefined, memoryConfigure);
  const content = [{ type: 'text', text: reinjectPrompt(quote, messages) }];
  const options = Object.assign({}, call.config, {
    messages: [{ role: 'user', content }],
    system: REINJECT_SUMMARY_SYSTEM,
  });
  const iterator = call.stream(options)[Symbol.asyncIterator]();
  let summary = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = next.value;
    if (!chunk) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text;
    else if (chunk.type === 'finish') {
      const reason = chunk.reason || {};
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new Error((reason.failure && reason.failure.message) || 'summary failed');
      }
      break;
    }
  }
  return summary.trim();
}

async function handleSummarize(host, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, e && e.status ? e.status : 400, { error: 'invalid request body' });
  }
  const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sid = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!quote) return sendJson(res, 400, { error: '缺少选中片段' });
  if (!messages.length) return sendJson(res, 400, { error: '缺少分支问答内容' });
  const { route } = resolveRoute(host, sid);
  if (!route) return sendJson(res, 502, { error: '没有可用的模型路由' });
  try {
    const summary = await summarizeReinject(host, route, quote, messages);
    if (!summary) return sendJson(res, 502, { error: '没有生成摘要内容' });
    return sendJson(res, 200, { summary });
  } catch (e) {
    return sendJson(res, 502, { error: '摘要生成失败：' + (e && e.message ? e.message : String(e)) });
  }
}

async function handleInject(host, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, e && e.status ? e.status : 400, { error: 'invalid request body' });
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const injectionId = typeof body.injectionId === 'string' ? body.injectionId : '';
  const wake = body.mode === 'wake';
  if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
  if (!text) return sendJson(res, 400, { error: '回注内容为空' });

  let agent = null;
  try {
    const agents = host.get('agents');
    agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null;
  } catch (_) {
    agent = null;
  }
  const session = agent && agent.session ? agent.session : null;
  // 直接注入需要可落盘的 Session；append 不可用视为会话不在运行
  if (!agent || !session || typeof session.append !== 'function') {
    return sendJson(res, 409, { error: '当前会话不在运行中' });
  }

  if (injectionId) {
    const injected = injectionStore.get(sessionId);
    if (injected && injected.has(injectionId)) return sendJson(res, 200, { ok: true, duplicate: true });
  }

  const message = {
    id: freshUuid(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-study-notes', form: 'notice' },
  };

  let mode = 'inject';
  let durable = false;
  try {
    if (wake) {
      if (typeof agent.followup !== 'function') return sendJson(res, 409, { error: '当前会话不在运行中' });
      await agent.followup(message);
      mode = 'wake';
    } else if (agent.status === 'running') {
      // 回合进行中：只能排队到下一步（非持久，cancel 时会丢）
      await agent.inject(message);
      mode = 'inject';
      durable = false;
    } else {
      // 空闲：直接写入会话表面，持久、重启保留、下回合模型可见
      await session.append('user/message', message, { surfaceOp: 'append' });
      mode = 'append';
      durable = true;
    }
  } catch (e) {
    return sendJson(res, 502, { error: '注入失败：' + (e && e.message ? e.message : String(e)) });
  }

  if (injectionId) {
    let injected = injectionStore.get(sessionId);
    if (!injected) {
      injected = new Set();
      injectionStore.set(sessionId, injected);
    }
    injected.add(injectionId);
  }
  return sendJson(res, 200, { ok: true, messageId: message.id, mode, durable });
}

const SYSTEM_BASE = [
  '你是学习助手。',
  '用户正在阅读一段材料，并针对其中选中的片段提问。',
  '只依据「选中片段」（以及用户提供的周边上下文）和你的知识回答；不要假设没有给出的主对话内容。',
  '回答简洁、准确；需要时给出例子。',
].join('\n');

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        req.pause();
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function buildMessages(history, question) {
  const parts = [];
  const turns = Array.isArray(history) ? history : [];
  if (turns.length) {
    parts.push('【之前的对话】');
    for (const m of turns) {
      if (!m || typeof m.text !== 'string' || m.text.trim() === '') continue;
      parts.push((m.role === 'user' ? '用户：' : '助手：') + m.text);
    }
    parts.push('');
  }
  parts.push('【当前问题】');
  parts.push(question);
  return [{ role: 'user', content: [{ type: 'text', text: parts.join('\n') }] }];
}

function systemText(quote, context, memoryBlocks) {
  let text = SYSTEM_BASE + '\n\n【选中片段】\n' + quote + (context ? '\n\n【周边上下文】\n' + context : '');
  const blocks = Array.isArray(memoryBlocks) ? memoryBlocks : [];
  for (const block of blocks) {
    if (block) text += '\n\n' + block;
  }
  return text;
}

function chatEndpoint(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(b)) return b;
  return b + '/chat/completions';
}

function openAIHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }
  return out;
}

async function customAsk(res, opts) {
  const ac = new AbortController();
  const onClose = () => {
    try {
      ac.abort();
    } catch (_) {}
  };
  res.on('close', onClose);
  try {
    const endpoint = chatEndpoint(opts.baseURL);
    const messages = [
      { role: 'system', content: systemText(opts.quote, opts.context, opts.memoryBlocks) },
      ...openAIHistory(opts.history),
      { role: 'user', content: opts.question },
    ];
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + opts.apiKey,
      },
      body: JSON.stringify(
        Object.assign(
          {
            model: opts.model,
            messages,
            stream: true,
            temperature: 0.3,
          },
          customThinkingFields(opts.thinking, opts.thinkingFormat),
        ),
      ),
      signal: ac.signal,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      throw new Error('HTTP ' + upstream.status + (text ? ' | ' + text.slice(0, 300) : ''));
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (obj) => {
      try {
        res.write('data: ' + JSON.stringify(obj) + '\n\n');
      } catch (_) {}
    };
    write({ ready: true });
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finishReason = null;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buf += dec.decode(part.value, { stream: true });
      const pieces = buf.split('\n\n');
      buf = pieces.pop() || '';
      for (const piece of pieces) {
        const line = piece.split('\n').find((l) => l.indexOf('data: ') === 0);
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          write({ done: true, finish: finishReason || 'stop' });
          res.end();
          return;
        }
        let data;
        try {
          data = JSON.parse(payload);
        } catch (_) {
          continue;
        }
        const choice = data && data.choices && data.choices[0];
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice && choice.delta ? choice.delta.content : '';
        if (delta) write({ delta });
      }
    }
    write({ done: true, finish: finishReason || 'stop' });
    res.end();
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (res.headersSent) {
      try {
        res.write('data: ' + JSON.stringify({ error: message }) + '\n\n');
      } catch (_) {}
      try {
        res.end();
      } catch (_) {}
    } else {
      sendJson(res, 502, { error: message });
    }
  } finally {
    res.removeListener('close', onClose);
  }
}

/** custom 模式：只走自定义 OpenAI 兼容接口；Key 从加密存储取（旧 body.apiKey 仅临时兜底） */
async function handleCustomAsk(host, res, opts) {
  const baseURL = typeof opts.baseURL === 'string' ? opts.baseURL.trim() : '';
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (!baseURL || !model) return sendJson(res, 400, { error: '自定义 API 未配置完整' });
  let storedKey = null;
  try {
    storedKey = await loadApiKey();
  } catch (_) {
    storedKey = null;
  }
  const legacy = typeof opts.legacyApiKey === 'string' ? opts.legacyApiKey.trim() : '';
  const key = storedKey || legacy;
  if (!key) return sendJson(res, 400, { error: '自定义 API 未配置完整' });

  let memoryPlan = null;
  let memoryBlocks = [];
  if (opts.memory === true && opts.sid) {
    try {
      await ensureMemoryLoaded(opts.sid);
      const { route } = resolveRoute(host, opts.sid);
      memoryPlan = planMemory(host, opts.sid, opts.memoryWindow, route || null);
      memoryBlocks = memorySections(memoryPlan);
    } catch (_) {
      memoryPlan = null;
      memoryBlocks = [];
    }
  }

  let answered = false;
  try {
    // custom 模式绝不尝试 native：直接调自定义接口（Key 只出现在 Authorization 头）
    await customAsk(res, {
      baseURL,
      apiKey: key,
      model,
      quote: opts.quote,
      context: opts.context,
      question: opts.question,
      history: opts.history,
      thinking: opts.thinking,
      thinkingFormat: opts.thinkingFormat,
      memoryBlocks,
    });
    answered = true;
  } finally {
    if (answered && memoryPlan) scheduleMemoryRefresh(host, memoryPlan);
  }
}

async function handle(host, req, res) {
  const url = req.url || '';
  const path = url.split('?')[0];
  if (path === SECRET_PATH) return handleSecret(host, req, res);
  if (path === MEMORY_PATH) return handleMemory(host, req, res);
  if (path === PREFIX + '/summarize') return handleSummarize(host, req, res);
  if (path === PREFIX + '/inject') return handleInject(host, req, res);
  if (!url.startsWith(PREFIX + '/ask')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, e && e.status ? e.status : 400, { error: 'invalid request body' });
  }

  const quote = typeof body.quote === 'string' ? body.quote : '';
  const context = typeof body.context === 'string' ? body.context : '';
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const history = body.history;
  const sid = typeof body.sessionId === 'string' ? body.sessionId : '';
  // 缺省视为开启思考（保持既有行为）；thinkingFormat 默认不发送自定义字段
  const thinking = body.thinking === false ? false : true;
  const thinkingFormat = normalizeThinkingFormat(body.thinkingFormat);
  // 记忆默认关闭；窗口条数 10–15
  const memory = body.memory === true;
  const memoryWindow = normalizeMemoryWindow(body.memoryWindow);
  if (!question) return sendJson(res, 400, { error: 'empty question' });
  if (!quote) return sendJson(res, 400, { error: 'empty quote' });

  const providerMode = body.providerMode === 'custom' ? 'custom' : 'native';
  const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  // 旧客户端可能仍传 apiKey：仅 custom 模式且未保存 Key 时临时使用；绝不存储/回显
  const legacyApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (providerMode === 'custom') {
    return handleCustomAsk(host, res, {
      baseURL,
      model,
      legacyApiKey,
      quote,
      context,
      question,
      history,
      thinking,
      thinkingFormat,
      memory,
      memoryWindow,
      sid,
    });
  }

  const llm = host.get('llm');
  const modelSvc = host.get('agentDefaultModel');
  if (!llm || typeof llm.prepareCall !== 'function') return sendJson(res, 503, { error: 'llm unavailable' });
  if (!modelSvc || typeof modelSvc.currentSelection !== 'function') {
    return sendJson(res, 503, { error: 'model selection unavailable' });
  }

  const { route, agent, selection } = resolveRoute(host, sid);
  if (!route) return sendJson(res, 503, { error: 'no model route available' });
  const agents = host.get('agents');

  // 记忆开启时才做持久化读取；关闭记忆不产生任何磁盘 I/O
  if (memory && sid) await ensureMemoryLoaded(sid);
  const memoryPlan = memory ? planMemory(host, sid, memoryWindow, route) : null;
  const memoryBlocks = memorySections(memoryPlan);
  const system = systemText(quote, context, memoryBlocks);
  const messages = buildMessages(history, question);

  const ac = new AbortController();
  const onClose = () => {
    try {
      ac.abort();
    } catch (_) {}
  };
  res.on('close', onClose);

  const write = (obj) => {
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    } catch (_) {}
  };

  const open = async (r) => {
    const call = await llm.prepareCall(
      { provider: r.provider, model: r.model },
      ac.signal,
      (controls, info) => configureThinkingControls(controls, info, thinking),
    );
    const options = Object.assign({}, call.config, { messages, system, signal: ac.signal });
    if (sid) options.sessionId = sid;
    const iterator = call.stream(options)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('empty stream');
    const chunk = first.value;
    if (chunk && chunk.type === 'finish') {
      const reason = chunk.reason || {};
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const err = new Error((reason.failure && reason.failure.message) || 'model call failed');
        err.code = reason.failure && reason.failure.code;
        err.failure = reason.failure;
        throw err;
      }
    }
    return { iterator, first, route: r };
  };

  const openWithRetry = async () => {
    const list = [];
    const push = (r) => {
      if (!r || !r.provider || !r.model) return;
      if (list.some((x) => x.provider === r.provider && x.model === r.model)) return;
      list.push(r);
    };
    push(route);
    push(lastRoute);
    if (selection && selection.provider && selection.model) {
      push({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort });
    }
    if (list.length) list.push(list[0]);
    let lastError = null;
    for (let pass = 0; pass < 3; pass += 1) {
      if (pass > 0) {
        if (ac.signal.aborted) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, pass === 1 ? 500 : 1500));
      }
      if (ac.signal.aborted) break;
      for (const r of list) {
        if (ac.signal.aborted) break;
        try {
          return await open(r);
        } catch (e) {
          lastError = e;
        }
      }
    }
    throw lastError || new Error('model call failed');
  };

  const run = async () => {
    const opened = await openWithRetry();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    write({ ready: true });
    lastRoute = opened.route;
    const iterator = opened.iterator;
    let chunk = opened.first.value;
    let lastUsage = null;
    for (;;) {
      if (!chunk) break;
      if (chunk.type === 'text-delta') write({ delta: chunk.text });
      else if (chunk.type === 'usage') {
        if (chunk.usage && typeof chunk.usage === 'object') lastUsage = chunk.usage;
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason || {};
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          write({ error: (reason.failure && reason.failure.message) || 'model call failed' });
        } else {
          const terminal = { done: true, finish: reason.kind || 'stop' };
          const usage = reason.usage || lastUsage;
          if (usage && typeof usage === 'object') {
            const slim = {};
            if (typeof usage.outputTokens === 'number') slim.outputTokens = usage.outputTokens;
            if (typeof usage.completionTokens === 'number') slim.completionTokens = usage.completionTokens;
            if (typeof usage.inputTokens === 'number') slim.inputTokens = usage.inputTokens;
            if (typeof usage.totalTokens === 'number') slim.totalTokens = usage.totalTokens;
            if (Object.keys(slim).length) terminal.usage = slim;
          }
          write(terminal);
        }
        break;
      }
      const next = await iterator.next();
      if (next.done) break;
      chunk = next.value;
    }
    res.end();
  };

  let answered = false;
  try {
    if (agent && agents && typeof agents.withInitiator === 'function') {
      await agents.withInitiator(agent, run);
    } else {
      await run();
    }
    answered = true;
  } catch (e) {
    {
      const code = e && e.code ? String(e.code) : '';
      const status = e && e.failure && e.failure.status ? 'HTTP ' + e.failure.status : '';
      const message = friendlyModelError(
        [code, status, e && e.message ? e.message : String(e)].filter(Boolean).join(' | '),
      );
      if (res.headersSent) {
        try {
          res.write('data: ' + JSON.stringify({ error: message }) + '\n\n');
        } catch (_) {}
        try {
          res.end();
        } catch (_) {}
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  } finally {
    res.removeListener('close', onClose);
    // 回答结束后再异步生成/刷新摘要：不阻塞回答，失败保留旧摘要
    if (answered) scheduleMemoryRefresh(host, memoryPlan);
  }
}

/**
 * 测试钩子：仅用于验证脚本注入 fake fs / spawn / crypto / platform 与直接调用路由。
 * Host 运行时不会调用它；不改变 apply 的行为。
 */
const TEST_HOOKS_ENABLED = process.env.DSH_STUDY_NOTES_TEST === '1';

export const __test__ = TEST_HOOKS_ENABLED
  ? {
  setIO(overrides) {
    io = Object.assign({}, io, overrides || {});
    return io;
  },
  resetIO() {
    io = DEFAULT_IO;
  },
  handle,
  memoryRootDir,
  memoryFilePath,
  secretsFilePath,
  aesKeyFilePath,
  loadApiKey,
  saveApiKey,
  deleteApiKey,
  keyPreview,
  encryptText,
  decryptText,
  memoryStore,
  }
  : undefined;

export function apply(ctx) {
  ctx.inject(['llm', 'agentDefaultModel', 'webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: (req, res) => handle(host, req, res),
        }),
      'dsh-study-notes: branch ask route',
    );
  });
}
