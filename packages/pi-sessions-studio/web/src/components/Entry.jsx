import { memo, useEffect, useRef, useState } from 'react';
import { fmtTime, fmtTokens, fmtCost, shortModel } from '../lib/format';
import { sessionBlockAnchorId } from '../lib/sessionDirectory';
import { Markdown, Collapsible, TruncText } from './Ui';
import JsonInspector from './JsonInspector';

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        if (b?.type === 'image') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  return '';
}

function RawJson({ entry }) {
  return <JsonInspector value={entry} />;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 非安全上下文下回退到 execCommand
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('复制失败');
}

function CopyEntryLink({ entryId }) {
  const [status, setStatus] = useState('idle');
  const timerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  if (!entryId) return null;

  const handleCopy = async () => {
    const url = new URL(window.location.href);
    url.hash = `entry-${entryId}`;
    try {
      await copyText(url.href);
      setStatus('copied');
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setStatus('idle'), 1600);
    } catch {
      setStatus('error');
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setStatus('idle'), 2000);
    }
  };

  const label = status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : '复制链接';
  const description =
    status === 'copied'
      ? '消息链接已复制'
      : status === 'error'
        ? '消息链接复制失败'
        : '复制该条消息的链接';
  return (
    <button
      type="button"
      className={`entry-link ${status}`}
      title={description}
      aria-label={description}
      onClick={handleCopy}
    >
      <span aria-hidden="true">{status === 'copied' ? '✓' : '⌁'}</span>
      <span>{label}</span>
    </button>
  );
}

function Meta({ entry }) {
  const ms = entry.timestamp ? Date.parse(entry.timestamp) : null;
  return (
    <>
      <span className="spacer" />
      {ms && <time>{fmtTime(ms)}</time>}
      <span className="dim2 mono small">#{entry.id}</span>
      <CopyEntryLink entryId={entry.id} />
    </>
  );
}

/** 单个工具调用 + 配对结果 */
function ToolCard({ call, result, anchorId }) {
  const isError = result?.message?.isError;
  const args = call.arguments || {};
  let summaryText = '';
  if (typeof args.command === 'string') summaryText = args.command;
  else if (typeof args.path === 'string') summaryText = args.path;
  else if (typeof args.pattern === 'string') summaryText = args.pattern;
  else summaryText = JSON.stringify(args);
  const resultText = result ? contentText(result.message?.content) : '';

  return (
    <div
      id={anchorId}
      className={`tool-card entry-content-anchor ${isError ? 'error' : ''}`}
    >
      <Collapsible
        className="tool-collapsible"
        summary={
          <>
            <span className="tool-name">{isError ? '✗' : '✓'} {call.name}</span>
            <span className="tool-summary">{summaryText?.slice(0, 160)}</span>
            {result == null && <span className="chip amber">无结果</span>}
          </>
        }
      >
        <div className="tool-body">
          <div>
            <div className="tool-sec-label">参数</div>
            <pre className="pre-block">{JSON.stringify(args, null, 2)}</pre>
          </div>
          {result && (
            <div>
              <div className="tool-sec-label">{isError ? '结果（错误）' : '结果'}</div>
              <TruncText text={resultText || '(空)'} limit={1200} />
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

const UserMsg = memo(function UserMsg({ entry }) {
  const m = entry.message || {};
  return (
    <div className="msg user">
      <div className="msg-head">
        <span className="avatar user">你</span>
        <b style={{ color: 'var(--user)' }}>用户</b>
        <Meta entry={entry} />
      </div>
      <div className="msg-body">
        <Markdown text={contentText(m.content)} />
        <RawJson entry={entry} />
      </div>
    </div>
  );
});

const AssistantMsg = memo(function AssistantMsg({
  entry,
  resultByCallId,
}) {
  const m = entry.message || {};
  const blocks = Array.isArray(m.content) ? m.content : [];
  const u = m.usage;
  return (
    <div className="msg assistant">
      <div className="msg-head">
        <span className="avatar assistant">π</span>
        <b style={{ color: 'var(--assistant)' }}>助手</b>
        {m.model && <span className="chip">{shortModel(m.model)}</span>}
        {m.stopReason && m.stopReason !== 'stop' && m.stopReason !== 'toolUse' && (
          <span className="chip red">{m.stopReason}</span>
        )}
        <Meta entry={entry} />
      </div>
      <div className="msg-body">
        {blocks.map((b, i) => {
          if (b.type === 'thinking' && b.thinking) {
            return (
              <div
                key={i}
                id={sessionBlockAnchorId(entry.id, 'thinking', i)}
                className="entry-content-anchor"
              >
                <Collapsible
                  className="thinking-collapsible"
                  summary={<span>💭 思考过程 · {b.thinking.length.toLocaleString()} 字符</span>}
                >
                  <div className="thinking-block">
                    <Markdown text={b.thinking} />
                  </div>
                </Collapsible>
              </div>
            );
          }
          if (b.type === 'text' && b.text) return <Markdown key={i} text={b.text} />;
          if (b.type === 'toolCall') {
            return (
              <ToolCard
                key={b.id || i}
                call={b}
                result={resultByCallId.get(b.id)}
                anchorId={sessionBlockAnchorId(entry.id, 'tool', i)}
              />
            );
          }
          return null;
        })}
        <RawJson entry={entry} />
      </div>
      {u && (
        <div className="usage-line">
          <span>输入 {fmtTokens(u.input)}</span>
          <span>输出 {fmtTokens(u.output)}</span>
          {u.cacheRead > 0 && <span>缓存读 {fmtTokens(u.cacheRead)}</span>}
          {u.reasoning > 0 && <span>推理 {fmtTokens(u.reasoning)}</span>}
          <span>成本 {fmtCost(u.cost?.total)}</span>
        </div>
      )}
    </div>
  );
});

const BashMsg = memo(function BashMsg({ entry }) {
  const m = entry.message || {};
  return (
    <div className="msg bash">
      <div className="msg-head">
        <b style={{ color: 'var(--amber)' }}>💻 手动命令</b>
        {m.exitCode !== 0 && m.exitCode != null && <span className="chip red">exit {m.exitCode}</span>}
        <Meta entry={entry} />
      </div>
      <div className="msg-body">
        <pre className="pre-block">$ {m.command}</pre>
        {m.output && <TruncText text={m.output} limit={1200} />}
        <RawJson entry={entry} />
      </div>
    </div>
  );
});

/** 未被 toolCall 消费的孤立工具结果 */
const OrphanToolResult = memo(function OrphanToolResult({ entry }) {
  const m = entry.message || {};
  return (
    <div className="tool-card">
      <Collapsible
        className="tool-collapsible"
        summary={<><span className="tool-name">🔧 {m.toolName}</span><span className="tool-summary">独立工具结果</span></>}
      >
        <div className="tool-body">
          <TruncText text={contentText(m.content) || '(空)'} limit={1200} />
        </div>
      </Collapsible>
    </div>
  );
});

const CompactionCard = memo(function CompactionCard({ entry }) {
  return (
    <div className="msg compaction">
      <div className="msg-head">
        <b style={{ color: 'var(--green)' }}>📦 上下文压缩</b>
        <span className="dim2 small">此前对话被压缩为摘要，后续消息以摘要为上文</span>
        <Meta entry={entry} />
      </div>
      <div className="msg-body">
        <Collapsible summary={<span>查看压缩摘要 · {(entry.summary || '').length.toLocaleString()} 字符</span>}>
          <Markdown text={entry.summary || ''} />
        </Collapsible>
        <RawJson entry={entry} />
      </div>
    </div>
  );
});

function BranchFileList({ label, files, tone }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const shown = files.slice(0, 6);
  return (
    <div className="branch-file-group">
      <span className={`chip ${tone}`}>{label} {files.length}</span>
      <div className="branch-file-items">
        {shown.map((file, index) => (
          <span key={`${file}-${index}`} className="branch-file-chip" title={file}>
            {file}
          </span>
        ))}
        {files.length > shown.length && (
          <span className="branch-file-more">另有 {files.length - shown.length} 个</span>
        )}
      </div>
    </div>
  );
}

const BranchSummaryCard = memo(function BranchSummaryCard({ entry }) {
  const details = entry.details || {};
  const u = entry.usage;
  return (
    <div className="msg branch-summary">
      <div className="msg-head">
        <b style={{ color: 'var(--amber)' }}>⑂ 分支摘要</b>
        <span className="dim2 small">切换路径时保留的上下文</span>
        {entry.fromHook && <span className="chip amber">扩展生成</span>}
        {entry.fromId && entry.fromId !== 'root' && (
          <span className="chip" title="生成摘要时所在分支的来源记录">
            来源 #{entry.fromId}
          </span>
        )}
        <Meta entry={entry} />
      </div>
      <div className="msg-body">
        <Collapsible
          className="branch-summary-content"
          defaultOpen
          summary={<span>查看分支摘要 · {(entry.summary || '').length.toLocaleString()} 字符</span>}
        >
          <Markdown text={entry.summary || ''} />
          <div className="branch-file-lists">
            <BranchFileList label="读取文件" files={details.readFiles} tone="accent" />
            <BranchFileList label="修改文件" files={details.modifiedFiles} tone="amber" />
          </div>
        </Collapsible>
        <RawJson entry={entry} />
      </div>
      {u && (
        <div className="usage-line">
          <span>摘要输入 {fmtTokens(u.input)}</span>
          <span>摘要输出 {fmtTokens(u.output)}</span>
          {u.cacheRead > 0 && <span>缓存读 {fmtTokens(u.cacheRead)}</span>}
          {u.reasoning > 0 && <span>推理 {fmtTokens(u.reasoning)}</span>}
          <span>成本 {fmtCost(u.cost?.total)}</span>
        </div>
      )}
    </div>
  );
});

function SysChip({ children }) {
  return (
    <div className="sys-chip">
      <span>{children}</span>
    </div>
  );
}

const CustomCard = memo(function CustomCard({ entry }) {
  const label = entry.customType || 'custom';
  const body =
    typeof entry.content === 'string'
      ? entry.content
      : JSON.stringify(entry.data ?? entry, null, 2);
  return (
    <Collapsible summary={<span>⚙️ 扩展事件 · {label}</span>}>
      <TruncText text={body} limit={1000} />
    </Collapsible>
  );
});

/** 条目分发器 */
export const EntryView = memo(function EntryView({
  entry,
  resultByCallId,
  consumedResults,
}) {
  switch (entry.type) {
    case 'session':
      return (
        <SysChip>
          ▶ 会话开始 · v{entry.version} · <span className="mono">{entry.cwd}</span>
        </SysChip>
      );
    case 'message': {
      const role = entry.message?.role;
      if (role === 'user') return <UserMsg entry={entry} />;
      if (role === 'assistant') {
        return (
          <AssistantMsg
            entry={entry}
            resultByCallId={resultByCallId}
          />
        );
      }
      if (role === 'bashExecution') return <BashMsg entry={entry} />;
      if (role === 'toolResult') {
        if (consumedResults.has(entry.id)) return null; // 已在 toolCall 卡片内展示
        return <OrphanToolResult entry={entry} />;
      }
      return null;
    }
    case 'branch_summary':
      return <BranchSummaryCard entry={entry} />;
    case 'compaction':
      return <CompactionCard entry={entry} />;
    case 'model_change':
      return (
        <SysChip>
          ⚙ 模型切换 → <b>{entry.provider}/{entry.modelId}</b>
        </SysChip>
      );
    case 'thinking_level_change':
      return <SysChip>⚙ 思考等级 → <b>{entry.thinkingLevel}</b></SysChip>;
    case 'session_info':
      return <SysChip>🏷 会话命名 → <b>{entry.name || '(清除)'}</b></SysChip>;
    case 'label':
      return (
        <SysChip>
          🔖 {entry.label ? <>标记 <b>{entry.label}</b></> : '清除标记'} · 目标 <span className="mono">#{entry.targetId}</span>
        </SysChip>
      );
    case 'custom':
    case 'custom_message':
      return <CustomCard entry={entry} />;
    default:
      return <SysChip>未知类型 · {entry.type}</SysChip>;
  }
});
