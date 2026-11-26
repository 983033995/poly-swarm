---
name: poly-swarm
description: Dispatch local Poly Swarm CLI workers from the current Codex chat, reopen its workbench, or open global Poly Swarm settings. Use for requests such as 派发 agy/Cursor/Grok, 打开本聊天工作台, or 打开 Poly Swarm 总控.
---

# Poly Swarm in Codex

- **Open global settings / 总控**: call `poly_swarm_hub` with no arguments. This does not select a chat or start workers.
- **Open this chat / 本聊天工作台**: read the current `CODEX_THREAD_ID` from the Codex terminal (`printenv CODEX_THREAD_ID`; use `rtk proxy printenv CODEX_THREAD_ID` in an RTK workspace). Call `poly_swarm_open` with that exact `conversation_id` and `auto_select: false`. If the user selects a past receipt, use its explicit `swarm_id`. Never guess a chat ID or select a chat's task by repository, title, or recency. If no binding was found, say so and offer the global history.
- **Dispatch**: call `poly_swarm_dispatch` as an MCP tool in the current chat. Pass the exact current `CODEX_THREAD_ID` as `conversation_id`. For a new task, pass `title`, an absolute `repo_root`, and `workers`. To add members to this chat's task, pass `workers` without a new title. If the user named a CLI, set `backend` explicitly; keep `auto_fallback: false` when the user is comparing named backends. For read-only work use `role: verifier` or `researcher` and `workspace_mode: inherit`. If the current thread ID is unavailable, report that binding is unavailable instead of submitting an unbound task.
- **Keep a receipt in the chat**: after dispatch, report the returned task ID, worker names and their backends and a Markdown link to `workbench_url`. State that the task was dispatched; only report completion after checking the result. For a status update use `poly_swarm` with `action: status` and the task ID. Existing work keeps running when the chat closes.
- **Dispatch a named Talent Park employee**: use `poly_swarm(action="staff")` and pass the exact `staff_id`. Leave model/role unset unless requested. To dispatch directly to a named Antigravity company, use `poly_swarm(action="companies")` and pass its exact `company_id` instead of using the legacy `agy` backend alone.
- **Retain team members at the end**: when finishing a task (or before your final summary in a long chat), call `poly_swarm_recap` with the exact `CODEX_THREAD_ID` as `conversation_id` (`finish: true, summary: "..."` when complete, or `finish: false` for mid-session recap). In your final reply, retain a compact list (or `<details>` summary) of all invoked members and the `[打开本次工作台](workbench_url)` link so the user can reopen or inspect them anytime.
- **Open a returned URL**: use the Codex host tool `open_in_codex` with `placement: right` and a browser target if available. Always give the user the returned link so they can reopen it later. Use the exact URL the tool returned. Opening the workbench is a read action and never dispatches again.

Use only the installed MCP tools. Do not launch the provider CLIs directly, create a separate Codex chat, or write to the SQLite database from the shell. Poly Swarm's workers are external CLI members; Codex's native Subagents panel is separate.
