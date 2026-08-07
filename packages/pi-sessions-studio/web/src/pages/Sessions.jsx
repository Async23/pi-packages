import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtTokens, fmtCost, fmtDuration, timeAgo, shortModel } from '../lib/format';
import { Spinner, ErrorBox, Empty, useDebounced } from '../components/Ui';

const SORTS = [
  ['updated', '最近活动'],
  ['created', '创建时间'],
  ['cost', '成本'],
  ['tokens', 'Tokens'],
  ['messages', '消息数'],
  ['duration', '时长'],
  ['size', '文件大小'],
];

const PAGE = 40;

export default function Sessions() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || '';
  const sort = params.get('sort') || 'updated';
  const [q, setQ] = useState(params.get('q') || '');
  const dq = useDebounced(q, 250);

  const [projects, setProjects] = useState([]);
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null);
    api
      .sessions({ project, q: dq, sort, limit: PAGE, offset: 0 })
      .then((d) => {
        setData(d);
        setItems(d.items);
      })
      .catch(setErr);
  }, [project, dq, sort]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const d = await api.sessions({ project, q: dq, sort, limit: PAGE, offset: items.length });
      setItems((prev) => [...prev, ...d.items]);
    } finally {
      setLoadingMore(false);
    }
  };

  const patchParams = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">会话</h1>
        {data && <span className="page-desc">{data.total} 个会话</span>}
      </div>

      <div className="toolbar">
        <input
          className="input grow"
          placeholder="按标题 / 项目 / 模型 / ID 过滤…（全文搜索请用「全局搜索」）"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            patchParams({ q: e.target.value });
          }}
        />
        <select className="select" value={project} onChange={(e) => patchParams({ project: e.target.value })}>
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>
              {p.name}（{p.sessions}）
            </option>
          ))}
        </select>
        <select className="select" value={sort} onChange={(e) => patchParams({ sort: e.target.value })}>
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>按{label}</option>
          ))}
        </select>
      </div>

      {err && <ErrorBox error={err} />}
      {!err && !data && <Spinner />}
      {data && items.length === 0 && <Empty text="没有匹配的会话" />}

      <div className="card" style={{ padding: 6 }}>
        {items.map((s) => (
          <Link className="session-row" key={s.id} to={`/sessions/${s.id}`}>
            <div className="session-main">
              <div className="session-title">
                {s.name && <span style={{ color: 'var(--accent2)' }}>{s.name} · </span>}
                {s.title}
              </div>
              <div className="session-meta">
                <span className="chip accent" title={s.cwd}>{s.project}</span>
                {s.models.slice(0, 3).map((m) => (
                  <span key={m} className="chip">{shortModel(m)}</span>
                ))}
                {s.counts.branchPoints > 0 && <span className="chip amber">⑂ {s.counts.branchPoints}</span>}
                {s.counts.compactions > 0 && <span className="chip green">📦 {s.counts.compactions}</span>}
                {s.counts.branchSummaries > 0 && <span className="chip amber">⑂ {s.counts.branchSummaries}</span>}
                {s.parentSession && <span className="chip cyan">↳ fork</span>}
                <span className="dim2 small">{timeAgo(s.lastActivityAt)} · 时长 {fmtDuration(s.durationMs)}</span>
              </div>
            </div>
            <div className="session-stats">
              <span><b>{s.counts.user + s.counts.assistant}</b>消息</span>
              <span><b>{s.counts.toolCalls}</b>工具</span>
              <span><b>{fmtTokens(s.tokens.total)}</b>tokens</span>
              <span><b>{fmtCost(s.cost)}</b>成本</span>
            </div>
          </Link>
        ))}
      </div>

      {data && items.length < data.total && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : `加载更多（${items.length}/${data.total}）`}
          </button>
        </div>
      )}
    </div>
  );
}
