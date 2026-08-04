# Pi MCP：各 Agent 配置来源、作用域与稳定身份研究

> 对应研究票：[Async23/pi-packages#3](https://github.com/Async23/pi-packages/issues/3)
>
> 研究时间：2026-08-04
>
> 证据范围：厂商官方文档、官方 schema 与官方源码；未读取本机 Agent 配置值、凭据文件或系统钥匙串。

## 结论

Pi 的 MCP extension 不应把扫描到的 server 压成一个同名列表。正确模型是：

1. **先保留来源条目**：每条配置按 `Agent / host / scope / config file / entry / server` 建立身份。
2. **再计算生效实例**：针对当前项目上下文，按该 Agent 自己的覆盖规则生成 effective view，并保留完整 `originChain`。
3. **跨 Agent 永不去重**：Claude Code、Codex、Cursor 中即使 server 名与 URL 相同，也仍是三个独立实例。
4. **发现默认只读**：解析配置形状，但不解析 secret indirection、不启动 server、不触发 OAuth，也不修改外部配置。
5. **Pi 独立鉴权**：其他客户端保存的 OAuth token、input secret 或钥匙串内容不能安全复用。

建议 `/mcp` 默认按来源展示：

```text
Claude Code
  project · <repo>/.mcp.json
    github                 active
  user · ~/.claude.json
    github                 shadowed by project

Codex
  project · <repo>/.codex/config.toml
    github                 active · merged from 2 origins
  user · ~/.codex/config.toml
    github                 contributes fields
```

另提供“当前项目生效视图”。这样既是管理面板，也能清楚看出“各 Agent 配置的 MCP”，不会把来源搅在一起。

## 边界与术语

- **来源条目（source entry）**：某个物理或虚拟配置来源中的一条 server 定义。
- **生效实例（effective instance）**：某 Agent 在指定 host、project、profile 上下文中最终使用的 server 定义。
- **静态可发现**：Pi 能在不执行命令、不登录、不读取 secret store 的前提下确定配置形状。
- **动态来源**：插件 API、云端 connector、组织 registry、运行时参数等没有稳定本地文件。
- 路径中的 `~` 表示对应运行 host 的 home；本机、WSL、SSH、dev container 必须视为不同 host。

## 来源与格式盘点

### Claude Code

| scope | 来源 |
|---|---|
| local | `~/.claude.json` 的 `projects[projectPath].mcpServers` |
| project | 项目根目录 `.mcp.json` |
| user | `~/.claude.json` 顶层 `mcpServers` |
| plugin | plugin 根目录 `.mcp.json` 或 `plugin.json` 内联定义 |
| managed | macOS `/Library/Application Support/ClaudeCode/managed-mcp.json`；Linux/WSL `/etc/claude-code/managed-mcp.json`；Windows `C:\Program Files\ClaudeCode\managed-mcp.json` |
| cloud connector | Claude 账户/组织配置，无稳定本地文件 |

local、project、user 的路径与 schema 见 [Claude Code MCP 官方文档](https://code.claude.com/docs/en/mcp)；managed 文件存在时只加载 managed server，平台路径与 allow/deny policy 见 [Managed MCP configuration](https://code.claude.com/docs/en/managed-mcp)。

- 根为 `mcpServers`。stdio 使用 `command/args/env`；remote 使用 `type = http|streamable-http|sse`、`url/headers`，并可有 OAuth/client 控制字段。
- 字符串支持 `${VAR}` 与 `${VAR:-default}`；发现时只保留表达式。
- 同名优先级为 `local > project > user > plugin > claude.ai connector`。[Claude Code MCP 官方文档](https://code.claude.com/docs/en/mcp)
- OAuth 凭据在 Claude Code 自己的钥匙串或凭据存储，不属于 MCP 配置文件。

`~/.claude.json` 同时承载 user 与多个 local scope，所以 `config file + server name` 仍不唯一；身份必须加入 JSON Pointer。

### Claude Desktop

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`
- Linux discovery 候选：`~/.config/Claude/claude_desktop_config.json`

本地文件根为 `mcpServers`，官方教程用它配置本机 stdio server。[MCP 官方 Claude Desktop 本地 server 教程](https://modelcontextprotocol.io/docs/develop/connect-local-servers) 三平台路径也见微软官方 native discovery 源码 [nativeMcpDiscoveryAdapters.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/mcp/common/discovery/nativeMcpDiscoveryAdapters.ts)。

远程 custom connector 由 Claude 产品 UI/云端管理，不应推断为该 JSON 的内容。[Anthropic remote MCP connector 文档](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers) 因此应分成 `claude-desktop-local` 与不可本地枚举的 `claude-cloud-connectors`。

### Codex

配置层从高到低为：

1. CLI flags 与 `--config`；
2. 从项目根到当前目录的 `.codex/config.toml`，越近越高，仅可信项目加载；
3. `--profile name` 选择的 `~/.codex/name.config.toml`；
4. `~/.codex/config.toml`；
5. Unix `/etc/codex/config.toml`；
6. 内置默认值。

层级及 CLI/IDE 共用关系见 [Codex Config basics](https://developers.openai.com/codex/config-basic/)。

- MCP table 是 `[mcp_servers.<server-id>]`。
- stdio 主要字段：`command/args/env/env_vars/cwd`。
- streamable HTTP 主要字段：`url/bearer_token_env_var/http_headers/env_http_headers`。
- 控制字段包括 `enabled/required/enabled_tools/disabled_tools`、timeouts、OAuth scopes/resource 与 server/tool approval mode。[Codex Configuration Reference](https://developers.openai.com/codex/config-reference/) [Codex MCP 文档](https://developers.openai.com/codex/mcp/)

Codex 的关键差异是 **TOML table 递归深合并**：同名 `mcp_servers.foo` 可由多个层逐字段共同组成，而非整条替换。官方实现见 [merge.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/merge.rs) 与 [loader/mod.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs)。

所以 UI 不能只标一个 winner file；必须显示 `originChain`，最好能展开字段来源。`enabled = false` 可能来自高层，而 command/url 来自低层。

Codex 不对任意字符串做通用 `${VAR}` 展开；环境引用通过 `env_vars`、`bearer_token_env_var`、`env_http_headers` 等类型化字段表达。静态 `env/http_headers` 仍可能直接含 secret，值必须遮蔽。[Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)

### Cursor

- global：`~/.cursor/mcp.json`
- project：项目根目录 `.cursor/mcp.json`
- Cursor Agent CLI 自动使用同一配置。[Cursor MCP 文档](https://docs.cursor.com/context/model-context-protocol) [Cursor CLI 文档](https://docs.cursor.com/en/cli/using)

根为 `mcpServers`；stdio 使用 `command/args/env`，remote 使用 `url/headers`，支持 stdio、SSE、streamable HTTP 与 OAuth。[Cursor MCP 文档](https://docs.cursor.com/context/model-context-protocol)

官方文档没有完整、稳定地说明 global/project 同名 server 的覆盖算法，也未公开完整 schema。首版应分别保留两条 origin，并把 effective resolution 标为 `unknown-precedence`，不要猜 winner。VS Code 官方 discovery 源码也把 Cursor global/workspace 当成独立 origin。[mcpConfiguration.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/mcp/common/mcpConfiguration.ts) [workspaceMcpDiscoveryAdapter.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/mcp/common/discovery/workspaceMcpDiscoveryAdapter.ts)

### Gemini CLI

主要静态层从低到高为 built-in、system defaults、user、project、system override、environment、CLI：

| scope | Linux | macOS | Windows |
|---|---|---|---|
| system defaults | `/etc/gemini-cli/system-defaults.json` | `/Library/Application Support/GeminiCli/system-defaults.json` | `C:\ProgramData\gemini-cli\system-defaults.json` |
| user | `~/.gemini/settings.json` | 同左 | 同左 |
| project | `<project>/.gemini/settings.json` | 同左 | 同左 |
| system override | `/etc/gemini-cli/settings.json` | `/Library/Application Support/GeminiCli/settings.json` | `C:\ProgramData\gemini-cli\settings.json` |

路径、override path 与“不信任项目时忽略 project settings”见 [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)。

- 根为 `mcpServers`。
- stdio 使用 `command/args/env/cwd`；remote 使用 `url` 或 `httpUrl`、`headers`。
- 支持 stdio、SSE、HTTP、OAuth、timeout、trust、include/exclude tools 与 auth provider metadata。[Gemini MCP 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) [settings.schema.json](https://github.com/google-gemini/gemini-cli/blob/main/schemas/settings.schema.json)
- `mcpServers` 使用 `SHALLOW_MERGE`：不同名累加，同名由高层整条覆盖。[settingsSchema.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settingsSchema.ts#L159-L173) [settings.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts#L253-L279)
- extension 可在 `~/.gemini/extensions/<name>/gemini-extension.json` 声明 server，settings 中同名定义优先；它应是独立 `extension` scope。[Gemini extension reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md)
- 字符串支持 `$VAR`、`${VAR}`、`${VAR:-DEFAULT}`。`~/.gemini/mcp-server-enablement.json` 是 policy overlay，不是第二条 server 来源。[Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md) [Gemini MCP 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

### Visual Studio Code / GitHub Copilot

来源包括：

- workspace：`.vscode/mcp.json`
- user：当前 VS Code **Profile** 的 `mcp.json`
- remote user：SSH/dev container 等 remote host 的对应 profile
- extension、gallery、native discovery：可能是动态/外部来源

workspace、user profile 与 remote locality 见 [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)。profile 与 remote authority 会改变身份，因此 Pi 不应硬编码成一个“全局 VS Code 文件”；可用 `vscode-profile://<host>/<profile>/mcp.json` 作为虚拟 locator。

根为 `servers`，不是 `mcpServers`，还可有 `inputs` 与 `sandbox`：

- stdio：`type/command/args/cwd/env/envFile`
- HTTP/SSE：`type/url/headers/oauth`
- 变量：`${workspaceFolder}`、`${input:id}` 等

完整字段见 [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)。

`inputs` 值与 OAuth 会话由 VS Code 安全存储；Pi 发现时不能触发 input prompt 或复用保存值。官方文档没有明确承诺 workspace/user 同名 server 的完整碰撞语义，因此 source view 高置信、effective resolution 中置信。

### Devin CLI

v3000.3 及之后：

- user：`~/.config/devin/mcp_config.json`；Windows `%APPDATA%\devin\mcp_config.json`
- project：`.devin/mcp_config.json`
- project local：`.devin/mcp_config.local.json`，默认 gitignored

旧版把 `mcpServers` 放在对应 `config.json`，新版会迁移。旧路径只能作为带版本标记的兼容候选，不能与新路径同时算两份。[Devin MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)

- 优先级 `project local > project > user`；同名由高层 **整条覆盖**；嵌套项目中更近配置优先。[Devin precedence](https://docs.devin.ai/cli/reference/configuration/global-vs-local)
- stdio 使用 `command/args/env`；remote 使用 `url`、`transport = http|sse`、`headers` 与 OAuth client metadata。
- secret 可写成 `${env:VAR}` 或 `${file:/path}`；发现阶段绝不能主动读目标文件。
- 官方明确说明每个 MCP client 维护独立 OAuth session，Pi 必须单独登录。[Devin MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)

### Windsurf Legacy Cascade

当前官方文档明确把该配置标为 legacy Cascade；新 tab 使用 Devin Local/CLI 配置，二者必须是不同 `agentId`。

- 文件：`~/.codeium/windsurf/mcp_config.json`
- 根：`mcpServers`
- stdio：`command/args/env`
- remote：`serverUrl` 或 `url`、`headers`
- transport：stdio、streamable HTTP、SSE；支持 OAuth
- indirection：`${env:VAR_NAME}`、`${file:/path}`

路径、格式、插值与 legacy 边界见 [Windsurf / Cascade MCP 官方文档](https://docs.windsurf.com/windsurf/cascade/mcp)。团队 marketplace、allowlist 与组织 registry 是动态 policy source，不是该 JSON 的内容。

### Zed

- macOS user：`~/.zed/settings.json`
- Linux user：`~/.config/zed/settings.json`
- project：`.zed/settings.json`
- remote development：remote host 有独立 settings 上下文

settings 键为 `context_servers`；stdio 使用 `command/args/env`，remote 使用 `url/headers`，可发起标准 MCP OAuth。[Zed MCP](https://zed.dev/docs/ai/mcp) 路径见 [Zed configuring](https://zed.dev/docs/configuring-zed)，remote 边界见 [Zed remote development](https://zed.dev/docs/remote-development)。

不可信项目 settings 不应用；extension 也能动态贡献 context server。[Zed worktree trust](https://zed.dev/docs/worktree-trust) [Zed extension context servers](https://zed.dev/docs/extensions/context-servers) 官方页面未钉死 MCP 同名 user/project 的完整合并细节，故路径/schema 高置信、碰撞解析中置信。

### Kiro

- global：`~/.kiro/settings/mcp.json`
- workspace：`.kiro/settings/mcp.json`
- Kiro CLI Agent JSON 内的 `mcpServers`

同名 server 按 `Agent > Workspace > Global` 整条覆盖，不同名累加。[Kiro IDE MCP](https://kiro.dev/docs/mcp/configuration/) [Kiro CLI MCP](https://kiro.dev/docs/cli/mcp/configuration/)

根为 `mcpServers`；local 用 `command/args/env`，remote 用 `url/headers`，另有 `disabled/disabledTools`，支持 `${VAR}` 与 remote OAuth。[Kiro CLI MCP](https://kiro.dev/docs/cli/mcp/configuration/) Agent JSON 的 locator 取决于当前 Agent 选择，必须带 file path/Agent ID，不能折叠成 global。

### JetBrains Junie

- project：`.junie/mcp/mcp.json`
- user：`~/.junie/mcp/mcp.json`
- CLI 可通过一个或多个 `--mcp-location <path>` 增加运行时来源

根为 `mcpServers`；stdio 用 `command/args/env`，remote 用 `url/headers`，OAuth 由 Junie UI 流程完成。[Junie MCP configuration](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html)

Junie 的 `/mcp` 也按 installation scope 展示 server，为 Pi 提供了直接交互先例。官方页面未说明 user/project/custom location 同名碰撞顺序，所以静态来源高置信、effective precedence 中置信。

## 候选适配器

| Agent | 一手证据 | 暂缓原因 |
|---|---|---|
| Amazon Q Developer | 新版 IDE 使用 `~/.aws/amazonq/default.json` 与 `.amazonq/default.json`；legacy 可能使用对应 `mcp.json`；CLI custom agent 另有 Agent JSON。[AWS IDE MCP](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html) [AWS CLI MCP](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-config-CLI.html) | 新旧格式、IDE/CLI/custom agent 并存，需先做版本判定 |
| Cline CLI | 官方共享配置根中固定包含 `~/.cline/data/settings/cline_mcp_settings.json`，供 Cline IDE、CLI、SDK 共用。[Cline Config](https://github.com/cline/cline/blob/main/docs/getting-started/config.mdx) | 该路径可被 `CLINE_DATA_DIR` 改写；本轮未补齐 MCP schema、precedence 与旧版 IDE global storage 的迁移边界 |

Roo Code 等来源在本轮没有获得足以支撑稳定 discovery contract 的官方证据，不列入 adapter 清单。缺证据不等于“不支持 MCP”，只表示 Pi 不应猜路径和覆盖规则。

## 稳定来源身份

### SourceEntryKeyV1

```ts
type SourceEntryKeyV1 = {
  schemaVersion: 1
  agentId: string
  hostId: string
  scopeKind: string
  scopeAnchor: string | null
  configLocator: string
  entryPointer: string
  serverKey: string
}
```

| 字段 | 规则 |
|---|---|
| `agentId` | 稳定 adapter ID，例如 `claude-code`、`codex`、`cursor`、`windsurf-cascade-legacy`、`devin-cli` |
| `hostId` | 区分 local、WSL distro、SSH remote、dev container、IDE remote authority |
| `scopeKind` | `managed/system/user/profile/project/local/plugin/extension/agent/custom/dynamic` 等 adapter 枚举 |
| `scopeAnchor` | project canonical root、profile ID、plugin/extension ID、Agent file ID |
| `configLocator` | canonical absolute path 或稳定 virtual URI；不含配置内容 |
| `entryPointer` | JSON Pointer 或 TOML table path；解决同文件多 scope/entry |
| `serverKey` | 配置中原样、区分大小写的 key；不用 URL 或 command 替代 |

机器 ID：

```text
sourceId = "mcp-source:v1:" + base64url(sha256(canonical-json(SourceEntryKeyV1)))
```

完整 tuple 必须与 digest 一起保存。身份中禁止放 endpoint、header/env value、OAuth token 或内容 hash。

路径规范化：

1. `~` 按该 `hostId` 的 home 展开。
2. 已存在文件可记录 realpath；不存在候选只做词法绝对化。
3. 只在明确大小写不敏感的文件系统做 path case normalization。
4. rename、移动 config 或修改 server key 会产生新身份。
5. dynamic 来源用稳定 URI，如 `plugin://claude-code/<plugin-id>/mcp/<server>`，不能冒充本地路径。

用户可见标签使用：

```text
<Agent> / <scope> / <short config locator> / <server key>
```

### EffectiveInstanceV1

```ts
type EffectiveInstanceV1 = {
  agentId: string
  hostId: string
  contextId: string
  serverKey: string
  originChain: SourceEntryKeyV1[]
  resolution:
    | "whole-record-winner"
    | "deep-merged"
    | "policy-blocked"
    | "untrusted"
    | "unknown-precedence"
  status:
    | "active"
    | "disabled"
    | "shadowed"
    | "blocked"
    | "invalid"
    | "dynamic"
    | "not-discoverable"
}
```

`contextId` 至少包含 project root、profile/Agent selection 与 trust context。各 adapter 策略：

| Agent | 同名处理 |
|---|---|
| Claude Code | whole-record：local > project > user > plugin > connector |
| Codex | TOML deep merge；保留字段级 origins |
| Cursor | `unknown-precedence` |
| Gemini CLI | shallow merge；高层同名整条覆盖 |
| VS Code | source 可列出；完整碰撞语义待补证 |
| Devin CLI | project local > project > user，整条覆盖 |
| Windsurf Legacy | 当前仅一个官方本地文件 |
| Zed | MCP 同名精确行为待补证 |
| Kiro | Agent > Workspace > Global，整条覆盖 |
| Junie | user/project/custom location 顺序待补证 |

## 环境变量、认证与隐私

### 发现阶段不解析 secret

| 体系 | 只识别、不求值 |
|---|---|
| Claude Code | `${VAR}`、`${VAR:-default}` |
| Codex | `env_vars`、`bearer_token_env_var`、`env_http_headers` 中的变量名 |
| Gemini CLI | `$VAR`、`${VAR}`、`${VAR:-DEFAULT}` |
| VS Code | `${workspaceFolder}`、`${input:id}`、`envFile` |
| Devin / Windsurf | `${env:VAR}`、`${file:/path}` |
| Kiro | `${VAR}` |

特别是 `${file:/path}`、`envFile`、`${input:id}`：只能显示“存在引用”，不能为了 preview 读取文件、触发 prompt 或调用 secret store。

以下值在进入日志、telemetry、UI 前统一替换为 `<redacted>`：

- 所有 env 与 HTTP header value；
- OAuth client secret、bearer token 与 token store 内容；
- URL userinfo 与可能含敏感参数的 query；
- 被 adapter 标记为 secret-bearing 的 CLI args；
- 任何由环境、文件、input、keychain 求出的结果。

可以显示 env/header **名称**、参数数量、transport、command basename、脱敏 URL 摘要与变量引用名称。

### OAuth 由 Pi 独立完成

Devin 官方明确要求 Windsurf、Claude Code、Devin CLI 各自登录，[Devin MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)；Claude、Codex、Gemini、VS Code 也把 OAuth 状态保存在各自客户端的安全存储中。

Pi 可以导入非敏感连接形状，但不得扫描其他客户端 credential DB、复制 token、把另一个客户端的“已登录”视为 Pi 已登录，或在 discovery 时自动打开浏览器。

### 配置存在不等于允许执行

project config 能启动任意 stdio command。Claude Code、Codex、Gemini、Zed 都有明确 project trust 边界；Pi 可列出 untrusted source，但默认不启动，首次 enable/connect 仍需 Pi 自己授权。

## Adapter 接口建议

不要写“兼容所有 JSON”的通用 parser。每个 Agent adapter 实现同一接口：

```ts
interface AgentMcpAdapter {
  id: string
  discover(context): Promise<ConfigCandidate[]>
  parse(candidate): Promise<SourceEntry[]>
  resolve(entries, context): EffectiveInstance[]
  redact(entry): RedactedSourceEntry
  capabilities: {
    scopes: string[]
    mergeStrategy: "whole" | "deep" | "unknown"
    transports: string[]
    auth: string[]
    dynamicSources: boolean
  }
}
```

同样叫 `mcpServers` 仍有实质差异：Codex 是 TOML/deep merge，Gemini 是 JSON/shallow merge，VS Code 使用 `servers`，Claude 的一个文件还承载多个 project-local scope。OpenAI 自己的外部 Agent migration 也使用 source-specific adapter 和显式转换，并拒绝无法安全转换的表达式。[Codex MCP migration source](https://github.com/openai/codex/blob/main/codex-rs/external-agent-migration/src/mcp.rs)

## 支持与置信度矩阵

- **高**：官方文档/schema/source 足以实现路径、解析与关键语义。
- **中**：来源和基本 schema 明确，但碰撞、runtime location 或版本分支仍有缺口。
- **低**：云端/动态来源，或无稳定官方本地契约。

| Agent / source | 路径与 scope | schema / transport | precedence | auth / indirection | 建议 |
|---|---:|---:|---:|---:|---|
| Claude Code local/project/user/managed/plugin | 高 | 高 | 高 | 高 | Phase 1 |
| Claude Desktop local | 高 | 高（本地 stdio） | 高（单文件） | 中 | Phase 1 |
| Claude cloud connectors | 低 | 中 | 中 | 低（不可本地读取） | 仅显示动态缺口 |
| Codex | 高 | 高 | 高（deep merge） | 高 | Phase 1 |
| Cursor | 高 | 高（公开字段） | **中/缺口** | 中 | Phase 1 source view |
| Gemini CLI settings/extensions | 高 | 高 | 高（shallow merge） | 高 | Phase 1 |
| VS Code workspace/profile/remote | 高（profile 需 host 枚举） | 高 | **中/缺口** | 高 | Phase 1 workspace |
| Devin CLI | 高 | 高 | 高（whole-record） | 高 | Phase 1 |
| Windsurf Legacy Cascade | 高 | 高 | 高（单静态文件） | 高 | Phase 2，标 legacy |
| Zed | 高 | 高 | **中/缺口** | 中 | Phase 2 |
| Kiro | 高 | 高 | 高 | 高 | Phase 2 |
| Junie | 高 | 高 | **中/缺口** | 高 | Phase 2 |
| Amazon Q Developer | 中 | 中 | 中 | 中 | 版本研究后再做 |
| Cline CLI / IDE | 中 | 中 | 低 | 中 | 先补 schema 与 custom data dir |

## 推荐交付顺序

### Phase 1：正确骨架

1. 实现 `SourceEntryKeyV1`、`EffectiveInstanceV1`、统一 redaction。
2. 适配 Claude Code、Claude Desktop local、Codex、Cursor、Gemini CLI、VS Code workspace、Devin CLI。
3. `/mcp` 默认 source-first，另有当前项目 effective view。
4. 未知 precedence 显式显示，不用启发式猜 winner。
5. discovery、connect、auth、enable 四个动作分离。

### Phase 2：扩展来源

加入 Windsurf Legacy、Zed、Kiro、Junie 与 VS Code profile/remote；动态来源显示 `dynamic/not-discoverable`，不静默遗漏，也不归并到 global。

### Phase 3：高变动生态

有版本探测与 host/profile discovery 后，再支持 Amazon Q、Cline IDE 等来源。

## 尚待补证

1. Cursor global/project 同名 server 的官方完整合并契约。
2. VS Code user profile 的跨平台物理枚举契约，以及 workspace/user 同名精确行为。
3. Zed `context_servers` 在 user/project 层的 MCP 专属碰撞语义。
4. Junie default/custom locations 同名 server 的确定优先级。
5. Amazon Q 新 `default.json`、legacy `mcp.json`、CLI custom agent 的版本判定矩阵。
6. Cline 的 MCP schema、`CLINE_DATA_DIR` 解析，以及旧版 IDE global storage 的迁移边界。

在这些问题补证前，原始 source view 仍可靠；受影响的只是 effective winner 计算。这个边界应直接体现在类型和 UI 状态中。
