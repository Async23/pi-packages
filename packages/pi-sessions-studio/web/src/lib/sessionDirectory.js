export function sessionBlockAnchorId(entryId, kind, blockIndex) {
  return `entry-${entryId}-${kind}-${blockIndex}`;
}

function assistantBlocks(entry) {
  return Array.isArray(entry.message?.content) ? entry.message.content : [];
}

function resultStatus(result) {
  if (!result) return { label: '无结果', tone: 'missing' };
  if (result.message?.isError) return { label: '结果 · 错误', tone: 'error' };
  return { label: '结果 · 成功', tone: 'success' };
}

/**
 * 从当前会话路径推导“用户轮次 → π 模型步骤 → 思考/工具”的语义目录。
 * 这不是 JSONL 的 id/parentId 原生分支树。
 */
export function buildSessionDirectory(entries, resultByCallId = new Map()) {
  const turns = [];
  let currentTurn = null;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const role = entry.message?.role;

    if (role === 'user') {
      currentTurn = {
        id: `turn-${entry.id || turns.length + 1}`,
        userEntryId: entry.id,
        index: turns.length + 1,
        steps: [],
        thinkingCount: 0,
        toolCount: 0,
      };
      turns.push(currentTurn);
      continue;
    }

    if (role !== 'assistant' || !currentTurn || !entry.id) continue;

    const blocks = assistantBlocks(entry);
    const details = [];
    let thinkingCount = 0;
    let toolCount = 0;
    let resultCount = 0;
    let hasText = false;

    blocks.forEach((block, blockIndex) => {
      if (block?.type === 'text' && block.text?.trim()) hasText = true;

      if (block?.type === 'thinking' && block.thinking?.trim()) {
        thinkingCount += 1;
        details.push({
          id: `${entry.id}:thinking:${blockIndex}`,
          type: 'thinking',
          entryId: entry.id,
          anchorId: sessionBlockAnchorId(entry.id, 'thinking', blockIndex),
          label: '思考',
        });
      }

      if (block?.type === 'toolCall') {
        toolCount += 1;
        const result = block.id ? resultByCallId.get(block.id) : null;
        if (result) resultCount += 1;
        const status = resultStatus(result);
        details.push({
          id: `${entry.id}:tool:${blockIndex}`,
          type: 'tool',
          entryId: entry.id,
          anchorId: sessionBlockAnchorId(entry.id, 'tool', blockIndex),
          label: `${block.name || '工具'} → ${status.label}`,
          tone: status.tone,
        });
      }
    });

    const step = {
      id: entry.id,
      entryId: entry.id,
      anchorId: `entry-${entry.id}`,
      index: currentTurn.steps.length + 1,
      thinkingCount,
      toolCount,
      resultCount,
      details,
      hasText,
      isFinal: false,
    };
    currentTurn.steps.push(step);
    currentTurn.thinkingCount += thinkingCount;
    currentTurn.toolCount += toolCount;
  }

  for (const turn of turns) {
    const lastStep = turn.steps[turn.steps.length - 1];
    if (lastStep?.hasText && lastStep.toolCount === 0) lastStep.isFinal = true;
  }

  return turns;
}
