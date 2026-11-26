# Poly Swarm

**Turn the AI coding tools you already use into a team that can split the work and review each other's changes.**

Start in Antigravity or Codex desktop. Dispatch local CLI agents for research, implementation, and review. Follow their work, handoffs, and results in one workbench.

[简体中文](README.md) · [Technical reference](docs/technical-reference.md)

![Poly Swarm workbench with member seats, progress, and activity](docs/media/workbench.png)

*The real workbench displaying an anonymized release review.*

- **Coordinate from one chat.** Dispatch members and inspect their progress, activity, messages, and diffs in the workbench.
- **Get a second opinion.** An author can write in a separate Git worktree. Assign review to a backend that supports strict read-only execution. Built-in verifier roles require a different vendor by default.
- **Pick the model tier for the task.** Reuse one CLI with different supported models or reasoning levels. See usage by member and backend. Figures can come from the CLI, a hook, or an estimate.
- **Keep a roster.** Save roles and dispatch preferences, see how members handed work off, and reopen past runs.

In one real project release review, the final wave involved **five CLI backends, nine members, and 17 turns**. The workbench recorded implementation, independent review, and follow-up. These figures describe the run; they are not performance benchmarks.

Poly Swarm coordinates the CLI tools you install and sign into. Each CLI retains its own authentication, supported models, tools, permissions, and quotas.

## Get started

Use macOS with Node.js 26, pnpm, Git, and at least one supported CLI. Try two vendors for an independent review.

```bash
git clone https://github.com/983033995/poly-swarm.git
cd poly-swarm
pnpm install --frozen-lockfile
```

| Host | Install and open |
| --- | --- |
| Antigravity | Run `pnpm run install-plugin`, reopen Antigravity, and ask Poly Swarm to check backends and open the workbench. |
| Codex desktop (macOS) | Run `pnpm run install-codex-plugin`, enable **Poly Swarm** from **Poly Swarm Local**, and use `@Poly Swarm` in a new chat. |
| Local browser dashboard | Run `pnpm run build` and `node dist/server.mjs --data-dir ~/.poly-swarm/data --http-port 8799`, then open `http://127.0.0.1:8799`. |

Adapters: **Antigravity, Codex, Cursor, Grok, CodeBuddy, OpenCode, Qoder, and TRAE**. Capabilities differ by CLI; OpenCode does not qualify for strict read-only roles. See the [technical reference](docs/technical-reference.md).

Try: “Ask one member to implement this small fix in its own worktree. Then ask a read-only reviewer from another vendor to check the change, edge cases, and test evidence.”

Share a use case or compatibility report in [Issues](https://github.com/983033995/poly-swarm/issues). The project's original code is under the [MIT License](LICENSE). Third-party marks belong to their owners; see [logo sources](src/ui/assets/agent-logos/README.md).
