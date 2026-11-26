# Poly-Swarm 项目交接文档

> **历史交接记录**：本文描述 v0.5.0 第一批 P0 的状态；当前安装与体验入口参见 [README](./README.md)。

---

## 1. 项目定位与当前进度

- **核心定位**：面向异构外部 CLI（`codex` / `cursor` / `grok` / `opencode` / `codebuddy` / `agy` / `qoder`）的统一执行层与证据链底座——提供共享黑板 `#seq` + `@mention` 门铃唤醒、`git worktree` 写隔离、跨厂商只读独立审校、429 自动容灾切换与统一 Trace/用量账本，并以 **Antigravity MCP App 插件（v0.5.0）** 形式运行。
- **源码仓库**：独立 Git 仓库。此记录对应 v0.5.0 第一批 P0 加固。
- **已安装插件目录**：`~/.gemini/config/plugins/poly-swarm/`（同步 `plugin.json`、`mcp_config.json`、`assets/logo.svg`、`skills/poly-swarm/SKILL.md`、`README.md`、`dist/server.mjs`、`dist/dashboard.html`、`dist/inline-nodes.html`）。
- **运行时环境**：macOS / Node.js `v26.7.0` / `pnpm 10.27.0` / TypeScript `5.9.3` / `esbuild 0.25.12` / `node:sqlite`。

### 已完成功能与实测验收记录（v0.5.0 第一批 P0 加固）

| 验证项 | 执行命令 / 检查方式 | 实测结果 |
| :--- | :--- | :--- |
| **首次 Git 基线** | `git rev-parse --short HEAD` | 已建立 `main` 基线提交 `1c5e947`（55 files），解除 `worktree` 无 `HEAD` 自举阻塞 |
| **类型检查** | `pnpm run typecheck` | 通过（`tsc --noEmit` 退出码 0） |
| **全量构建** | `pnpm run build` | 生成单文件内联 `dist/dashboard.html`、`dist/inline-nodes.html` 与 `dist/server.mjs` |
| **自动化测试** | `pnpm test` | **9 个套件共 44 项测试全部 PASS（0 fail / 0 skipped）**：`adapters.test.ts`（14 项）、`db.test.ts`（2 项）、`engine.test.ts`（7 项）、`markdown.test.ts`（2 项）、`mcp.test.ts`（2 项，含 HTTP 安全 E2E）、`mention_picker.test.ts`（4 项）、`trace_model.test.ts`（5 项）、`ui_models.test.ts`（3 项）、`worktree.test.ts`（5 项） |
| **日志流规范检查** | `grep -rn "console\.log" src/` | 零匹配（服务端诊断日志统一走 `console.error`） |

---

## 2. 架构与源码地图

### 目录与核心模块职责

| 路径 | 核心导出符号 | 职责 |
| :--- | :--- | :--- |
| `src/shared/types.ts` | `BackendId`, `WorkerRole`, `WorkerState`, `DashboardSnapshot`, `WorkflowDefinition` 等 | 前后端共享强类型定义（含 `suppress_wake`、`owner_instance_id`、`projected`） |
| `src/core/config.ts` | `DEFAULT_ROUTES`, `loadPolySwarmConfig`, `updateBackendOverride`, `savePolySwarmConfig` | 默认能力路由链、扩展 `PATH`、读写 `~/.poly-swarm/backends.json`（原子落盘 `0600`） |
| `src/core/db.ts` | `PolySwarmDB`, `stripMarkdownCode`, `parseMessageSignals` | `node:sqlite` WAL + 幂等迁移（`server_instances`、`suppress_wake`、`owner_instance_id`）、单遍词法扫描代码剥离、PID+心跳属主恢复 |
| `src/core/worktree.ts` | `WorkspaceManager`, `RollbackReport`, `runGit` | `share`/`branch` 隔离工作树、`.git/info/exclude` 注入、pre-dirty 有界快照、诚实区分 `reverted` / `unreverted` 回滚报告 |
| `src/core/adapters/base.ts` | `BaseCliAdapter`, `spawnStreamingCli`, `classifyError`, `estimateTokens`, `readCursorHookUsage` | 独立 PGID 子进程（支持 `stdinText` 管道）、超时/中断强杀、`hasOutput` 联动 `exit 0` 错误分类 |
| `src/core/adapters/json_helpers.ts` | `accumulateUsage`, `handleGenericJsonLine`, `extractUsageFromObj` | 流式 NDJSON 公共字段解析与用量累加器 |
| `src/core/adapters/*.ts` | `AgyAdapter`, `CursorAdapter`, `GrokAdapter`, `OpenCodeAdapter`, `CodexAdapter`, `QoderAdapter`, `CodeBuddyAdapter`, `MockAdapter` | 7 家 CLI + 测试用 `MockAdapter`；声明 `supportsStrictReadonly`（`codex` 走 `stdin` 且 resume 强制 `sandbox_mode="read-only"`；`opencode` 标为 `false`） |
| `src/core/adapters/registry.ts` | `AdapterRegistry`, `REAL_BACKEND_IDS` | 统一适配器注册表与纯本地健康检查 (`detectAllBackends`) |
| `src/core/engine.ts` | `PolySwarmEngine`, `truncateUtf8Bytes`, `validateWorkerName` | 核心调度器：实例心跳注册、强只读角色拦截、UTF-8 精确字节截断、模型端 `getModelSnapshot` 投影、429 热切 |
| `src/core/watchdog.ts` | `StallWatchdog` | 零 Token 定时巡检，按 `waiting` 工人独立检测，自动跳过持久化 `suppress_wake === 1` 的静默通知 |
| `src/core/workflow.ts` | `WorkflowRunner`, `validateJsonSchemaLite` | 前置定义校验、`v0.5` 暂禁写步骤（`readonly=false`）、全模式（`parallel`/`pipeline`）统一入全局并发槽、并行失败取消同批步骤 |
| `src/server/mcp.ts` | `createPolySwarmMcpServer`, `APP_URI`, `INLINE_APP_URI` | 注册双 UI 资源、8 个 Model 工具（`open`/`dispatch` 返回瘦载荷 `getModelSnapshot`）、8 个 App-Only 工具 |
| `src/server/http.ts` | `startDashboardHttpServer` | 本地独立看板 HTTP 服务：校验 `Host` / `Origin` / `Sec-Fetch-Site`、全量 `POST` 强制 JSON（含 chunked）、`backend` 枚举校验与 256 KiB 请求体上限 |
| `src/server/index.ts` | `parseCliFlags`, `main` | CLI 入口（支持 `--data-dir`、`--config`、`--http-port`）与优雅退出注销实例 |
| `src/ui/*` | `app.ts`, `inline.ts`, `swarm_view_model.ts`, `markdown.ts`, `mention_picker.ts`, `trace_model.ts` | Antigravity MCP App 双 UI（内联流式节点卡 + 简体中文 4-Tab 工作台：**工作台 / 群聊 / 用量 / 配置**），带完整 `historyBrowsingMode` 只读护栏与瘦快照自动水合 |
| `scripts/*` | `build.mjs`, `install-plugin.mjs` | `esbuild` 打包后端、双单文件 HTML、9 套件测试并同步安装至 `~/.gemini/config/plugins/poly-swarm/` |
| `plugin/*` | `plugin.json`, `mcp_config.json`, `assets/logo.svg`, `skills/poly-swarm/SKILL.md` | Antigravity 插件清单与 Coordinator 调度规范 Skill |

### MCP 工具与数据流说明（共 16 个工具：8 Model + 8 App-Only）

- **UI 资源**：
  - `ui://poly-swarm/dashboard.html`（MIME：`text/html;profile=mcp-app`，侧栏/全局 4-Tab 中文工作台）
  - `ui://poly-swarm/inline-nodes.html`（MIME：`text/html;profile=mcp-app`，主对话极简内联节点卡）
- **8 个 Model 工具**（对主 LLM 可见）：
  - `poly_swarm_open`：挂接 `aux_pane` + `global` 入口，默认空参返回会话隔离空态，调用 `getModelSnapshot` 返精简绑定骨架（`projected: true`）。
  - `poly_swarm_dispatch`：一次性建群/派发并渲染单张内联节点卡，返回 `getModelSnapshot` 精简结构供内联卡即时绑定 `swarm.id`。
  - `poly_swarm`：覆盖 `backends` / `create` / `add` / `status` / `switch` / `merge` / `kill` / `channel` / `plan` / `finish`。
  - `poly_board_post`、`poly_board_read`、`poly_board_wait`、`poly_worker_inspect`、`poly_workflow`（v0.5 仅允许只读步骤）。
- **8 个 App-Only 工具**（`_meta.ui.visibility: ["app"]`，**零消耗主会话上下文**）：
  - `app_get_dashboard`（返回完整 `DashboardSnapshot` 供工作台水合）、`app_focus_worker`、`app_get_worker_detail`、`app_get_turn_events`、`app_board_post`、`app_worker_action`（`cancel`/`switch`/`merge`/`kill`/`refresh_backends`）、`app_list_backend_models`、`app_update_backend_config`。

---

## 3. 本机 7 款 CLI 现状与实测适配表

> 注：本机真实已装状态以 `~/.poly-swarm/backends.json` 与 `poly_swarm(action="backends")` 实测为准。

| Backend ID | 本机探测状态 | 无头调用与传参方式 | 只读强制模式 (`supportsStrictReadonly`) | 会话续接 | 消耗统计精确度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`codex`** | **已装** (`codex-cli 0.171.0`) | `codex exec --json -C <cwd>`，Prompt 经 **`stdin` (`-`)** 传入 | **是**（新建 `--sandbox read-only`；续接 `-c sandbox_mode="read-only"`） | `codex exec resume <id> --json ... -` | `exact`（解析 `turn.completed.usage`） |
| **`cursor`** | **已装** (`2026.11.22-e9042b2`) | `cursor-agent -p <prompt> --output-format stream-json --stream-partial-output --trust --workspace <cwd>` | **是**（`--mode ask`） | `--resume <id>` | `hook`（读 `~/.poly-swarm/hooks/cursor-<sid>.json`）或回退 `estimated` |
| **`grok`** | **已装** (`grok 1.0.92`) | `grok -p <prompt> --output-format streaming-json --cwd <cwd> --no-subagents` | **是**（`--permission-mode plan`） | `-r <id>` | `exact`（优先采用 `end` 累计，缺失时累加或 `estimated`） |
| **`opencode`** | **已装** (`opencode v2.3.2`) | `opencode run --format json --thinking <prompt>` | **否**（仅省去 `--auto`，v0.5 已拦截其出任 `verifier`/`researcher`/只读工作流） | `-s <id>` | `exact`（累加 `step_finish` 的 `part.tokens` 与 `part.cost`） |
| **`codebuddy`** | **已装** (`2.185.0`) | `codebuddy -p --output-format stream-json --verbose <prompt>` | **是**（`--permission-mode plan`） | `-r <id>` | `exact` / `estimated` |
| **`agy`** | **已安装，配置已禁用** | `agy -p <prompt> --output-format stream-json` | **是**（`--mode plan`） | `--conversation <id>` | `exact`（`step_update.usage`）或回退 `estimated` |
| **`qoder`** | **配置已禁用** | `qodercli -p -w <cwd> -o stream-json <prompt>` | **是**（`--permission-mode dont_ask --disallowed-tools Write,Edit,MultiEdit,NotebookEdit`） | `-r <id>` | `estimated`（含 JSON 兼容尝试） |

---

## 4. 关键工程约束与避坑清单

1. **严禁 `console.log`**：MCP 运行在 `stdio` 上，任何 `console.log` 都会破坏 JSON-RPC 帧；服务端日志必须统一使用 `console.error`。
2. **MCP SDK 版本锁定**：严格使用 `@modelcontextprotocol/server@^2.4.0` + `@modelcontextprotocol/core@^2.4.0` + `@modelcontextprotocol/ext-apps@^2.0.4` + `zod@^4.6.0`。
3. **Node 26 `node:sqlite` 与打包坑**：
   - `esbuild` 打包后端与测试保持 `external: ["node:*"]` 并注入 `createRequire` banner。
   - `DatabaseSync` 返回行对象为 null-prototype，通过 `{ ...row }` 规整；新增表/列必须在 `init()` 用 `PRAGMA table_info` 做幂等迁移以兼容线上历史 DB。
4. **MCP App 前端 CSP 与生命周期铁律**：
   - 打包为单文件内联 HTML（IIFE `<script>` + `<style>`，零外链 CDN，远小于 10 MiB 上限）。
   - `src/ui/app.ts` 与 `inline.ts` 必须在 `await app.connect()` **之前**注册 `ontoolinput`、`ontoolresult`、`onhostcontextchanged`。
   - 所有动态文本经 `esc()` 转义；当 `ontoolresult` 收到 `projected: true` 瘦快照时，工作台通过 `app_get_dashboard` 自动补齐完整群聊/配置。
5. **外层仓库隔离**：所有 Git 操作仅限本仓库；自动化测试的 Git 操作在临时目录内执行。
6. **插件更新同步**：修改源码后运行 `pnpm run install-plugin` 同步产物到 `~/.gemini/config/plugins/poly-swarm/`；严禁手改 `~/.gemini/config/config.json`。
7. **测试红线**：自动化测试全程使用 `MockAdapter` 或临时假 CLI，严禁在自动化测试中调用外部付费模型推理或探测任何认证接口。

---

## 5. 开发与排障命令速查

所有常规指令请在 Poly Swarm 仓库根目录执行：

- **严格类型检查**：`pnpm run typecheck`
- **构建产物（后端 + 双单文件 UI HTML）**：`pnpm run build`
- **构建并运行全量测试**：`pnpm test`
- **重新构建并安装到 Antigravity 插件目录**：`pnpm run install-plugin`
- **脱离 Antigravity 独立运行 Web 看板调试**：
  `node dist/server.mjs --data-dir ~/.poly-swarm/data --http-port 8799`
- **刷新 Antigravity 中已运行插件 MCP（在 Antigravity 终端内执行）**：
  ```bash
  curl -sf -H "Content-Type: application/json" \
    -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
    -d '{"serverName": "poly-swarm_poly-swarm"}' \
    "http://${ANTIGRAVITY_LS_ADDRESS:-localhost:5387}/exa.language_server_pb.LanguageServerService/RefreshMcpServers"
  ```

---

## 6. 下一阶段待办与收敛路线（v0.5 P1 → v1.0，Non-Goals）

1. **【v0.5 P1】真实闭环验收（基于已落地基线与瘦载荷）**：
   - 在已有 `HEAD` 基线与瘦载荷下，实测 Codex/Cursor 首轮及 `--resume` 续接（含 `share` worktree 写入 + 跨厂商只读复核 + 429 自动切换 + 用量口径核对）。
   - 补强 Cursor/Grok/Agy 等仍走 `argv` 的非 Codex 适配器：视 CLI 版本支持评估迁往 `--prompt-file` 或 `stdin`；补齐 Cursor Hook 轮次隔离校验。
2. **【v1.0 护城河跃迁】提交绑定的跨厂商审校门禁**：
   - `mergeWorker` 默认校验对应分支存在跨厂商 `[review_pass]` 记录与一致提交指针；完善结构化交接与用量凭证沉淀；仅在轮询实测出现瓶颈时按需引入增量游标。
3. **【明确 Non-Goals（不做 / 暂缓）】**：
   - 不将侧栏扩展为第二套控制台（UI 新建群、派发、触发 `poly_workflow`、导出复盘暂缓，写控制面唯一走 MCP）。
   - 不复刻宿主原生 DAG 编辑器，不为本地 HTTP 看板做账号/登录体系。
   - 不把凑齐未安装 CLI（如 `qodercli`）或 Cursor Hook 产品化作为主链路前置阻塞。
