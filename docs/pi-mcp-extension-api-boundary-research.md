# Pi Extension API 承载 MCP 的技术边界

研究日期：2026-08-04

## 结论

以本机 `pi --version` 返回的 `0.83.0` 为准；npm 的 `gitHead` 和官方 `v0.83.0` 标签都指向 `845d6ff1f6643aba440341cce877ce1c43ebbc39`，官方包清单也声明版本为 `0.83.0`。[版本源码](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/package.json#L1-L4)

**可以只用 extension 做出用户所需的完整 MCP 使用体验**：发现各 Agent 的配置实例、建立 stdio/HTTP 连接、把 MCP tools 暴露给模型、提供 `/mcp` 管理面板、浏览 resources、调用 prompts、处理 OAuth/权限、显示状态并在 session 结束时清理。Extension 可加载 npm 依赖和 Node.js 内置模块，且运行在 Pi 进程的完整系统权限下，因此协议栈、子进程、socket、HTTP 和凭证实现本身不受 Extension API 阻碍。[官方扩展运行与依赖说明](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L109-L152)

**但不能做到“Pi 原生且无损”的完整 MCP host**。主要缺口是：Pi 没有 MCP resource/prompt registry；tool/result 内容只支持 text 和 image；`AgentToolResult` 没有 `isError`；tool/command 没有 unregister；MCP prompt 的多角色消息不能通过公开 API 原样持久化进会话；server-initiated sampling、通用安全凭证库和非 TUI 管理 UI 也没有一等 Extension API。

因此建议：**最终产品先按 extension-only 实现，但把所有有损适配集中在明确 seam 中**。这足以交付目标体验；只有追求协议内容无损、原生 resource/prompt UI 或热删除 tool 时，才需要改 Pi core。

## 能力矩阵

| 能力 | Pi 0.83.0 可用机制 | 结论与限制 |
|---|---|---|
| stdio / HTTP / OAuth 连接 | Extension 可使用 npm 依赖、Node 子进程、网络和文件系统 | 可实现；凭证与 OAuth 状态由 extension 自己管理，Pi 没有通用 MCP credential store |
| 异步初始化 | async factory 会被等待；`session_start` handler 也会被等待 | 可实现；长生命周期连接应从 `session_start` 启动，不应从 factory 启动；必须自行设置连接超时 |
| tool 发现与注册 | `pi.registerTool()` 可在启动后调用，并立即刷新当前 session | 原生支持动态增加与同名更新；没有 unregister |
| tool 启停与延迟加载 | `getActiveTools()` / `getAllTools()` / `setActiveTools()`；支持 deferred tool loading | 原生支持；`setActiveTools()` 是全局 tool 名单，修改时必须保留其他 extension 的 tools |
| MCP `inputSchema` | Pi 参数类型是 TypeBox `TSchema`，运行时也显式支持序列化后的普通 JSON Schema | 基本可直接适配并做 TypeScript cast；仍受 Pi/TypeBox 编译器支持的 JSON Schema 关键字范围约束 |
| tool 结果 | `execute()` 返回 text/image、arbitrary `details`，可用 `onUpdate` 推送 partial result | 部分支持；audio、resource link、embedded resource、annotations 和 structured content 需要转换 |
| MCP `isError` | `tool_result` 事件可返回 `{ isError }`；tool 抛错会被 Pi 转成 error result | 可桥接但非直接支持；不能从 `execute()` 的结果直接设置 `isError` |
| 取消与进度 | `execute()` 收到 `AbortSignal` 和 `onUpdate` | 可桥接到 MCP SDK 的 `signal` / `onprogress`；若底层 transport 不响应 signal，Pi 不会强制终止该 Promise |
| MCP resources | Extension 内部可 list/read/subscribe；可用 tool result、`sendMessage()` 或编辑器注入内容 | 没有 Pi 原生 resource registry/URI picker；`resources_discover` 不是 MCP resources |
| MCP prompts | 可注册 slash command，或在 `/mcp` 中选择后用 `sendUserMessage()` / editor 注入 | 可用但多角色结构有损；推荐一个稳定的 `/mcp-prompt` 命令，而不是为每个远程 prompt 热注册命令 |
| `/mcp` 管理面板 | `ctx.ui.custom()`、status、widget、notify、dialog | TUI 可完整实现；RPC 的 `custom()` 返回 `undefined`，JSON/print 没有交互 UI |
| session 生命周期 | `session_start` / `session_shutdown`，覆盖 startup/reload/new/resume/fork/quit | 原生支持 session-scoped 连接；session 替换后旧 `pi`/`ctx` 会失效，必须重建连接 |
| roots | `ctx.cwd`、`ctx.isProjectTrusted()` | 可声明当前 cwd 为一个 root；Pi 没有公开的多 workspace roots 列表，其他 roots 需来自配置 |
| sampling / elicitation | 可直接使用当前 model/provider 的 pi-ai stream API；可用 dialog/custom TUI | 仅有底层 seam，无一等 MCP host API；审批、消息转换、usage 与 transcript 记录都要自行实现 |

## 1. 动态 tools 的精确边界

### 能做什么

`pi.registerTool()` 明确支持 extension load 之后调用；官方文档保证新 tool 会在同一个 session 立即刷新、出现在 `getAllTools()`，且不需要 `/reload`。[动态注册契约](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L1337-L1349) 实现中，每个 extension 用 `Map` 保存 tools，`registerTool()` 对同一名字执行 `set()` 并触发 `refreshTools()`，所以**同一个 extension 内重新注册同名 tool 就是更新定义**。[注册实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/loader.ts#L245-L252)

刷新 registry 后：

- 新名字会自动加入 active tools；
- 已 active 的同名 tool 会换成新 wrapper；
- system prompt 的 tool snippet/guidelines 会重建；
- active 变化会在下一个 agent turn 使用。[registry 刷新实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L2455-L2545)

`setActiveTools()` 在同一次 agent run 的下一次 provider request 前生效。纯增量激活还会把新增名字记到当前 tool result 的 `addedToolNames`，让支持 deferred loading 的模型在正确位置加载 schema；其他模型会在下一请求发送完整 active tool 列表。[官方动态加载流程](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2306-L2339)

这适合大量 MCP tools：先注册全部定义，但只激活一个 `mcp_search_tools`/`mcp_load_tools`，按需增量启用。不要给延迟 tools 配 `promptSnippet`/`promptGuidelines`，否则激活时仍会改 system prompt、破坏缓存前缀。[缓存注意事项](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2333-L2339)

### 不能做什么

ExtensionAPI 只有 `registerTool()`，没有 `unregisterTool()` 或 `replaceToolSet()`。[API 类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L1233-L1241) 因此收到 MCP `notifications/tools/list_changed` 时：

- 新增：`registerTool()`；
- 同名 schema/description 变化：重新 `registerTool()`；
- 删除：只能从 `setActiveTools()` 中移除，旧定义仍留在 `getAllTools()`，直到 `/reload`、session 替换或整个 extension runtime 重建。

跨 extension 的同名 tool 由加载顺序中的第一个注册胜出；而在最终 registry 中，Pi 先放入 built-in，再用 custom/extension tool 做 `Map.set()`，所以 extension tool 可以覆盖同名 built-in tool。[跨 extension 去重](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L449-L470) [最终 registry 合并](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L2455-L2521) 所以 MCP tool 必须生成稳定、provider 可接受且包含来源身份的 Pi 名字，不能只使用 server 返回的裸 `tool.name`。

`setActiveTools(names)` 会替换整个 active 集合，未知或被 CLI allowlist/denylist 排除的名字会被忽略，并重建 system prompt。[启停实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L920-L941) MCP extension 每次修改时应先读取当前 active names，仅增删自己拥有的名字，避免关闭其他 extension 的 tools。

### Schema 适配

Pi 声明参数为 TypeBox `TSchema`，但校验器会检测 schema 是否带 `TypeBox.Kind`；普通 JSON Schema 会走专门的递归 coercion，再交给 TypeBox `Compile()` 校验。[普通 JSON Schema 路径](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/utils/validation.ts#L232-L309) 官方测试覆盖了 serialized plain JSON Schema 的 number/integer/boolean/string/null/union coercion。[校验测试](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/test/validation.test.ts#L64-L127)

因此 MCP `inputSchema` 可作为普通对象传入并在 TypeScript 边界 cast 为 `TSchema`，无需机械重建成 `Type.Object()`；但连接时应预编译/试校验每个 schema，把 TypeBox 不支持的关键字或外部 `$ref` 提前报告在 `/mcp`，不要等模型第一次调用才失败。

## 2. tool 内容、错误和取消的适配

Pi 的 `ToolDefinition.execute()` 收到 `toolCallId`、参数、可选 `AbortSignal`、可选 update callback 和 `ExtensionContext`；最终必须返回 `AgentToolResult`。[ToolDefinition 类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L449-L497) Pi 的最终和 partial tool result 都只允许 `TextContent | ImageContent`；`details` 是给日志/UI 的任意结构，不是一种模型内容。[AgentToolResult 类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/agent/src/types.ts#L354-L377) Text/Image 的实际形状和 tool result 消息限制也固定在这两个类型上。[内容类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/types.ts#L338-L358) [ToolResultMessage](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/types.ts#L415-L430)

MCP 2025-11-25 的 `CallToolResult.content` 可以包含 text、image、audio、resource link、embedded resource，并另有 `structuredContent`、`isError` 和 `_meta`。[MCP Schema Reference](https://modelcontextprotocol.io/specification/2025-11-25/schema)

推荐唯一的 content converter：

| MCP 内容 | Pi 内容 | 保留策略 |
|---|---|---|
| `text` | `{ type: "text", text }` | 无损；annotations/_meta 放 `details` |
| `image` | `{ type: "image", data, mimeType }` | 主体无损；annotations/_meta 放 `details` |
| `audio` | text 占位/摘要 | Pi 0.83.0 无 audio block；原 base64 与 mimeType 只放 `details`，不要默认把大段 base64 发给模型 |
| embedded text resource | 带 `uri`/`mimeType` 边界的 text | 文本可见，resource 类型语义有损；原对象放 `details` |
| embedded blob resource | 若是受支持图片则转 image；否则 text 占位 | 非图片 blob 无原生通道；原对象放 `details` |
| `resource_link` | 含 name/URI/mime/description 的 text | 链接可见但不是可点击/可延迟获取的原生 content block |
| `structuredContent` | `details` 中保留；需要模型使用时再序列化为额外 text | 仅放 `details` 不会成为模型可见内容 |
| annotations / `_meta` | namespaced `details` | Pi content block 没有对应字段 |

### `isError` seam

`AgentToolResult` 没有 `isError`。Pi 官方要求 tool `execute` 用 throw 表示错误，框架会生成 `isError: true` 的文本结果。[错误契约](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2862-L2867) 但 MCP 的业务错误是一个正常返回的 `CallToolResult { content, isError: true }`；直接 throw 会丢掉多块 content、structuredContent 和 metadata。

推荐桥接：MCP wrapper 正常返回转换后的 content，并在 namespaced `details` 记录 MCP `isError`；同一 extension 的 `tool_result` handler 识别自己的 tool，再返回 `{ isError: true }`。该事件的公开返回类型允许独立修改 `content`、`details`、`isError` 和 `usage`。[ToolResultEventResult](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L1085-L1090) 真正的 JSON-RPC/transport exception 则直接 throw，让 Pi 走标准错误路径。

### 取消和进度

把 Pi `execute(..., signal, onUpdate)` 的 signal 原样传给 MCP request，并把 MCP progress notification 转成 `onUpdate({ content, details })`。官方 MCP TypeScript SDK `1.30.0` 的 `RequestOptions` 同时提供 `onprogress`、`signal` 和 request timeout；signal 取消会让 request 抛 `AbortError`。[SDK RequestOptions](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/shared/protocol.ts#L103-L128) SDK 的 `callTool()` 接受这组 options，并负责 output schema 校验。[SDK callTool](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/client/index.ts#L709-L744)

Pi 自己不会把 tool Promise 与 AbortSignal 做强制 `Promise.race`；执行器把 signal 传进去后直接 `await tool.execute(...)`。[执行实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/agent/src/agent-loop.ts#L666-L706) 因此 transport/SDK 必须真正响应 signal，并且每个 connect/list/call 都要有 deadline。否则用户按 Esc 后，session 仍可能等待一个不结束的 MCP Promise。

## 3. Resources 与 Prompts

### `resources_discover` 不是 MCP resource registry

Pi 的 `resources_discover` 只能返回 `skillPaths`、`promptPaths`、`themePaths`，触发时机是 `session_start` 之后的 startup/reload。[事件类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L543-L555) ExtensionAPI 中也不存在 `registerResource()`、`readResource()` 或 URI resource provider 接口。

所以 MCP resources 应放在 extension 自己的 per-instance registry 中：

- `/mcp` 面板负责按 Agent / scope / config file / server 浏览资源；
- 暴露稳定的 `mcp_list_resources`、`mcp_read_resource` tools 给模型；
- 用户从面板选中资源后，用 `pi.sendMessage()` 注入已转换的 text/image，或用 `pasteToEditor()` 让用户编辑后发送；
- subscription/list-changed 更新内部 registry 和面板，不尝试写进 Pi 的“resource”系统。

`sendMessage()` 的 custom message 会参与 LLM context，但其内容同样只支持 string、text、image；转换到 LLM 时总是变成 user message。[CustomMessage 类型与转换](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/messages.ts#L43-L53) [LLM 转换](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/messages.ts#L148-L168)

### MCP prompts 的可行暴露方式

`pi.registerCommand()` 可以注册 async slash command 和 async 参数补全；同名命令跨 extension 会获得 `:1`、`:2` 后缀。[命令 API](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L1493-L1559) 推荐在 factory 中注册一个稳定命令：

```text
/mcp-prompt <agent>/<scope>/<server>/<prompt> [arguments]
```

参数补全读取 extension 的实时 prompt catalog；handler 调 `prompts/get`，展示预览/审批，再把转换结果送进编辑器或 `sendUserMessage()`。这样 server prompt list 变化不需要热增删命令，也不会污染 slash command 名字空间。

不能无损映射的是 MCP prompt 的 `PromptMessage[]`：它可包含 user/assistant 角色和 richer content，而 Pi 的 `sendUserMessage()` 只能创建 user message，`sendMessage()` 也会转换成 user message。[发送 API 类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L1285-L1298) Extension 可在 `context` 事件里暂时构造更多角色，但那是每次 LLM call 前的非持久 context 变换，不是公开的任意 session message append API。[context 事件](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L648-L658)

默认应把多角色 MCP prompt 序列化成一个带清晰 role/content 边界的 user message；原始结构放在 `details` 或 extension state。若未来要求真正的多角色 prompt fidelity，需要 Pi core 提供受控的 structured prompt/message injection API。

### Sampling 与 elicitation

这两项是 MCP server 发给 client 的反向请求，不是 Pi 的 tool/resource/prompt 注册。Extension 可以在 MCP SDK client 上安装 request handler；收到 sampling 请求后，从 `ctx.model` 取得当前模型，通过 `ctx.modelRegistry.getProvider()` 和 `getProviderAuth()` 取得 provider 与已解析认证，再直接调用 pi-ai provider 的 `streamSimple()`。Pi 明确把当前 model、有效 provider 和认证暴露给 extension，而 provider 接口也公开 `stream()` / `streamSimple()`。[Extension model/provider API](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L985-L993) [Provider stream 接口](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/models.ts#L75-L123)

但这只是可实现 sampling 的底层 seam，不是 host-level sampling API：extension 仍要自己完成 MCP message/model-preference 转换、max-token/timeout/abort 限制、用户审批、响应转换和 usage 记录；直接调用 provider 也不会自动成为 Pi 当前 AgentSession 的一轮对话。Elicitation 同样可用 `ctx.ui.select()` / `input()` / `confirm()` / `custom()` 实现，但只能在有对应 UI 能力的 mode 中交互；JSON/print 模式应按显式无头策略处理或拒绝，不能静默代替用户作安全决定。[MCP sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) [Pi mode 降级](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2868-L2877)

## 4. 异步连接与 session 生命周期

Extension factory 可以返回 Promise，Pi 会等待它结束后才继续 startup；但官方明确要求不要在 factory 启动 process/socket/watcher/timer，因为有些 invocation 根本不会创建 session。长生命周期资源应在 `session_start` 创建，并在幂等的 `session_shutdown` 中清理。[async factory 与资源生命周期](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L154-L224)

`session_start` handler 会被 await，随后才执行 `resources_discover`；TUI 再在 bind 完成后建立 slash autocomplete。[bind 顺序](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L2229-L2276) [TUI 初始化顺序](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1634-L1710) 因此有两种合法策略：

1. 在 `session_start` await 全部 connect/list：首个 prompt 就有完整 tools/prompts，但拖慢甚至卡住 Pi 启动。
2. `session_start` 建立受监督的后台连接任务并尽快返回：Pi 先可用，server 连上后调用动态 `registerTool()`；但用户过早发送 prompt 时可能暂时看不到 MCP tools。

建议采用第二种，并为显式标记为 required 的 server 提供短时 blocking readiness；所有 server 用 `Promise.allSettled`、单 server deadline 和 session epoch/AbortController 隔离。`/mcp` 命令与空面板应在 factory 注册，确保即使所有连接失败仍能打开管理和诊断。

session 替换/new/resume/fork 会先对旧 extension instance 发 `session_shutdown`，再重载并绑定新 instance、发新的 `session_start`；reload/quit 也有明确 reason。[生命周期说明](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L415-L449) [shutdown 事件](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L507-L516) Shutdown handlers 会被 await，但没有框架级 teardown timeout，因此 `client.close()`/child kill 必须幂等且有上限。

runtime replacement/reload 后，旧 `pi` 和旧 context 会被标成 stale，再调用会 throw。[失效实现](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L833-L853) 后台连接回调必须先检查 session epoch/disposed flag，不能在 shutdown 后继续注册 tools 或更新 UI。

## 5. `/mcp` TUI 与状态

TUI 模式可以实现目标管理面板：`ctx.ui.custom()` 支持同步或异步 component factory、键盘焦点、overlay、动态 overlay options 和 `dispose()`；`setStatus()` 可持久显示 footer 状态，`setWidget()` 可显示简表，dialog 可做确认、输入和选择。[UI 类型](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L127-L210) [官方 UI 模式](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2527-L2702)

连接状态变化时更新 panel state、调用注入的 `tui.requestRender()`；组件关闭时 `dispose()` 取消订阅。footer 建议只显示汇总，例如 `MCP 7/9`，详细错误留在 `/mcp`，避免持续占屏。

限制按 mode 处理：

- `tui`：完整面板；
- `rpc`：dialog/notify/status/widget 可通过 JSON 子协议工作，但 `custom()` 返回 `undefined`；
- `json`：UI no-op；
- `print`：extension 可运行但不能 prompt 用户。[Mode Behavior](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2868-L2877) [RPC 降级清单](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/rpc.md#L1143-L1164)

因此 `/mcp` 的 custom panel 必须用 `ctx.mode === "tui"` 守卫；headless 模式应提供稳定 commands/tools 和结构化日志，而不是假设面板存在。

## 6. 完整 MCP host 的缺口与建议 seams

### Extension 内必须先定义的 seams

1. **`McpInstanceId`**：身份至少包含 `agent + scope + configPath + serverName`；连接、tool 名、权限、OAuth 和状态全部以此隔离，绝不跨 Agent 合并。
2. **`McpConnectionSupervisor`**：per-session epoch、connect deadline、reconnect/backoff、AbortController、幂等 close；禁止散落裸 Promise。
3. **`McpToolRegistryAdapter`**：负责名字编码、schema 预检、register/update、active-set merge、删除 tombstone 和 list-changed。
4. **`McpContentAdapter`**：唯一处理 text/image/audio/resource/link/structuredContent/annotations；显式记录 conversion warnings。
5. **`McpToolErrorBridge`**：用 namespaced details + `tool_result` 恢复 MCP `isError`，协议异常则 throw。
6. **`McpPromptAdapter`**：稳定 `/mcp-prompt` 命令、实时补全、预览、参数收集、多角色 flatten 策略。
7. **`McpUiAdapter`**：TUI custom panel 与 RPC/JSON/print fallback 分开，不把协议状态绑死在 Component 上。

### 若要 Pi 原生无损，最小 core seams

优先级从高到低：

1. `pi.unregisterTool(name)` 或 `pi.replaceTools(sourceId, definitions)`，支持 MCP list-changed 的真实删除和原子替换。
2. `AgentToolResult.isError?: boolean`，保留 MCP 业务错误的原始 content/details，不再依赖 `tool_result` side channel。
3. richer tool/message content abstraction，至少原生支持 audio、resource link、embedded resource 与 content annotations；或提供官方、可扩展的 content lowering hook。
4. `registerResourceProvider()` / `registerPromptProvider()`，让远端动态资源和 prompts 进入 Pi/RPC 的一等发现与调用界面，而不是伪装成文件路径或 generic command。
5. `unregisterCommand()` / autocomplete refresh，支持真正的每-prompt command 热更新；当前方案可用稳定 generic command 避开。
6. 受控的 `ctx.sample()` / structured message injection API，以及 host-level approval/usage/transcript hook，承载 server-initiated sampling。
7. 面向 extension 的通用安全 credential store，而不是复用只面向模型 provider 的 `/login`/OAuth 注册。

## 最终决策

**继续按 extension-only 方案设计和实现，不先 fork/patch Pi。** Pi 0.83.0 已经提供最关键的动态 tool、取消信号、session 生命周期和完整 TUI 能力，足以完成用户看到的最终 MCP 体验。

同时把以下三点写入产品语义，不能暗中假装无损：

- MCP resources/prompts 由 extension 自己管理和呈现，不宣称是 Pi 原生 registry；
- 非 text/image 内容、多角色 prompt 和 structured metadata 使用明确、可检查的 lowering 策略；
- tool 删除先 tombstone + deactivate，真正从 registry 移除需要 reload/session replacement，直到 Pi 提供 unregister seam。

这样可以先把完整体验交付出来，并把未来可能提交给 Pi upstream 的 core 改动压缩成少数、独立且可测试的接口。
