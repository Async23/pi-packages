import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtTokens, fmtCost } from '../lib/format';
import Chart from '../components/Chart';
import { StatCard, Spinner, ErrorBox } from '../components/Ui';

const AXIS = {
  axisLine: { lineStyle: { color: 'var(--chart-axis)' } },
  axisLabel: { color: 'var(--chart-muted)' },
};
const SPLIT = { splitLine: { lineStyle: { color: 'var(--chart-grid)' } } };
const PALETTE = [
  'var(--chart-accent)',
  'var(--chart-rust)',
  'var(--chart-green)',
  'var(--chart-amber)',
  'var(--chart-sage)',
  'var(--chart-red)',
  'var(--chart-text)',
  'var(--chart-muted)',
];

export default function Insights() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const [range, setRange] = useState(30);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null);
    api.stats({ project }).then(setData).catch(setErr);
  }, [project]);

  const days = useMemo(() => {
    const out = [];
    const n = range === 0 ? 365 : range;
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return out;
  }, [range]);

  const tokenOption = useMemo(() => {
    if (!data) return null;
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['输入', '输出'], textStyle: { color: 'var(--chart-text)' }, top: 0 },
      xAxis: { type: 'category', data: days.map((d) => d.slice(5)), ...AXIS },
      yAxis: { type: 'value', ...AXIS, ...SPLIT, axisLabel: { color: 'var(--chart-muted)', formatter: (v) => fmtTokens(v) } },
      series: [
        {
          name: '输入', type: 'bar', stack: 't',
          data: days.map((k) => data.daily[k]?.input || 0),
          itemStyle: { color: 'var(--chart-accent)' },
        },
        {
          name: '输出', type: 'bar', stack: 't',
          data: days.map((k) => data.daily[k]?.output || 0),
          itemStyle: { color: 'var(--chart-rust)', borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  }, [data, days]);

  const costOption = useMemo(() => {
    if (!data) return null;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => '$' + (+v).toFixed(3) },
      xAxis: { type: 'category', data: days.map((d) => d.slice(5)), ...AXIS },
      yAxis: { type: 'value', ...AXIS, ...SPLIT, axisLabel: { color: 'var(--chart-muted)', formatter: '${value}' } },
      series: [
        {
          type: 'bar',
          data: days.map((k) => +(data.daily[k]?.cost || 0).toFixed(4)),
          itemStyle: { color: 'var(--chart-green)', borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  }, [data, days]);

  const modelPie = useMemo(() => {
    if (!data) return null;
    const items = data.models.filter((m) => m.cost > 0).slice(0, 8);
    return {
      color: PALETTE,
      tooltip: { trigger: 'item', valueFormatter: (v) => '$' + (+v).toFixed(2) },
      legend: { orient: 'vertical', right: 0, top: 'middle', textStyle: { color: 'var(--chart-text)', fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          center: ['32%', '50%'],
          data: items.map((m) => ({ name: m.model.split('/').pop(), value: +m.cost.toFixed(3) })),
          label: { show: false },
          itemStyle: { borderColor: 'var(--chart-panel)', borderWidth: 2 },
        },
      ],
    };
  }, [data]);

  const heatOption = useMemo(() => {
    if (!data) return null;
    const dows = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const points = [];
    let max = 0;
    for (let d = 0; d < 7; d++)
      for (let h = 0; h < 24; h++) {
        const v = data.hourWeek[`${d}-${h}`] || 0;
        max = Math.max(max, v);
        points.push([h, d, v]);
      }
    return {
      tooltip: {
        formatter: (p) => `${dows[p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00 · ${p.value[2]} 条消息`,
      },
      grid: { left: 8, right: 12, top: 10, bottom: 30, containLabel: true },
      xAxis: { type: 'category', data: [...Array(24).keys()], ...AXIS, splitArea: { show: false } },
      yAxis: { type: 'category', data: dows, ...AXIS },
      visualMap: {
        min: 0, max: Math.max(max, 1), calculable: false, show: false,
        inRange: { color: ['var(--chart-panel)', 'var(--chart-axis)', 'var(--chart-accent)', 'var(--chart-rust)'] },
      },
      series: [{ type: 'heatmap', data: points, itemStyle: { borderColor: 'var(--chart-deep)', borderWidth: 2, borderRadius: 1 } }],
    };
  }, [data]);

  const projOption = useMemo(() => {
    if (!data) return null;
    const items = [...data.projects].slice(0, 10).reverse();
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => '$' + (+v).toFixed(2) },
      grid: { left: 8, right: 40, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: 'value', ...AXIS, ...SPLIT, axisLabel: { color: 'var(--chart-muted)', formatter: '${value}' } },
      yAxis: { type: 'category', data: items.map((p) => p.name), axisLabel: { color: 'var(--chart-text)', fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false } },
      series: [
        {
          type: 'bar',
          data: items.map((p) => +p.cost.toFixed(3)),
          barWidth: 14,
          itemStyle: { borderRadius: [0, 2, 2, 0], color: 'var(--chart-accent)' },
          label: { show: true, position: 'right', color: 'var(--chart-text)', fontSize: 11, formatter: (p) => '$' + p.value },
        },
      ],
    };
  }, [data]);

  const cacheOption = useMemo(() => {
    if (!data) return null;
    const items = data.models
      .filter((m) => m.input + m.cacheRead > 10000)
      .map((m) => ({
        name: m.model.split('/').pop(),
        rate: (m.cacheRead / (m.input + m.cacheRead)) * 100,
      }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 10)
      .reverse();
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => (+v).toFixed(1) + '%' },
      grid: { left: 8, right: 44, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: 'value', max: 100, ...AXIS, ...SPLIT, axisLabel: { color: 'var(--chart-muted)', formatter: '{value}%' } },
      yAxis: { type: 'category', data: items.map((i) => i.name), axisLabel: { color: 'var(--chart-text)', fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false } },
      series: [
        {
          type: 'bar',
          data: items.map((i) => +i.rate.toFixed(1)),
          barWidth: 14,
          itemStyle: { borderRadius: [0, 2, 2, 0], color: 'var(--chart-rust)' },
          label: { show: true, position: 'right', color: 'var(--chart-text)', fontSize: 11, formatter: '{c}%' },
        },
      ],
    };
  }, [data]);

  if (err) return <div className="page"><ErrorBox error={err} /></div>;
  if (!data) return <div className="page"><Spinner text="统计中…" /></div>;

  const t = data.totals;
  const cacheRate = t.input + t.cacheRead > 0 ? ((t.cacheRead / (t.input + t.cacheRead)) * 100).toFixed(1) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">统计洞察</h1>
        <span className="page-desc">Token、成本、模型、工具与使用习惯的深度分析</span>
      </div>

      <div className="toolbar">
        <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>{p.name}</option>
          ))}
        </select>
        <div className="seg">
          {[[30, '30 天'], [90, '90 天'], [0, '全部']].map(([v, label]) => (
            <button key={v} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid kpis">
        <StatCard label="总成本" value={fmtCost(t.cost)} accent="var(--green)" />
        <StatCard label="输入 Tokens" value={fmtTokens(t.input)} sub={`缓存读 ${fmtTokens(t.cacheRead)}`} />
        <StatCard label="输出 Tokens" value={fmtTokens(t.output)} />
        <StatCard label="缓存命中率" value={cacheRate + '%'} accent="var(--accent)" sub="cacheRead / (input+cacheRead)" />
        <StatCard label="平均每会话成本" value={fmtCost(t.sessions ? t.cost / t.sessions : 0)} />
        <StatCard label="分支点总数" value={t.branchPoints} sub={`压缩 ${t.compactions} 次`} />
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <p className="card-title">每日 Tokens（输入/输出堆叠）</p>
          <Chart option={tokenOption} height={250} />
        </div>
        <div className="card">
          <p className="card-title">每日成本</p>
          <Chart option={costOption} height={250} />
        </div>
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <p className="card-title">模型成本分布</p>
          <Chart option={modelPie} height={260} />
        </div>
        <div className="card">
          <p className="card-title">活跃时段热力图（周 × 小时）</p>
          <Chart option={heatOption} height={260} />
        </div>
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <p className="card-title">项目成本 Top 10</p>
          <Chart option={projOption} height={300} />
        </div>
        <div className="card">
          <p className="card-title">模型缓存命中率</p>
          <Chart option={cacheOption} height={300} />
        </div>
      </div>

      <div className="card mt">
        <p className="card-title">模型明细</p>
        <table className="table">
          <thead>
            <tr>
              <th>模型</th><th className="num">消息</th><th className="num">输入</th><th className="num">输出</th>
              <th className="num">缓存读</th><th className="num">推理</th><th className="num">成本</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.model}>
                <td className="mono small">{m.model}</td>
                <td className="num">{m.messages.toLocaleString()}</td>
                <td className="num">{fmtTokens(m.input)}</td>
                <td className="num">{fmtTokens(m.output)}</td>
                <td className="num">{fmtTokens(m.cacheRead)}</td>
                <td className="num">{fmtTokens(m.reasoning)}</td>
                <td className="num" style={{ color: 'var(--green)' }}>{fmtCost(m.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
