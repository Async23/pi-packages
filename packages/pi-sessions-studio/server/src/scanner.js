import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './config.js';
import { buildFileData } from './parser.js';

// filePath -> { mtimeMs, size, summary, searchDocs }
const cache = new Map();

function listSessionFiles() {
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    const p = path.join(SESSIONS_DIR, d.name);
    if (d.isFile() && d.name.endsWith('.jsonl')) {
      files.push({ file: p, dir: SESSIONS_DIR });
      continue;
    }
    if (!d.isDirectory()) continue;
    let inner = [];
    try {
      inner = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith('.jsonl')) files.push({ file: path.join(p, f.name), dir: d.name });
    }
  }
  return files;
}

/** 扫描 + 增量解析（mtime/size 变化才重新解析） */
export function getIndex() {
  const found = listSessionFiles();
  const seen = new Set();
  const summaries = [];

  for (const { file, dir } of found) {
    seen.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      summaries.push(hit.summary);
      continue;
    }
    try {
      const data = buildFileData(file, dir);
      cache.set(file, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        summary: data.summary,
        searchDocs: data.searchDocs,
      });
      summaries.push(data.summary);
    } catch {
      // 解析失败的文件跳过
    }
  }
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

  summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return summaries;
}

export function findById(id) {
  const summaries = getIndex();
  return summaries.find((s) => s.id === id) || null;
}

/** parentSession 是完整文件路径，解析为已索引的会话 id */
export function resolveParent(parentSessionPath) {
  if (!parentSessionPath) return null;
  for (const { summary } of cache.values()) {
    if (summary.file === parentSessionPath) return summary.id;
  }
  return null;
}

export function getSearchCorpus() {
  getIndex(); // 确保缓存最新
  const corpus = [];
  for (const { summary, searchDocs } of cache.values()) {
    corpus.push({ summary, searchDocs });
  }
  return corpus;
}
