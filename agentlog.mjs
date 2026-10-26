#!/usr/bin/env node
/**
 * agentlog.mjs — 采集「某个工作区（文件夹）」下各类 AI Agent 的对话日志，导出为可读的 Markdown + 结构化 JSON。
 *
 * 支持的 Agent（自动探测本机存储位置）：
 *   - WorkBuddy            ~/.workbuddy/projects/<项目>/<sessionId>.jsonl
 *   - DeepSeek Harness     ~/.dsh/sessions/<项目>/session-<id>/session.v4.jsonl.zstd（多帧 zstd）
 *   - opencode             ~/.local/share/opencode/opencode.db（SQLite）
 *   - Qoder                ~/.qoder/projects/<项目>/*.jsonl
 *   - GitHub Copilot       VS Code 系 workspaceStorage/<hash>/chatSessions/*.jsonl|*.json
 *   - GitHub Copilot CLI   ~/.copilot/session-state/<id>/{workspace.yaml,events.jsonl}
 *   - Claude Code（附加）  ~/.claude/projects/<项目>/*.jsonl
 *
 * 零第三方依赖：只用 Node 内置模块（node:sqlite 用于读 opencode 数据库，node:zlib 用于 zstd）。
 * 要求 Node >= 22.5（node:sqlite）。zstd 需要 Node >= 22.15，若更低则自动回退到系统 zstd 命令。
 *
 * 用法见 --help 或 README.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const VERSION = '1.0.0';
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

/* ═══════════════════════════════ 通用工具 ═══════════════════════════════ */

/** 统一路径写法：正斜杠、去尾斜杠、Windows 下小写，便于跨来源比较 */
function normPath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  // file:///d%3A/proj、vscode-remote://ssh-remote%2B.../root/x 等 URI 形式：解码后取出路径部分
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    try {
      s = decodeURIComponent(rest).replace(/\\/g, '/');
    } catch {
      s = rest;
    }
    if (/^\/[a-z]:/i.test(s)) s = s.slice(1); // /d:/xxx → d:/xxx
  } else if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 保持原样 */
    }
  }
  s = s.replace(/\/+$/, '');
  if (IS_WIN) s = s.toLowerCase();
  return s;
}

/** 展示用：把家目录替换成 ~，路径统一为正斜杠 */
function tildePath(p) {
  const s = String(p || '');
  const esc = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(esc, IS_WIN ? 'gi' : 'g'), '~').replace(/\\/g, '/');
}

/** child 是否在工作区 root 之内（含 root 本身、含子目录） */
function isUnder(child, root) {
  const c = normPath(child);
  const r = normPath(root);
  if (!c || !r) return false;
  return c === r || c.startsWith(r + '/');
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  const t = readTextSafe(file);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 逐行解析 JSONL，坏行静默跳过（日志文件常被截断或仍在追加） */
function readJsonLines(file, transform) {
  const buf = fs.readFileSync(file);
  let text;
  if (file.endsWith('.zstd') || (buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd)) {
    text = decompressZstd(buf).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(transform ? transform(JSON.parse(s)) : JSON.parse(s));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/** 只读文件开头若干字节（必要时只解首帧），用于快速判断 cwd，避免全量解压 */
function peekHead(file, bytes = 65536) {
  try {
    if (file.endsWith('.zstd')) {
      const buf = fs.readFileSync(file);
      const frames = splitZstdFrames(buf).slice(0, 4);
      let text = '';
      for (const [a, b] of frames) {
        try {
          text += zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8');
        } catch {
          /* 忽略坏帧 */
        }
        if (text.length > bytes) break;
      }
      return text;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(bytes);
      const n = fs.readSync(fd, b, 0, bytes, 0);
      return b.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 快速预筛：头部的 cwd 明显不属于本工作区时跳过整个文件。
 * 兜底 —— 如果文件开头就出现了工作区路径（说明 cwd 可能只是正文里的内容），则不跳过。
 */
function shouldSkipByPeek(file, workspace) {
  const head = peekHead(file);
  if (!head) return false;
  const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return false;
  let cwd = m[1];
  try {
    cwd = JSON.parse(`"${m[1]}"`);
  } catch {
    /* 保持原样 */
  }
  if (isUnder(cwd, workspace)) return false;
  const flat = (s) => s.replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase();
  if (flat(head).includes(flat(workspace))) return false;
  return true;
}

/** 目录存在才返回，否则 null */
function existingDir(p) {
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function listFiles(dir, ext) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext)))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** 递归找文件（限定深度，避免误扫巨大的目录树） */
function walkFiles(dir, filter, maxDepth = 4, depth = 0) {
  const out = [];
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, filter, maxDepth, depth + 1));
    else if (e.isFile() && filter(p)) out.push(p);
  }
  return out;
}

/* ── 时间 ── */

function toMillis(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // 秒 → 毫秒
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '' && /^\d+$/.test(v.trim())) return toMillis(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  if (v instanceof Date) return v.getTime();
  return 0;
}

function fmtTime(ms, withSeconds = true) {
  if (!ms) return '未知时间';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withSeconds) return base;
  return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 解析 --since/--until：支持 2026-10-01、2026-10-01 12:00、ISO */
function parseBoundary(s, endOfDay = false) {
  if (!s) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T${endOfDay ? '23:59:59' : '00:00:00'}`) : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/* ── 文本 ── */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI, '') : '';
}

/** 清洗代码块里的超长 base64/内联图片，避免文档体积爆炸 */
function cleanHeavy(s) {
  let t = String(s);
  t = t.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=\s]{200,}/gi, '[内联图片已省略]');
  t = t.replace(/([A-Za-z0-9+/]{500,}={0,2})/g, (m) => `[长串数据已省略 ${m.length} 字符]`);
  return decodeFileUris(t);
}

/** 把 file:///d%3A/%E7%9B%AE%E5%BD%95 这类 URI 还原成可读路径 */
function decodeFileUris(text) {
  return String(text).replace(/file:\/\/\/[^\s)\]"'<>|]+/g, (m) => {
    try {
      let p = decodeURIComponent(m.replace(/^file:\/\//, ''));
      if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
      return p;
    } catch {
      return m;
    }
  });
}

/**
 * WorkBuddy / 部分 Agent 会把系统注入块（user_info、memory 提示等）拼进用户消息，
 * 真正的提问包在 <user_query> 里。这里提取真实内容，交作业时更像人写的东西。
 */
function cleanUserText(raw) {
  if (!raw) return '';
  let t = String(raw);
  const q = t.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (q) return q[1].trim();
  t = t.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  t = t.replace(/<identity_context>[\s\S]*?<\/identity_context>/g, '');
  t = t.replace(/<user_info>[\s\S]*?<\/user_info>/g, '');
  return t.trim();
}

function truncate(s, n) {
  if (s == null) return '';
  const t = String(s);
  if (!n || t.length <= n) return t;
  return `${t.slice(0, n)}\n…（省略 ${t.length - n} 字符，共 ${t.length} 字符）`;
}

/** 去掉 Windows 非法文件名字符 */
function safeName(s, fallback = 'session') {
  const r = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return r || fallback;
}

/* ═══════════════════════════ zstd 多帧解码 ═══════════════════════════ */

/**
 * dsh 的 .jsonl.zstd 是「每次追加写一帧」的拼接文件。
 * zlib.zstdDecompressSync 只解第一帧，所以先按帧头/块头切分，再逐帧解压。
 */
function splitZstdFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (!(buf[off] === 0x28 && buf[off + 1] === 0xb5 && buf[off + 2] === 0x2f && buf[off + 3] === 0xfd)) {
      off++;
      continue;
    }
    const start = off;
    let p = off + 4;
    try {
      const fhd = buf[p++];
      const fcsFlag = fhd >> 6;
      const single = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const dictFlag = fhd & 3;
      if (!single) p += 1; // window descriptor
      p += [0, 1, 2, 4][dictFlag];
      p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
      let last = 0;
      while (!last && p + 3 <= buf.length) {
        const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        last = h & 1;
        const type = (h >> 1) & 3;
        const size = h >>> 3;
        p += 3 + (type === 1 ? 1 : size);
      }
      if (checksum) p += 4;
      if (p <= start) break;
      frames.push([start, Math.min(p, buf.length)]);
      off = p;
    } catch {
      off = start + 4;
    }
  }
  return frames;
}

/** 解压 zstd：优先 Node 内置，失败时回退系统 zstd 命令 */
function decompressZstd(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') {
    const frames = splitZstdFrames(buf);
    if (!frames.length) {
      try {
        return zlib.zstdDecompressSync(buf);
      } catch {
        /* fallthrough */
      }
    }
    const chunks = [];
    let failed = 0;
    for (const [a, b] of frames) {
      try {
        chunks.push(zlib.zstdDecompressSync(buf.subarray(a, b)));
      } catch {
        failed++;
      }
    }
    if (chunks.length) return Buffer.concat(chunks);
    if (failed) throw new Error('zstd 帧解码失败');
  }
  // 回退：系统 zstd 命令
  const r = spawnSync('zstd', ['-dc'], { input: buf, maxBuffer: 1024 * 1024 * 512 });
  if (r.status === 0 && r.stdout) return r.stdout;
  throw new Error('当前 Node 不支持 zstd，且系统无 zstd 命令（建议升级到 Node 22.15+）');
}

/* ═══════════════════════════ 统一会话模型 ═══════════════════════════ */

/**
 * Session 结构：
 * {
 *   agent, agentLabel, editor?, id, title, cwd, source, model,
 *   startedAt, endedAt,
 *   entries: [{ role: 'user'|'assistant'|'tool'|'system', ts, text, reasoning,
 *               toolName, toolInput, toolOutput, toolStatus, model }]
 * }
 */
function makeSession(meta) {
  const s = {
    agent: meta.agent,
    agentLabel: meta.agentLabel,
    editor: meta.editor || '',
    id: meta.id || '',
    title: meta.title || '',
    cwd: meta.cwd || '',
    source: meta.source || '',
    model: meta.model || '',
    startedAt: 0,
    endedAt: 0,
    entries: [],
  };
  return s;
}

function pushEntry(session, entry) {
  if (!entry) return;
  if (entry.ts && !session.startedAt) session.startedAt = entry.ts;
  if (entry.ts) session.endedAt = Math.max(session.endedAt, entry.ts);
  if (!entry.text && !entry.reasoning && !entry.toolName) return;
  session.entries.push(entry);
}

/** 会话内统计：用户轮次、助手消息、工具调用 */
function sessionStats(session) {
  let userTurns = 0;
  let assistant = 0;
  let tools = 0;
  let chars = 0;
  for (const e of session.entries) {
    if (e.role === 'user') userTurns++;
    else if (e.role === 'assistant') assistant++;
    else if (e.role === 'tool') tools++;
    chars += (e.text || '').length + (e.toolOutput || '').length;
  }
  return { userTurns, assistant, tools, chars };
}

/** 合并相邻的同类助手片段（很多 Agent 把一段话拆成多个流式条目） */
function coalesceSession(session) {
  const out = [];
  for (const e of session.entries) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'assistant' && e.role === 'assistant') {
      if (prev.text && e.text && !prev.reasoning && !e.reasoning) {
        prev.text += '\n\n' + e.text;
        continue;
      }
      if (!prev.text && !e.text && prev.reasoning && e.reasoning) {
        prev.reasoning += '\n\n' + e.reasoning;
        continue;
      }
    }
    out.push(e);
  }
  session.entries = out;
  return session;
}

/** 把同一轮里零散的 tool 结果回填到对应的 tool 调用条目上 */
function attachToolResult(byId, callId, output, status) {
  if (!callId) return false;
  const target = byId.get(callId);
  if (!target) return false;
  if (!target.toolOutput) target.toolOutput = output;
  if (status) target.toolStatus = status;
  return true;
}

/* ═══════════════════════════════ 适配器 ═══════════════════════════════ */

/* ─────────────── 1. WorkBuddy ─────────────── */

function collectWorkBuddy(ctx) {
  const root = existingDir(path.join(HOME, '.workbuddy', 'projects'));
  if (!root) return { sessions: [], probes: ['~/.workbuddy/projects（不存在）'] };

  const sessions = [];
  const probes = [];
  for (const projDir of listDirs(root)) {
    const files = listFiles(projDir, '.jsonl');
    if (!files.length) continue;
    for (const file of files) {
      try {
        if (shouldSkipByPeek(file, ctx.workspace)) continue;
        const session = parseWorkBuddyFile(file);
        if (!session) continue;
        if (!isUnder(session.cwd, ctx.workspace)) continue;
        sessions.push(session);
        probes.push(`~/.workbuddy/projects/${path.basename(projDir)}/${path.basename(file)}`);
      } catch (e) {
        ctx.warn(`WorkBuddy 解析失败 ${path.basename(file)}: ${e.message}`);
      }
    }
    // tool-results 子目录不属于会话本体，忽略
  }
  return { sessions, probes };
}

function parseWorkBuddyFile(file) {
  const lines = readJsonLines(file);
  if (!lines.length) return null;

  let cwd = '';
  let title = '';
  let model = '';
  let sessionId = path.basename(file, '.jsonl');
  const seen = new Set();
  const callMap = new Map();

  const session = makeSession({ agent: 'workbuddy', agentLabel: 'WorkBuddy', id: sessionId, source: file });

  for (const r of lines) {
    if (!r || typeof r !== 'object') continue;
    if (r.cwd) cwd = cwd || r.cwd;
    if (r.sessionId) sessionId = r.sessionId;

    if (r.type === 'ai-title' && r.aiTitle) {
      title = r.aiTitle;
      continue;
    }
    if (r.type === 'message' && r.role === 'user') {
      if (r.id && seen.has(r.id)) continue;
      if (r.id) seen.add(r.id);
      const text = (Array.isArray(r.content) ? r.content : [])
        .filter((c) => c && (c.type === 'text' || c.type === 'input_text'))
        .map((c) => c.text || '')
        .join('\n');
      pushEntry(session, { role: 'user', ts: toMillis(r.timestamp), text: cleanUserText(text) });
      continue;
    }
    if (r.type === 'message' && r.role === 'assistant') {
      if (r.id && seen.has(r.id)) continue;
      if (r.id) seen.add(r.id);
      const text = (Array.isArray(r.content) ? r.content : [])
        .filter((c) => c && (c.type === 'output_text' || c.type === 'text'))
        .map((c) => c.text || '')
        .join('\n');
      const m = r.providerData?.requestModelName || r.providerData?.model || '';
      if (m && !model) model = m;
      pushEntry(session, { role: 'assistant', ts: toMillis(r.timestamp), text, model: m });
      continue;
    }
    if (r.type === 'reasoning') {
      // 该版本 reasoning 内容为空数组，保留兼容
      const text = (Array.isArray(r.content) ? r.content : [])
        .filter((c) => c && (c.type === 'reasoning' || c.type === 'text'))
        .map((c) => c.text || '')
        .join('\n')
        .trim();
      if (text) pushEntry(session, { role: 'assistant', ts: toMillis(r.timestamp), reasoning: text });
      continue;
    }
    if (r.type === 'function_call') {
      let input = r.arguments ?? r.input ?? '';
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          /* 保持原字符串 */
        }
      }
      const entry = {
        role: 'tool',
        ts: toMillis(r.timestamp),
        toolName: r.name || 'tool',
        toolInput: formatToolInput(input),
      };
      if (r.callId) callMap.set(r.callId, entry);
      pushEntry(session, entry);
      continue;
    }
    if (r.type === 'function_call_result') {
      const out = r.output?.text ?? r.output ?? r.result ?? '';
      const entry = r.callId ? callMap.get(r.callId) : null;
      if (entry) {
        entry.toolOutput = typeof out === 'string' ? out : JSON.stringify(out);
        entry.toolStatus = r.status || '';
      } else {
        pushEntry(session, {
          role: 'tool',
          ts: toMillis(r.timestamp),
          toolName: r.name || 'tool',
          toolOutput: typeof out === 'string' ? out : JSON.stringify(out),
          toolStatus: r.status || '',
        });
      }
      continue;
    }
  }

  session.cwd = cwd;
  session.title = title || firstUserLine(session) || sessionId;
  session.model = model;
  session.id = sessionId;
  // 只有带用户消息的才算有效会话
  if (!session.entries.some((e) => e.role === 'user')) return null;
  return session;
}

/* ─────────────── 2. DeepSeek Harness (.dsh) ─────────────── */

function collectDeepseekHarness(ctx) {
  const root = existingDir(path.join(HOME, '.dsh', 'sessions'));
  if (!root) return { sessions: [], probes: ['~/.dsh/sessions（不存在）'] };

  const sessions = [];
  const probes = [];
  for (const projDir of listDirs(root)) {
    for (const sessDir of listDirs(projDir)) {
      const files = listFiles(sessDir).filter((f) => f.includes('session') && (f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd')));
      if (!files.length) continue;
      // 优先取版本最高 / 最新的文件
      files.sort((a, b) => (a.includes('v4') === b.includes('v4') ? a.localeCompare(b) : a.includes('v4') ? -1 : 1));
      try {
        // 先读文件头部猜 cwd，不属于本工作区就直接跳过，避免解压整个会话
        if (shouldSkipByPeek(files[0], ctx.workspace)) continue;
        const session = parseDshFile(files[0]);
        if (!session || !isUnder(session.cwd, ctx.workspace)) continue;
        sessions.push(session);
        probes.push(`~/.dsh/sessions/${path.basename(projDir)}/${path.basename(sessDir)}/${path.basename(files[0])}`);
      } catch (e) {
        ctx.warn(`DeepSeek Harness 解析失败 ${path.basename(sessDir)}: ${e.message}`);
      }
    }
  }
  return { sessions, probes };
}

function parseDshFile(file) {
  const lines = readJsonLines(file);
  if (!lines.length) return null;

  let cwd = '';
  let title = '';
  let model = '';
  let sessionId = '';
  const callMap = new Map();
  const session = makeSession({ agent: 'deepseek-harness', agentLabel: 'DeepSeek Harness', source: file });

  for (const r of lines) {
    if (!r || !r.type) continue;
    const ts = toMillis(r.time ?? r.timestamp);
    const data = r.data || {};

    if (r.type === 'session') {
      // 注意：dsh 的 cwd 在记录顶层，不在 data 内
      cwd = r.cwd || data.cwd || cwd;
      sessionId = r.id || sessionId;
      if (!session.startedAt) session.startedAt = toMillis(r.createdAt);
      continue;
    }
    if (r.type === 'session/title') {
      if (data.title) title = data.title;
      continue;
    }
    if (r.type === 'request/context' || r.type === 'request/header') {
      const m = data.model || data.header?.config?.model;
      if (m && !model) model = m;
      continue;
    }
    if (r.type === 'user/message') {
      // dsh 会把审批结果、运行时上下文、技能清单、时间提示也记成 user/message，
      // 只有 source.kind === 'user' 才是人真正输入的内容
      const srcKind = data.source?.kind;
      if (srcKind && srcKind !== 'user') continue;
      const text = contentText(data.content);
      pushEntry(session, { role: 'user', ts, text: cleanUserText(text) });
      continue;
    }
    if (r.type === 'assistant/message') {
      const parts = data.message?.content || [];
      let text = '';
      let reasoning = '';
      for (const p of parts) {
        if (p.type === 'text') text += (text ? '\n' : '') + (p.text || '');
        else if (p.type === 'reasoning') reasoning += (reasoning ? '\n' : '') + (p.text || '');
        else if (p.type === 'tool-call') {
          const entry = {
            role: 'tool',
            ts,
            toolName: p.name || 'tool',
            toolInput: formatToolInput(parseMaybeJson(p.arguments)),
          };
          const key = p.id || p.callId;
          if (key) callMap.set(key, entry);
          pushEntry(session, entry);
        }
      }
      if (text || reasoning) pushEntry(session, { role: 'assistant', ts, text, reasoning: reasoning.trim(), model });
      continue;
    }
    if (r.type === 'tool/result') {
      const callId = data.message?.toolCallId || data.toolCallId;
      const text = contentText(data.message?.content || data.content);
      if (!attachToolResult(callMap, callId, text, data.message?.isError ? 'error' : 'completed')) {
        pushEntry(session, { role: 'tool', ts, toolName: data.name || 'tool', toolOutput: text });
      }
      continue;
    }
  }

  session.cwd = cwd;
  session.id = sessionId || path.basename(path.dirname(file));
  session.title = title || firstUserLine(session) || session.id;
  session.model = model;
  if (!session.entries.some((e) => e.role === 'user')) return null;
  return session;
}

/* ─────────────── 3. opencode（SQLite） ─────────────── */

function opencodeDbPaths() {
  const cands = [];
  if (process.env.XDG_DATA_HOME) cands.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  if (IS_WIN && process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db'));
  cands.push(path.join(HOME, '.local', 'share', 'opencode', 'opencode.db'));
  if (!IS_WIN) cands.push(path.join(HOME, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  return cands;
}

async function collectOpencode(ctx) {
  const probes = [];
  const existing = opencodeDbPaths().filter((p) => fs.existsSync(p));
  if (!existing.length) return { sessions: [], probes: ['~/.local/share/opencode/opencode.db（不存在）'] };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return {
      sessions: [],
      probes: ['opencode.db 存在，但当前 Node 不支持 node:sqlite（需 Node 22.5+，或加 --experimental-sqlite）'],
    };
  }

  const sessions = [];
  for (const dbPath of existing) {
    probes.push(dbPath);
    // 数据库可能被 opencode 正在写入（WAL 模式），复制快照后再读，避免锁与半写状态
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlog-oc-'));
    const copy = path.join(tmpDir, 'opencode.db');
    try {
      fs.copyFileSync(dbPath, copy);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
      }
    } catch (e) {
      ctx.warn(`opencode 数据库复制失败: ${e.message}`);
      continue;
    }

    let db;
    try {
      db = new DatabaseSync(copy);
    } catch (e) {
      ctx.warn(`opencode 数据库打开失败: ${e.message}`);
      continue;
    }

    try {
      let rows = [];
      try {
        rows = db
          .prepare('SELECT id, directory, title, model, time_created, time_updated FROM session_v2 ORDER BY time_created')
          .all();
      } catch {
        // 老版本 schema
        rows = db.prepare('SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_created').all();
      }

      for (const row of rows) {
        if (!isUnder(row.directory, ctx.workspace)) continue;
        const session = makeSession({
          agent: 'opencode',
          agentLabel: 'opencode',
          id: row.id,
          title: row.title || row.id,
          cwd: row.directory,
          source: dbPath,
          model: typeof row.model === 'string' ? row.model : '',
        });
        session.startedAt = toMillis(row.time_created);
        session.endedAt = toMillis(row.time_updated);

        const msgs = db
          .prepare('SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq')
          .all(row.id);
        const callMap = new Map();

        for (const m of msgs) {
          let data;
          try {
            data = JSON.parse(m.data);
          } catch {
            continue;
          }
          const ts = toMillis(m.time_created) || toMillis(data?.time?.created);

          if (m.type === 'user') {
            const text = data.text || contentText(data.content) || data.metadata?.displayText || '';
            pushEntry(session, { role: 'user', ts, text: cleanUserText(text) });
            continue;
          }
          if (m.type === 'assistant') {
            for (const part of data.content || []) {
              if (part.type === 'text') {
                pushEntry(session, { role: 'assistant', ts, text: part.text || '', model: data.model?.id || '' });
              } else if (part.type === 'reasoning') {
                pushEntry(session, { role: 'assistant', ts, reasoning: part.text || '' });
              } else if (part.type === 'tool') {
                const st = part.state || {};
                const entry = {
                  role: 'tool',
                  ts,
                  toolName: part.name || 'tool',
                  toolInput: formatToolInput(st.input),
                  toolOutput: st.status === 'completed' ? outputText(st.output) : st.error ? String(st.error) : '',
                  toolStatus: st.status || '',
                };
                if (part.id || part.callID) callMap.set(part.id || part.callID, entry);
                pushEntry(session, entry);
              }
            }
            continue;
          }
          // system / 其它类型默认丢弃
        }
        if (!session.entries.some((e) => e.role === 'user')) continue;
        if (!session.title || session.title === session.id) session.title = firstUserLine(session) || session.id;
        sessions.push(session);
      }
    } catch (e) {
      ctx.warn(`opencode 读取失败: ${e.message}`);
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return { sessions, probes };
}

/* ─────────────── 4. Qoder（Claude 风格 JSONL） ─────────────── */

function collectQoder(ctx) {
  const root = existingDir(path.join(HOME, '.qoder', 'projects'));
  if (!root) return { sessions: [], probes: ['~/.qoder/projects（不存在）'] };
  const { sessions, probes } = collectClaudeStyle(root, {
    agent: 'qoder',
    agentLabel: 'Qoder',
    ctx,
    probePrefix: '~/.qoder/projects',
  });
  return { sessions, probes };
}

/* ─────────────── 5. GitHub Copilot（VS Code 系） ─────────────── */

function vscodeAppDataDirs() {
  const names = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Trae', 'Trae CN', 'Windsurf', 'Kiro', 'Qoder'];
  const out = [];
  for (const n of names) {
    if (IS_WIN) {
      if (process.env.APPDATA) out.push({ editor: n, dir: path.join(process.env.APPDATA, n, 'User', 'workspaceStorage') });
    } else if (process.platform === 'darwin') {
      out.push({ editor: n, dir: path.join(HOME, 'Library', 'Application Support', n, 'User', 'workspaceStorage') });
    } else {
      out.push({ editor: n, dir: path.join(HOME, '.config', n, 'User', 'workspaceStorage') });
    }
  }
  return out.filter((x) => fs.existsSync(x.dir));
}

function collectCopilotVSCode(ctx) {
  const editors = vscodeAppDataDirs();
  if (!editors.length) return { sessions: [], probes: ['未找到 VS Code 系 workspaceStorage 目录'] };

  const sessions = [];
  const probes = [];
  for (const { editor, dir } of editors) {
    let matchedDirs = 0;
    for (const hashDir of listDirs(dir)) {
      // 先用 workspace.json 做廉价过滤，避免解析上千个无关工作区的聊天记录
      const ws = readJsonSafe(path.join(hashDir, 'workspace.json'));
      const folder = ws?.folder || ws?.workspace || '';
      if (!folder || !isUnder(folder, ctx.workspace)) continue;
      matchedDirs++;

      const chatDir = existingDir(path.join(hashDir, 'chatSessions'));
      if (!chatDir) continue;
      const files = listFiles(chatDir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
      for (const file of files) {
        try {
          const session = parseCopilotSessionFile(file, editor, folder);
          if (!session) continue;
          sessions.push(session);
          probes.push(`${editor}: workspaceStorage/${path.basename(hashDir)}/chatSessions/${path.basename(file)}`);
        } catch (e) {
          ctx.warn(`Copilot 解析失败 ${path.basename(file)}: ${e.message}`);
        }
      }
    }
    if (!matchedDirs) probes.push(`${editor}: ${dir}（无匹配工作区）`);
  }
  return { sessions, probes };
}

/**
 * 新版 .jsonl 是「一次快照 + 若干增量 patch」，按顺序重放出完整文档。
 * 三种写入语义（实测得出）：
 *   1. k = ['requests'] 且 v 为数组  → 追加式：新请求按顺序插入（同 requestId 视为更新）
 *   2. k 末级落在数组上且带 i        → 从下标 i 起覆盖/续写（流式文本常用：先截断到 i 再拼接）
 *   3. 其它                          → 直接赋值
 */
function replayChatSession(lines) {
  let doc = null;
  for (const rec of lines) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 0) {
      doc = rec.v ? JSON.parse(JSON.stringify(rec.v)) : null;
      continue;
    }
    if (!doc || !rec.k || rec.v === undefined) continue;
    const pathArr = Array.isArray(rec.k) ? rec.k : [rec.k];

    // ① requests 追加
    if (pathArr.length === 1 && pathArr[0] === 'requests' && Array.isArray(rec.v)) {
      if (!Array.isArray(doc.requests)) doc.requests = [];
      for (const item of rec.v) {
        if (!item) continue;
        const idx = item.requestId ? doc.requests.findIndex((r) => r && r.requestId === item.requestId) : -1;
        if (idx >= 0) doc.requests[idx] = item;
        else doc.requests.push(item);
      }
      continue;
    }

    // 定位父容器
    let container = doc;
    for (let i = 0; i < pathArr.length - 1; i++) {
      container = container?.[pathArr[i]];
      if (container == null) break;
    }
    if (container == null) continue;
    const lastKey = pathArr[pathArr.length - 1];

    // ② 带下标的数组续写
    if (typeof rec.i === 'number') {
      const arr = Array.isArray(container) && pathArr.length === 1 ? container : container[lastKey];
      if (!Array.isArray(arr)) {
        container[lastKey] = rec.v;
        continue;
      }
      if (Array.isArray(rec.v)) {
        if (rec.i <= arr.length) {
          arr.length = rec.i;
          arr.push(...rec.v);
        } else {
          for (let j = 0; j < rec.v.length; j++) arr[rec.i + j] = rec.v[j];
        }
      } else {
        arr[rec.i] = rec.v;
      }
      continue;
    }

    // ③ 直接赋值
    container[lastKey] = rec.v;
  }
  return doc;
}

function isCopilotDoc(doc) {
  if (!doc) return false;
  if (/copilot/i.test(doc.responderUsername || doc.responderName || '')) return true;
  for (const r of doc.requests || []) {
    const ext = r?.agent?.extensionId?.value || r?.agent?.id || '';
    if (/copilot/i.test(String(ext))) return true;
  }
  return false;
}

function parseCopilotSessionFile(file, editor, folder) {
  let doc;
  if (file.endsWith('.jsonl')) {
    doc = replayChatSession(readJsonLines(file));
  } else {
    doc = readJsonSafe(file);
  }
  if (!doc || !isCopilotDoc(doc)) return null;

  const requests = Array.isArray(doc.requests) ? doc.requests : [];
  if (!requests.length) return null;

  const session = makeSession({
    agent: 'copilot',
    agentLabel: 'GitHub Copilot',
    editor,
    id: doc.sessionId || path.basename(file).replace(/\.jsonl?$/, ''),
    title: doc.customTitle || doc.title || '',
    cwd: folder,
    source: file,
  });
  if (doc.creationDate) session.startedAt = toMillis(doc.creationDate);

  for (const req of requests) {
    if (req.hiddenFromTranscript) continue;
    const ts = toMillis(req.timestamp);
    // 助手侧的条目时间优先用 responseTimestamp（一轮可能持续几分钟）
    const ats = toMillis(req.responseTimestamp) || ts;
    const userText = req.message?.text || contentText(req.message?.parts) || '';
    pushEntry(session, { role: 'user', ts, text: cleanUserText(userText) });

    for (const part of req.response || []) {
      if (!part) continue;
      const kind = part.kind;
      // 新版格式：正文条目没有 kind，只有 { value: "..." }；老版是 kind: 'markdownContent'
      if (kind === 'markdownContent' || (!kind && typeof part.value === 'string')) {
        pushEntry(session, { role: 'assistant', ts: ats, text: part.value || '', model: req.modelId || '' });
      } else if (kind === 'thinking') {
        pushEntry(session, { role: 'assistant', ts: ats, reasoning: part.value || '' });
      } else if (kind === 'toolInvocationSerialized') {
        const input = part.toolSpecificData?.command
          ? { command: part.toolSpecificData.command }
          : part.invocationMessage?.value || part.invocationMessage || '';
        pushEntry(session, {
          role: 'tool',
          ts: ats,
          toolName: part.toolId || 'tool',
          toolInput: typeof input === 'string' ? input : formatToolInput(input),
          toolOutput: part.pastTenseMessage?.value || '',
          toolStatus: part.isComplete === false ? 'running' : 'completed',
        });
      } else if (kind === 'textEditGroup') {
        const files = (part.uri ? [part.uri] : (part.edits || []).map((e) => e.uri))
          .map((u) => u?.fsPath || u?.path || u?.external || '')
          .filter(Boolean);
        if (files.length) {
          pushEntry(session, {
            role: 'tool',
            ts: ats,
            toolName: 'editFiles',
            toolInput: formatToolInput({ files }),
            toolStatus: 'completed',
          });
        }
      }
      // 其它 kind（progressTaskSerialized / inlineReference / codeblockUri / mcpServersStarting 等）为过程噪音，跳过
    }
  }

  if (!session.entries.some((e) => e.role === 'user')) return null;
  if (!session.title) session.title = firstUserLine(session) || session.id;
  return session;
}

/* ─────────────── 6. GitHub Copilot CLI ─────────────── */

function collectCopilotCli(ctx) {
  const root = existingDir(path.join(HOME, '.copilot', 'session-state'));
  if (!root) return { sessions: [], probes: ['~/.copilot/session-state（不存在）'] };

  const sessions = [];
  const probes = [];
  for (const sessDir of listDirs(root)) {
    const eventsFile = path.join(sessDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) continue;
    try {
      const session = parseCopilotCliSession(sessDir, eventsFile);
      if (!session || !isUnder(session.cwd, ctx.workspace)) continue;
      sessions.push(session);
      probes.push(`~/.copilot/session-state/${path.basename(sessDir)}/events.jsonl`);
    } catch (e) {
      ctx.warn(`Copilot CLI 解析失败 ${path.basename(sessDir)}: ${e.message}`);
    }
  }
  return { sessions, probes };
}

/** workspace.yaml 只有几个标量字段，手写解析足够，避免引入 yaml 依赖 */
function parseSimpleYaml(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseCopilotCliSession(sessDir, eventsFile) {
  const meta = parseSimpleYaml(readTextSafe(path.join(sessDir, 'workspace.yaml')));
  const lines = readJsonLines(eventsFile);
  if (!lines.length) return null;

  const session = makeSession({
    agent: 'copilot-cli',
    agentLabel: 'GitHub Copilot CLI',
    id: meta.id || path.basename(sessDir),
    title: meta.name || '',
    cwd: meta.cwd || '',
    source: eventsFile,
    model: '',
  });
  if (meta.created_at) session.startedAt = toMillis(meta.created_at);

  const callMap = new Map();
  for (const r of lines) {
    if (!r || !r.type) continue;
    const ts = toMillis(r.timestamp);
    const d = r.data || {};

    if (r.type === 'session.start') {
      session.cwd = session.cwd || d.context?.cwd || '';
      session.model = session.model || d.selectedModel || '';
      continue;
    }
    if (r.type === 'user.message') {
      pushEntry(session, { role: 'user', ts, text: cleanUserText(d.content || '') });
      continue;
    }
    if (r.type === 'assistant.message') {
      if (d.content) pushEntry(session, { role: 'assistant', ts, text: d.content, model: d.model || session.model });
      for (const t of d.toolRequests || []) {
        const entry = {
          role: 'tool',
          ts,
          toolName: t.name || 'tool',
          toolInput: formatToolInput(t.arguments),
        };
        if (t.toolCallId) callMap.set(t.toolCallId, entry);
        pushEntry(session, entry);
      }
      continue;
    }
    if (r.type === 'tool.execution_complete') {
      const out = outputText(d.result?.content) || d.result?.detailedContent || '';
      if (!attachToolResult(callMap, d.toolCallId, out, d.success === false ? 'error' : 'completed')) {
        if (out) pushEntry(session, { role: 'tool', ts, toolName: d.toolName || 'tool', toolOutput: out });
      }
      continue;
    }
  }

  if (!session.cwd) return null;
  if (!session.title) session.title = firstUserLine(session) || session.id;
  if (!session.entries.some((e) => e.role === 'user')) return null;
  return session;
}

/* ─────────────── 7. Claude Code（附加） ─────────────── */

function collectClaudeCode(ctx) {
  const root = existingDir(path.join(HOME, '.claude', 'projects'));
  if (!root) return { sessions: [], probes: ['~/.claude/projects（不存在）'] };
  return collectClaudeStyle(root, {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    ctx,
    probePrefix: '~/.claude/projects',
  });
}

/** Qoder 与 Claude Code 共用 Claude 的 JSONL 会话格式 */
function collectClaudeStyle(root, { agent, agentLabel, ctx, probePrefix }) {
  const sessions = [];
  const probes = [];
  for (const projDir of listDirs(root)) {
    const files = walkFiles(projDir, (f) => f.endsWith('.jsonl'), 2);
    for (const file of files) {
      try {
        const session = parseClaudeStyleFile(file, agent, agentLabel);
        if (!session || !isUnder(session.cwd, ctx.workspace)) continue;
        sessions.push(session);
        probes.push(`${probePrefix}/${path.basename(projDir)}/${path.relative(projDir, file).replace(/\\/g, '/')}`);
      } catch (e) {
        ctx.warn(`${agentLabel} 解析失败 ${path.basename(file)}: ${e.message}`);
      }
    }
  }
  return { sessions, probes };
}

function parseClaudeStyleFile(file, agent, agentLabel) {
  const lines = readJsonLines(file);
  if (!lines.length) return null;

  let cwd = '';
  let title = '';
  let model = '';
  let sessionId = path.basename(file, '.jsonl');
  const seen = new Set();
  const callMap = new Map();
  const session = makeSession({ agent, agentLabel, id: sessionId, source: file });

  for (const r of lines) {
    if (!r || typeof r !== 'object') continue;
    if (r.cwd) cwd = cwd || r.cwd;
    if (r.sessionId) sessionId = r.sessionId;
    if (r.type === 'summary' && r.summary) {
      title = title || r.summary;
      continue;
    }
    if (r.type === 'custom-title' && r.customTitle) {
      title = r.customTitle;
      continue;
    }
    if (r.type === 'ai-title' && r.aiTitle) {
      title = r.aiTitle;
      continue;
    }
    if (r.isSidechain) continue; // 子代理（sidechain）轨迹默认不计入主对话

    const ts = toMillis(r.timestamp);
    const msg = r.message;
    if (!msg) continue;

    if (r.type === 'user') {
      const content = msg.content;
      if (typeof content === 'string') {
        if (r.uuid && seen.has(r.uuid)) continue;
        if (r.uuid) seen.add(r.uuid);
        pushEntry(session, { role: 'user', ts, text: cleanUserText(content) });
        continue;
      }
      let userText = '';
      for (const part of content || []) {
        if (part.type === 'tool_result') {
          const out = contentText(part.content);
          if (!attachToolResult(callMap, part.tool_use_id, out, part.is_error ? 'error' : 'completed')) {
            pushEntry(session, { role: 'tool', ts, toolOutput: out });
          }
        } else if (part.type === 'text') {
          userText += (userText ? '\n' : '') + (part.text || '');
        }
      }
      if (userText.trim()) {
        if (r.uuid && seen.has(r.uuid)) continue;
        if (r.uuid) seen.add(r.uuid);
        pushEntry(session, { role: 'user', ts, text: cleanUserText(userText) });
      }
      continue;
    }

    if (r.type === 'assistant') {
      if (r.uuid && seen.has(r.uuid)) continue;
      if (r.uuid) seen.add(r.uuid);
      const m = msg.model || '';
      if (m && !model) model = m;
      let text = '';
      let reasoning = '';
      for (const part of msg.content || []) {
        if (part.type === 'text') text += (text ? '\n' : '') + (part.text || '');
        else if (part.type === 'thinking') reasoning += (reasoning ? '\n' : '') + (part.thinking || '');
        else if (part.type === 'tool_use') {
          const entry = { role: 'tool', ts, toolName: part.name || 'tool', toolInput: formatToolInput(part.input) };
          if (part.id) callMap.set(part.id, entry);
          pushEntry(session, entry);
        }
      }
      if (text || reasoning) pushEntry(session, { role: 'assistant', ts, text, reasoning: reasoning.trim(), model: m });
      continue;
    }
  }

  session.cwd = cwd;
  session.id = sessionId;
  session.model = model;
  if (!session.entries.some((e) => e.role === 'user')) return null;
  session.title = title || firstUserLine(session) || sessionId;
  return session;
}

/* ─────────────── 内容抽取小工具 ─────────────── */

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object') return content.text || content.value || '';
    return '';
  }
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '';
      if (typeof c.text === 'string') return c.text;
      if (typeof c.value === 'string') return c.value;
      if (c.content) return contentText(c.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    if (typeof output.output === 'string') return output.output;
    if (typeof output.text === 'string') return output.text;
    if (output.content) return contentText(output.content);
    try {
      return JSON.stringify(output);
    } catch {
      return '';
    }
  }
  return String(output);
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** 工具入参统一格式化：只保留最有信息量的字段，避免整段 JSON 噪音 */
function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const preferred = ['command', 'description', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'files', 'tool_names', 'toolName', 'name', 'prompt'];
  const picked = {};
  for (const k of preferred) {
    if (input[k] !== undefined && input[k] !== '') picked[k] = input[k];
  }
  const keys = Object.keys(input).filter((k) => !(k in picked));
  for (const k of keys.slice(0, 3)) picked[k] = input[k];
  try {
    return JSON.stringify(picked, null, 0);
  } catch {
    return '';
  }
}

function firstUserLine(session) {
  const first = session.entries.find((e) => e.role === 'user' && e.text);
  if (!first) return '';
  return first.text.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/* ═══════════════════════════════ 渲染 ═══════════════════════════════ */

const AGENT_ORDER = ['workbuddy', 'deepseek-harness', 'opencode', 'qoder', 'copilot', 'copilot-cli', 'claude-code'];

function renderSessionMd(session, opts) {
  const st = sessionStats(session);
  // 若整个会话没有任何助手正文（例如只记录了思考过程），则退回展示思考内容，避免文档空掉
  const hasAssistantText = session.entries.some((e) => e.role === 'assistant' && e.text);
  const showReasoning = opts.reasoning || !hasAssistantText;
  const lines = [];
  lines.push(`# ${session.title || session.id}`);
  lines.push('');
  lines.push(`- **Agent**：${session.agentLabel}${session.editor ? `（${session.editor}）` : ''}`);
  lines.push(`- **会话 ID**：\`${session.id}\``);
  if (session.model) lines.push(`- **模型**：${session.model}`);
  lines.push(`- **工作区**：\`${session.cwd || '未记录'}\``);
  lines.push(`- **开始时间**：${fmtTime(session.startedAt)}`);
  lines.push(`- **结束时间**：${fmtTime(session.endedAt)}`);
  lines.push(`- **规模**：${st.userTurns} 轮提问 / ${st.assistant} 条助手消息 / ${st.tools} 次工具调用`);
  lines.push(`- **原始记录**：\`${session.source}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  let turn = 0;
  let pendingReasoning = [];
  for (const e of session.entries) {
    if (e.role === 'user') {
      turn++;
      lines.push(`## 第 ${turn} 轮`);
      lines.push('');
      lines.push(`### 用户 · ${fmtTime(e.ts, false)} ${fmtTime(e.ts).slice(11)}`);
      lines.push('');
      lines.push(fence(e.text || '（空）'));
      lines.push('');
      continue;
    }
    if (e.role === 'assistant') {
      if (e.reasoning && !showReasoning) {
        pendingReasoning.push(e.reasoning);
        if (!e.text) continue;
      }
      if (e.text) {
        if (e.reasoning && showReasoning) {
          lines.push(`### 助手 · ${fmtTime(e.ts).slice(11)}（含思考过程）`);
          lines.push('');
          lines.push('<details><summary>思考过程</summary>');
          lines.push('');
          lines.push(fence(truncate(cleanHeavy(e.reasoning), opts.reasoningChars)));
          lines.push('');
          lines.push('</details>');
          lines.push('');
          lines.push(fence(cleanHeavy(e.text)));
        } else {
          lines.push(`### 助手 · ${fmtTime(e.ts).slice(11)}`);
          lines.push('');
          lines.push(fence(cleanHeavy(e.text)));
        }
        lines.push('');
      } else if (e.reasoning && showReasoning) {
        lines.push('### 助手（思考）');
        lines.push('');
        lines.push(fence(truncate(cleanHeavy(e.reasoning), opts.reasoningChars)));
        lines.push('');
      }
      continue;
    }
    if (e.role === 'tool') {
      if (!opts.tools) continue;
      const status = e.toolStatus === 'error' ? '（失败）' : e.toolStatus === 'running' ? '（进行中）' : '';
      lines.push(`#### 工具调用 · \`${e.toolName}\`${status} · ${fmtTime(e.ts).slice(11)}`);
      lines.push('');
      if (e.toolInput) {
        lines.push('入参：');
        lines.push('');
        lines.push(fence(truncate(cleanHeavy(e.toolInput), opts.toolInputChars)));
        lines.push('');
      }
      if (e.toolOutput) {
        lines.push('结果：');
        lines.push('');
        lines.push(fence(truncate(cleanHeavy(e.toolOutput), opts.toolOutputChars)));
        lines.push('');
      }
      continue;
    }
  }

  if (pendingReasoning.length && showReasoning && !session.entries.some((e) => e.role === 'assistant' && e.reasoning && e.text)) {
    lines.push('## 思考过程汇总');
    lines.push('');
    for (const r of pendingReasoning) {
      lines.push(fence(truncate(cleanHeavy(r), opts.reasoningChars)));
      lines.push('');
    }
  }

  if (!st.userTurns) {
    lines.push('_（该会话未解析到用户提问，可能是被中断的空会话）_');
    lines.push('');
  }

  return applyRedactionLines(lines, opts);
}

function fence(text) {
  const body = String(text == null ? '' : text).replace(/```/g, 'ˋˋˋ');
  return '```text\n' + body.replace(/\s+$/, '') + '\n```';
}

function renderIndexMd(sessions, meta, probes, opts) {
  const lines = [];
  lines.push('# 工作区 AI 对话记录汇总');
  lines.push('');
  lines.push(`- **工作区**：\`${meta.workspace}\``);
  lines.push(`- **导出时间**：${fmtTime(Date.now())}`);
  lines.push(`- **导出工具**：agentlog v${VERSION}`);
  if (opts.since || opts.until) {
    lines.push(`- **时间范围**：${opts.since || '不限'} ~ ${opts.until || '不限'}`);
  }
  lines.push('');

  const total = { userTurns: 0, tools: 0, chars: 0 };
  const byAgent = new Map();
  for (const s of sessions) {
    const st = sessionStats(s);
    total.userTurns += st.userTurns;
    total.tools += st.tools;
    total.chars += st.chars;
    const cur = byAgent.get(s.agent) || { sessions: 0, turns: 0, tools: 0, label: s.agentLabel };
    cur.sessions++;
    cur.turns += st.userTurns;
    cur.tools += st.tools;
    byAgent.set(s.agent, cur);
  }

  lines.push(`**共 ${sessions.length} 个会话，${total.userTurns} 轮提问，${total.tools} 次工具调用，约 ${(total.chars / 1000).toFixed(0)}k 字符交互内容。**`);
  lines.push('');

  lines.push('## 按 Agent 统计');
  lines.push('');
  lines.push('| Agent | 会话数 | 提问轮次 | 工具调用 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const agent of AGENT_ORDER) {
    const v = byAgent.get(agent);
    if (v) lines.push(`| ${v.label} | ${v.sessions} | ${v.turns} | ${v.tools} |`);
  }
  for (const [agent, v] of byAgent) {
    if (!AGENT_ORDER.includes(agent)) lines.push(`| ${v.label} | ${v.sessions} | ${v.turns} | ${v.tools} |`);
  }
  lines.push('');

  lines.push('## 会话清单');
  lines.push('');
  lines.push('| # | Agent | 会话标题 | 时间 | 轮次 | 工具 | 记录文件 |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | --- |');
  sessions.forEach((s, i) => {
    const st = sessionStats(s);
    const title = (s.title || s.id).replace(/\|/g, '/').slice(0, 60);
    const link = `transcripts/${transcriptFileName(s, i)}`;
    lines.push(
      `| ${i + 1} | ${s.agentLabel}${s.editor ? ` / ${s.editor}` : ''} | [${title}](${encodeURI(link)}) | ${fmtTime(s.startedAt, false)} | ${st.userTurns} | ${st.tools} | \`${path.basename(s.source)}\` |`,
    );
  });
  lines.push('');

  if (opts.merged && sessions.length > 1) {
    lines.push('## 合并时间线');
    lines.push('');
    lines.push('多个 Agent 的交互按时间顺序合并：见 [timeline.md](timeline.md)。');
    lines.push('');
  }

  lines.push('## 数据文件');
  lines.push('');
  lines.push('- `sessions.json`：结构化原始数据（含完整消息与工具调用），便于二次处理或存档');
  lines.push('- `manifest.json`：本次导出的参数与数据来源清单');
  lines.push('');
  lines.push('## 数据来源说明');
  lines.push('');
  lines.push('本工具直接读取各 Agent 在本机保存的原始会话文件，不做联网上传。本次探测到的记录位置：');
  lines.push('');
  for (const p of probes) lines.push(`- \`${tildePath(p)}\``);
  lines.push('');
  lines.push('> 说明：Agent 升级后若更改存储格式，对应适配器可能需要更新；未匹配到会话的 Agent 会在下方「未发现的 Agent」中列出。');
  lines.push('');

  const seenAgents = new Set(sessions.map((s) => s.agent));
  const missing = AGENT_ORDER.filter((a) => !seenAgents.has(a));
  if (missing.length) {
    lines.push('## 未发现的 Agent');
    lines.push('');
    lines.push('以下 Agent 未在该工作区找到会话（可能未使用、未登录，或日志存放在别处）：');
    lines.push('');
    for (const a of missing) lines.push(`- ${PROBE_LABELS[a] || a}`);
    lines.push('');
  }

  return applyRedactionLines(lines, opts);
}

const PROBE_LABELS = {  workbuddy: 'WorkBuddy（~/.workbuddy/projects）',
  'deepseek-harness': 'DeepSeek Harness（~/.dsh/sessions）',
  opencode: 'opencode（~/.local/share/opencode/opencode.db）',
  qoder: 'Qoder（~/.qoder/projects）',
  copilot: 'GitHub Copilot（VS Code workspaceStorage/chatSessions）',
  'copilot-cli': 'GitHub Copilot CLI（~/.copilot/session-state）',
  'claude-code': 'Claude Code（~/.claude/projects）',
};

function renderTimelineMd(sessions, meta, opts) {
  const rows = [];
  for (const s of sessions) {
    for (const e of s.entries) {
      if (e.role === 'user') rows.push({ ts: e.ts, session: s, entry: e });
      else if (e.role === 'assistant' && e.text) rows.push({ ts: e.ts, session: s, entry: e });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);

  const lines = [];
  lines.push('# 跨 Agent 交互时间线');
  lines.push('');
  lines.push(`- **工作区**：\`${meta.workspace}\``);
  lines.push(`- **导出时间**：${fmtTime(Date.now())}`);
  lines.push(`- **范围**：${sessions.length} 个会话，按消息时间排序`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const r of rows) {
    const who = r.entry.role === 'user' ? '用户' : '助手';
    lines.push(`### ${fmtTime(r.entry.ts)} · [${r.session.agentLabel}] ${who}`);
    lines.push('');
    lines.push('> ' + (r.session.title || r.session.id).replace(/\n/g, ' '));
    lines.push('');
    lines.push(fence(truncate(cleanHeavy(r.entry.text), opts.mergedChars)));
    lines.push('');
  }
  return applyRedactionLines(lines, opts);
}

/* ═══════════════════════════════ 脱敏 ═══════════════════════════════ */

const SECRET_RULES = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'ghp_***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT-***'],
  [/((?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1***'],
];

const PII_RULES = [
  [/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, '***@***'],
  [/\b1[3-9]\d{9}\b/g, '1**********'],
  // 本机用户名出现在路径里时替换掉
  [new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\/g, '[\\\\/]'), 'gi'), '<HOME>'],
];

function redactText(text, opts) {
  let t = String(text);
  for (const [re, rep] of SECRET_RULES) t = t.replace(re, rep);
  if (opts.redact) for (const [re, rep] of PII_RULES) t = t.replace(re, rep);
  return t;
}

function redactDeep(value, opts) {
  if (typeof value === 'string') return redactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out;
  }
  return value;
}

/** 渲染期脱敏：直接作用在输出行上，避免漏掉任何拼进来的片段 */
function applyRedactionLines(lines, opts) {
  return lines.map((l) => redactText(l, opts));
}

/* ═══════════════════════════════ 主流程 ═══════════════════════════════ */

const ADAPTERS = [
  { id: 'workbuddy', label: 'WorkBuddy', collect: collectWorkBuddy },
  { id: 'deepseek-harness', label: 'DeepSeek Harness', collect: collectDeepseekHarness },
  { id: 'opencode', label: 'opencode', collect: collectOpencode },
  { id: 'qoder', label: 'Qoder', collect: collectQoder },
  { id: 'copilot', label: 'GitHub Copilot', collect: collectCopilotVSCode },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', collect: collectCopilotCli },
  { id: 'claude-code', label: 'Claude Code', collect: collectClaudeCode },
];

function parseArgs(argv) {
  const opts = {
    workspace: '',
    out: '',
    agents: null,
    since: null,
    until: null,
    sinceRaw: '',
    untilRaw: '',
    tools: true,
    reasoning: false,
    redact: false,
    merged: true,
    toolOutputChars: 1500,
    toolInputChars: 600,
    reasoningChars: 4000,
    mergedChars: 3000,
    listOnly: false,
    verbose: false,
    gui: false,
    selfTest: false,
    help: false,
    jsonOnly: false,
    mdOnly: false,
    quiet: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        console.log(`agentlog v${VERSION}`);
        process.exit(0);
        break;
      case '--gui':
        opts.gui = true;
        break;
      case '-o':
      case '--out':
        opts.out = next();
        break;
      case '--agents':
        opts.agents = String(next() || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--since':
        opts.sinceRaw = next();
        opts.since = parseBoundary(opts.sinceRaw, false);
        break;
      case '--until':
        opts.untilRaw = next();
        opts.until = parseBoundary(opts.untilRaw, true);
        break;
      case '--no-tools':
        opts.tools = false;
        break;
      case '--reasoning':
        opts.reasoning = true;
        break;
      case '--no-reasoning':
        opts.reasoning = false;
        break;
      case '--redact':
        opts.redact = true;
        break;
      case '--no-merge':
        opts.merged = false;
        break;
      case '--tool-output-chars':
        opts.toolOutputChars = Number(next()) || opts.toolOutputChars;
        break;
      case '--tool-input-chars':
        opts.toolInputChars = Number(next()) || opts.toolInputChars;
        break;
      case '--merged-chars':
        opts.mergedChars = Number(next()) || opts.mergedChars;
        break;
      case '--list':
        opts.listOnly = true;
        break;
      case '--json-only':
        opts.jsonOnly = true;
        break;
      case '--md-only':
        opts.mdOnly = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--self-test':
        opts.selfTest = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`未知参数：${a}（用 --help 查看用法）`);
          process.exit(2);
        }
        if (!opts.workspace) opts.workspace = a;
        break;
    }
  }
  return opts;
}

/** 唤起同目录下的 Windows 原生图形界面（agentlog-gui.ps1） */
function launchGui(workspace) {
  if (process.platform !== 'win32') {
    console.error('图形界面仅在 Windows 上可用。命令行用法：agentlog <工作区目录> [选项]');
    process.exit(1);
  }
  const selfDir = path.dirname(process.argv[1] || '.');
  const script = path.join(selfDir, 'agentlog-gui.ps1');
  if (!fs.existsSync(script)) {
    console.error(`未找到图形界面脚本：${script}`);
    console.error('请从发布包中获取 agentlog-gui.ps1，或与 agentlog.mjs 放在同一目录。');
    process.exit(1);
  }
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script];
  if (workspace) psArgs.push('-Workspace', workspace);
  const r = spawnSync('powershell.exe', psArgs, { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

function printHelp() {
  console.log(`agentlog v${VERSION} — 采集工作区内各类 AI Agent 的对话日志

用法：
  node agentlog.mjs [工作区目录] [选项]

常用：
  -o, --out <目录>          输出目录（默认 <工作区>/.agent-logs）
  --agents <列表>           只导出指定 Agent，逗号分隔：
                            workbuddy, deepseek-harness, opencode, qoder, copilot, copilot-cli, claude-code
  --since <日期>            只保留该时间之后的会话，如 2026-10-01 或 "2026-10-01 12:00"
  --until <日期>            只要该时间之前的会话
  --redact                  脱敏：邮箱、手机号、本机用户名路径（API Key/Token 始终自动打码）
  --no-tools                不输出工具调用细节（只保留对话）
  --reasoning               额外输出模型的思考过程（会显著变长，交作业一般不需要）
  --no-reasoning            不输出思考过程（默认）
  --no-merge                不生成跨 Agent 合并时间线
  --tool-output-chars <n>   工具输出截断长度（默认 1500）
  --list                    只列出发现的会话，不写文件
  --json-only / --md-only   只输出结构化数据 / 只输出 Markdown
  --gui                     启动 Windows 原生图形界面（仅 Windows）
  --self-test               检查运行环境（zstd、sqlite 支持情况）
  -h, --help                显示帮助

示例：
  node agentlog.mjs .                        # 导出当前目录的对话记录到 ./.agent-logs
  node agentlog.mjs "D:/my project" -o ./记录 --redact
  node agentlog.mjs . --agents workbuddy,opencode --since 2026-10-20
  node agentlog.mjs . --list                 # 先看看有什么
  node agentlog.mjs --gui                    # 打开图形界面

独立版 agentlog.exe 用法相同；不带任何参数运行会自动打开图形界面。

支持的 Agent 与本机存储位置：
  WorkBuddy            ~/.workbuddy/projects/<项目>/<sessionId>.jsonl
  DeepSeek Harness     ~/.dsh/sessions/<项目>/session-*/session.v4.jsonl.zstd
  opencode             ~/.local/share/opencode/opencode.db（SQLite）
  Qoder                ~/.qoder/projects/<项目>/*.jsonl
  GitHub Copilot       <AppData>/Code/User/workspaceStorage/<hash>/chatSessions/*
  GitHub Copilot CLI   ~/.copilot/session-state/<id>/events.jsonl
  Claude Code          ~/.claude/projects/<项目>/*.jsonl

环境要求：Node.js >= 22.5（zstd 解码需 >= 22.15，否则回退系统 zstd 命令）。无第三方依赖。
`);
}

function selfTest() {
  console.log('agentlog 环境自检');
  console.log(`  Node 版本          : ${process.version}`);
  console.log(`  平台               : ${process.platform} (${os.arch()})`);
  console.log(`  zstd 解码（内置）  : ${typeof zlib.zstdDecompressSync === 'function' ? '可用' : '不可用（将回退系统 zstd 命令）'}`);
  const zstdCli = spawnSync('zstd', ['--version'], { encoding: 'utf8' });
  console.log(`  系统 zstd 命令     : ${zstdCli.status === 0 ? '可用' : '未找到'}`);
  return import('node:sqlite')
    .then(() => {
      console.log('  node:sqlite        : 可用');
      console.log('');
      console.log('各 Agent 存储目录：');
      for (const a of ADAPTERS) console.log(`  ${a.label.padEnd(22)}: ${describeRoot(a.id)}`);
    })
    .catch(() => {
      console.log('  node:sqlite        : 不可用（opencode 适配器将跳过；请升级到 Node 22.5+ 或加 --experimental-sqlite）');
    });
}

function describeRoot(id) {
  const map = {
    workbuddy: path.join(HOME, '.workbuddy', 'projects'),
    'deepseek-harness': path.join(HOME, '.dsh', 'sessions'),
    qoder: path.join(HOME, '.qoder', 'projects'),
    'copilot-cli': path.join(HOME, '.copilot', 'session-state'),
    'claude-code': path.join(HOME, '.claude', 'projects'),
  };
  if (id === 'opencode') {
    const p = opencodeDbPaths().find((x) => fs.existsSync(x));
    return p ? `存在 ${p}` : '未找到 opencode.db';
  }
  if (id === 'copilot') {
    const dirs = vscodeAppDataDirs();
    return dirs.length ? dirs.map((d) => `${d.editor}: 存在`).join('; ') : '未找到 VS Code 系 workspaceStorage';
  }
  const p = map[id];
  return p && fs.existsSync(p) ? `存在 ${p}` : `未找到 ${p}`;
}

function transcriptFileName(session, index) {
  const idx = String(index + 1).padStart(2, '0');
  const day = session.startedAt ? fmtTime(session.startedAt, false) : 'unknown-date';
  const title = safeName(session.title || session.id, 'session');
  return `${idx}-${session.agent}-${day}-${title}.md`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (opts.gui) return launchGui(opts.workspace);
  if (opts.selfTest) return selfTest();

  const workspaceRaw = opts.workspace || process.cwd();
  const workspace = path.resolve(workspaceRaw);
  if (!fs.existsSync(workspace)) {
    // 目录可能被移动/改名，但历史日志仍按绝对路径保存，这里只警告不退出
    console.warn(`注意：工作区目录当前不存在（${workspace}），仍按路径字符串匹配历史记录。`);
  }

  const outDir = path.resolve(opts.out || path.join(workspace, '.agent-logs'));
  const ctx = {
    workspace,
    warn: (msg) => console.warn(`  ! ${msg}`),
  };

  const selected = opts.agents ? ADAPTERS.filter((a) => opts.agents.includes(a.id)) : ADAPTERS;
  if (!selected.length) {
    console.error(`没有匹配的 Agent：${opts.agents.join(',')}（可选：${ADAPTERS.map((a) => a.id).join(', ')}）`);
    process.exit(2);
  }

  if (!opts.quiet) console.log(`工作区：${workspace}`);

  let sessions = [];
  const probes = [];
  for (const adapter of selected) {
    if (!opts.quiet) process.stdout.write(`  探测 ${adapter.label} ... `);
    let res;
    try {
      res = await adapter.collect(ctx);
    } catch (e) {
      console.log(`失败：${e.message}`);
      continue;
    }
    sessions.push(...res.sessions);
    probes.push(...res.probes);
    if (!opts.quiet) console.log(`发现 ${res.sessions.length} 个会话`);
  }

  // 统一整理：合并流式碎片，避免一段话被切成十几块
  sessions.forEach(coalesceSession);
  const beforeFilter = sessions.length;

  // 时间过滤：会话只要有落在区间内的消息就保留
  if (opts.since || opts.until) {
    sessions = sessions.filter((s) => {
      const times = s.entries.map((e) => e.ts).filter(Boolean);
      if (!times.length) return true;
      const max = Math.max(...times);
      const min = Math.min(...times);
      if (opts.since && max < opts.since) return false;
      if (opts.until && min > opts.until) return false;
      return true;
    });
  }

  // 排序：按开始时间正序，同时间按 Agent 固定顺序
  sessions.sort((a, b) => {
    const t = (a.startedAt || 0) - (b.startedAt || 0);
    if (t) return t;
    return AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent);
  });

  if (!sessions.length) {
    if (!opts.quiet) {
      console.log('');
      if (beforeFilter > 0) {
        console.log(`工作区内共找到 ${beforeFilter} 个会话，但都不在指定的时间范围内（--since / --until）。`);
      } else {
        console.log('没有找到该工作区的对话记录。');
        console.log('可能原因：工作区路径不一致（例如用软链接/不同盘符打开过）、Agent 换了存储位置、或该工作区确实没聊过。');
        console.log('可用 --self-test 查看各 Agent 存储目录是否存在；用 --list 查看已探测到的记录文件。');
      }
    }
    return;
  }

  if (opts.listOnly) {
    console.log('');
    for (const [i, s] of sessions.entries()) {
      const st = sessionStats(s);
      console.log(
        `${String(i + 1).padStart(2, ' ')}. [${s.agentLabel}${s.editor ? '/' + s.editor : ''}] ${s.title || s.id} · ${fmtTime(s.startedAt, false)} · ${st.userTurns} 轮 · ${st.tools} 次工具`,
      );
      console.log(`     ${s.source}`);
    }
    return;
  }

  /* ── 写文件 ── */
  fs.mkdirSync(outDir, { recursive: true });
  const transcriptDir = path.join(outDir, 'transcripts');
  if (!opts.jsonOnly) fs.mkdirSync(transcriptDir, { recursive: true });

  const renderOpts = {
    tools: opts.tools,
    reasoning: opts.reasoning,
    toolOutputChars: opts.toolOutputChars,
    toolInputChars: opts.toolInputChars,
    reasoningChars: opts.reasoningChars,
    mergedChars: opts.mergedChars,
    redact: opts.redact,
  };

  if (!opts.jsonOnly) {
    // 每个会话一份 Markdown，文件名带序号方便排序
    const usedNames = new Set();
    sessions.forEach((s, i) => {
      let name = transcriptFileName(s, i);
      let k = 2;
      while (usedNames.has(name)) {
        name = transcriptFileName(s, i).replace(/\.md$/, `-${k}.md`);
        k++;
      }
      usedNames.add(name);
      const md = renderSessionMd(s, renderOpts);
      fs.writeFileSync(path.join(transcriptDir, name), md.join('\n'), 'utf8');
    });

    const meta = { workspace };
    fs.writeFileSync(path.join(outDir, 'index.md'), renderIndexMd(sessions, meta, probes, { ...renderOpts, merged: opts.merged, since: opts.sinceRaw, until: opts.untilRaw }).join('\n'), 'utf8');

    if (opts.merged && sessions.length > 1) {
      fs.writeFileSync(path.join(outDir, 'timeline.md'), renderTimelineMd(sessions, meta, renderOpts).join('\n'), 'utf8');
    }
  }

  if (!opts.mdOnly) {
    const payload = {
      meta: {
        tool: `agentlog v${VERSION}`,
        exportedAt: new Date().toISOString(),
        workspace,
        workspaceRaw,
        agents: selected.map((a) => a.id),
        since: opts.sinceRaw || null,
        until: opts.untilRaw || null,
        redacted: opts.redact,
        sessionCount: sessions.length,
      },
      sessions: redactDeep(
        sessions.map((s) => ({
          agent: s.agent,
          agentLabel: s.agentLabel,
          editor: s.editor,
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          model: s.model,
          startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
          endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
          sourceFile: s.source,
          stats: sessionStats(s),
          entries: s.entries.map((e) => ({
            role: e.role,
            ts: e.ts ? new Date(e.ts).toISOString() : null,
            text: e.text || '',
            reasoning: e.reasoning || '',
            toolName: e.toolName || '',
            toolInput: e.toolInput || '',
            toolOutput: e.toolOutput || '',
            toolStatus: e.toolStatus || '',
            model: e.model || '',
          })),
        })),
        renderOpts,
      ),
    };
    fs.writeFileSync(path.join(outDir, 'sessions.json'), JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify({ ...payload.meta, probes, stats: sessions.map((s) => ({ agent: s.agent, title: s.title, ...sessionStats(s) })) }, null, 2),
      'utf8',
    );
  }

  if (!opts.quiet) {
    const total = sessions.reduce(
      (acc, s) => {
        const st = sessionStats(s);
        acc.turns += st.userTurns;
        acc.tools += st.tools;
        return acc;
      },
      { turns: 0, tools: 0 },
    );
    console.log('');
    console.log(`完成：${sessions.length} 个会话 / ${total.turns} 轮提问 / ${total.tools} 次工具调用`);
    console.log(`输出目录：${outDir}`);
    if (!opts.jsonOnly) {
      console.log(`  index.md          汇总与索引`);
      if (opts.merged && sessions.length > 1) console.log(`  timeline.md       跨 Agent 时间线`);
      console.log(`  transcripts/      每个会话一份完整记录`);
    }
    if (!opts.mdOnly) console.log(`  sessions.json     结构化数据`);
  }
}

main().catch((e) => {
  console.error('执行失败：', e?.stack || e);
  process.exit(1);
});
