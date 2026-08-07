import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Spinner, ErrorBox, Empty, useDebounced } from '../components/Ui';

const KINDS = [
  ['', '全部内容'],
  ['user', '用户消息'],
  ['assistant', '助手回复'],
  ['thinking', '思考过程'],
  ['tool', '工具调用/结果'],
  ['bash', '手动命令'],
  ['compaction', '压缩摘要'],
  ['branch_summary', '分支摘要'],
  ['system', '系统消息'],
];

const KIND_LABEL = Object.fromEntries(KINDS.filter(([v]) => v));

function Highlight({ text, terms }) {
  const parts = useMemo(() => {
    if (!terms.length) return [{ t: text, hit: false }];
    const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(${pattern})`, 'gi');
    const hits = new Set(terms.map((term) => term.toLowerCase()));
    return text.split(re).map((seg) => ({ t: seg, hit: hits.has(seg.toLowerCase()) }));
  }, [text, terms]);
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}
    </>
  );
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [kind, setKind] = useState(params.get('kind') || '');
  const [project, setProject] = useState(params.get('project') || '');
  const [projects, setProjects] = useState([]);
  const dq = useDebounced(q, 350);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    if (!dq.trim()) {
      setData(null);
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .search({ q: dq, kind, project, limit: 100 })
      .then(setData)
      .catch(setErr)
      .finally(() => setLoading(false));
    const nextParams = {};
    if (dq) nextParams.q = dq;
    if (kind) nextParams.kind = kind;
    if (project) nextParams.project = project;
    setParams(nextParams, { replace: true });
  }, [dq, kind, project]);

  const terms = dq.toLowerCase().split(/\s+/).filter(Boolean);

  // 按会话分组
  const groups = useMemo(() => {
    if (!data) return [];
    const m = new Map();
    for (const r of data.results) {
      if (!m.has(r.sessionId)) m.set(r.sessionId, { session: r, hits: [] });
      m.get(r.sessionId).hits.push(r);
    }
    return [...m.values()];
  }, [data]);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">全局搜索</h1>
        <span className="page-desc">跨全部会话的全文检索：对话、思考、工具参数与输出</span>
      </div>

      <div className="toolbar">
        <input
          autoFocus
          className="input grow"
          aria-label="搜索关键词"
          placeholder="输入关键词，空格分隔多个词（AND）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" aria-label="内容类型" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select className="select" aria-label="项目" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>{p.name}</option>
          ))}
        </select>
      </div>

      {err && <ErrorBox error={err} />}
      {loading && <Spinner text="搜索中…" />}
      {!loading && data && (
        <p className="dim small">
          命中 {data.results.length} 条（扫描 {data.scanned.toLocaleString()} 个文本块，耗时 {data.tookMs}ms）
        </p>
      )}
      {!loading && data && data.results.length === 0 && <Empty text="没有找到匹配内容" />}
      {!q.trim() && !data && <Empty text="输入关键词开始搜索，例如：compaction 触发 / vite 报错 / kubectl" />}

      {groups.map((g) => (
        <div className="card hit-group" key={g.session.sessionId} style={{ padding: 10 }}>
          <div style={{ padding: '4px 14px 8px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link to={`/sessions/${g.session.sessionId}`} style={{ fontWeight: 600 }}>
              {g.session.sessionTitle}
            </Link>
            <span className="chip accent">{g.session.project}</span>
            <span className="dim2 small">{timeAgo(g.session.sessionTime)} · {g.hits.length} 处命中</span>
          </div>
          {g.hits.slice(0, 6).map((r, i) => (
            <Link key={i} className="hit" to={`/sessions/${r.sessionId}#entry-${r.entryId}`}>
              <span className="chip" style={{ marginRight: 8 }}>{KIND_LABEL[r.kind] || r.kind}</span>
              <div className="hit-snippet">
                <Highlight text={r.snippet} terms={terms} />
              </div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
