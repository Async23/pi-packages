# Pi Sessions Studio

Pi 的本地会话可观测与复盘工作台。它通过 `/studio` 从 Pi 当前会话进入浏览器，将 `~/.pi/agent/sessions` 中的分支、工具调用、上下文、Token 与成本还原成可检索、可解释、可导出的工作记录。

```text
Pi TUI ── /studio ──► Pi Package Extension
                           │ 懒启动 / 复用本地服务
                           ▼
                    browser ui (React + Vite + ECharts)
                           │  /api/*
                           ▼
                    backend (Node.js + Express)
                           │  只读扫描 / 增量解析
                           ▼
                    ~/.pi/agent/sessions/**/*.jsonl
```

## 功能

- **总览**：会话/消息/工具调用/Token/成本 KPI，近 30 天活动趋势，工具 Top 10，项目排行，最近会话
- **会话浏览器**：按项目/关键词过滤，按活动时间/成本/Token/时长等排序，无限加载
- **会话详情**：
  - 完整对话流：用户 / 助手 / 思考过程（折叠）/ 工具调用与结果自动配对 / 手动 bash / 系统事件
  - **分支可视化**：识别重试/回溯产生的树形分支，标出分支点，可切换任意分支路径
  - 上下文规模趋势图（观察 compaction 锯齿）、用户消息大纲导航、逐条原始 JSON
  - 导出 Markdown、fork 父会话跳转、搜索结果锚点定位
- **全局搜索**：跨会话全文检索（对话/思考/工具参数与输出/压缩摘要），类型与项目过滤，高亮命中
- **统计洞察**：每日 Token/成本、模型成本分布、周×小时活跃热力图、项目成本、模型缓存命中率、模型明细表
- **数据格式**：内置 JSONL 格式说明文档，便于学习理解

## 作为 Pi Package 使用（推荐）

当前仓库可作为本地 Pi Package 安装：

```bash
cd /path/to/pi-sessions-studio
npm install
npm run build
pi install "$(pwd)"
```

安装后重启 Pi 或执行 `/reload`，然后使用：

| 命令 | 说明 |
| --- | --- |
| `/studio` | 懒启动本地服务，并直接打开当前持久化会话与当前分支位置 |
| `/studio home` | 打开 Studio 总览 |
| `/studio status` | 查看当前 Session 数据目录对应的服务状态 |
| `/studio stop` | 停止本地服务 |

Extension 只在用户执行 `/studio` 时启动服务；同一 Session 数据目录会复用同一个后台进程。服务绑定 `127.0.0.1`，运行状态和日志保存在 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下的 `pi-sessions-studio/`。

发布到 npm 后，可改用：

```bash
pi install npm:pi-sessions-studio
```

## 独立运行与开发

```bash
npm install

# 生产模式（单端口）
npm run build
npm start            # → http://127.0.0.1:5177

# 开发模式（前端热更新）
npm run dev          # 后端 :5177 + 前端 :5173（代理 /api）
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | 独立运行时的会话数据目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `<PI_CODING_AGENT_DIR>/sessions` | 自定义 Pi Session 数据目录；未设置时 Extension 从当前项目目录定位全局 `sessions` 根目录 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置目录，同时作为 Studio 后台进程状态目录的上级目录 |
| `PI_STUDIO_HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `5177` | 独立运行端口；Extension 启动时使用系统分配的空闲端口 |

## API

| 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 服务身份、PID、监听地址与 Session 数据目录 |
| `GET /api/overview` | 全局总览（KPI、近 30 天、Top 工具/项目、最近会话） |
| `GET /api/projects` | 项目列表及聚合统计 |
| `GET /api/sessions?project=&q=&sort=&order=&limit=&offset=` | 会话列表 |
| `GET /api/sessions/:id` | 会话详情（全部原始条目 + 摘要） |
| `GET /api/sessions/:id/export.md` | 导出主路径为 Markdown |
| `GET /api/search?q=&kind=&project=&limit=` | 全文搜索 |
| `GET /api/stats?project=` | 统计（每日/热力图/模型/工具/项目） |

数据只读，不会修改任何会话文件；文件按 mtime 增量重解析，TUI 里新产生的消息刷新页面即可看到。
