import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, RUNTIME_STATE_FILE, SESSIONS_DIR } from './config.js';
import { getIndex, findById, resolveParent } from './scanner.js';
import { buildDetail } from './parser.js';
import { search } from './search.js';
import { computeStats, computeModelStats } from './stats.js';
import { toMarkdown } from './export.js';
import {
  STUDIO_SERVICE_ID,
  normalizeSessionsDir,
  removeOwnedRuntimeState,
  writeRuntimeState,
} from '../../shared/runtime-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression());

let listeningPort = PORT;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: STUDIO_SERVICE_ID,
    pid: process.pid,
    host: HOST,
    port: listeningPort,
    sessionsDir: normalizeSessionsDir(SESSIONS_DIR),
  });
});

app.get('/api/overview', (_req, res) => {
  const summaries = getIndex();
  const stats = computeStats({});
  const recent = summaries.slice(0, 8).map(slim);
  const topTools = Object.entries(stats.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  res.json({
    sessionsDir: SESSIONS_DIR,
    totals: stats.totals,
    daily: stats.daily,
    topTools,
    projects: stats.projects.slice(0, 8),
    recent,
    generatedAt: Date.now(),
  });
});

app.get('/api/projects', (_req, res) => {
  const stats = computeStats({});
  res.json(stats.projects);
});

function slim(s) {
  return {
    id: s.id,
    title: s.title,
    name: s.name,
    project: s.project,
    cwd: s.cwd,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    durationMs: s.durationMs,
    counts: s.counts,
    tokens: s.tokens,
    cost: s.cost,
    models: s.models,
    sizeBytes: s.sizeBytes,
    parentSession: s.parentSession,
  };
}

app.get('/api/sessions', (req, res) => {
  const { project, q, sort = 'updated', order = 'desc', limit = '50', offset = '0' } = req.query;
  let items = getIndex();
  if (project) items = items.filter((s) => s.cwd === project);
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(
      (s) =>
        s.title.toLowerCase().includes(needle) ||
        s.project.toLowerCase().includes(needle) ||
        s.cwd.toLowerCase().includes(needle) ||
        s.models.some((m) => m.toLowerCase().includes(needle)) ||
        s.id.includes(needle)
    );
  }
  const keyFns = {
    updated: (s) => s.lastActivityAt,
    created: (s) => s.createdAt,
    cost: (s) => s.cost,
    tokens: (s) => s.tokens.total,
    messages: (s) => s.counts.user + s.counts.assistant,
    duration: (s) => s.durationMs,
    size: (s) => s.sizeBytes,
  };
  const keyFn = keyFns[sort] || keyFns.updated;
  items = [...items].sort((a, b) => (order === 'asc' ? keyFn(a) - keyFn(b) : keyFn(b) - keyFn(a)));
  const total = items.length;
  const off = parseInt(offset, 10) || 0;
  const lim = Math.min(parseInt(limit, 10) || 50, 500);
  res.json({ total, items: items.slice(off, off + lim).map(slim) });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = findById(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  try {
    const detail = buildDetail(s.file, s.dir);
    detail.parentSessionId = resolveParent(s.parentSession);
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/sessions/:id/export.md', (req, res) => {
  const s = findById(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const md = toMarkdown(buildDetail(s.file, s.dir));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="session-${s.id.slice(-12)}.md"`);
  res.send(md);
});

app.get('/api/sessions/:id/export.jsonl', (req, res, next) => {
  const s = findById(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const safeId = String(s.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-64) || 'session';
  res.download(
    s.file,
    `session-${safeId}.jsonl`,
    { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } },
    (err) => {
      if (err) next(err);
    }
  );
});

app.get('/api/search', (req, res) => {
  const { q, project, kind, limit } = req.query;
  res.json(search({ q, project, kind, limit: Math.min(parseInt(limit, 10) || 60, 200) }));
});

app.get('/api/stats', (req, res) => {
  const { project } = req.query;
  const stats = computeStats({ project });
  const models = computeModelStats({ project });
  res.json({ ...stats, models });
});

// 生产模式：托管前端构建产物
const dist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (res.headersSent) return _next(err);
  console.error(err);
  res.status(500).json({ error: String(err?.message || err) });
});

function displayHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

const server = app.listen(PORT, HOST, async () => {
  const address = server.address();
  listeningPort = typeof address === 'object' && address ? address.port : PORT;

  if (RUNTIME_STATE_FILE) {
    try {
      await writeRuntimeState(RUNTIME_STATE_FILE, {
        service: STUDIO_SERVICE_ID,
        pid: process.pid,
        host: HOST,
        port: listeningPort,
        sessionsDir: normalizeSessionsDir(SESSIONS_DIR),
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`[pi-sessions-studio] 无法写入运行状态：${error.message}`);
      server.close(() => process.exit(1));
      return;
    }
  }

  console.log(`[pi-sessions-studio] http://${displayHost(HOST)}:${listeningPort}`);
  console.log(`[pi-sessions-studio] sessions dir: ${SESSIONS_DIR}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pi-sessions-studio] received ${signal}, shutting down`);

  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  server.close(async (error) => {
    clearTimeout(forceExit);
    if (RUNTIME_STATE_FILE) {
      await removeOwnedRuntimeState(RUNTIME_STATE_FILE, process.pid).catch(() => {});
    }
    if (error) console.error(error);
    process.exit(error ? 1 : 0);
  });
}

server.on('error', async (error) => {
  console.error(`[pi-sessions-studio] ${error.message}`);
  if (RUNTIME_STATE_FILE) {
    await removeOwnedRuntimeState(RUNTIME_STATE_FILE, process.pid).catch(() => {});
  }
  if (!shuttingDown) process.exit(1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
