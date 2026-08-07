import { getSearchCorpus } from './scanner.js';

/**
 * 朴素全文搜索：空格分词，AND 语义，大小写不敏感。
 * 返回按命中次数排序的条目级结果，附带上下文片段。
 */
export function search({ q, project, kind, limit = 60 }) {
  const t0 = Date.now();
  const terms = String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return { results: [], scanned: 0, tookMs: 0 };

  const corpus = getSearchCorpus();
  const results = [];
  let scanned = 0;

  for (const { summary, searchDocs } of corpus) {
    if (project && summary.cwd !== project) continue;
    for (const doc of searchDocs) {
      if (kind && doc.kind !== kind) continue;
      scanned++;
      const lower = doc.text.toLowerCase();
      let score = 0;
      let firstIdx = -1;
      let ok = true;
      for (const term of terms) {
        let idx = lower.indexOf(term);
        if (idx === -1) {
          ok = false;
          break;
        }
        if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
        // 统计出现次数
        let count = 0;
        while (idx !== -1 && count < 50) {
          count++;
          idx = lower.indexOf(term, idx + term.length);
        }
        score += count;
      }
      if (!ok) continue;
      const start = Math.max(0, firstIdx - 120);
      const end = Math.min(doc.text.length, firstIdx + 240);
      results.push({
        sessionId: summary.id,
        sessionTitle: summary.title,
        project: summary.project,
        cwd: summary.cwd,
        entryId: doc.entryId,
        kind: doc.kind,
        score,
        snippet:
          (start > 0 ? '…' : '') + doc.text.slice(start, end) + (end < doc.text.length ? '…' : ''),
        sessionTime: summary.lastActivityAt,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || b.sessionTime - a.sessionTime);
  return { results: results.slice(0, limit), scanned, tookMs: Date.now() - t0 };
}
