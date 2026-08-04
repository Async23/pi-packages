# Pi MCP 客户端协议能力与生命周期研究

> 研究日期：2026-08-04
>
> 研究问题：一个完整的 Pi MCP client/host extension 需要支持哪些协议能力、transport、认证、协商、生命周期、通知、内容、取消与错误语义？
>
> 资料边界：仅使用 MCP 官方版本化规范、官方扩展规范、官方 TypeScript SDK 文档与源码。

## 结论

Pi 的 MCP extension 应设计为一个**双协议时代（dual-era）的完整 host/client**，以当前稳定的 MCP `2026-07-28` 和 `@modelcontextprotocol/client` v2 为主路径，同时保留 `2024-10-07` 至 `2025-11-25` 的 legacy 兼容。不能再把 `initialize`、HTTP session、GET SSE 流当成统一生命周期：`2026-07-28` 已改为无协议级 session、每请求携带版本与 client capabilities、可选 `server/discover`、MRTR 和 `subscriptions/listen`；旧版仍以 `initialize` 建立连接级协商。官方 TypeScript SDK v2 已稳定发布并同时支持两种时代，但默认仍使用 legacy，必须显式选择 `versionNegotiation: { mode: "auto" }` 才会探测 modern server。[MCP 版本与兼容性](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)；[TypeScript SDK v2 协议版本指南](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)；[SDK v2 README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md)

“完整”不等于无条件宣告所有能力。协议要求 client 在每次 modern 请求中只声明当前确实可兑现的能力；未实现相应交互 UI、模型调用或安全策略时，不应宣告 elicitation、sampling、roots 或任何 extension。Core conformance 的最低层是 JSON-RPC、版本/扩展协商与消息模式；tools、resources、prompts、completion、elicitation 和 authorization 都由能力或 transport 条件启用。[基础协议](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)；[架构与能力协商](https://modelcontextprotocol.io/specification/2026-07-28/architecture)

建议锁定以下产品边界：

1. **首个完整交付必须覆盖 active core**：stdio、Streamable HTTP、tools、resources、prompts、completion、pagination、cache hints、progress、cancellation、subscriptions、MRTR、form/URL elicitation，以及远程 HTTP OAuth。
2. **legacy 是兼容层，不是新架构的中心**：保留旧 `initialize`、旧 Streamable HTTP session 行为和 HTTP+SSE fallback；roots、sampling、logging 只为旧 server 兼容，不作为新功能入口。
3. **官方 extensions 显式 opt-in**：Tasks、MCP Apps、client credentials、enterprise-managed authorization 均不得默认宣告。Tasks 当前官网称官方 extension，但其官方仓库仍标为 experimental 且 SDK core 没有高层 task client，因此应先放在 feature flag 后；MCP Apps 需要 sandboxed iframe/App Bridge，不适合直接塞进终端 TUI，需独立 renderer 设计。[Extensions 总览](https://modelcontextprotocol.io/extensions/overview)；[Tasks 文档](https://modelcontextprotocol.io/extensions/tasks/overview)；[Tasks 官方仓库](https://github.com/modelcontextprotocol/ext-tasks)；[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
4. **每个已解析的 Agent / scope / 配置文件 / server 条目拥有独立 client 实例**。MCP 架构本身规定一个 client 只连接一个 server；`serverInfo.name` 是自报且不保证唯一，不能拿它合并实例或做安全判断。[MCP 架构](https://modelcontextprotocol.io/specification/2026-07-28/architecture)；[Tool 名称冲突规则](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-names)

## 版本与 SDK 决策

| 决策 | 选择 | 直接影响 |
| --- | --- | --- |
| 协议主版本 | `2026-07-28` | 按无状态、per-request `_meta`、MRTR、subscription stream 建模，不创建虚构的 MCP session |
| 兼容范围 | dual-era：modern + legacy | 同时服务新版 server 与现存 Claude/Codex/Cursor 配置中的旧 server |
| TypeScript SDK | `@modelcontextprotocol/client@2.x`，锁文件固定实际版本 | v2 是 `2026-07-28` 的稳定实现；不要用旧的单包 `@modelcontextprotocol/sdk` 作为新实现基础 |
| Node 基线 | Node.js `>=20` | 官方 client v2 的 engine 要求；包安装检查应给出明确错误 |
| 版本探测 | 长驻 Pi extension 默认 `mode: "auto"`；允许按实例 pin modern/legacy | SDK 默认是 legacy；不显式 auto 就不会优先使用新版协议 |
| 探测缓存 | 缓存 era/discover verdict，但配置、command、URL 或认证 issuer 改变时失效 | 减少 HTTP round trip；stdio auto 探测会启动 disposable sibling process，缓存可避免重复探测 |

SDK v2 将 client/server 拆为独立包；client 包导出 Streamable HTTP、OAuth helpers，stdio transport 从 `@modelcontextprotocol/client/stdio` 导入，且 `package.json` 要求 Node `>=20`。[SDK v2 README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md)；[client v2 package.json](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/package.json)

官方 SDK 把 `2024-10-07` 至 `2025-11-25` 归为 legacy，把 `2026-07-28` 归为 modern。`mode: "auto"` 先探测 modern，再回退 legacy；stdio 探测使用一个短命 sibling process，避免某些 server 因收到 `initialize` 前的未知方法而退出。Pi 是长驻 host，不是 spawn-per-invocation CLI，因此 auto 合理，但管理面板应能显示 `probing / modern / legacy / pinned`，并允许针对有问题的 server 固定时代。[SDK 协议版本指南](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)

## 协议时代兼容矩阵

| 维度 | Modern：`2026-07-28` | Legacy：`2025-11-25` 及更早 | Pi 决策 |
| --- | --- | --- | --- |
| 初始化/协商 | 无 `initialize`；可先 `server/discover`，每请求声明版本与 client capabilities | `initialize` → result → `notifications/initialized` | SDK v2 auto 探测；存储最终 era、版本与 capability snapshot |
| 状态模型 | 协议无状态、无 session；跨请求状态必须使用显式 handle | capability/version 通常绑定连接或 HTTP session | 内部业务模型始终按显式实例与 handle，不把连接当 conversation |
| HTTP | 每条消息独立 POST；响应为 JSON 或 request-scoped SSE；无 GET/DELETE/session ID | Streamable HTTP 可有 session ID、GET stream、DELETE；更老 server 可能仅 HTTP+SSE | modern 主路径；SDK 处理旧 Streamable HTTP；HTTP+SSE 仅 fallback |
| server → client 交互 | 通过 `InputRequiredResult` + retry（MRTR） | server 可发 JSON-RPC request | 统一注册 handler，由 adapter 隐藏 delivery 差异 |
| 变更通知 | 显式 `subscriptions/listen` 长流 | unsolicited list/resource notifications，或旧 resource subscribe | 统一转为内部 subscription event；断线后按 era 重建 |
| 取消 | HTTP 关闭该请求 SSE；stdio 发 `notifications/cancelled` | 通常发 `notifications/cancelled` | 将 Pi 的 AbortSignal/用户取消映射给 SDK/transport |
| 日志级别 | request `_meta.io.modelcontextprotocol/logLevel`；logging 已 deprecated | `logging/setLevel` session 级 | 只做兼容和诊断，不作为新产品能力 |
| 结果判别 | `resultType` 必填：`complete` / `input_required` / negotiated extension value | 没有 `resultType` | 缺失时按 `complete`；未知且未协商的值判协议错误 |
| 重连 | 不恢复协议 session；重建 subscriptions；显式 handle 可继续 | 需重新 initialize/session；旧 SSE 可能有 era-specific resume | 自动重连连接层，但不盲目重放可能有副作用的 tool call |

Modern/legacy 的区别和回退条件由版本规范与 transport binding 明确定义；新版移除了 `initialize`、协议 session、HTTP GET、SSE resumability，并把 server-initiated requests 改成 MRTR。[版本与兼容性](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)；[2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)；[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

## 能力与交付优先级矩阵

这里的 “P0 / P1 / P2” 是 Pi 产品优先级，不改变协议本身的 MUST/SHOULD/MAY。

| 能力 | 协议地位 | Pi 优先级 | 必须形成的体验/行为 |
| --- | --- | --- | --- |
| JSON-RPC request/result/error/notification | 所有实现 MUST | P0 | 并发 request ID 唯一；response 关联；notification 不回包；拒绝 malformed/未知 result type |
| per-request version/capabilities + `server/discover` | modern core | P0 | 自动选择共同版本；保留 capability snapshot 和 server instructions；不信任自报 identity |
| stdio | 标准 transport，client SHOULD 支持 | P0 | 启动子进程、区分 stdout protocol/stderr log、取消、EOF shutdown、超时升级终止、异常重启 |
| Streamable HTTP | 标准 transport | P0 | POST + JSON/SSE、required headers、OAuth、request-scoped stream、关闭流取消 |
| legacy Streamable HTTP / HTTP+SSE | 兼容 / HTTP+SSE deprecated | P1，但发布前应有互操作测试 | 先 modern/Streamable HTTP，识别非-modern 错误后回退；不把旧 transport 暴露成默认推荐 |
| tools list/call | negotiated server capability | P0 | 模型可调用；稳定来源前缀消歧；输入审批；structured/unstructured 输出；`isError` 回馈模型 |
| resources list/templates/read | negotiated server capability | P0 | 用户浏览并按需加入 context；text/blob、URI template、resource link、embedded resource、更新订阅 |
| prompts list/get | negotiated server capability | P0 | 作为用户主动选择的模板/命令，不自动执行；支持参数与富内容 |
| pagination | list operations core utility | P0 | opaque cursor、空字符串仍是有效 cursor、页数上限与错误可见 |
| cache hints | modern core utility | P0 | `ttlMs` + `cacheScope`；private cache 按认证上下文隔离；通知即时失效 |
| progress | optional message pattern | P0 | 唯一 progress token；单调更新；节流；可延长软超时但不能突破 absolute timeout |
| cancellation + timeout | core pattern / transport binding | P0 | 用户取消立即可见；HTTP close stream，stdio notification；竞态与迟到响应安全忽略 |
| subscriptions/listen | modern core pattern | P0 | 订阅确认、honored filter、subscriptionId demux、意外断流重连、graceful close 不重连 |
| MRTR / `input_required` | modern core pattern | P0 | 支持多 input request；全新 JSON-RPC id 重试；原样回传 opaque `requestState`；轮数上限 |
| elicitation form + URL | negotiated client capability | P0 | 明示请求 server；表单 review/edit/decline/cancel；URL 显示域名并经用户同意后打开 |
| completion | negotiated server capability | P0 | prompt/resource-template 参数输入时 debounce 并展示最多 100 个建议 |
| OAuth authorization-code | HTTP auth optional，但远程完整体验必需 | P0 | discovery、PKCE、state、issuer、resource indicator、refresh、step-up、secure storage、重新连接 |
| static bearer token | SDK auth provider 能力 | P0 | 从安全存储/外部 provider 读取，不写日志或面板明文；401 给出可操作状态 |
| client credentials / private-key JWT | 官方 auth extension | P1 | 无人值守场景；明确与用户授权流区分；扩展能力显式 opt-in |
| enterprise-managed authorization | 官方 auth extension | P2 | 仅组织策略明确要求时启用；独立 IdP/ID-JAG 状态机 |
| roots | deprecated core feature | P1 compatibility only | 只对 legacy/明确请求提供；说明它是 advisory，不是 filesystem sandbox |
| sampling（含 tools） | deprecated core feature | P1 compatibility only | 仅兼容；人工审批、模型/费用策略和循环上限；新 server 不推荐 |
| logging | deprecated core feature | P1 compatibility only | stderr/OpenTelemetry 为新路径；协议日志仅诊断且必须脱敏/限流 |
| Tasks | 独立 extension，当前实现状态仍快速变化 | P2 feature flag | 持久化 task ID、poll interval、input_required/update、cooperative cancel、terminal states |
| MCP Apps | 独立 extension | 独立产品 seam | 只有具备 sandboxed iframe/App Bridge、安全 permission/CSP 的 renderer 才可宣告；纯 TUI 不宣告 |
| custom transport | 可选 | 扩展 seam | core 不实现具体额外 transport；保留 transport factory 接口 |

Core 明确要求所有实现支持基础协议、版本与消息模式，其他能力按需协商；extensions 始终默认关闭并显式 opt-in。[基础协议](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)；[Extensions negotiation](https://modelcontextprotocol.io/extensions/overview#negotiation)

## Transport 要求

### stdio

stdio server 由 client 启动，消息为 UTF-8、每行一个 JSON-RPC frame，frame 内不得嵌入换行；server 的 stdout 只能写 MCP 消息，stderr 可用于任意日志，client 不应把 stderr 有输出等同于失败。关闭顺序应是关 stdin、等待退出、超时后升级为平台终止机制；异常退出后可以重启，但 subscriptions 必须重新建立。[stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

Pi 生命周期管理器应：

- 使用 argv 数组启动命令，不经过 shell 拼接；环境变量按实例隔离，日志中只展示键名和脱敏值。
- 捕获有界 stderr ring buffer 供 `/mcp` 诊断；stdout 仅交给 SDK parser。
- 使用指数退避 + jitter 重启 crashed process，设置熔断；用户手动 `Restart` 清除熔断。
- transport 恢复后重新 discovery/list/subscription；**不自动重放 `tools/call`**。进程可能在响应丢失前已经完成副作用，自动重放会重复操作；是否重试必须由用户或更高层幂等策略决定。

### Streamable HTTP

当前 binding 要求单一 MCP endpoint 接收 POST；client 的 `Accept` 同时包含 `application/json` 与 `text/event-stream`，并同时支持单 JSON response 和 request-scoped SSE。每次 POST 都要带 `MCP-Protocol-Version`、`Mcp-Method`，对 `tools/call`、`resources/read`、`prompts/get` 还要带 `Mcp-Name`；`x-mcp-header` 标记的 tool primitive 参数必须镜像为 `Mcp-Param-*`，且 header/body 不一致是 `-32020 HeaderMismatch`。这些 2026 细节应交给官方 v2 transport，不应自行拼 HTTP。[Streamable HTTP request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata)；[Tool `x-mcp-header`](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header)

Modern HTTP 没有 GET notification stream、`Mcp-Session-Id`、DELETE termination 或 `Last-Event-ID` resume；request SSE 断开会丢失该次 in-flight response，重新请求必须使用新 request ID。旧版兼容仍由 SDK era adapter 处理。[Streamable HTTP backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility)

## Capability negotiation 与 server catalog

Modern request 的 `_meta` 必须包含 `io.modelcontextprotocol/protocolVersion` 和 `io.modelcontextprotocol/clientCapabilities`，并应携带 `clientInfo`；server 不能依赖未声明能力，缺能力时应返回 `-32021 MissingRequiredClientCapability`。`server/discover` 返回支持版本、server capabilities、可选 instructions 和 serverInfo，并带 cache hints；serverInfo 是自报信息，只能展示/调试，不能用于权限或唯一性判断。[`_meta` per-request fields](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)；[`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)

Pi 应把 capability 分成三层：

- **Server advertised**：`tools`、`resources`、`prompts`、`completions`、deprecated `logging`、extensions。
- **Host implemented**：Pi 当前能兑现的 elicitation modes、deprecated sampling/roots、extensions。
- **Policy enabled**：用户在该 Agent / config / server 实例上允许暴露给模型或 UI 的子集。

发送给 server 的 client capabilities 是 “implemented ∩ policy-enabled”，不能把“代码里可能支持”当作“当前请求可支持”。同一 server 的工具、资源、prompt 列表可以随授权身份变化，因此 catalog/cache identity 必须至少包含完整配置实例和认证上下文，不能按 URL 或 server name 跨 Agent 合并。

## Server primitives 与内容映射

### Tools

Tools 是 model-controlled primitive，但规范仍建议始终保留用户拒绝调用的能力、清楚展示暴露给模型的 tools，并在调用时显示输入。工具定义包括 `name`、description、JSON Schema `inputSchema`、可选 `outputSchema`、icons 和 annotations；annotations 来自 server，必须视为不可信。跨 server 聚合时会自然发生同名冲突，且 serverInfo name 不唯一，因此 Pi 注册给模型的名称必须由稳定实例 ID 消歧，而 `/mcp` 继续显示原始 Agent / scope / server / tool 名。[Tools 与 HITL](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#user-interaction-model)；[Tool 数据与名称](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)

Tool result 有两条错误通道：未知 tool、malformed request、server failure 是 JSON-RPC protocol error；可由模型调整参数恢复的 input/business/API failure 应是正常 result 加 `isError: true`，且应该回馈模型以便自我修正。Pi 不能把两者都折叠成 throw 或都折叠成普通文本。[Tool error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)

### Resources

完整 client 要支持 `resources/list`、`resources/templates/list`、`resources/read`，以及由 `subscriptions/listen` 传来的 list/update notification。Resource content 可以是 text 或 base64 blob；resource link 不保证出现在 list 中；annotations 提供 audience、priority、lastModified，但只是提示。对 `file://`、自定义 scheme 或 binary content 应设置 URI、大小和 MIME 上限；不要因为看到 `https://` resource link 就携带 MCP token 自动抓取。[Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)

### Prompts

Prompts 是 user-controlled primitive：应出现在明确的用户选择入口，而不是模型自动执行。`prompts/list` + `prompts/get` 支持参数、MRTR 与 rich content；返回内容与 server instructions 一样属于不可信输入，注入 LLM context 时必须带来源边界。[Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)

### ContentBlock

Active core 的通用 `ContentBlock` 包含：

- `text`
- base64 `image` + MIME
- base64 `audio` + MIME
- `resource_link`
- embedded `resource`（text 或 blob）

这些 block 都可带 annotations / `_meta`；tool 还可返回任意 JSON 值的 `structuredContent`，有 `outputSchema` 时 client 应验证。Sampling 专用的 `tool_use` / `tool_result` 不属于 active core 通用 ContentBlock，并随 sampling 被 deprecated。Pi 的 adapter 应保留原始结构化值，不先串成文本；实际模型不支持某种 modality 时，明确降级为 attachment/metadata 或可读提示，不静默丢弃。[官方 schema `ContentBlock`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts#L2305)；[Tool structured content](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content)

Icons 并非必须渲染；若 `/mcp` 渲染，规范要求把 URI/bytes 当不可信输入，只允许安全 scheme、同源优先、无 cookie/Authorization fetch、限制大小并核验 MIME/magic bytes。终端第一版可以只显示文本 metadata，避免引入图片解析攻击面。[Icons security](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#icons)

## JSON Schema、pagination 与 caching

MCP 未声明 `$schema` 时默认 JSON Schema 2020-12，双方至少必须支持该 dialect。客户端不得默认联网解析 `$ref`；若提供 opt-in，也要 host allowlist、阻断 loopback/private/link-local、限制时间/大小/深度。官方 v2 client 已内建 runtime validator，Pi 不应另写一个宽松 validator 绕过它。[JSON Schema usage](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#json-schema-usage)

`tools/list`、`resources/list`、`resources/templates/list`、`prompts/list` 使用 opaque cursor；空字符串也是有效 cursor，不能用 truthy 判断。SDK v2 的 typed list helpers 默认自动走完所有页并以 64 页为上限；Pi 应保留上限，遇到异常 pagination 显示明确错误，而不是无限循环。[Pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)；[SDK client calling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/calling.md)

Modern server 对 `server/discover`、各种 list、`resources/read` 的 complete result 必须给出 `ttlMs` 与 `cacheScope`。`private` 响应不得跨 authorization context 复用，notification 会立即使对应 cache stale，MRTR retry 结果不得缓存。最安全的默认是每个 MCP 实例使用独立 SDK in-memory cache；只有确需共享/持久化时才加入稳定的 `instanceId + issuer + subject/token identity` partition。[Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)；[SDK cache guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/caching.md)

## MRTR、elicitation 与交互生命周期

Modern server 不再主动发 JSON-RPC request。只有 `tools/call`、`resources/read`、`prompts/get` 可以返回 `resultType: "input_required"`；其中 `inputRequests` 是 keyed map，可同时要求 elicitation、sampling 或 roots，`requestState` 是 server opaque string。Client 必须完成自己已宣告支持的 input、用全新 JSON-RPC id 重试原请求、原样回传 `requestState`，且不得解析或复用到其他并行请求。[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)

Pi 需要独立的 `InteractionBroker`，把 protocol request 暂停与 TUI/用户/模型交互解耦：

- form elicitation：从受限 schema 生成表单，允许 review/edit/accept/decline/cancel；严禁用 form 索取密码、API key、token 或支付凭据。
- URL elicitation：先显示请求 server、完整目标 host 与说明，经用户同意才导航；它用于 server 与第三方的敏感交互，不是 MCP client 对 server 的 OAuth。
- 为自动 MRTR 设置轮数上限（SDK v2 默认 10），超限转为可诊断错误；同一 round 的多个 input 可并行呈现，但每项回应仍按 key 对应。
- 非交互模式或 UI 不可用时，不宣告 elicitation；不能假装用户接受。

以上安全与 action 语义来自 elicitation 规范；URL accept 只表示用户同意导航，不表示外部流程已经完成，客户端应提供 retry/cancel 控制。[Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)；[SDK server-request handling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/server-requests.md)

## Notifications、progress、cancellation

Modern notification 分两路：progress/deprecated log message 只在所关联 request 的 response stream；list/resource change 只在显式 `subscriptions/listen` stream。订阅第一条消息必须是 acknowledgment，后续消息用 `_meta.io.modelcontextprotocol/subscriptionId` demux；server 只可发送 client 请求 filter 的类型。意外断流可退避后重建，收到 graceful complete 或本地 close 则不应重连；SDK 不会替应用自动 re-listen。[Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)；[SDK subscriptions guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/subscriptions.md)

Progress 只有请求提供唯一 active `progressToken` 后 server 才可发送；数值必须单调增加，total 可缺省。客户端可以用 progress 重置软 timeout，但始终要有 absolute maximum，并对 notification 限流。[Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)

所有请求都应有可配置 timeout。超时后 client 停止等待并发出 transport-specific cancellation；HTTP 是关闭 request SSE，stdio 是 `notifications/cancelled`。取消存在竞态：迟到 response 要忽略；server 可因已完成/不可取消而忽略取消。`subscriptions/listen` 的 server graceful teardown 是唯一允许的 server cancellation 特例。[Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)

## Authorization 状态机

Authorization 对 MCP 整体是 optional，但 HTTP 实现一旦支持就应遵循 MCP OAuth；stdio 不走该 OAuth 协议，而是从进程环境获取凭证。完整远程 client 的 core OAuth 状态机应是：未认证请求 → 401 `WWW-Authenticate` → RFC 9728 protected-resource metadata → RFC 8414/OIDC authorization-server metadata → 选择 client registration → PKCE authorization code + browser handoff → callback 校验 state/issuer → token exchange（authorization 和 token request 都含 RFC 8707 `resource`）→ bearer request → refresh/step-up。[MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)；[Authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)

必须实现的安全边界：

- PKCE 且确认 authorization server metadata 声明支持；能用时采用 `S256`。
- callback 的 `state` 由 Pi 自己校验；`iss` 存在时按 RFC 9207 与发起时记录 issuer 精确比较。
- access/refresh token 使用 OS keychain 或等价 secret store，不写普通 JSON、日志、错误详情或对话上下文。
- client registration credentials 按 authorization server issuer 绑定；issuer 变化不得复用。实例隔离键至少包含 Agent/source/config/server/resource/issuer/principal。
- token 只能通过 `Authorization: Bearer` header 发送，不能放 query；必须绑定目标 MCP resource，禁止 token passthrough。
- scope 初次取 challenge 的权威 scope，否则取 protected-resource metadata；403 `insufficient_scope` 走 step-up，而不是当连接失败或协议时代证据。

这些均是当前规范要求；Dynamic Client Registration 在 `2026-07-28` 已 deprecated，优先级应为 pre-registered credentials → Client ID Metadata Document → DCR fallback → 用户手填，而不是默认大量动态注册。[Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)；[Authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)；[Deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)

SDK v2 的 `OAuthClientProvider` 负责 registration、tokens、PKCE verifier、discovery state 和 redirect；首次 connect 需要用户授权时抛 `UnauthorizedError`，callback 后调用 `finishAuth(params)`，然后必须用 fresh transport reconnect。SDK 不替 host 校验 `state`，所以这是 Pi 自己不可省略的责任。[SDK OAuth guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md)

无人值守的 client credentials / private-key JWT 和 enterprise-managed authorization 都是独立官方 auth extension；TypeScript SDK v2 已提供 `ClientCredentialsProvider`、`PrivateKeyJwtProvider`、`CrossAppAccessProvider`，但只有明确配置对应流程时才宣告 extension，不能把它们混成普通用户 OAuth。[SDK machine auth guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md)；[OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)；[Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)

## 错误模型与可观测性

Pi 内部不要用一个 `Error` 状态吞掉所有失败，应至少保留：

| 类别 | 例子 | 面板/调用行为 |
| --- | --- | --- |
| MCP protocol error | `-32601`、`-32602`、`-32603`、`-32020`、`-32021`、`-32022` | 展示 method/code/message/safe data；按 version/capability/header 给修复动作 |
| Tool execution error | `result.isError: true` | 保留为工具结果交给模型和用户，不等同 transport failure |
| HTTP auth error | 401、403 insufficient scope、issuer mismatch | 进入 `auth_required` / `reauthorize`，永不打印 token 或 attacker-controlled callback detail |
| SDK/local error | timeout、connection closed、pagination exceeded、era negotiation failed | 明确标成 local；可重连/改 pin/增 timeout，不伪装成 server JSON-RPC code |
| Transport/process error | spawn ENOENT、exit code、malformed stdout、network/TLS/SSE drop | 展示脱敏 stderr tail 和 retry state；保留原 cause chain |
| Cancelled/uncertain outcome | 用户取消、断流时 tool 可能已执行 | 不自动重放；告诉用户结果未知并提供显式重试 |

JSON-RPC 标准错误为 `-32700`、`-32600` 至 `-32603`；MCP 当前分配 `-32020 HeaderMismatch`、`-32021 MissingRequiredClientCapability`、`-32022 UnsupportedProtocolVersion`，还应接受 legacy `-32002` resource-not-found。Local timeout 等没有 MCP wire code，不能伪造成 peer error。[MCP error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)

日志应带稳定 `instanceId`、Agent/source/scope、server entry、era/version、transport、method、duration、request correlation、retry count；参数、content、headers、env、OAuth callback 和 token 默认不记录。OpenTelemetry trace context 可通过 `_meta` 传播；deprecated MCP logging 只作兼容，stdio 原生日志来自 stderr。[`_meta` trace context](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)；[Deprecated logging](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging)

## 建议的内部模块边界

协议研究导出的最低模块边界如下，具体文件组织由后续设计票决定：

1. `ServerRegistry`：保存带 provenance 的独立 server instance；绝不按 server name 跨 Agent 去重。
2. `ClientRuntime`：每实例一个 SDK Client + transport + era/version/capability snapshot + lifecycle state。
3. `TransportFactory`：stdio、Streamable HTTP、legacy SSE fallback；隐藏时代差异。
4. `AuthBroker`：OAuth discovery/redirect/callback/token refresh/step-up，与 OS secret store 对接。
5. `InteractionBroker`：tool approval、elicitation、deprecated sampling/roots、MRTR round orchestration。
6. `PrimitiveCatalog`：tools/resources/prompts/completion 的分页、cache、subscription invalidation 与稳定命名。
7. `ContentAdapter`：完整保留 MCP content/structured data，再按 Pi/model modality 做显式降级。
8. `PolicyEngine`：实现能力与用户策略求交，决定 advertise、模型可见性、调用审批和资源注入。
9. `Diagnostics`：typed error、脱敏 log、stderr ring、连接 timeline、用户可执行恢复动作。

推荐 runtime 状态至少包含：

```text
discovered -> probing/connect -> auth_required -> ready
                        |             |           |
                        v             v           v
                      failed       disabled    reconnecting
                                                   |
                                                   v
                                                 ready

ready -> closing -> closed
```

Modern “ready” 只表示 transport 可用且已有当前 discovery/capability view，不代表存在协议 session。`subscriptions/listen`、in-flight requests、OAuth credential 和 explicit application handles 都有各自独立生命周期。

## 发布前协议验收清单

- modern `2026-07-28` + legacy `2025-11-25` 的 stdio 与 Streamable HTTP 互操作矩阵。
- legacy HTTP+SSE fallback 只在响应不是 recognized modern error 时触发。
- auto negotiation、modern pin、legacy pin；stdio silent/exit-on-probe server；探测缓存失效。
- tools/resources/prompts 有能力、无能力、空列表、多页、invalid cursor、list change、private cache partition。
- text/image/audio/resource link/embedded resource/structuredContent；oversize、bad MIME、invalid output schema。
- tool `isError` 与 JSON-RPC error 分流；legacy `-32002`；modern `-32020/-32021/-32022`。
- MRTR 多 request、opaque state、不同 retry id、decline/cancel、round limit、并行请求隔离。
- progress flood、soft timeout reset、absolute timeout；HTTP/stdio cancellation 与迟到 response。
- subscription ack/honored filter/demux、多订阅、remote drop 重连、graceful close 不重连。
- OAuth 401 discovery、PKCE、state mismatch、issuer mismatch、resource binding、refresh、403 step-up、issuer 变更、token store 隔离。
- stdio malformed stdout、stderr flood、spawn failure、crash/restart/backoff、shutdown escalation。
- 同名 server/tool 跨 Agent 配置保持独立，模型调用名稳定且 `/mcp` 能反查完整来源。
- capability advertisement 与实际 handler/policy 一致；未实现 Tasks/Apps 时完全不宣告。

## 最终建议

后续规格与实现应以“**active core 全覆盖 + dual-era compatibility + extension opt-in**”为验收定义。最关键的不可逆架构决策不是 TUI 长什么样，而是：采用 SDK v2、一个 resolved server entry 对应一个独立 client runtime、modern 无状态模型为内部真相、所有 client capability 均由实际 handler 与 policy 动态求交、OAuth/cache/日志严格按实例和身份隔离。这样 `/mcp` 才能在不把各 Agent 配置搅在一起的前提下，既连接今天仍大量存在的 legacy server，又不把新实现锁死在已被 `2026-07-28` 淘汰的 session 生命周期上。
