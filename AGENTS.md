# AGENTS.md — Poly-Swarm 项目规范

> 上手背景、完整架构、接口与待办清单请先阅读：[HANDOFF.md](./HANDOFF.md)。

## 构建、测试与插件安装命令

- 类型检查：`pnpm run typecheck`
- 全量构建：`pnpm run build`（产出 `dist/server.mjs` 与单文件 `dist/dashboard.html`）
- 自动化测试：`pnpm test`（全本地 Mock + 临时 Git 仓库 + Stdio MCP 端到端）
- 同步更新 Antigravity 插件：`pnpm run install-plugin`（安装至 `~/.gemini/config/plugins/poly-swarm/`）
- 安装 Codex 本地插件：`pnpm run install-codex-plugin`（macOS，本机 marketplace + 独立 LaunchAgent）

## 本仓库硬约束

1. **严禁 `console.log`**：所有服务端（`src/core/`、`src/server/`）日志必须使用 `console.error`，防止破坏 MCP `stdio` JSON-RPC 帧。
2. **MCP SDK 与运行时约定**：保持 `@modelcontextprotocol/server@^2.4.0` + `@modelcontextprotocol/ext-apps@^2.0.4` + `zod@^4.6.0`；`esbuild` 打包时保持 `external: ["node:*"]`；`node:sqlite` 返回行注意通过 `{ ...row }` 规整后再序列化。
3. **前端单文件与主题安全**：`src/ui/` 必须通过 `scripts/build.mjs` 编译成零外链内联 HTML（IIFE）；所有动态内容写入 DOM 前必须转义，严禁在 `app.connect()` 之前遗漏 handler 注册。
4. **测试严禁烧外部额度**：`pnpm test` 必须 100% 走 `MockAdapter` 或本地假脚本，严禁触发真实付费模型推理或探测任何认证接口。
5. **独立 Git 边界**：仅在本仓库目录内操作 `git`，严禁触碰外层父仓库或手改 `~/.gemini/config/config.json`。每次修改功能后必须跑通 `typecheck` + `build` + `test`，若需在 Antigravity 生效同步执行 `pnpm run install-plugin`。
6. **派发后的自检**：核对成员是否实际交付。只读 AGY 的简报限制在工作区内，不派发外部媒体路径；遇到拒绝不得绕过。CLI 报错应先读真实轨迹，区分权限、排队和连接故障。只读任务的连接故障可有界重试，不自动重放写任务。
