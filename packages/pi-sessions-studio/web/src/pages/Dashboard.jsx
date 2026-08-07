import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtTokens, fmtCost, fmtBytes, timeAgo, shortModel, fmtDuration } from '../lib/format';
import Chart from '../components/Chart';
import { StatCard, Spinner, ErrorBox } from '../components/Ui';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const nav = useNavigate();

  useEffect(() => {
    api.overview().then(setData).catch(setErr);
  }, []);

  const dailyOption = useMemo(() => {
    if (!data) return null;
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push(k);
    }
    const msgs = days.map((k) => data.daily[k]?.messages || 0);
    const cost = days.map((k) => +(data.daily[k]?.cost || 0).toFixed(3));
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['消息数', '成本 ($)'], textStyle: { color: 'var(--chart-text)' }, top: 0 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.slice(5)),
        axisLine: { lineStyle: { color: 'var(--chart-axis)' } },
        axisLabel: { color: 'var(--chart-muted)' },
      },
      yAxis: [
        { type: 'value', splitLine: { lineStyle: { color: 'var(--chart-grid)' } }, axisLabel: { color: 'var(--chart-muted)' } },
        { type: 'value', splitLine: { show: false }, axisLabel: { color: 'var(--chart-muted)', formatter: '${value}' } },
      ],
      series: [
        {
          name: '消息数',
          type: 'bar',
          data: msgs,
          itemStyle: { color: 'var(--chart-accent)', borderRadius: [2, 2, 0, 0] },
        },
        {
          name: '成本 ($)',
          type: 'line',
          yAxisIndex: 1,
          data: cost,
          smooth: true,
          itemStyle: { color: 'var(--chart-rust)' },
          lineStyle: { width: 2 },
          areaStyle: { color: 'var(--chart-accent-fill)' },
        },
      ],
    };
  }, [data]);

  const toolsOption = useMemo(() => {
    if (!data) return null;
    const items = [...data.topTools].reverse();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 30, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: 'var(--chart-grid)' } }, axisLabel: { color: 'var(--chart-muted)' } },
      yAxis: {
        type: 'category',
        data: items.map((t) => t.name),
        axisLabel: { color: 'var(--chart-text)', fontFamily: 'var(--mono)', fontSize: 11 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          data: items.map((t) => t.count),
          barWidth: 14,
          itemStyle: { borderRadius: [0, 2, 2, 0], color: 'var(--chart-accent)' },
          label: { show: true, position: 'right', color: 'var(--chart-text)', fontSize: 11 },
        },
      ],
    };
  }, [data]);

  if (err) return <div className="page"><ErrorBox error={err} /></div>;
  if (!data) return <div className="page"><Spinner /></div>;

  const t = data.totals;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">总览</h1>
        <span className="page-desc mono">{data.sessionsDir}</span>
      </div>

      <div className="grid kpis">
        <StatCard label="会话总数" value={t.sessions} sub={`${Object.keys(data.daily).length} 个活跃日`} />
        <StatCard label="对话消息" value={(t.userMessages + t.assistantMessages).toLocaleString()} sub={`用户 ${t.userMessages} · 助手 ${t.assistantMessages}`} />
        <StatCard label="工具调用" value={t.toolCalls.toLocaleString()} sub={`上下文压缩 ${t.compactions} 次`} />
        <StatCard label="总 Tokens" value={fmtTokens(t.input + t.output + t.cacheRead)} sub={`输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)}`} />
        <StatCard label="总成本" value={fmtCost(t.cost)} accent="var(--green)" sub={`缓存读 ${fmtTokens(t.cacheRead)}`} />
        <StatCard label="数据体积" value={fmtBytes(t.sizeBytes)} sub={`累计时长 ${fmtDuration(t.totalDurationMs)}`} />
      </div>

      <div className="grid cols-2 mt">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <p className="card-title">近 30 天活动（消息数 / 成本）</p>
          <Chart option={dailyOption} height={280} />
        </div>
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <p className="card-title">工具调用 Top 10</p>
          <Chart option={toolsOption} height={320} />
        </div>
        <div className="card">
          <p className="card-title">项目排行（按成本）</p>
          <table className="table">
            <thead>
              <tr><th>项目</th><th className="num">会话</th><th className="num">消息</th><th className="num">Tokens</th><th className="num">成本</th></tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.cwd} style={{ cursor: 'pointer' }} onClick={() => nav(`/sessions?project=${encodeURIComponent(p.cwd)}`)} title={p.cwd}>
                  <td><span className="chip accent">{p.name}</span></td>
                  <td className="num">{p.sessions}</td>
                  <td className="num">{p.messages.toLocaleString()}</td>
                  <td className="num">{fmtTokens(p.tokens)}</td>
                  <td className="num">{fmtCost(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mt">
        <p className="card-title">最近会话</p>
        {data.recent.map((s) => (
          <Link className="session-row" key={s.id} to={`/sessions/${s.id}`}>
            <div className="session-main">
              <div className="session-title">{s.title}</div>
              <div className="session-meta">
                <span className="chip accent">{s.project}</span>
                {s.models.slice(0, 2).map((m) => (
                  <span key={m} className="chip">{shortModel(m)}</span>
                ))}
                {s.counts.branchPoints > 0 && <span className="chip amber">⑂ {s.counts.branchPoints} 分支点</span>}
                <span className="dim2 small">{timeAgo(s.lastActivityAt)}</span>
              </div>
            </div>
            <div className="session-stats">
              <span><b>{s.counts.user + s.counts.assistant}</b>消息</span>
              <span><b>{fmtTokens(s.tokens.total)}</b>tokens</span>
              <span><b>{fmtCost(s.cost)}</b>成本</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
