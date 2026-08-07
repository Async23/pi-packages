import { Markdown } from '../components/Ui';

const DOC = String.raw`
Pi Agent 将每次会话记录为一个 **JSONL 文件**（每行一个 JSON 对象），本页帮助你读懂这份数据。

## 目录组织

\`\`\`text
~/.pi/agent/sessions/
├── --Users-alfheim-code-oss-pi--/          ← 工作目录路径（/ 替换为 -）
│   ├── 2026-07-23T08-36-21-506Z_019f8e1e-….jsonl   ← 创建时间 + UUIDv7
│   └── …
└── --private-tmp-…--/
\`\`\`

## 树形结构：id / parentId

每行记录都有 \`id\` 与 \`parentId\`，整个会话是一棵**树**而不是简单列表：

- 正常对话沿一条链增长；
- 当你**重试回复 / 回溯编辑**时，会从某个节点分叉出新分支——旧分支仍保留在文件中；
- 当前活跃路径 = **文件最后一行记录向上回溯到根**的祖先链；
- 一个节点有多个子节点 ⇒ 这里是**分支点**（本应用中用 ⑂ 标出，可切换查看）。

## 行类型（type）

| type | 说明 |
| --- | --- |
| \`session\` | 文件头：版本、会话 id、创建时间、\`cwd\`、可选 \`parentSession\`（fork 来源文件） |
| \`message\` | 对话消息，具体内容看 \`message.role\`（见下） |
| \`model_change\` | 切换模型：\`provider\` + \`modelId\` |
| \`thinking_level_change\` | 切换思考等级：off / minimal / low / medium / high / max |
| \`compaction\` | 上下文压缩：\`summary\` 为压缩摘要，其后的对话以摘要为上文 |
| \`branch_summary\` | 通过 /tree 切换路径时保存的分支摘要：\`fromId\` + \`summary\`，可附带 \`usage\` 与文件轨迹 \`details\` |
| \`session_info\` | 会话命名（/name），\`name\` 字段 |
| \`label\` | 给某条记录打标（\`targetId\` + \`label\`） |
| \`custom\` / \`custom_message\` | 扩展写入的自定义数据/消息（如 web-search-results、workflow 通知） |

## message.role 四种角色

| role | 说明 |
| --- | --- |
| \`user\` | 用户输入，\`content\` 为文本/图片块数组 |
| \`assistant\` | 模型回复，\`content\` 块：\`text\`（正文）、\`thinking\`（思考）、\`toolCall\`（工具调用，含 \`id\`/\`name\`/\`arguments\`）；附带 \`usage\`（tokens 与成本）、\`model\`、\`stopReason\` |
| \`toolResult\` | 工具执行结果，通过 \`toolCallId\` 与 \`toolCall\` 配对；\`isError\` 标记失败 |
| \`bashExecution\` | 用户在 TUI 中手动执行的 \`!命令\`（command / output / exitCode） |

## usage 字段（assistant / compaction / branch_summary）

\`\`\`json
{
  "input": 14493,          // 非缓存输入 tokens
  "output": 12,            // 输出 tokens
  "cacheRead": 0,          // 命中提示缓存的 tokens（便宜很多）
  "cacheWrite": 0,         // 写入缓存的 tokens
  "reasoning": 0,          // 推理（思考）tokens
  "totalTokens": 14505,
  "cost": { "input": 0.07, "output": 0.0004, "total": 0.0728 }   // 单位：美元
}
\`\`\`

**上下文规模** ≈ \`input + cacheRead\`。会话越长该值越大，达到阈值会触发 compaction，
压缩后重新从小上下文开始——在会话详情页的「上下文规模趋势」图中可以直观看到锯齿形变化。

## 一条典型的对话链

\`\`\`text
session → model_change → thinking_level_change
  → message(user)
  → message(assistant, content=[thinking, toolCall])
  → message(toolResult)         ← 通过 toolCallId 配对
  → message(assistant, content=[text])   ← 最终回答
  → message(user) → …
\`\`\`

## 本系统如何使用这些数据

- **后端**（Express）扫描目录、逐行解析，按 mtime 增量缓存摘要与全文索引；
- **会话详情**重建树结构、默认展示主路径、配对工具调用与结果、支持分支切换；
- **统计洞察**聚合 usage 得到 token/成本/模型/缓存命中率等维度；
- 所有原始行都可在界面中展开「原始 JSON」查看，便于学习该格式。
- 会话详情支持直接下载未加工的原始 JSONL，也可导出包含分支摘要的 Markdown。
`.replaceAll('\\`', '`');

export default function Schema() {
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <h1 className="page-title">数据格式</h1>
        <span className="page-desc">理解 ~/.pi/agent/sessions 的会话存储结构</span>
      </div>
      <div className="card schema-doc">
        <Markdown text={DOC} />
      </div>
    </div>
  );
}
