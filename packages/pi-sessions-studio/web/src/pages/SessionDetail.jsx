import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { buildTree, pathIds, descendantLeaves, entryPreview } from '../lib/tree';
import { fmtTokens, fmtCost, fmtDate, fmtDuration, fmtBytes, shortModel } from '../lib/format';
import { buildSessionDirectory } from '../lib/sessionDirectory';
import { EntryView } from '../components/Entry';
import SessionDirectory from '../components/SessionDirectory';
import Chart from '../components/Chart';
import { Spinner, ErrorBox, Empty } from '../components/Ui';

const CHUNK = 60;

function scrollAnchor(anchorId, block = 'center') {
  const container = document.querySelector('.content');
  const target = document.getElementById(anchorId);
  if (!container || !target) return;

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  let top = container.scrollTop + targetRect.top - containerRect.top;
  if (block === 'center') {
    top -= Math.max(0, (container.clientHeight - targetRect.height) / 2);
  }
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  container.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
}

// 目标可能尚未渲染（无限滚动按需加载），先轮询等元素出现；
// 滚动后页面高度仍会随动态内容（图表/高亮块等）增长，目标位置会被顶走，
// 因此在滚动结束后反复校正，直到目标稳定在预期位置。
function scrollAnchorWhenReady(anchorId, block, hooks = {}, attempts = 30) {
  const target = document.getElementById(anchorId);
  if (!target) {
    if (attempts > 0) {
      window.setTimeout(() => scrollAnchorWhenReady(anchorId, block, hooks, attempts - 1), 100);
    } else {
      hooks.afterSettled?.();
    }
    return;
  }
  hooks.beforeScroll?.();
  const box0 = document.querySelector('.content');
  let lastTop = box0 ? box0.scrollTop : -1;
  scrollAnchor(anchorId, block);

  // json-inspector / tool-card 等内容在挂载后还会继续长高，把已滚到的目标顶走；
  // 等滚动停稳后反复校正，连续 3 次采样稳定才算就位（上限约 10 秒）。
  let stableCount = 0;
  let iterations = 0;
  const correct = () => {
    if (hooks.aborted?.()) return;
    const el = document.getElementById(anchorId);
    const box = document.querySelector('.content');
    if (!el || !box) { hooks.afterSettled?.(); return; }
    iterations += 1;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let desired = box.scrollTop + elRect.top - boxRect.top;
    if (block === 'center') desired -= Math.max(0, (box.clientHeight - elRect.height) / 2);
    desired = Math.max(0, desired);

    const top = box.scrollTop;
    const moving = lastTop >= 0 && top !== lastTop;
    if (Math.abs(top - desired) > 4) {
      if (!moving) box.scrollTo({ top: desired, behavior: 'auto' });
      stableCount = 0;
    } else if (!moving) {
      stableCount += 1;
    } else {
      stableCount = 0;
    }
    lastTop = top;

    const settled = stableCount >= 3;
    if (settled || iterations >= 60) hooks.afterSettled?.();
    else window.setTimeout(correct, 160);
  };
  window.setTimeout(correct, 300);
}

export default function SessionDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [activeLeafId, setActiveLeafId] = useState(null);
  const [shownCount, setShownCount] = useState(CHUNK);
  const [branchModal, setBranchModal] = useState(null); // {parentId, childIds} | 'all'
  const [flashId, setFlashId] = useState(null);
  const [activeDirectoryEntryId, setActiveDirectoryEntryId] = useState(null);
  const sentinelRef = useRef(null);
  const didScrollRef = useRef(false);
  const directorySpyGuardRef = useRef(false);
  const directorySpyTimerRef = useRef(0);
  const directoryNavSeqRef = useRef(0);

  // 程序化导航滚动期间挂起目录 scroll-spy，避免途经条目反复改写当前定位、面板跟着抖动
  const armDirectorySpyGuard = () => {
    directorySpyGuardRef.current = true;
    window.clearTimeout(directorySpyTimerRef.current);
  };
  const disarmDirectorySpyGuard = () => {
    window.clearTimeout(directorySpyTimerRef.current);
    directorySpyTimerRef.current = window.setTimeout(() => {
      directorySpyGuardRef.current = false;
    }, 200);
  };

  useEffect(() => () => window.clearTimeout(directorySpyTimerRef.current), []);

  useEffect(() => {
    setData(null);
    setErr(null);
    setActiveLeafId(null);
    setShownCount(CHUNK);
    setActiveDirectoryEntryId(null);
    didScrollRef.current = false;
    api.session(id).then(setData).catch(setErr);
  }, [id]);

  const entries = data?.entries || [];
  const tree = useMemo(() => buildTree(entries), [entries]);

  // 默认主路径 = 文件最后一条记录的祖先链
  const defaultLeafId = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].id) return entries[i].id;
    return null;
  }, [entries]);

  const leafId = activeLeafId || defaultLeafId;
  const onPath = useMemo(() => (leafId ? pathIds(tree.byId, leafId) : new Set()), [tree, leafId]);

  // 当前路径上的条目（文件顺序 = 时间顺序）
  const pathEntries = useMemo(
    () => entries.filter((e) => !e.id || onPath.has(e.id)),
    [entries, onPath]
  );

  // 工具结果配对：toolCallId -> toolResult entry（仅路径上的）
  const { resultByCallId, consumedResults } = useMemo(() => {
    const map = new Map();
    const consumed = new Set();
    const callIds = new Set();
    for (const e of pathEntries) {
      if (e.type === 'message' && e.message?.role === 'assistant' && Array.isArray(e.message.content)) {
        for (const b of e.message.content) if (b.type === 'toolCall' && b.id) callIds.add(b.id);
      }
    }
    for (const e of pathEntries) {
      if (e.type === 'message' && e.message?.role === 'toolResult') {
        const cid = e.message.toolCallId;
        if (cid && callIds.has(cid)) {
          map.set(cid, e);
          consumed.add(e.id);
        }
      }
    }
    return { resultByCallId: map, consumedResults: consumed };
  }, [pathEntries]);

  const renderablePathEntries = useMemo(
    () => pathEntries.filter((entry) => !consumedResults.has(entry.id)),
    [pathEntries, consumedResults]
  );

  const directoryTurns = useMemo(
    () => buildSessionDirectory(pathEntries, resultByCallId),
    [pathEntries, resultByCallId]
  );

  const observedDirectoryIds = useMemo(
    () =>
      renderablePathEntries
        .slice(0, shownCount)
        .filter(
          (entry) =>
            entry.id
            && entry.type === 'message'
            && (entry.message?.role === 'user' || entry.message?.role === 'assistant')
        )
        .map((entry) => entry.id),
    [renderablePathEntries, shownCount]
  );

  // 分支点：parentId -> childIds（仅当父节点在当前路径上时展示提示）
  const branchByParent = useMemo(() => {
    const m = new Map();
    for (const bp of tree.branchPoints) m.set(bp.parentId, bp.childIds);
    return m;
  }, [tree]);

  // 大纲：路径上的用户消息
  const outline = useMemo(
    () =>
      pathEntries
        .filter((e) => e.type === 'message' && e.message?.role === 'user')
        .map((e) => ({ id: e.id, text: entryPreview(e, 46).replace(/^👤\s*/, '') })),
    [pathEntries]
  );

  // 上下文增长曲线（每条 assistant 消息的 input+cacheRead）
  const ctxOption = useMemo(() => {
    const pts = [];
    for (const e of pathEntries) {
      if (e.type === 'message' && e.message?.role === 'assistant' && e.message.usage) {
        const u = e.message.usage;
        pts.push((u.input || 0) + (u.cacheRead || 0));
      }
    }
    if (pts.length < 2) return null;
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 4, right: 8, top: 8, bottom: 4, containLabel: true },
      xAxis: { type: 'category', show: false, data: pts.map((_, i) => i + 1) },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'var(--chart-grid)' } },
        axisLabel: { color: 'var(--chart-muted)', formatter: (v) => fmtTokens(v), fontSize: 10 },
      },
      series: [
        {
          type: 'line', data: pts, smooth: true, showSymbol: false,
          lineStyle: { color: 'var(--chart-accent)', width: 2 },
          areaStyle: { color: 'var(--chart-accent-fill)' },
        },
      ],
    };
  }, [pathEntries]);

  // 无限滚动
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((ents) => {
      if (ents[0].isIntersecting) {
        setShownCount((c) => Math.min(c + CHUNK, renderablePathEntries.length));
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [renderablePathEntries.length]);

  // 锚点定位（来自搜索）：等数据加载后滚动
  useEffect(() => {
    if (!data || didScrollRef.current) return;
    const hash = window.location.hash;
    const m = hash.match(/^#entry-(.+)$/);
    if (!m) return;
    const targetId = m[1];
    const idx = pathEntries.findIndex((e) => e.id === targetId);
    if (idx === -1) {
      // 目标可能在其他分支：切到包含它的叶子
      if (tree.byId.has(targetId)) {
        const leaves = descendantLeaves(tree, targetId);
        if (leaves.length > 0) {
          setActiveLeafId(leaves[leaves.length - 1].id);
          return; // 路径变化后本 effect 会再跑
        }
      }
      didScrollRef.current = true;
      return;
    }
    setShownCount(Math.max(idx + CHUNK, CHUNK));
    didScrollRef.current = true;
    requestAnimationFrame(() => {
      setTimeout(() => {
        scrollAnchorWhenReady(`entry-${targetId}`, 'center', {
          beforeScroll: () => {
            armDirectorySpyGuard();
            setActiveDirectoryEntryId(targetId);
          },
          afterSettled: disarmDirectorySpyGuard,
        });
        setFlashId(targetId);
      }, 100);
    });
  }, [data, pathEntries, tree]);

  // 目录 scroll-spy：以内容区上方约 22% 处作为当前阅读标记。
  useEffect(() => {
    const container = document.querySelector('.content');
    if (!container || observedDirectoryIds.length === 0) return undefined;

    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        const marker = containerRect.top + Math.min(180, containerRect.height * 0.22);
        let nextId = observedDirectoryIds[0];

        for (const entryId of observedDirectoryIds) {
          const element = document.getElementById(`entry-${entryId}`);
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (rect.top <= marker) nextId = entryId;
          else break;
        }

        if (!directorySpyGuardRef.current) {
          setActiveDirectoryEntryId((current) => (current === nextId ? current : nextId));
        }
      });
    };

    update();
    container.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [observedDirectoryIds]);

  const navigateFromDirectory = (entryId, anchorId) => {
    const index = renderablePathEntries.findIndex((entry) => entry.id === entryId);
    if (index >= 0) setShownCount((current) => Math.max(current, index + 20));
    const navSeq = ++directoryNavSeqRef.current;
    armDirectorySpyGuard();
    setActiveDirectoryEntryId(entryId);

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        scrollAnchorWhenReady(anchorId, 'start', {
          beforeScroll: armDirectorySpyGuard,
          afterSettled: disarmDirectorySpyGuard,
          aborted: () => directoryNavSeqRef.current !== navSeq,
        });
        setFlashId(entryId);
      }, 80);
    });
  };

  if (err) return <div className="page"><ErrorBox error={err} /></div>;
  if (!data) return <div className="page"><Spinner text="解析会话中…" /></div>;

  const s = data.summary;
  const shown = renderablePathEntries.slice(0, shownCount);
  const multiBranch = tree.leaves.length > 1;

  return (
    <div className="page">
      <div className="detail-head">
        <Link to="/sessions" className="dim small">← 返回会话列表</Link>
        <h1 className="detail-title">{s.title}</h1>
        <div className="detail-badges">
          <span className="chip accent" title={s.cwd}>{s.project}</span>
          <span className="chip">{fmtDate(s.createdAt)}</span>
          <span className="chip">时长 {fmtDuration(s.durationMs)}</span>
          {s.models.map((m) => (
            <span key={m} className="chip cyan">{shortModel(m)}</span>
          ))}
          <span className="chip">{fmtBytes(s.sizeBytes)}</span>
          {data.parentSessionId && (
            <Link to={`/sessions/${data.parentSessionId}`} className="chip green click">↳ fork 自父会话</Link>
          )}
          <a className="chip click" href={`/api/sessions/${s.id}/export.md`}>⬇ 导出 Markdown</a>
          <a className="chip click" href={`/api/sessions/${s.id}/export.jsonl`}>⬇ 原始 JSONL</a>
        </div>
      </div>

      {multiBranch && (
        <div className="branch-banner">
          <span>⑂ 该会话包含 <b>{tree.leaves.length}</b> 条分支路径（重试/回溯产生），当前展示其中一条。</span>
          <button className="btn small" onClick={() => setBranchModal('all')}>切换分支</button>
        </div>
      )}

      <div className="detail-layout">
        <div className="stream">
          {shown.map((e, i) => {
            const sibs = e.parentId ? branchByParent.get(e.parentId) : null;
            return (
              <div
                key={e.id || `i${i}`}
                id={e.id ? `entry-${e.id}` : undefined}
                className={`entry ${flashId === e.id ? 'flash' : ''}`}
                data-entry-id={e.id || undefined}
                data-entry-type={e.type}
                data-entry-role={e.message?.role || undefined}
              >
                {sibs && sibs.length > 1 && (
                  <div className="branch-point" style={{ marginBottom: 8 }}>
                    <button onClick={() => setBranchModal({ parentId: e.parentId, childIds: sibs })}>
                      ⑂ 此处存在 {sibs.length} 个并行分支
                    </button>
                  </div>
                )}
                <EntryView
                  entry={e}
                  resultByCallId={resultByCallId}
                  consumedResults={consumedResults}
                />
              </div>
            );
          })}
          {renderablePathEntries.length === 0 && (
            <Empty text="当前路径没有可展示的条目" />
          )}
          {shownCount < renderablePathEntries.length && (
            <div ref={sentinelRef} className="load-sentinel">
              <Spinner text={`已显示 ${shownCount}/${renderablePathEntries.length} 条`} />
            </div>
          )}
        </div>

        <aside className="detail-aside">
          <SessionDirectory
            turns={directoryTurns}
            activeEntryId={activeDirectoryEntryId}
            onNavigate={navigateFromDirectory}
          />
          <div className="card">
            <p className="card-title">本会话统计</p>
            <table className="table">
              <tbody>
                <tr><td>用户消息</td><td className="num">{s.counts.user}</td></tr>
                <tr><td>助手消息</td><td className="num">{s.counts.assistant}</td></tr>
                <tr><td>工具调用</td><td className="num">{s.counts.toolCalls}</td></tr>
                <tr><td>思考块</td><td className="num">{s.counts.thinkingBlocks}</td></tr>
                <tr><td>上下文压缩</td><td className="num">{s.counts.compactions}</td></tr>
                {s.counts.branchSummaries > 0 && (
                  <tr><td>分支摘要</td><td className="num">{s.counts.branchSummaries}</td></tr>
                )}
                <tr><td>输入 tokens</td><td className="num">{fmtTokens(s.tokens.input)}</td></tr>
                <tr><td>输出 tokens</td><td className="num">{fmtTokens(s.tokens.output)}</td></tr>
                <tr><td>缓存读</td><td className="num">{fmtTokens(s.tokens.cacheRead)}</td></tr>
                <tr><td>成本</td><td className="num" style={{ color: 'var(--green)' }}>{fmtCost(s.cost)}</td></tr>
              </tbody>
            </table>
          </div>
          {ctxOption && (
            <div className="card">
              <p className="card-title">上下文规模趋势</p>
              <Chart option={ctxOption} height={120} />
            </div>
          )}
          {outline.length > 0 && (
            <div className="card aside-scroll">
              <p className="card-title">用户消息导航（{outline.length}）</p>
              {outline.map((o, i) => (
                <button
                  key={o.id}
                  className="outline-item"
                  title={o.text}
                  onClick={() => {
                    const idx = renderablePathEntries.findIndex((e) => e.id === o.id);
                    if (idx >= shownCount) setShownCount(idx + 20);
                    setTimeout(() => {
                      const navSeq = ++directoryNavSeqRef.current;
                      scrollAnchorWhenReady(`entry-${o.id}`, 'start', {
                        beforeScroll: armDirectorySpyGuard,
                        afterSettled: disarmDirectorySpyGuard,
                        aborted: () => directoryNavSeqRef.current !== navSeq,
                      });
                      setFlashId(o.id);
                      setActiveDirectoryEntryId(o.id);
                    }, 80);
                  }}
                >
                  {i + 1}. {o.text}
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      {branchModal && (
        <BranchModal
          tree={tree}
          mode={branchModal}
          currentLeafId={leafId}
          onPick={(lid) => {
            setActiveLeafId(lid);
            setShownCount(CHUNK * 4);
            setActiveDirectoryEntryId(null);
            setBranchModal(null);
          }}
          onClose={() => setBranchModal(null)}
        />
      )}
    </div>
  );
}

function BranchModal({ tree, mode, currentLeafId, onPick, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // mode='all' → 列出所有叶子；否则列出某分支点下每个子分支
  let options = [];
  if (mode === 'all') {
    options = tree.leaves.map((leaf) => ({
      leafId: leaf.id,
      preview: entryPreview(leaf, 90),
      count: pathSize(tree, leaf.id),
      time: leaf.timestamp,
    }));
  } else {
    options = mode.childIds.filter(Boolean).map((cid) => {
      const leaves = descendantLeaves(tree, cid);
      const leaf = leaves[leaves.length - 1] || tree.byId.get(cid);
      const first = tree.byId.get(cid);
      return {
        leafId: leaf?.id,
        preview: entryPreview(first, 90),
        count: leaves.length ? pathSize(tree, leaf.id) : 1,
        time: first?.timestamp,
      };
    });
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h3 id="branch-dialog-title" style={{ margin: 0, flex: 1 }}>⑂ 选择分支路径</h3>
          <button ref={closeRef} className="btn small" onClick={onClose}>关闭</button>
        </div>
        <p className="dim small">分支由重试 / 回溯编辑产生。选择一个分支后，时间线将展示该路径。</p>
        {options.map((o, i) => {
          const isCurrent = o.leafId === currentLeafId;
          return (
            <button
              key={o.leafId || i}
              className={`branch-option ${isCurrent ? 'current' : ''}`}
              onClick={() => !isCurrent && o.leafId && onPick(o.leafId)}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b>分支 {i + 1}</b>
                {isCurrent && <span className="chip green">当前</span>}
                <span className="dim2 small">{o.count} 条记录 · {o.time ? fmtDate(Date.parse(o.time)) : ''}</span>
              </div>
              <div className="dim small" style={{ marginTop: 4 }}>{o.preview}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function pathSize(tree, leafId) {
  let n = 0;
  let cur = tree.byId.get(leafId);
  let guard = 0;
  while (cur && guard++ < 200000) {
    n++;
    cur = cur.parentId ? tree.byId.get(cur.parentId) : null;
  }
  return n;
}
