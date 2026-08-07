# Pi Sessions Studio：C4 四层架构导览

这份文档用 C4 的四个层级逐步放大项目：先看系统与外界的关系，再进入运行容器、前后端组件，最后落到核心后端函数。

## 先看结论

- 这是一个**只读本地工作台**：Pi Agent CLI 写入 JSONL，Pi Sessions Studio 只负责扫描、解析、检索和展示。
- 生产模式只有一个端口：Express 同时提供 `/api/*` 和 `web/dist` 静态资源。
- 没有数据库：原始事实来源始终是 `~/.pi/agent/sessions/**/*.jsonl`。
- 后端使用进程内增量缓存：文件的 `mtime` 或大小变化时才重新解析摘要和搜索文本。
- 会话详情保留树形分支；列表、搜索、统计和 Markdown 导出是这棵数据树的不同投影。

---

## C4 Level 1：System Context

这一层只回答三个问题：谁使用系统、系统解决什么问题、数据从哪里来。

[↗ 在 Mermaid.ai 打开](http://127.0.0.1:38473/v1/open/eyJ2IjoxLCJwYXRoIjoiL1VzZXJzL2FsZmhlaW0vY29kZS9kZW1vL3BpLXNlc3Npb25zLXN0dWRpby9DNC1BUkNISVRFQ1RVUkUubWQiLCJibG9ja19pZCI6ImIwMDc4ZWU3ZGUyZTQ0NTI4MzcwNTk5N2RhZmY4NDY1In0.CDR2BpCmtFvh8bI1gnCFM_tfpis43SEHdBCIY284dwA)
```mermaid
flowchart LR
    user["使用者<br/>在浏览器中浏览、搜索、分析会话"]
    studio["Pi Sessions Studio<br/>本地会话数据可视化与理解工作台"]
    pi_agent["Pi Agent CLI<br/>产生并持续追加会话记录"]
    session_store[("本地会话数据<br/>~/.pi/agent/sessions/**/*.jsonl")]

    user -->|"浏览、检索、导出"| studio
    pi_agent -->|"追加写入 JSONL"| session_store
    studio -->|"只读扫描与解析"| session_store

    classDef person fill:#e8f0ff,stroke:#4263eb,color:#172554,stroke-width:1.5px;
    classDef system fill:#ede9fe,stroke:#7c3aed,color:#2e1065,stroke-width:2px;
    classDef external fill:#ecfeff,stroke:#0891b2,color:#164e63,stroke-width:1.5px;
    classDef data fill:#ecfdf5,stroke:#059669,color:#064e3b,stroke-width:1.5px;
    class user person;
    class studio system;
    class pi_agent external;
    class session_store data;
```

### 核心边界

- Pi Sessions Studio 不负责生成会话，也不会修改原始 JSONL。
- Pi Agent CLI 可以继续写文件；刷新页面时，后端会根据文件变化更新缓存。
- 当前服务没有鉴权，适合本机使用，不应直接暴露到不可信网络。

---

## C4 Level 2：Container

这一层展示运行时边界：浏览器、Node.js 服务和本地文件系统如何协作。

[↗ 在 Mermaid.ai 打开](http://127.0.0.1:38473/v1/open/eyJ2IjoxLCJwYXRoIjoiL1VzZXJzL2FsZmhlaW0vY29kZS9kZW1vL3BpLXNlc3Npb25zLXN0dWRpby9DNC1BUkNISVRFQ1RVUkUubWQiLCJibG9ja19pZCI6ImM4NWZmMjQwMjU2YzQwNjVhNjMxMTVhM2VkODk2YjhiIn0.JZghcSJuaFevnAcjxkq3RH6gIEhVPT76iG3fAVk760M)
```mermaid
flowchart LR
    user["使用者"]
    pi_agent["Pi Agent CLI"]

    subgraph product["Pi Sessions Studio 系统边界"]
        direction LR
        web_app["Web 应用容器<br/>React、React Router、ECharts<br/>运行在浏览器"]
        api_server["服务端容器<br/>Node.js、Express<br/>提供 API 与静态资源"]
    end

    session_store[("数据容器<br/>JSONL 文件目录<br/>~/.pi/agent/sessions")]

    user -->|"HTTP 访问"| web_app
    web_app -->|"GET /api/*"| api_server
    api_server -.->|"托管 web/dist"| web_app
    api_server -->|"同步只读访问"| session_store
    pi_agent -->|"持续写入"| session_store

    classDef person fill:#e8f0ff,stroke:#4263eb,color:#172554;
    classDef browser fill:#ede9fe,stroke:#7c3aed,color:#2e1065;
    classDef server fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef external fill:#ecfeff,stroke:#0891b2,color:#164e63;
    classDef data fill:#ecfdf5,stroke:#059669,color:#064e3b;
    class user person;
    class web_app browser;
    class api_server server;
    class pi_agent external;
    class session_store data;
```

### 运行方式

| 场景 | 浏览器入口 | 运行关系 |
| --- | --- | --- |
| 生产模式 | `http://localhost:5177` | Express 提供 API，并托管 Vite 构建产物 |
| 开发模式 | `http://localhost:5173` | Vite 热更新，`/api` 代理到 Express `5177` |

---

## C4 Level 3：Component

这一层进入两个容器内部，展示前端页面、共享组件和后端数据组件的职责。

[↗ 在 Mermaid.ai 打开](http://127.0.0.1:38473/v1/open/eyJ2IjoxLCJwYXRoIjoiL1VzZXJzL2FsZmhlaW0vY29kZS9kZW1vL3BpLXNlc3Npb25zLXN0dWRpby9DNC1BUkNISVRFQ1RVUkUubWQiLCJibG9ja19pZCI6IjA2YmE4NjdlNmY3YjQ1OTk5OTE3M2FkYWFkNzkxYTFlIn0.uBuj_JW3PixhyXIQwCNmUAagnNkMi2JEW6pXiLsVF10)
```mermaid
flowchart TB
    subgraph frontend["Web 应用容器"]
        app_shell["App.jsx<br/>应用布局、路由、三态主题"]
        pages["pages/*<br/>总览、会话、详情、搜索、洞察、数据格式"]
        entry_view["Entry.jsx<br/>消息、思考、工具结果与系统事件"]
        chart_view["Chart.jsx<br/>ECharts 生命周期与尺寸响应"]
        ui_components["Ui.jsx<br/>卡片、Markdown、折叠、加载与错误态"]
        client_libs["lib/*<br/>API、格式化、Markdown、会话树算法"]

        app_shell --> pages
        pages --> entry_view
        pages --> chart_view
        pages --> ui_components
        pages --> client_libs
        entry_view --> ui_components
        entry_view --> client_libs
    end

    subgraph backend["服务端容器"]
        http_api["index.js<br/>Express 路由与静态资源"]
        scanner["scanner.js<br/>目录扫描、增量缓存、会话定位"]
        parser["parser.js<br/>JSONL 解析、摘要与搜索文档"]
        search_engine["search.js<br/>跨会话 AND 全文检索"]
        stats_engine["stats.js<br/>Token、成本、模型与活动聚合"]
        markdown_export["export.js<br/>主分支 Markdown 导出"]

        http_api --> scanner
        http_api --> parser
        http_api --> search_engine
        http_api --> stats_engine
        http_api --> markdown_export
        scanner --> parser
        search_engine --> scanner
        stats_engine --> scanner
        stats_engine --> parser
        markdown_export --> parser
    end

    session_store[("~/.pi/agent/sessions<br/>JSONL 文件")]

    client_libs -->|"Fetch /api/*"| http_api
    scanner -->|"扫描与读取"| session_store
    parser -->|"读取单个文件"| session_store

    classDef frontend_node fill:#f5f3ff,stroke:#8b5cf6,color:#2e1065;
    classDef backend_node fill:#eff6ff,stroke:#3b82f6,color:#172554;
    classDef data fill:#ecfdf5,stroke:#059669,color:#064e3b;
    class app_shell,pages,entry_view,chart_view,ui_components,client_libs frontend_node;
    class http_api,scanner,parser,search_engine,stats_engine,markdown_export backend_node;
    class session_store data;
```

### 组件职责速查

| 目录或文件 | 主要职责 |
| --- | --- |
| `web/src/pages/` | 把 API 数据组织成六个用户页面 |
| `web/src/components/Entry.jsx` | 将 JSONL 条目映射为可读的时间线，并配对工具调用与结果 |
| `web/src/lib/tree.js` | 从 `id / parentId` 重建分支树和当前路径 |
| `server/src/scanner.js` | 建立会话索引，并按文件变化增量刷新 |
| `server/src/parser.js` | 一次遍历提取摘要、统计基础数据和搜索文本 |
| `server/src/search.js` | 对缓存搜索文档执行大小写不敏感的多词 AND 查询 |
| `server/src/stats.js` | 聚合日报、热力图、项目和模型使用数据 |
| `server/src/export.js` | 沿主路径生成可下载的 Markdown |

---

## C4 Level 4：Code

代码层聚焦后端核心，因为它决定了所有页面看到的数据。图中展示路由处理函数如何复用扫描、解析、检索、统计和导出函数。

[↗ 在 Mermaid.ai 打开](http://127.0.0.1:38473/v1/open/eyJ2IjoxLCJwYXRoIjoiL1VzZXJzL2FsZmhlaW0vY29kZS9kZW1vL3BpLXNlc3Npb25zLXN0dWRpby9DNC1BUkNISVRFQ1RVUkUubWQiLCJibG9ja19pZCI6IjRjNTYzMzZhZDk3YzQxYTY4NjY5MWJhMWQ0ZDI1NzI3In0.Iyf7ZpzWaQPXKBiPEwVce5yXLJ1hnNCQQzkMUFjOTzk)
```mermaid
flowchart LR
    subgraph routes["index.js 路由入口"]
        overview_route["GET /api/overview<br/>GET /api/projects"]
        sessions_route["GET /api/sessions<br/>GET /api/sessions/:id"]
        search_route["GET /api/search"]
        stats_route["GET /api/stats"]
        export_route["GET /api/sessions/:id/export.md"]
    end

    subgraph scan_code["scanner.js"]
        get_index["getIndex()<br/>扫描、命中缓存、刷新摘要"]
        find_by_id["findById()<br/>按会话 ID 定位"]
        search_corpus["getSearchCorpus()<br/>组合摘要与搜索文档"]
        memory_cache[("cache Map<br/>mtime、size、summary、searchDocs")]
    end

    subgraph parse_code["parser.js"]
        parse_lines["parseLines()<br/>逐行 JSON.parse 并跳过坏行"]
        build_file_data["buildFileData()<br/>摘要、计数、Token、成本、搜索文本"]
        build_detail["buildDetail()<br/>返回摘要与全部原始条目"]
        content_text["contentText()<br/>统一抽取消息纯文本"]
    end

    subgraph query_code["查询与输出模块"]
        search_fn["search()<br/>多词 AND、评分、片段截取"]
        compute_stats["computeStats()<br/>会话与项目聚合"]
        compute_models["computeModelStats()<br/>模型级惰性缓存"]
        to_markdown["toMarkdown()<br/>主路径回溯与工具结果配对"]
    end

    session_store[("JSONL 文件")]

    overview_route --> get_index
    overview_route --> compute_stats
    sessions_route --> get_index
    sessions_route --> find_by_id
    sessions_route --> build_detail
    search_route --> search_fn
    stats_route --> compute_stats
    stats_route --> compute_models
    export_route --> build_detail
    export_route --> to_markdown

    get_index --> build_file_data
    get_index <--> memory_cache
    find_by_id --> get_index
    search_corpus --> get_index
    search_fn --> search_corpus
    compute_stats --> get_index
    compute_models --> get_index
    compute_models --> parse_lines
    build_file_data --> parse_lines
    build_detail --> build_file_data
    build_detail --> parse_lines
    to_markdown --> content_text

    parse_lines -->|"fs.readFileSync"| session_store
    build_file_data -->|"fs.statSync"| session_store

    classDef route fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef scan fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
    classDef parse fill:#ede9fe,stroke:#7c3aed,color:#2e1065;
    classDef query fill:#f0fdf4,stroke:#16a34a,color:#14532d;
    classDef data fill:#ecfdf5,stroke:#059669,color:#064e3b;
    class overview_route,sessions_route,search_route,stats_route,export_route route;
    class get_index,find_by_id,search_corpus,memory_cache scan;
    class parse_lines,build_file_data,build_detail,content_text parse;
    class search_fn,compute_stats,compute_models,to_markdown query;
    class session_store data;
```

### 四条关键执行链路

1. **总览和会话列表**：路由 → `getIndex()` → 增量缓存 → 会话摘要。
2. **会话详情**：`findById()` 定位文件 → `buildDetail()` 读取全部条目 → 前端 `tree.js` 重建分支。
3. **全局搜索**：`search()` → `getSearchCorpus()` → 对缓存的 `searchDocs` 进行多词匹配和排序。
4. **统计洞察**：`computeStats()` 聚合摘要；`computeModelStats()` 在需要时轻扫 assistant usage。

---

## 建议阅读顺序

想在十分钟内掌握代码，可按下面顺序阅读：

1. `README.md`：功能与启动方式。
2. `server/src/index.js`：先建立 API 全貌。
3. `server/src/scanner.js` → `server/src/parser.js`：理解数据如何进入系统。
4. `web/src/App.jsx` → `web/src/pages/SessionDetail.jsx`：理解 UI 路由和最复杂页面。
5. `web/src/lib/tree.js` → `web/src/components/Entry.jsx`：理解会话分支和消息渲染。
6. `server/src/search.js`、`server/src/stats.js`、`server/src/export.js`：理解三个派生能力。

## 本地运行

```bash
cd /Users/alfheim/code/demo/pi-packages/packages/pi-sessions-studio
npm install
npm run build
npm start
```

然后访问 `http://127.0.0.1:5177`。
