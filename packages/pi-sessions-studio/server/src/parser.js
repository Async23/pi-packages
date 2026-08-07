import fs from 'node:fs';
import path from 'node:path';

/** 将一个 jsonl 文件解析为条目数组，跳过坏行 */
export function parseLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // 跳过被截断/损坏的行
    }
  }
  return entries;
}

function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 提取消息 content（数组或字符串）中的纯文本 */
export function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return '';
        if (typeof b === 'string') return b;
        if (b.type === 'text' || b.type === 'thinking') return b.text ?? b.thinking ?? '';
        if (b.type === 'image') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const CAP = 4000; // 单条搜索文本上限
const cap = (s) => (s && s.length > CAP ? s.slice(0, CAP) : s);

/**
 * 单次遍历，产出：
 *  - summary: 会话摘要（列表 / 统计用的小对象）
 *  - searchDocs: 全文搜索用的 {entryId, kind, text} 数组
 */
export function buildFileData(filePath, dirName) {
  const stat = fs.statSync(filePath);
  const entries = parseLines(filePath);
  const fileName = path.basename(filePath);
  const uuidMatch = fileName.match(/_([0-9a-f-]{36})\.jsonl$/i);
  const id = uuidMatch ? uuidMatch[1] : fileName.replace(/\.jsonl$/, '');

  const header = entries.find((e) => e.type === 'session') || {};
  const cwd = header.cwd || dirName || '(未知)';

  const summary = {
    id,
    file: filePath,
    fileName,
    dir: dirName,
    cwd,
    project: path.basename(cwd) || cwd,
    parentSession: header.parentSession || null,
    version: header.version ?? null,
    createdAt: toMs(header.timestamp) ?? stat.birthtimeMs ?? stat.mtimeMs,
    updatedAt: stat.mtimeMs,
    sizeBytes: stat.size,
    name: null,
    title: '',
    firstUserText: '',
    counts: {
      entries: entries.length,
      user: 0,
      assistant: 0,
      toolResults: 0,
      toolCalls: 0,
      bash: 0,
      thinkingBlocks: 0,
      compactions: 0,
      branchSummaries: 0,
      branchPoints: 0,
      leaves: 0,
    },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    cost: 0,
    models: [],
    tools: {},
    daily: {}, // date -> {messages, cost, input, output}
    hourWeek: {}, // "dow-hour" -> count （dow: 0=周一）
    durationMs: 0,
    lastActivityAt: null,
  };

  const modelSet = new Set();
  const childCount = new Map(); // parentId -> count
  const hasChild = new Set();
  const searchDocs = [];
  let firstMs = null;
  let lastMs = null;

  const bumpDaily = (ms, patch) => {
    if (ms == null) return;
    const k = dayKey(ms);
    const d = (summary.daily[k] ||= { messages: 0, cost: 0, input: 0, output: 0 });
    for (const [key, v] of Object.entries(patch)) d[key] += v;
  };
  const bumpHour = (ms) => {
    if (ms == null) return;
    const d = new Date(ms);
    const dow = (d.getDay() + 6) % 7; // 0=周一
    const k = `${dow}-${d.getHours()}`;
    summary.hourWeek[k] = (summary.hourWeek[k] || 0) + 1;
  };
  const addUsage = (usage, ms) => {
    if (!usage) return;
    summary.tokens.input += usage.input || 0;
    summary.tokens.output += usage.output || 0;
    summary.tokens.cacheRead += usage.cacheRead || 0;
    summary.tokens.cacheWrite += usage.cacheWrite || 0;
    summary.tokens.reasoning += usage.reasoning || 0;
    summary.tokens.total += usage.totalTokens || 0;
    const cost = usage.cost?.total || 0;
    summary.cost += cost;
    bumpDaily(ms, {
      cost,
      input: usage.input || 0,
      output: usage.output || 0,
    });
  };

  for (const e of entries) {
    const ms = toMs(e.timestamp);
    if (ms != null) {
      if (firstMs == null) firstMs = ms;
      lastMs = ms;
    }
    if (e.parentId != null) {
      const n = (childCount.get(e.parentId) || 0) + 1;
      childCount.set(e.parentId, n);
      hasChild.add(e.parentId);
    }

    switch (e.type) {
      case 'session_info':
        if (e.name) summary.name = e.name;
        if (e.name) searchDocs.push({ entryId: e.id, kind: 'session_info', text: cap(e.name) });
        break;
      case 'compaction': {
        summary.counts.compactions++;
        if (e.summary) searchDocs.push({ entryId: e.id, kind: 'compaction', text: cap(e.summary) });
        addUsage(e.usage, ms);
        break;
      }
      case 'branch_summary': {
        summary.counts.branchSummaries++;
        if (e.summary) searchDocs.push({ entryId: e.id, kind: 'branch_summary', text: cap(e.summary) });
        addUsage(e.usage, ms);
        break;
      }
      case 'model_change':
        if (e.modelId) modelSet.add(`${e.provider || '?'}/${e.modelId}`);
        break;
      case 'custom_message':
        if (typeof e.content === 'string')
          searchDocs.push({ entryId: e.id, kind: 'system', text: cap(e.content) });
        break;
      case 'message': {
        const m = e.message || {};
        const role = m.role;
        if (role === 'user') {
          summary.counts.user++;
          const text = contentText(m.content);
          if (!summary.firstUserText && text) summary.firstUserText = text.slice(0, 200);
          if (text) searchDocs.push({ entryId: e.id, kind: 'user', text: cap(text) });
          bumpDaily(ms, { messages: 1 });
          bumpHour(ms);
        } else if (role === 'assistant') {
          summary.counts.assistant++;
          if (m.model) modelSet.add(`${m.provider || '?'}/${m.model}`);
          const u = m.usage;
          addUsage(u, ms);
          bumpDaily(ms, { messages: 1 });
          bumpHour(ms);
          if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (!b || typeof b !== 'object') continue;
              if (b.type === 'text' && b.text)
                searchDocs.push({ entryId: e.id, kind: 'assistant', text: cap(b.text) });
              else if (b.type === 'thinking') {
                summary.counts.thinkingBlocks++;
                if (b.thinking)
                  searchDocs.push({ entryId: e.id, kind: 'thinking', text: cap(b.thinking) });
              } else if (b.type === 'toolCall') {
                summary.counts.toolCalls++;
                const argText = b.arguments ? JSON.stringify(b.arguments) : '';
                searchDocs.push({
                  entryId: e.id,
                  kind: 'tool',
                  text: cap(`${b.name || ''} ${argText}`),
                });
              }
            }
          }
        } else if (role === 'toolResult') {
          summary.counts.toolResults++;
          const name = m.toolName || '(unknown)';
          summary.tools[name] = (summary.tools[name] || 0) + 1;
          const text = contentText(m.content);
          if (text) searchDocs.push({ entryId: e.id, kind: 'tool', text: cap(text) });
        } else if (role === 'bashExecution') {
          summary.counts.bash++;
          const text = `${m.command || ''}\n${m.output || ''}`;
          searchDocs.push({ entryId: e.id, kind: 'bash', text: cap(text) });
        }
        break;
      }
      default:
        break;
    }
  }

  let branchPoints = 0;
  for (const n of childCount.values()) if (n > 1) branchPoints++;
  summary.counts.branchPoints = branchPoints;
  let leaves = 0;
  for (const e of entries) {
    if (e.type !== 'session' && e.id && !hasChild.has(e.id)) leaves++;
  }
  summary.counts.leaves = leaves;

  summary.models = [...modelSet];
  summary.durationMs = firstMs != null && lastMs != null ? Math.max(0, lastMs - firstMs) : 0;
  summary.lastActivityAt = lastMs ?? summary.updatedAt;
  const flatTitle = (summary.firstUserText || '').replace(/\s+/g, ' ').trim();
  summary.title = summary.name || flatTitle.slice(0, 120) || '(空会话)';

  return { summary, searchDocs };
}

/** 会话详情：原始条目 + 摘要 */
export function buildDetail(filePath, dirName) {
  const { summary } = buildFileData(filePath, dirName);
  const entries = parseLines(filePath);
  return { summary, entries };
}
