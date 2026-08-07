import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const LONG_STRING_LENGTH = 240;
const MAX_ARRAY_CHILDREN = 200;
const MAX_SEARCH_RESULTS = 1000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function pathKey(path) {
  return JSON.stringify(path);
}

function formatPath(path) {
  return path.reduce((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    if (IDENTIFIER.test(part)) return `${text}.${part}`;
    return `${text}[${JSON.stringify(part)}]`;
  }, '$');
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function entriesOf(value) {
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (isContainer(value)) return Object.entries(value);
  return [];
}

function containerSummary(value) {
  if (Array.isArray(value)) return `Array(${value.length.toLocaleString()})`;
  const count = Object.keys(value).length;
  return `Object · ${count.toLocaleString()} 个字段`;
}

function defaultExpandedPaths(value, maxDepth = 2) {
  const paths = new Set();

  function visit(node, path, depth) {
    if (!isContainer(node) || depth >= maxDepth) return;
    if (path.length > 0) paths.add(pathKey(path));
    for (const [key, child] of entriesOf(node)) {
      visit(child, [...path, key], depth + 1);
    }
  }

  visit(value, [], 0);
  return paths;
}

function collectMatches(value, rawQuery) {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return { paths: [], truncated: false };

  const paths = [];
  let truncated = false;

  function visit(node, path, key) {
    if (paths.length >= MAX_SEARCH_RESULTS) {
      truncated = true;
      return;
    }

    const keyMatches = key != null && String(key).toLocaleLowerCase().includes(query);
    const valueMatches =
      !isContainer(node) &&
      String(node ?? 'null').toLocaleLowerCase().includes(query);

    if (path.length > 0 && (keyMatches || valueMatches)) paths.push(path);
    if (!isContainer(node)) return;

    for (const [childKey, child] of entriesOf(node)) {
      visit(child, [...path, childKey], childKey);
      if (truncated) return;
    }
  }

  visit(value, [], null);
  return { paths, truncated };
}

function utf8Size(text) {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function copyTextFallback(text) {
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy command failed');
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyTextFallback(text);
}

function textForCopy(value) {
  if (typeof value === 'string') return value;
  if (isContainer(value)) return JSON.stringify(value, null, 2);
  return String(value ?? 'null');
}

function JsonPrimitive({ value }) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) return <span className="json-value null">null</span>;
  if (typeof value === 'boolean') {
    return <span className="json-value boolean">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="json-value number">{String(value)}</span>;
  }

  const stringValue = String(value);
  const isLong = stringValue.length > LONG_STRING_LENGTH;
  const visibleValue = isLong && !expanded
    ? `${stringValue.slice(0, LONG_STRING_LENGTH)}…`
    : stringValue;

  return (
    <span className="json-string-wrap">
      <span className="json-value string">{JSON.stringify(visibleValue)}</span>
      {isLong && (
        <button
          type="button"
          className="json-inline-action"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '收起' : `展开 ${stringValue.length.toLocaleString()} 字符`}
        </button>
      )}
    </span>
  );
}

const JsonNode = memo(function JsonNode({
  nodeKey,
  value,
  path,
  depth,
  expandedPaths,
  forcedPaths,
  matchPaths,
  activeMatchKey,
  onToggle,
  onCopy,
}) {
  const id = pathKey(path);
  const container = isContainer(value);
  const children = container ? entriesOf(value) : [];
  const expandable = children.length > 0;
  const open = expandable && (expandedPaths.has(id) || forcedPaths.has(id));
  const isMatch = matchPaths.has(id);
  const isActiveMatch = activeMatchKey === id;
  const displayKey = typeof nodeKey === 'number' ? `[${nodeKey}]` : nodeKey;
  const [visibleChildren, setVisibleChildren] = useState(MAX_ARRAY_CHILDREN);
  const shownChildren = children.slice(0, visibleChildren);
  const fullPath = formatPath(path);

  return (
    <div
      className={`json-node ${isMatch ? 'is-match' : ''} ${isActiveMatch ? 'is-active-match' : ''}`}
      role="treeitem"
      aria-expanded={container && expandable ? open : undefined}
    >
      <div className="json-node-row" style={{ '--json-depth': depth }} title={fullPath}>
        {container ? (
          <button
            type="button"
            className="json-node-toggle"
            onClick={() => expandable && onToggle(id)}
            disabled={!expandable}
            aria-label={`${open ? '收起' : '展开'} ${fullPath}`}
          >
            <span className={`json-chevron ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
            <span className="json-key">{displayKey}</span>
            <span className="json-punctuation">:</span>
            <span className="json-container-summary">{containerSummary(value)}</span>
          </button>
        ) : (
          <div className="json-node-primitive">
            <span className="json-leaf-dot" aria-hidden="true">·</span>
            <span className="json-key">{displayKey}</span>
            <span className="json-punctuation">:</span>
            <JsonPrimitive value={value} />
          </div>
        )}

        <div className="json-row-actions">
          <button type="button" onClick={() => onCopy(fullPath, '字段路径')}>路径</button>
          <button
            type="button"
            onClick={() => onCopy(textForCopy(value), container ? '当前子树' : '字段值')}
          >
            {container ? '子树' : '值'}
          </button>
        </div>
      </div>

      {open && (
        <div role="group">
          {shownChildren.map(([childKey, child]) => (
            <JsonNode
              key={`${id}:${String(childKey)}`}
              nodeKey={childKey}
              value={child}
              path={[...path, childKey]}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              forcedPaths={forcedPaths}
              matchPaths={matchPaths}
              activeMatchKey={activeMatchKey}
              onToggle={onToggle}
              onCopy={onCopy}
            />
          ))}
          {shownChildren.length < children.length && (
            <div className="json-more-row" style={{ '--json-depth': depth + 1 }}>
              <button
                type="button"
                onClick={() => setVisibleChildren((count) => count + MAX_ARRAY_CHILDREN)}
              >
                再显示 {Math.min(MAX_ARRAY_CHILDREN, children.length - shownChildren.length)} 项
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function HighlightedJson({ text }) {
  const parts = useMemo(() => {
    const tokenPattern =
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
    const result = [];
    let cursor = 0;
    let match;

    while ((match = tokenPattern.exec(text))) {
      if (match.index > cursor) result.push(text.slice(cursor, match.index));
      const token = match[0];
      let type = 'number';
      if (token.startsWith('"')) {
        type = /^\s*:/.test(text.slice(tokenPattern.lastIndex)) ? 'key' : 'string';
      } else if (token === 'true' || token === 'false') {
        type = 'boolean';
      } else if (token === 'null') {
        type = 'null';
      }
      result.push(<span className={`json-token ${type}`} key={`${match.index}:${type}`}>{token}</span>);
      cursor = tokenPattern.lastIndex;
    }

    if (cursor < text.length) result.push(text.slice(cursor));
    return result;
  }, [text]);

  return parts;
}

function InspectorPanel({
  value,
  jsonText,
  mode,
  setMode,
  query,
  setQuery,
  matches,
  activeMatch,
  setActiveMatch,
  expandedPaths,
  setExpandedPaths,
  forcedPaths,
  matchPaths,
  activeMatchKey,
  onCopy,
  sourceWrap,
  setSourceWrap,
  treeRef,
  fullScreen = false,
}) {
  const nextMatch = useCallback((direction) => {
    if (matches.paths.length === 0) return;
    setActiveMatch((current) => {
      const next = current + direction;
      if (next < 0) return matches.paths.length - 1;
      if (next >= matches.paths.length) return 0;
      return next;
    });
  }, [matches.paths.length, setActiveMatch]);

  const togglePath = useCallback((id) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setExpandedPaths]);

  return (
    <div className={`json-inspector-body ${fullScreen ? 'fullscreen' : ''}`}>
      <div className="json-toolbar">
        <div className="json-view-tabs" role="tablist" aria-label="JSON 查看方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'tree'}
            className={mode === 'tree' ? 'active' : ''}
            onClick={() => setMode('tree')}
          >
            树形
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className={mode === 'source' ? 'active' : ''}
            onClick={() => setMode('source')}
          >
            源码
          </button>
        </div>

        {mode === 'tree' ? (
          <>
            <label className="json-search">
              <span className="sr-only">搜索 JSON 的字段名或值</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索字段名或值"
              />
            </label>
            {query.trim() && (
              <>
                <span className="json-match-count" aria-live="polite">
                  {matches.paths.length > 0
                    ? `${activeMatch + 1}/${matches.paths.length}${matches.truncated ? '+' : ''}`
                    : '无匹配'}
                </span>
                <button
                  type="button"
                  className="json-tool-button"
                  disabled={matches.paths.length === 0}
                  onClick={() => nextMatch(-1)}
                >
                  上一处
                </button>
                <button
                  type="button"
                  className="json-tool-button"
                  disabled={matches.paths.length === 0}
                  onClick={() => nextMatch(1)}
                >
                  下一处
                </button>
              </>
            )}
            <span className="json-toolbar-spacer" />
            <button
              type="button"
              className="json-tool-button"
              onClick={() => setExpandedPaths(defaultExpandedPaths(value))}
            >
              展开两层
            </button>
            <button
              type="button"
              className="json-tool-button"
              onClick={() => setExpandedPaths(new Set())}
            >
              全部收起
            </button>
          </>
        ) : (
          <>
            <span className="json-toolbar-spacer" />
            <button
              type="button"
              className={`json-tool-button ${sourceWrap ? 'active' : ''}`}
              aria-pressed={sourceWrap}
              onClick={() => setSourceWrap((current) => !current)}
            >
              自动换行
            </button>
          </>
        )}
      </div>

      {mode === 'tree' ? (
        <div className="json-tree" role="tree" aria-label="JSON 数据树" ref={treeRef}>
          {entriesOf(value).map(([key, child]) => (
            <JsonNode
              key={String(key)}
              nodeKey={key}
              value={child}
              path={[key]}
              depth={0}
              expandedPaths={expandedPaths}
              forcedPaths={forcedPaths}
              matchPaths={matchPaths}
              activeMatchKey={activeMatchKey}
              onToggle={togglePath}
              onCopy={onCopy}
            />
          ))}
        </div>
      ) : (
        <pre className={`json-source ${sourceWrap ? 'wrap' : ''}`} tabIndex="0">
          <code><HighlightedJson text={jsonText} /></code>
        </pre>
      )}
    </div>
  );
}

export default function JsonInspector({ value, label = '原始 JSON' }) {
  const [open, setOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [mode, setMode] = useState('tree');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [activeMatch, setActiveMatch] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState(() => defaultExpandedPaths(value));
  const [sourceWrap, setSourceWrap] = useState(true);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(null);
  const treeRef = useRef(null);
  const closeButtonRef = useRef(null);
  const fullScreenButtonRef = useRef(null);
  const titleId = useId();

  const jsonText = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const meta = useMemo(
    () => `${containerSummary(value)} · ${formatBytes(utf8Size(jsonText))}`,
    [jsonText, value]
  );
  const matches = useMemo(
    () => collectMatches(value, deferredQuery),
    [deferredQuery, value]
  );
  const activePath = matches.paths[activeMatch] || null;
  const activeMatchKey = activePath ? pathKey(activePath) : '';
  const matchPaths = useMemo(
    () => new Set(matches.paths.map((path) => pathKey(path))),
    [matches.paths]
  );
  const forcedPaths = useMemo(() => {
    const paths = new Set();
    if (!activePath) return paths;
    for (let length = 1; length < activePath.length; length += 1) {
      paths.add(pathKey(activePath.slice(0, length)));
    }
    return paths;
  }, [activeMatchKey]);

  useEffect(() => {
    setActiveMatch(0);
  }, [deferredQuery]);

  useEffect(() => {
    if (!activeMatchKey || mode !== 'tree') return;
    const frame = requestAnimationFrame(() => {
      const container = treeRef.current;
      const target = container?.querySelector('.json-node.is-active-match');
      if (!container || !target) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = target.offsetTop - container.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeMatchKey, mode, fullScreen]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    const previousFocus = document.activeElement;
    const appRoot = document.getElementById('root');
    const wasInert = appRoot?.inert;
    if (appRoot) appRoot.inert = true;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setFullScreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (appRoot) appRoot.inert = Boolean(wasInert);
      const returnTarget =
        previousFocus instanceof HTMLElement && previousFocus !== document.body
          ? previousFocus
          : fullScreenButtonRef.current;
      returnTarget?.focus();
    };
  }, [fullScreen]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const copy = useCallback(async (text, name) => {
    try {
      await writeClipboard(text);
      setNotice(`已复制${name}`);
    } catch {
      setNotice('复制失败，请手动选择');
    }
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 1800);
  }, []);

  const panelProps = {
    value,
    jsonText,
    mode,
    setMode,
    query,
    setQuery,
    matches,
    activeMatch,
    setActiveMatch,
    expandedPaths,
    setExpandedPaths,
    forcedPaths,
    matchPaths,
    activeMatchKey,
    onCopy: copy,
    sourceWrap,
    setSourceWrap,
    treeRef,
  };

  return (
    <>
      <section className={`json-inspector ${open ? 'open' : ''}`}>
        <div className="json-inspector-summary">
          <button
            type="button"
            className="json-summary-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className={`json-chevron ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
            <span>{label}</span>
            <span className="json-summary-meta">{meta}</span>
          </button>
          <div className="json-summary-actions">
            <button type="button" onClick={() => copy(jsonText, '完整 JSON')}>复制</button>
            <button
              type="button"
              ref={fullScreenButtonRef}
              onClick={() => {
                setOpen(true);
                setFullScreen(true);
              }}
            >
              全屏检查
            </button>
          </div>
        </div>
        {notice && <div className="json-copy-notice" role="status">{notice}</div>}
        {open && !fullScreen && <InspectorPanel {...panelProps} />}
      </section>

      {fullScreen && createPortal(
        <div
          className="json-dialog-mask"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFullScreen(false);
          }}
        >
          <section
            className="json-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="json-dialog-head">
              <div>
                <h2 id={titleId}>{label}</h2>
                <p>{meta}</p>
              </div>
              <div className="json-dialog-actions">
                <button type="button" onClick={() => copy(jsonText, '完整 JSON')}>复制全部</button>
                <button
                  type="button"
                  ref={closeButtonRef}
                  className="primary"
                  onClick={() => setFullScreen(false)}
                >
                  关闭
                </button>
              </div>
            </div>
            {notice && <div className="json-dialog-notice" role="status">{notice}</div>}
            <InspectorPanel {...panelProps} fullScreen />
          </section>
        </div>,
        document.body
      )}
    </>
  );
}
