import { useEffect, useRef, useState } from 'react';
import { renderMarkdown, highlightIn } from '../lib/markdown';

export function StatCard({ label, value, sub, accent }) {
  return (
    <div className="card stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Markdown({ text, className }) {
  const ref = useRef(null);
  useEffect(() => {
    highlightIn(ref.current);
  }, [text]);
  return (
    <div
      ref={ref}
      className={`md ${className || ''}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

export function Collapsible({ summary, children, defaultOpen = false, className, command }) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (command && typeof command.open === 'boolean') setOpen(command.open);
  }, [command]);

  return (
    <div className={`collapsible ${className || ''} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="collapsible-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`chev ${open ? 'down' : ''}`}>▸</span>
        {summary}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

/** 长文本：默认截断显示，可展开 */
export function TruncText({ text, limit = 800, mono = true }) {
  const [expanded, setExpanded] = useState(false);
  if (text == null) return null;
  const over = text.length > limit;
  const shown = expanded || !over ? text : text.slice(0, limit);
  return (
    <div>
      <pre className={mono ? 'pre-block' : 'pre-block sans'}>{shown}</pre>
      {over && (
        <button className="link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `展开全部（共 ${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </div>
  );
}

export function Spinner({ text = '加载中…' }) {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
      <span>{text}</span>
    </div>
  );
}

export function ErrorBox({ error }) {
  return <div className="error-box">出错了：{String(error?.message || error)}</div>;
}

export function Empty({ text = '暂无数据' }) {
  return <div className="empty-box">{text}</div>;
}

export function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
