# Poly Swarm

**把手头的 AI 编程工具，编成一支会分工、会互审的团队。**

在 Antigravity 或 Codex 桌面端发起任务，让不同的本机 CLI 去调研、实现和复核，再回到同一个工作台看结果。可以混用不同厂商的工具，也可以用同一种 CLI，把不同模型档位分给不同的活。

[English](README.en.md) · [快速上手](#快速上手) · [技术说明](docs/technical-reference.md)

![Poly Swarm 工作台：成员席位、状态和单轮执行记录](docs/media/workbench.png)

*实际工作台。画面使用项目验收案例的脱敏记录。*

## 为什么做它

我订了几家的模型套餐，各家的 Agent 又各有长处。做一个项目时，我常在几个工具间来回搬上下文；改完让同一个模型回头检查，它容易沿着原来的思路跑一遍。

API 网关能统一请求入口，但模型 API 和完整的 Agent 工作流是两回事。把模型接到另一个工具里，原生工具链、权限和能力不一定能原样带过去。Poly Swarm 在任务层协作：让每个成员通过自己的 CLI 工作，由一个入口负责分派、收集结果和交接。各 CLI 仍需自行登录，使用各自允许的模型、套餐和配额。

## 可以怎么用

| 场景 | Poly Swarm 怎么帮你 |
| --- | --- |
| **少切几个窗口** | 在主聊天派活；从工作台看成员状态、执行轨迹、群聊、文件差异和交接记录。 |
| **让不同的模型互相挑错** | 作者可以在独立 Git worktree 里改；再派支持严格只读的后端做独立复核。内置审校岗默认要求跨厂商，具体执行受所用角色、后端和策略约束。 |
| **把强模型用在难题上** | 同一个后端也可以派多个成员，为每位选择其支持的模型或推理档位。轻量模型扫资料、归纳，强模型处理复杂实现或疑难审查。工作台按成员和后端记录用量；统计来源可能是 CLI 上报、Hook 或估算。 |
| **把常用分工留下来** | 在人才园区配置员工、岗位、执行权限和调度专长。用协同图谱查看派发、审校及交接，按项目回看已归档轮次。 |

> **真实案例：一次项目级发布验收。** 最后一轮用了 AGY、CodeBuddy、Codex、Cursor 和 Grok，9 名成员共执行 17 轮：作者修复，其他后端独立复核，审查意见和交接留在工作台。数字来自一场真实任务，供理解协作规模，不代表速度、成本或成功率基准。

### 一句可以直接试的任务

```text
用 Poly Swarm 给当前仓库派两位成员：先让一位作者在独立 worktree
修复空输入崩溃并运行相关测试，再让另一家 CLI 的只读审校员
复核改动、遗漏的边界情况和测试证据。把结论与文件位置留在工作台。
```

把示例中的问题换成你仓库里一个明确的小任务，并选两款已登录的后端。写入任务的仓库应已有 Git 提交。只有一个 CLI 时，可以先派同一后端的不同模型做调研和实现；跨厂商审校需要另一家后端。

## 快速上手

当前从源码安装。建议用 **macOS、Node.js 26、pnpm 和 Git**，再安装至少一个支持的 CLI，按该厂商的方式登录。首体验推荐两款不同厂商的 CLI。

```bash
git clone https://github.com/983033995/poly-swarm.git
cd poly-swarm
pnpm install --frozen-lockfile
```

| 入口 | 安装 | 第一次使用 |
| --- | --- | --- |
| **Antigravity** | `pnpm run install-plugin` | 重开宿主以加载插件，在聊天里请 Poly Swarm 检查后端并打开工作台。支持 MCP App 的宿主界面可显示成员卡和工作台。 |
| **Codex 桌面端（macOS）** | `pnpm run install-codex-plugin` | 安装后在新聊天启用 **Poly Swarm Local** 市场中的 **Poly Swarm**，用 `@Poly Swarm` 打开本聊天工作台或派发成员。使用聊天回执中的链接可重新打开同一任务。 |
| **本地浏览器看板** | `pnpm run build` | 执行 `node dist/server.mjs --data-dir ~/.poly-swarm/data --http-port 8799`，打开 `http://127.0.0.1:8799`。独立看板使用指定的数据目录。 |

适配的 CLI：**Antigravity、Codex、Cursor、Grok、CodeBuddy、OpenCode、Qoder、TRAE**。模型目录、登录状态、权限和用量支持因安装版本及后端而异；例如 OpenCode 不承担要求严格只读的岗位。应用写入本地任务记录；CLI 产生的请求仍受各自服务的条款与配置约束。详情见[技术说明](docs/technical-reference.md)。

## 参与项目

欢迎在 [Issues](https://github.com/983033995/poly-swarm/issues) 分享一个真实的协作场景，或报告某个 CLI 版本的适配问题。报错请带上宿主、CLI 版本、复现步骤和脱敏日志。

```bash
pnpm run typecheck
pnpm run build
pnpm test
```

[MIT License](LICENSE) 适用于项目原创代码。第三方标识归各自权利人所有，来源见[标识说明](src/ui/assets/agent-logos/README.md)。
