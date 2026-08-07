import { contentText } from './parser.js';

/** 沿主路径（最后一条记录的祖先链）导出 Markdown */
export function toMarkdown(detail) {
  const { summary, entries } = detail;
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));

  // 主路径 = 最后一条记录向上回溯
  const last = entries[entries.length - 1];
  const onPath = new Set();
  let cur = last;
  let guard = 0;
  while (cur && guard++ < 100000) {
    if (cur.id) onPath.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }

  const lines = [];
  lines.push(`# ${summary.title}`);
  lines.push('');
  lines.push(`- 项目: \`${summary.cwd}\``);
  lines.push(`- 创建时间: ${new Date(summary.createdAt).toLocaleString('zh-CN')}`);
  lines.push(`- 模型: ${summary.models.join(', ') || '-'}`);
  lines.push(
    `- Tokens: 输入 ${summary.tokens.input.toLocaleString()} / 输出 ${summary.tokens.output.toLocaleString()} / 缓存读 ${summary.tokens.cacheRead.toLocaleString()}`
  );
  lines.push(`- 成本: $${summary.cost.toFixed(4)}`);
  lines.push('');
  lines.push('---');

  // 工具结果按 callId 配对
  const resultByCallId = new Map();
  for (const e of entries) {
    if (e.type === 'message' && e.message?.role === 'toolResult' && e.message.toolCallId) {
      resultByCallId.set(e.message.toolCallId, e.message);
    }
  }

  for (const e of entries) {
    if (e.id && !onPath.has(e.id)) continue;
    if (e.type === 'branch_summary') {
      lines.push('', '## ⑂ 分支摘要', '');
      if (e.fromId) lines.push(`- 来源记录: \`#${e.fromId}\``, '');
      lines.push(e.summary || '');
      continue;
    }
    if (e.type === 'compaction') {
      lines.push('', '## 📦 上下文压缩', '', e.summary || '');
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message || {};
    if (m.role === 'user') {
      lines.push('', `## 👤 用户`, '', contentText(m.content));
    } else if (m.role === 'bashExecution') {
      lines.push('', '## 💻 手动命令', '', '```bash', `$ ${m.command || ''}`, '```');
      if (m.output) lines.push('', '```', m.output.slice(0, 4000), '```');
    } else if (m.role === 'assistant') {
      lines.push('', `## 🤖 助手 (${m.model || '?'})`);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'thinking' && b.thinking) {
          lines.push('', '<details><summary>思考过程</summary>', '', b.thinking, '', '</details>');
        } else if (b.type === 'text' && b.text) {
          lines.push('', b.text);
        } else if (b.type === 'toolCall') {
          lines.push('', `### 🔧 ${b.name}`, '', '```json', JSON.stringify(b.arguments ?? {}, null, 2), '```');
          const r = resultByCallId.get(b.id);
          if (r) {
            const text = contentText(r.content);
            lines.push('', r.isError ? '结果（错误）:' : '结果:', '', '```', text.slice(0, 4000), '```');
          }
        }
      }
    }
  }
  return lines.join('\n');
}
