/** 会话条目树工具：id/parentId 结构，支持分支（重试/回溯） */

export function buildTree(entries) {
  const byId = new Map();
  const children = new Map(); // parentId -> [entry...]
  const seq = new Map(); // id -> 文件内顺序
  const treeEntries = entries.filter((entry) => entry.type !== 'session');
  treeEntries.forEach((e, i) => {
    if (e.id) {
      byId.set(e.id, e);
      seq.set(e.id, i);
    }
    const p = e.parentId ?? '__root__';
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(e);
  });

  const leaves = treeEntries.filter((e) => e.id && !(children.get(e.id)?.length > 0));
  const branchPoints = [];
  for (const [pid, kids] of children.entries()) {
    if (pid !== '__root__' && kids.length > 1) branchPoints.push({ parentId: pid, childIds: kids.map((k) => k.id) });
  }
  return { byId, children, seq, leaves, branchPoints };
}

/** 从叶子回溯到根的 id 集合 */
export function pathIds(byId, leafId) {
  const set = new Set();
  let cur = byId.get(leafId);
  let guard = 0;
  while (cur && guard++ < 200000) {
    if (cur.id) set.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return set;
}

/** 某节点的全部后代叶子（含自身若为叶子） */
export function descendantLeaves(tree, nodeId) {
  const out = [];
  const stack = [nodeId];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const id = stack.pop();
    const kids = tree.children.get(id) || [];
    if (kids.length === 0) {
      const e = tree.byId.get(id);
      if (e) out.push(e);
    } else {
      for (const k of kids) if (k.id) stack.push(k.id);
    }
  }
  out.sort((a, b) => (tree.seq.get(a.id) ?? 0) - (tree.seq.get(b.id) ?? 0));
  return out;
}

/** 条目文本预览（用于分支面板等） */
export function entryPreview(e, maxLen = 80) {
  if (!e) return '';
  let text = '';
  if (e.type === 'message') {
    const m = e.message || {};
    if (m.role === 'user') text = '👤 ' + flat(m.content);
    else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const t = blocks.find((b) => b.type === 'text')?.text;
      const tc = blocks.filter((b) => b.type === 'toolCall');
      text = '🤖 ' + (t || (tc.length ? `调用 ${tc.map((x) => x.name).join(', ')}` : '(思考)'));
    } else if (m.role === 'toolResult') text = `🔧 ${m.toolName || ''} 结果`;
    else if (m.role === 'bashExecution') text = `💻 $ ${m.command || ''}`;
  } else if (e.type === 'compaction') text = '📦 上下文压缩';
  else if (e.type === 'branch_summary') text = `⑂ 分支摘要 ${e.summary || ''}`;
  else if (e.type === 'model_change') text = `⚙️ 模型 → ${e.modelId || ''}`;
  else if (e.type === 'thinking_level_change') text = `⚙️ 思考等级 → ${e.thinkingLevel || ''}`;
  else if (e.type === 'session_info') text = `🏷 命名 → ${e.name || ''}`;
  else if (e.type === 'label') text = `🔖 标记 ${e.label || '(清除)'}`;
  else text = e.customType || e.type;
  text = (text || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

function flat(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === 'string' ? b : b?.text || (b?.type === 'image' ? '[图片]' : '')))
      .join(' ');
  return '';
}
