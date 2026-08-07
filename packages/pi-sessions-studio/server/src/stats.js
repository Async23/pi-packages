import { getIndex } from './scanner.js';
import { parseLines } from './parser.js';

/** 聚合所有会话摘要，产出全局统计 */
export function computeStats({ project } = {}) {
  let summaries = getIndex();
  if (project) summaries = summaries.filter((s) => s.cwd === project);

  const daily = {}; // date -> {messages, cost, input, output, sessions:Set 计数}
  const hourWeek = {}; // "dow-hour" -> count
  const models = {}; // provider/model -> {sessions, messages?, input, output, cacheRead, cacheWrite, cost}
  const tools = {}; // name -> count
  const projects = {}; // cwd -> {name, sessions, cost, tokens, messages, lastActive}

  const totals = {
    sessions: summaries.length,
    entries: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    compactions: 0,
    branchSummaries: 0,
    branchPoints: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    firstActivity: null,
    lastActivity: null,
    totalDurationMs: 0,
    sizeBytes: 0,
  };

  for (const s of summaries) {
    totals.entries += s.counts.entries;
    totals.userMessages += s.counts.user;
    totals.assistantMessages += s.counts.assistant;
    totals.toolCalls += s.counts.toolCalls;
    totals.compactions += s.counts.compactions;
    totals.branchSummaries += s.counts.branchSummaries || 0;
    totals.branchPoints += s.counts.branchPoints;
    totals.cost += s.cost;
    totals.input += s.tokens.input;
    totals.output += s.tokens.output;
    totals.cacheRead += s.tokens.cacheRead;
    totals.cacheWrite += s.tokens.cacheWrite;
    totals.totalDurationMs += s.durationMs;
    totals.sizeBytes += s.sizeBytes;
    if (totals.firstActivity == null || s.createdAt < totals.firstActivity)
      totals.firstActivity = s.createdAt;
    if (totals.lastActivity == null || s.lastActivityAt > totals.lastActivity)
      totals.lastActivity = s.lastActivityAt;

    for (const [k, v] of Object.entries(s.daily)) {
      const d = (daily[k] ||= { messages: 0, cost: 0, input: 0, output: 0, sessions: 0 });
      d.messages += v.messages;
      d.cost += v.cost;
      d.input += v.input;
      d.output += v.output;
      d.sessions += 1;
    }
    for (const [k, v] of Object.entries(s.hourWeek)) hourWeek[k] = (hourWeek[k] || 0) + v;
    for (const [k, v] of Object.entries(s.tools)) tools[k] = (tools[k] || 0) + v;

    const p = (projects[s.cwd] ||= {
      cwd: s.cwd,
      name: s.project,
      sessions: 0,
      cost: 0,
      tokens: 0,
      messages: 0,
      lastActive: 0,
    });
    p.sessions++;
    p.cost += s.cost;
    p.tokens += s.tokens.total;
    p.messages += s.counts.user + s.counts.assistant;
    p.lastActive = Math.max(p.lastActive, s.lastActivityAt);
  }

  return {
    totals,
    daily,
    hourWeek,
    tools,
    projects: Object.values(projects).sort((a, b) => b.cost - a.cost),
  };
}

/** 模型维度需要逐条 usage，单独从缓存的摘要无法拿到 → 从会话文件轻扫（惰性，仅统计页调用） */
const modelCache = new Map(); // file -> {mtimeMs, models: {key: {...}}}

export function computeModelStats({ project } = {}) {
  let summaries = getIndex();
  if (project) summaries = summaries.filter((s) => s.cwd === project);

  const agg = {};
  for (const s of summaries) {
    let hit = modelCache.get(s.file);
    if (!hit || hit.mtimeMs !== s.updatedAt) {
      const models = {};
      try {
        for (const e of parseLines(s.file)) {
          if (e.type !== 'message' || e.message?.role !== 'assistant') continue;
          const m = e.message;
          const key = `${m.provider || '?'}/${m.model || '?'}`;
          const u = m.usage || {};
          const t = (models[key] ||= {
            messages: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            cost: 0,
          });
          t.messages++;
          t.input += u.input || 0;
          t.output += u.output || 0;
          t.cacheRead += u.cacheRead || 0;
          t.cacheWrite += u.cacheWrite || 0;
          t.reasoning += u.reasoning || 0;
          t.cost += u.cost?.total || 0;
        }
      } catch {
        // ignore
      }
      hit = { mtimeMs: s.updatedAt, models };
      modelCache.set(s.file, hit);
    }
    for (const [key, v] of Object.entries(hit.models)) {
      const t = (agg[key] ||= {
        model: key,
        messages: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        cost: 0,
        sessions: 0,
      });
      t.messages += v.messages;
      t.input += v.input;
      t.output += v.output;
      t.cacheRead += v.cacheRead;
      t.cacheWrite += v.cacheWrite;
      t.reasoning += v.reasoning;
      t.cost += v.cost;
      t.sessions++;
    }
  }
  return Object.values(agg).sort((a, b) => b.cost - a.cost);
}
