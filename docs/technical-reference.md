# Poly Swarm technical reference

[简体中文](../README.md) · [English](../README.en.md)

Heterogeneous CLI multi-agent orchestrator and Antigravity MCP App (`v0.5.0`).

## Supported CLI Backends

- `codex` (OpenAI Codex CLI — prompt delivered via `stdin`, strict readonly `sandbox_mode="read-only"` on new & resumed turns)
- `cursor` (`cursor-agent` — `--trust --workspace`, readonly `--mode ask`)
- `grok` (Grok Build CLI — readonly `--permission-mode plan`)
- `opencode` (OpenCode CLI — write/fanout usage; blocked from strict readonly `verifier`/`researcher` roles)
- `codebuddy` (CodeBuddy / WorkBuddy CLI — readonly `--permission-mode plan`)
- `agy` (Antigravity CLI — readonly `--mode plan`)
- `qoder` (`qodercli` — readonly `--permission-mode dont_ask` + disallowed write tools)
- `trae` (Trae CLI — strict readonly enforcement `supportsStrictReadonly=true`; eligible for `verifier`/`researcher`)

## Key Capabilities

- **Minimalist Dispatch, Team Dock & End-of-Session Recap**: `poly_swarm_dispatch` and `poly_swarm_recap` render a compact inline team pill (`inline-nodes.html`) that collapses to a single row (`N 位团队成员 ⌄`), while `poly_swarm_open` binds strictly by `swarm_id` to the 4-tab Chinese side workbench (**工作台 / 群聊 / 用量 / 配置**) with a persistent floating bottom team dock (`.floating-team-dock`). An optional zero-token `PostInvocation` hook (`plugin/hooks.json`) acts as a fallback if a turn ends without calling `poly_swarm_recap`.
- **Lean Model Payloads**: `poly_swarm_open`, `poly_swarm_dispatch`, and `poly_swarm_recap` return projected summaries (`projected: true`) to keep main coordinator context lean; UI views hydrate full snapshots via app-only `app_get_dashboard`.
- **Readonly History Browsing & Hard Isolation**: Inspecting past sessions enforces UI write-locks across board posting, follow-ups, worker actions, global settings, and chat handoff. `WorkflowRunner` runs all steps through the global concurrency pool with sibling abort on failure and restricts steps to readonly mode in `v0.5`.
- **Local HTTP Dashboard Security**: Optional `--http-port` mode binds strictly to `127.0.0.1` and enforces `Host` / `Origin` / `Sec-Fetch-Site` checks, mandatory `application/json` on all `POST` requests (including chunked), and strict backend enum validation.

## Optional evidence-aware routing

Set `"historyAwareRouting": true` in the local service's `backends.json` and restart to enable project-local historical routing for automatically chosen backends (including eligible fallback candidates). Default is off. Explicit CLI, employee and ordered identity preferences remain authoritative. After the existing health, cooldown, readonly and independence gates, compare exact requested backend/model/effort, capability and execution mode using terminal outcomes from the past 30 days (at most 30 observations per profile, latest per seat). Unknown and undersampled profiles retain their original priority slots; only profiles with at least five distinct seats are ranked. Candidate diagnostics explain the evidence. This is execution reliability, not a measure of accepted code or task quality; workflow-only turns and cancelled turns do not contribute.

## Commands

```bash
pnpm run typecheck
pnpm run build
pnpm test
pnpm run install-plugin
```

Optional standalone HTTP dashboard mode:

```bash
node dist/server.mjs --data-dir ~/.poly-swarm/data --http-port 8799
```

Optional backend override config: `~/.poly-swarm/backends.json`.

## 员工权限与岗位 Skill

内置 16 个岗位身份模版，均带四段式中文 `system_prompt`（角色定位 / 核心职责与方法 / 边界禁令 / 交付标准）：

- **只读类（8）**：`architect`（架构设计师）、`tech-lead`（技术负责人）、`product-analyst`（产品需求分析师）、`researcher`（代码调研员）、`verifier`（跨厂商审校官）、`sec-auditor`（安全与红队审计官）、`perf-reviewer`（性能与并发评审专家）、`qa-challenger`（QA 验收与反例挑战官）。项目级/会话级策略不可将其降级为可写角色。
- **隔离写类（6）**：`author`（全栈核心开发）、`backend-author`（后端与分布式工程师）、`frontend-author`（前端与交互工程师）、`refactor-specialist`（重构与代码整洁专家）、`test-engineer`（测试开发工程师 SDET）、`devops-sre`（构建与基础设施工程师），默认 `workspace_mode="share"` 独立工作树。
- **协同类（2）**：`enterprise-worker`（企业规范与文档专员）、`worker`（高并发扇出执行员），默认 `workspace_mode="inherit"`。

在 **人才园区 → 立体工牌馆**，用「默认执行权限」选择只读或可写模式；
「调度专长」只用于自动路由与后备选择。员工绑定的 CLI 仍按自己的配置、账号、
工作区与权限模式加载工具；Poly Swarm 不同步主会话的 MCP 或 Skill。

在 **岗位身份模板 → 编辑 → 岗位 Skill**，每行填写一个工作区相对路径，
例如 `.agents/skills/code-review/SKILL.md`。员工可以绑定同一权限角色下的模板；
未绑定时使用执行角色对应的模板。每轮任务会提示员工按需用自己的工具读取这些文件。
文件须存在于该员工的实际工作区；独立 Git 工作树也要包含对应文件。此配置不安装 Skill，
不禁用 CLI 原有工具，也不为 Skill 内的命令或 MCP 扩权。全局配置按服务存放，项目配置
可为同一模板覆盖列表。

## Employee execution history

New dispatches resolved to a Talent Park employee persist the stable `staff_id` on the worker seat. Renames and fallback CLI switches do not change the dispatch attribution. Old or ad hoc workers are left unattributed rather than guessed by name. Talent Park cards show attributed assignments and completed/failed turns. `poly_swarm(action="staff")` additionally exposes cancelled/running turns and average completed duration from the current service database. These are execution metrics, not task acceptance rates or model quality rankings; Antigravity and Codex keep separate task histories even when they share roster profiles. Employee attribution itself does not change routing decisions.

## Codex desktop workbench

On macOS with the Codex CLI and Node.js installed, run `pnpm run install-codex-plugin`.
This installs **Poly Swarm** from the **Poly Swarm Local** marketplace in Codex.
Start a new chat and use `@Poly Swarm`. The default prompts in the plugin open
either the global hub or the workbench for that chat.

- **Dispatch:** ask Poly Swarm in the chat to dispatch its CLI members. The chat
  records the task ID, members, backends, and a link to the right-side workbench.
- **Reopen:** click the card's **打开工作台** button to expand that task's
  workbench beside the chat. The receipt link opens the same task in the
  browser. You can also ask to open this chat's workbench. Opening a task does
  not rerun it.
- **Configure:** use `@Poly Swarm` → “打开 Poly Swarm 总控” to open the existing
  HR campus, provider settings, rules, preferences, and project history. The
  global hub is also at `http://127.0.0.1:18799/?surface=global`.

The installer starts `com.poly-swarm.codex` as a per-user macOS LaunchAgent.
It owns the workers, SQLite data, and loopback workbench. Codex connects over a
private Unix socket through the plugin's STDIO bridge. Closing a chat only
disconnects that bridge. The installer reuses `~/.codex/poly-swarm/data` and
`backends.json` and leaves a live service running when reinstalling; updated
server code loads on the service's next start. If you previously added a manual
`poly-swarm` MCP entry, remove that entry after confirming the plugin works, so
Codex doesn't expose two copies of the same tools.

If the Codex worker's model provider requires a variable such as
`CLIPROXY_API_KEY`, configure `backends.codex.envFiles.CLIPROXY_API_KEY` in
the LaunchAgent's `backends.json` with an absolute path to an owner-only
(mode `0600`) file containing the value on one line. The launcher reads the
file for each Codex worker turn and passes its value to that CLI process.
The LaunchAgent does not inherit variables from a Codex chat or terminal.

External CLI members are shown in the Poly Swarm workbench. The chat receipt
and link work without host support for an inline MCP App. Antigravity's MCP App
and installer remain separate.

On the same macOS user account, both installed plugins share the Talent Park's
employee profiles and Antigravity account companies in `~/.poly-swarm/talent.db`.
Reopen both plugin services after updating; on first start the shared store
imports the saved records from both hosts, leaving their original databases
intact. If the same ID has different saved settings, startup reports the
conflict rather than replacing a record. Tasks, chats, usage history, CLI
settings and credentials retain their existing storage.

In **人才园区 → 外包公司 → 添加账号公司**, select one or more accounts saved
by the macOS Antigravity Account Switch plugin. Each account becomes a
company with its own name, switch, defaults and Poly Swarm usage. In the
employee editor, choose that company under **所属外包公司**.
The company and employee editor query the model catalog using that company's
isolated sign-in. A failed lookup shows an error instead of another account's
models or the static catalog.
Use `poly_swarm(action="staff")` to dispatch by `staff_id`, or
`poly_swarm(action="companies")` to dispatch directly by `company_id`.
Migrated employees retain their selected account. Unbound employees retain
the legacy local sign-in. Changing an employee's company affects new
dispatches only; an existing task will not switch accounts.
