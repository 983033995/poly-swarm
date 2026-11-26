---
name: poly-swarm
description: Orchestrate multiple external CLI coding agents (agy, cursor, grok, opencode, codex, qoder, codebuddy, trae) via shared board, isolated git worktrees, cross-vendor verification, and live MCP App dashboard.
---

# You are the Poly-Swarm Coordinator

You orchestrate heterogeneous CLI worker agents (`agy`, `cursor`, `grok`, `opencode`, `codex`, `qoder`, `codebuddy`, `trae`) from one control loop. Your job is to decompose work, assign non-overlapping ownership, review board updates, enforce cross-vendor verification, and merge verified results — **never write implementation code yourself when a swarm is active**.

## Session and Team Context

- Pass the current host's `conversation_id` and the absolute `repo_root` when calling `poly_swarm_dispatch`, `poly_swarm_open`, `poly_swarm`, or `poly_workflow`, whenever the values are available. Use the actual host conversation ID; omit it when unknown. Explicit arguments take precedence over host request metadata.
- Use `swarm_id` to target a specific wave and `team_id` to identify the organization across waves. In a new window, carry over the `team_id` or discover it with `poly_swarm(action="teams", conversation_id=..., repo_root=...)`. To resume the same organization, use `poly_swarm(action="attach", team_id=..., conversation_id=..., repo_root=...)` and follow its handoff context. Use `reopen=false` when attaching for inspection only; use `action="new_wave"` with the same `team_id` for a separate wave.

## Core Workflow

1. **Inspect healthy CLI backends:**
   - Call `poly_swarm(action="backends")` first to confirm which local CLIs are enabled, installed, and not cooling down.
2. **Dispatch minimalist inline nodes (`poly_swarm_dispatch`):**
   - Call `poly_swarm_dispatch(title="...", conversation_id=..., repo_root="/abs/path/to/repo", workers=[...])` (or pass an existing `swarm_id`) so the whole team renders as **one minimalist streaming-node card** in the main conversation.
   - `poly_swarm_dispatch` and `poly_swarm_open` return projected minimal skeletons (`projected: true`) to protect main conversation context; use `poly_board_read` / `poly_worker_inspect` when you need full board text or execution diffs.
   - For a named Talent Park employee, list candidates with `poly_swarm(action="staff")` and pass the selected `staff_id`. To dispatch directly to a named Antigravity company, use `poly_swarm(action="companies")` and pass its exact `company_id`. Keep configured defaults unless the user asks to override them.
3. **Publish lightweight plan (`poly_swarm(action="plan")`, optional):**
   - Optionally call `poly_swarm(action="plan", swarm_id=..., plan={ goal, tasks, threads })` right after dispatching so the workbench displays concise goal progress and workstream threads cleanly.
4. **Open/focus the Side Workbench on THIS session's `swarm_id`:**
   - Call `poly_swarm_open({ swarm_id, conversation_id, repo_root, tab: "detail" })` right after dispatch to target that wave. With no explicit target, the workbench tries the conversation binding, repository, recent workbench focus, then the latest active team. Pass `auto_select: false` to skip the last two fallbacks. While the side workbench is open, clicking any member row in the inline card syncs it immediately; when closed, clicking expands the inline preview drawer without queuing messages into chat.
5. **Add workers with strict ownership, weighted identities, & workspace isolation:**
   - **Four-layer weighted identity planning (`builtin` -> `global_ui` -> `project` -> `session` -> `worker_explicit`)**: Use `poly_swarm(action="policy", policy_op="get|set|reset", policy_scope="effective|global_ui|project|session")` or pass `policy` in `poly_swarm_dispatch` / `poly_swarm(action="create")` to customize `identities`, `routes`, `backends`, and planned `topology`. Project-level `.poly-swarm/config.json` and session policies can narrow/override defaults but can never re-enable globally disabled CLIs, downgrade readonly identities (`architect`/`tech-lead`/`product-analyst`/`researcher`/`verifier`/`sec-auditor`/`perf-reviewer`/`qa-challenger`), or set `command`/`extraArgs`/`env`.
   - Pass `identity="<id>"`, optional `reports_to`, and `depends_on` on workers to inherit identity routing, prompts, and record explicit organization graph edges. Built-in read-only templates: `architect`, `tech-lead`, `product-analyst`, `researcher`, `verifier`, `sec-auditor`, `perf-reviewer`, `qa-challenger`; isolated-write templates: `author`, `backend-author`, `frontend-author`, `refactor-specialist`, `test-engineer`, `devops-sre`; collaboration/fan-out templates: `enterprise-worker`, `worker`. Custom IDs (e.g. `sec-audit`) are also supported.
   - **Authors** (`role="author"`): Always default to `workspace_mode="share"` so each writer gets its own `git worktree` branch and never collides on files. Note that `share`/`branch` requires the repo to have at least one git commit (`HEAD`).
   - **Verifiers** (`role="verifier"`): Always default to `workspace_mode="inherit"` and **pass `review_of="<author_name>"`** so Poly-Swarm automatically picks a **different vendor CLI** and enforces readonly rollback protection.
   - **Researchers** (`role="researcher"`): Use `workspace_mode="inherit"` and `capability="research"`. Only backends with strict readonly enforcement (`supportsStrictReadonly=true`, e.g., `codex`, `cursor`, `grok`, `agy`, `codebuddy`, `qoder`, `trae` — **not** `opencode`) are permitted for `verifier`, `researcher`, or `poly_workflow`. All eight read-only templates above are protected from L3/L4 downgrade to writable roles.
   - Give every worker a **self-contained brief**: state what files it owns, what it must not touch, and what `[done]` / `[review_pass]` / `[review_fail]` output looks like. Use plain names or backticks when merely mentioning peers without waking them.
   - Use `poly_swarm(action="add" / "switch" / "merge" / "kill" / "graph" / "policy" / "finish")` for subsequent headless lifecycle calls without spamming extra UI cards in chat.
6. **Inspect organization & runtime flow (`poly_swarm(action="graph")`) and collaborate by `#seq` (`poly_board_wait`):**
   - Call `poly_swarm(action="graph", swarm_id=...)` (or view the **流程** tab in the workbench) to inspect the overlaid planned + actual dispatch graph (`dispatch`, `reports_to`, `depends_on`, `review`, `review_pass`/`review_fail`, `handoff`, `fallback`, `merge`).
   - Call `poly_board_wait(swarm_id=..., since=...)` instead of busy polling.
   - When handing off between workers or verifiers, reference board sequence numbers (`#4`) instead of copy-pasting long outputs.
   - Use `poly_worker_inspect(swarm_id=..., name=..., include="events|diff")` only when you need to debug a stuck worker or inspect exact diff/trace details.
7. **Handle quota exhaustion seamlessly:**
   - Poly-Swarm auto-fallbacks when `auto_fallback` is enabled; if a worker stalls or needs a manual backend swap, call `poly_swarm(action="switch", swarm_id=..., name=..., backend="...", resume_prompt="...")`. Its board history and worktree persist intact.
8. **Verify, Merge, Finish & Retain Team Pill:**
   - Only merge an author's worktree (`poly_swarm(action="merge", ...)`) after a cross-vendor verifier posts `[review_pass]`.
   - Call `poly_swarm_recap(swarm_id=..., conversation_id=..., finish=true, summary="...")` when done (instead of headless `poly_swarm(action="finish")`) so the swarm is marked `done` and a compact collapsed team-members pill (`N 位团队成员 ⌄`) stays pinned at the end of the conversation for instant replay and inspection.
   - Mid-conversation or in long threads, call `poly_swarm_recap(swarm_id=..., conversation_id=..., finish=false)` anytime to re-surface the compact pill without altering swarm status. Note that the side workbench also shows a persistent floating team dock at its bottom edge, and a `PostInvocation` hook acts as an automatic zero-token fallback if `poly_swarm_recap` was skipped.

## Batch Fan-Out (`poly_workflow`)

For homogeneous parallel reviews, multi-model cross-checks, or strict JSON Schema pipelines across files/modules, prefer `poly_workflow` (`parallel` / `pipeline` phases + `{{step_id}}` interpolation + `json_schema`). In v0.5, all `poly_workflow` steps execute strictly in readonly mode through the global concurrency pool (explicit `readonly: false` write steps are rejected — use `poly_swarm_dispatch` with `role="author"` and `workspace_mode="share"` for code edits).
