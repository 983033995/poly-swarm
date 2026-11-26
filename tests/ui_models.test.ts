import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardMessage, ConversationArchiveSummary, DashboardSnapshot, StaffRosterMember, WorkerDeliverableSummary, WorkerSummary } from "../src/shared/types.js";
import { renderMiniOfficeSvg } from "../src/ui/avatars_3d.js";
import { getPreferences, hydratePreferences, t } from "../src/ui/i18n.js";
import { renderAgyCompanyImport, renderGlobalCompanies, renderGlobalHistory, renderGlobalStaff, renderStaffEditorModal, renderTeamCards } from "../src/ui/views_global.js";
import { renderSessionPeople, renderTeamSummaryPreview, renderTeamSwitcher } from "../src/ui/views_session.js";
import {
  blackboardTagTone,
  dashboardTarget,
  deriveOkrTree,
  deriveSwarmPlan,
  filterAndSortConversationArchives,
  filterWorkersByStatus,
  formatShortRepoLabels,
  getLatestBlackboardSignal,
  graphEdgeKindLabel,
  groupBlackboard,
  isWorkerTaskDone,
  normalizeTab,
  pickDefaultReviewWave,
  policyLayerBadgeClass,
  policyLayerLabel,
  policyLayerShortLabel,
  projectBlackboard,
  projectDeliverables,
  readSessionHints,
  reconcileDraftAfterSave,
} from "../src/ui/swarm_view_model.js";

function makeWorker(overrides: Partial<WorkerSummary> & { name: string }): WorkerSummary {
  return {
    id: `wk-${overrides.name}`,
    swarm_id: "sw-test",
    name: overrides.name,
    role: overrides.role ?? "author",
    capability: overrides.capability ?? "author",
    backend: overrides.backend ?? "codex",
    model: overrides.model ?? "gpt-6.2-sol",
    effort: overrides.effort ?? "high",
    state: overrides.state ?? "waiting",
    workspace_mode: overrides.workspace_mode ?? "share",
    workspace_path: "/tmp/repo",
    worktree_branch: overrides.worktree_branch ?? null,
    session_id: null,
    needs_handoff: 0,
    auto_fallback: 1,
    review_of: overrides.review_of ?? null,
    channels_json: JSON.stringify(overrides.channels ?? ["main"]),
    last_read_seq: 0,
    last_post_seq: 0,
    last_error: null,
    created_at: 1000,
    updated_at: 1000,
    channels: overrides.channels ?? ["main"],
    latest_turn: overrides.latest_turn ?? null,
    latest_event: overrides.latest_event ?? null,
    usage: overrides.usage ?? {
      key: overrides.name,
      turns: 1,
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      duration_ms: 1200,
      tool_calls_count: 1,
      exact_turns: 1,
      hook_turns: 0,
      estimated_turns: 0,
    },
  };
}

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const now = 1_700_000_000_000;
  return {
    swarm: {
      id: "sw-test",
      title: "v0.4 Parity Swarm",
      repo_root: "/tmp/poly-swarm",
      base_branch: "main",
      status: "active",
      plan_json: null,
      created_at: now,
      updated_at: now,
    },
    swarms: [],
    plan: null,
    channels: [{ id: 1, swarm_id: "sw-test", name: "main", topic: "Main", archived: 0, created_at: now }],
    workers: [
      makeWorker({ name: "auditor-1", role: "author", backend: "codex" }),
      makeWorker({
        name: "verifier",
        role: "verifier",
        backend: "grok",
        review_of: "auditor-1",
        state: "working",
        usage: {
          key: "verifier",
          turns: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          duration_ms: 0,
          tool_calls_count: 0,
          exact_turns: 0,
          hook_turns: 0,
          estimated_turns: 0,
        },
      }),
    ],
    board_tail: [],
    backends: [],
    workflows: [],
    usage_totals: {
      key: "total",
      turns: 1,
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      duration_ms: 1200,
      tool_calls_count: 1,
      exact_turns: 1,
      hook_turns: 0,
      estimated_turns: 0,
    },
    usage_by_backend: [],
    usage_by_worker: [],
    ui_focus: {
      swarm_id: "sw-test",
      worker_name: "auditor-1",
      tab: "detail",
      seq: 1,
      updated_at: now,
      workbench_alive: true,
    },
    effective_defaults: {},
    backend_configs: {},
    generated_at: now,
    ...overrides,
  };
}

function boardMessage(seq: number, tag: BoardMessage["tag"], sender = "auditor-1"): BoardMessage {
  return {
    seq, tag, sender, swarm_id: "sw-test", channel: "main", text: `message ${seq}`,
    mentions_json: "[]", refs_json: "[]", turn_id: null, created_at: 1000 + seq,
  };
}

describe("Poly Swarm UI view models", () => {
  it("normalizes legacy tabs separately for the session and global entries", () => {
    assert.equal(normalizeTab("detail"), "detail");
    assert.equal(normalizeTab("graph"), "graph");
    assert.equal(normalizeTab("board"), "board");
    assert.equal(normalizeTab("usage"), "usage");
    assert.equal(normalizeTab("settings"), "detail");
    assert.equal(normalizeTab("overview"), "detail");
    assert.equal(normalizeTab("members"), "detail");
    assert.equal(normalizeTab(undefined), "detail");
    assert.equal(normalizeTab(undefined, "global"), "hr");
    assert.equal(normalizeTab("usage", "global"), "hr");
    assert.equal(normalizeTab("history", "global"), "history");
    assert.equal(normalizeTab("settings", "global"), "settings");

    assert.equal(policyLayerLabel("project"), "项目级 (300)");
    assert.equal(policyLayerShortLabel("session"), "会话");
    assert.equal(policyLayerBadgeClass("global_ui"), "layer-pill-global");
    assert.equal(graphEdgeKindLabel("review_pass"), "审校通过");
    assert.equal(graphEdgeKindLabel("fallback"), "容灾切换");
  });

  it("reconciles unsaved model/effort drafts when only enabled toggle is saved", () => {
    const draft = {
      enabled: false,
      defaultModel: "custom-model-v2",
      defaultEffort: "xhigh",
      customMode: true,
    };
    const afterToggleSave = reconcileDraftAfterSave(
      draft,
      { enabled: false, defaultModel: "old-model", defaultEffort: "high" },
      { enabled: false },
    );
    assert.ok(afterToggleSave);
    assert.equal(afterToggleSave.enabled, false);
    assert.equal(afterToggleSave.defaultModel, "custom-model-v2");
    assert.equal(afterToggleSave.defaultEffort, "xhigh");
    assert.equal(afterToggleSave.customMode, true);

    const afterFullSave = reconcileDraftAfterSave(
      afterToggleSave,
      { enabled: false, defaultModel: "custom-model-v2", defaultEffort: "xhigh" },
      { enabled: false, defaultModel: "custom-model-v2", defaultEffort: "xhigh" },
    );
    assert.equal(afterFullSave, null);
  });

  it("synthesizes plan threads when absent, backfills missing workers, and detects completion", () => {
    const t0 = 1_700_000_000_000;
    const snapNoPlan = makeSnapshot({
      board_tail: [
        {
          seq: 1,
          swarm_id: "sw-test",
          channel: "main",
          sender: "coordinator",
          tag: "brief",
          text: "@auditor-1 Audit engine internals and report gaps",
          mentions_json: '["auditor-1"]',
          refs_json: "[]",
          turn_id: null,
          created_at: t0,
        },
      ],
    });
    assert.equal(isWorkerTaskDone(snapNoPlan.workers[0]!, snapNoPlan.board_tail), false);
    assert.equal(isWorkerTaskDone(snapNoPlan.workers[1]!, snapNoPlan.board_tail), false);

    const derived = deriveSwarmPlan(snapNoPlan);
    assert.equal(derived.isSynthetic, true);
    assert.equal(derived.goal.title, "v0.4 Parity Swarm");
    assert.equal(derived.tasks["auditor-1"], "Audit engine internals and report gaps");
    assert.equal(derived.threads.length, 2);

    const snapWithPartialPlan = makeSnapshot({
      plan: {
        goal: { title: "Explicit Goal", line: "Line" },
        tasks: { "auditor-1": "Explicit task" },
        threads: [{ id: "t1", title: "Thread One", goal: "Goal 1", tasks: ["auditor-1"] }],
      },
    });
    const merged = deriveSwarmPlan(snapWithPartialPlan);
    assert.equal(merged.isSynthetic, false);
    assert.equal(merged.threads.length, 2);
    assert.ok(merged.threads[1]!.tasks.includes("verifier"));
  });

  it("keeps waiting seats idle until a completion signal and does not count blocked work as complete", () => {
    const plan = {
      goal: { title: "Work", line: "Verify the result" }, tasks: {},
      threads: [{ id: "t1", title: "Delivery", goal: "Record evidence", tasks: ["auditor-1", "verifier"] }],
    };
    const snap = makeSnapshot({ plan, board_tail: [boardMessage(1, "brief", "coordinator")] });
    assert.deepEqual(filterWorkersByStatus(snap.workers, "idle", snap).map((w) => w.name), ["auditor-1"]);
    assert.equal(deriveOkrTree(snap).done, 0);
    snap.board_tail.push(boardMessage(2, "done"));
    assert.deepEqual(filterWorkersByStatus(snap.workers, "acceptance", snap).map((w) => w.name), ["auditor-1"]);
    assert.equal(deriveOkrTree(snap).done, 1);
    snap.board_tail.push(boardMessage(3, "blocked"));
    assert.equal(deriveOkrTree(snap).done, 0);
    assert.deepEqual(filterWorkersByStatus(snap.workers, "risk", snap).map((w) => w.name), ["auditor-1"]);
    snap.board_tail.push({ ...boardMessage(4, "brief", "coordinator"), text: "@auditor-1 a new assignment" });
    assert.deepEqual(filterWorkersByStatus(snap.workers, "idle", snap).map((w) => w.name), ["auditor-1"]);
  });

  it("uses the durable blackboard when present and falls back to recent signals otherwise", () => {
    const snap = makeSnapshot({
      board_tail: [boardMessage(2, "brief"), boardMessage(3, "review_pass"), boardMessage(4, "update"), boardMessage(5, "stall")],
    });
    assert.deepEqual(projectBlackboard(snap).map((m) => m.seq), [5, 3, 2]);
    assert.deepEqual(Object.fromEntries(Object.entries(groupBlackboard(snap)).map(([key, rows]) => [key, rows.map((m) => m.seq)])), {
      risks: [5], results: [3], briefs: [2],
    });
    assert.deepEqual(projectBlackboard({ ...snap, blackboard_messages: [] }), []);
    assert.deepEqual(projectBlackboard({ ...snap, blackboard_messages: [boardMessage(2, "blocked"), boardMessage(1, "done")] }).map((m) => m.seq), [2, 1]);
  });

  it("allows the UI merge only for the clean, independently reviewed HEAD on an active worktree branch", () => {
    const worker = makeWorker({ name: "auditor-1", worktree_branch: "sw/auditor", workspace_mode: "branch" });
    const snap = makeSnapshot({ workers: [worker] });
    const reviewed: WorkerDeliverableSummary = {
      worker_name: worker.name, branch: worker.worktree_branch, target_branch: "main", head_sha: "abc1234",
      dirty: false, dirty_files: [], latest_review: boardMessage(3, "review_pass", "verifier"),
      reviewed_sha: "abc1234", needs_independent_reviewer: false, sha_matches: true, stale: false,
    };
    const project = (patch: Partial<WorkerDeliverableSummary> = {}, options: Partial<DashboardSnapshot> = {}) =>
      projectDeliverables({ ...snap, ...options, deliverables: { [worker.name]: { ...reviewed, ...patch } } })[0]!;
    assert.equal(project().canMerge, true);
    assert.equal(project({ head_sha: "def1234", sha_matches: false, stale: true }).status, "stale");
    for (const patch of [{ dirty: true }, { sha_matches: false }, { needs_independent_reviewer: true }, { target_branch: null }, { branch: "unrelated" }, { latest_review: boardMessage(4, "review_fail", "verifier") }]) {
      assert.equal(project(patch).canMerge, false, JSON.stringify(patch));
    }
    assert.equal(project({}, { read_only_reason: "History" }).canMerge, false);
    assert.equal(project({}, { workers: [{ ...worker, state: "working" }] }).canMerge, false);
  });

  it("escapes office SVG seat names and keeps USD and unpriced turns visible in both languages", () => {
    const name = 'seat" onmouseover="<svg>';
    const snap = makeSnapshot();
    const usage = { ...snap.usage_totals, known_cost_usd: 0.012, priced_turns: 1, unpriced_turns: 2 };
    snap.usage_totals = usage;
    snap.workers = [makeWorker({ name, usage })];
    const svg = renderMiniOfficeSvg(snap.workers);
    assert.ok(svg.includes('data-worker="seat&quot; onmouseover=&quot;&lt;svg&gt;"'));
    assert.ok(!svg.includes(`data-worker="${name}"`));
    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      assert.match(renderSessionPeople(snap), /订阅制 · 未计价 \(2\)/);
      for (const key of ["switchTeam", "copyHandoff", "teamAttached"] as const) {
        assert.notEqual(t(key), key);
        assert.ok(t(key).length > 0);
      }
      hydratePreferences({ ...prior, language: "en" });
      assert.equal(t("reassign"), "Reassign");
      for (const key of ["switchTeam", "copyHandoff", "teamAttached"] as const) {
        assert.notEqual(t(key), key);
        assert.ok(t(key).length > 0);
      }
      assert.match(renderSessionPeople(snap), /\$0\.0120/);
      assert.match(renderSessionPeople(snap), /Subscription · unpriced \(2\)/);
    } finally {
      hydratePreferences(prior);
    }
  });

  it("enables workbench fallback auto_select without session hints, disables when conversationId exists, reads nested hints, and marks fallback models", () => {
    const targetNoHints = dashboardTarget({
      surface: "workbench",
      swarmId: null,
      teamId: null,
      conversationId: null,
      repoRoot: null,
    });
    assert.equal(targetNoHints.args.surface, "workbench");
    assert.equal(targetNoHints.args.auto_select, true);

    const targetWithChat = dashboardTarget({
      surface: "workbench",
      swarmId: null,
      teamId: null,
      conversationId: "chat-new",
      repoRoot: null,
    });
    assert.equal(targetWithChat.args.surface, "workbench");
    assert.equal(targetWithChat.args.auto_select, false);

    assert.deepEqual(
      readSessionHints({
        "com.google.antigravity/conversationId": "chat-ns",
        host: { workspacePath: "file:///tmp/my-repo" },
      }),
      { conversationId: "chat-ns", repoRoot: "/tmp/my-repo" },
    );

    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const snap = makeSnapshot();
      const html = renderGlobalCompanies(snap, {
        selectedVendor: "codex",
        savingBackends: new Set(),
        backendModels: {
          codex: [
            { id: "live-model", label: "Live Model", source: "detected", detected_at: 1000 },
            { id: "static-model", label: "Static Model", source: "fallback", detected_at: null },
          ],
        },
        modelsLoading: false,
        draft: () => ({ enabled: true, defaultModel: "", defaultEffort: "", customMode: false }),
        saved: () => ({ enabled: true }),
        isDirty: () => false,
      });
      assert.ok(html.includes("Static Model · static-model [静态]"));
      assert.equal(html.includes("Live Model · live-model [静态]"), false);
    } finally {
      hydratePreferences(prior);
    }
  });

  it("renders curated editable staff roster cards and recruit/edit modal", () => {
    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const curatedRoster: StaffRosterMember[] = [
        { id: "st-aria", name: "Aria", title: "首席架构师", avatar: "aria", backend: "codex", model: "gpt-6.2-sol", effort: "xhigh", role: "author", capability: "architect", bio: "负责系统边界拆分", enabled: true, created_at: 1000, updated_at: 1000 },
        { id: "st-leo", name: "Leo", title: "全栈主力开发", avatar: "leo", backend: "codex", model: "gpt-6.2-sol", effort: "high", role: "author", capability: "author", bio: "主力编码与单测", enabled: true, created_at: 1000, updated_at: 1000 },
        { id: "st-theo", name: "Theo", title: "独立审校官", avatar: "theo", backend: "cursor", model: "grok-4.7-high-fast", role: "verifier", capability: "verifier", bio: "交叉复核源码", enabled: true, created_at: 1000, updated_at: 1000 },
        { id: "st-jules", name: "Jules", title: "前端交互设计师", avatar: "jules", backend: "codebuddy", model: "kimi-k3.1-pro", role: "author", capability: "author", bio: "负责界面与动效", enabled: true, created_at: 1000, updated_at: 1000 },
        { id: "st-mia", name: "Mia", title: "调研情报员", avatar: "mia", backend: "grok", model: "grok-4.7", role: "researcher", capability: "research", bio: "文档资料检索", enabled: true, created_at: 1000, updated_at: 1000 },
      ];
      const snap = makeSnapshot({ staff_roster: curatedRoster });
      const catalog = {
        codex: Array.from({ length: 12 }, (_, idx) => ({
          id: `unlisted-model-${idx}`,
          label: `Unlisted Model ${idx}`,
          source: "detected" as const,
          detected_at: 1000,
        })),
      };
      const staffHtml = renderGlobalStaff(snap, catalog, "all", "", false);
      for (const m of curatedRoster) {
        assert.ok(staffHtml.includes(m.name), `missing curated member ${m.name}`);
      }
      assert.ok(staffHtml.includes('data-action="open-staff-recruit"'));
      assert.ok(staffHtml.includes('data-action="edit-staff-member"'));
      assert.ok(staffHtml.includes('data-action="reset-staff-roster"'));
      assert.equal(staffHtml.includes("Unlisted Model 9"), false);

      const createModal = renderStaffEditorModal({
        draft: {
          mode: "create",
          id: "",
          name: "Nova",
          title: "视频编导",
          avatar: "mia",
          backend: "codex",
          model: "gpt-6.2-sol",
          effort: "high",
          role: "author",
          capability: "author",
          identity_id: "impl",
          bio: "分镜合成",
          enabled: true,
        },
        catalog,
        busy: false,
        loadingModels: false,
      });
      assert.ok(createModal.includes("招募员工"));
      assert.ok(createModal.includes('data-action="pick-staff-avatar"'));
      assert.ok(createModal.includes('data-action="save-staff-member"'));
      assert.equal(createModal.includes('data-action="delete-staff-member"'), false);

      const editModal = renderStaffEditorModal({
        draft: {
          mode: "edit",
          id: "st-aria",
          name: "Aria",
          title: "首席架构师",
          avatar: "aria",
          backend: "codex",
          model: "gpt-6.2-sol",
          effort: "xhigh",
          role: "author",
          capability: "architect",
          identity_id: "arch",
          bio: "负责系统边界拆分",
          enabled: true,
        },
        catalog,
        busy: false,
        loadingModels: false,
      });
      assert.ok(editModal.includes('data-action="delete-staff-member" data-staff-id="st-aria"'));
    } finally {
      hydratePreferences(prior);
    }
  });

  it("renders AGY accounts as distinct companies and only offers company selection when recruiting", () => {
    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const company = (id: string, name: string, default_model: string) => ({
        id: "agy-" + id, name, default_model, default_effort: "high", enabled: true,
        account_available: true, cooldown_until: null,
      });
      const a = company("a".repeat(24), "主号公司", "model-a");
      const b = company("b".repeat(24), "副号公司", "model-b");
      const snap = makeSnapshot({
        agy_companies: [a, b],
        agy_company_usage: [{ ...makeWorker({ name: "fixture" }).usage, key: b.id, turns: 3, total_tokens: 456 }],
      });
      const html = renderGlobalCompanies(snap, {
        selectedVendor: "agy", selectedAgyCompany: b.id, savingBackends: new Set(),
        backendModels: { agy: [{ id: "legacy-only", label: "Legacy-only model" }] }, modelsLoading: false,
        agyCompanyModels: { models: [{ id: "b-only", label: "B-only model" }], loading: false, fetchedAt: 1 },
        draft: () => ({ enabled: true, defaultModel: "", defaultEffort: "", customMode: false }),
        saved: () => ({ enabled: true }),
        isDirty: () => false,
      });
      assert.ok(html.includes(`data-company="${a.id}" aria-pressed="false"`));
      assert.ok(html.includes(`data-company="${b.id}" aria-pressed="true"`));
      assert.ok(html.includes('data-agy-company-field="model" value="model-b"'));
      assert.ok(html.includes("<strong>456</strong>"));
      assert.ok(html.includes("B-only model"));
      assert.ok(!html.includes("Legacy-only model"));
      const editor = renderStaffEditorModal({
        draft: {
          mode: "create", id: "", name: "", title: "", backend: "agy", company_id: b.id, avatar: "aria",
          model: "", effort: "", identity_id: "", bio: "", role: "author", capability: "author", enabled: true,
        },
        catalog: { agy: [{ id: "legacy-only" }] }, busy: false, loadingModels: false, agyCompanies: [a, b],
        agyCompanyModels: { models: [{ id: "b-only" }], loading: false, fetchedAt: 1 },
      });
      assert.ok(editor.includes(`value="${b.id}" selected>副号公司`));
      assert.ok(editor.includes("使用公司默认 · model-b"));
      assert.ok(!editor.includes("staff-edit-agy-account"));
      assert.ok(!editor.includes('value="agy"'));
      assert.ok(editor.includes('value="b-only"'));
      assert.ok(!editor.includes("legacy-only"));
      const modal = renderAgyCompanyImport({
        open: true, loading: false, failed: false, saving: false, companies: [a], picked: new Set(),
        accounts: [{ id: a.id.slice(4), email: "saved@example.invalid" }, { id: b.id.slice(4), email: "new@example.invalid" }],
      });
      assert.ok(modal.includes("new@example.invalid"));
      assert.ok(!modal.includes("saved@example.invalid"));
    } finally {
      hydratePreferences(prior);
    }
  });

  it("formats short disambiguated repo labels, picks max seq signal, and renders conversation-centric project archive views", () => {
    const labels = formatShortRepoLabels([
      "/Volumes/disk/work/poly-swarm",
      "/Volumes/disk/backup/poly-swarm",
      "/Volumes/disk/skills/akb",
    ]);
    assert.equal(labels.get("/Volumes/disk/work/poly-swarm"), "work/poly-swarm");
    assert.equal(labels.get("/Volumes/disk/backup/poly-swarm"), "backup/poly-swarm");
    assert.equal(labels.get("/Volumes/disk/skills/akb"), "akb");

    const latestSig = getLatestBlackboardSignal([
      boardMessage(3, "brief"),
      boardMessage(9, "review_pass"),
      boardMessage(5, "blocked"),
    ]);
    assert.equal(latestSig?.seq, 9);
    assert.equal(blackboardTagTone("review_pass"), "ok");
    assert.equal(blackboardTagTone("blocked"), "risk");
    assert.equal(blackboardTagTone("brief"), "info");

    const now = 1_700_000_000_000;
    const convCur: ConversationArchiveSummary = {
      conversation_id: "conv-111111",
      title: 'Session <script>alert("x")</script>',
      custom_title: null,
      host_title: 'Session <script>alert("x")</script>',
      title_source: "host",
      is_current: true,
      bound_team_id: "tm-1",
      bound_swarm_id: "sw-1",
      repo_roots: ["/tmp/repo-a"],
      primary_repo_root: "/tmp/repo-a",
      team_ids: ["tm-1"],
      wave_count: 2,
      real_wave_count: 1,
      workflow_wave_count: 1,
      worker_count: 3,
      backends: ["codex", "cursor"],
      known_cost_usd: 0.42,
      priced_turns: 1,
      unpriced_turns: 1,
      total_tokens: 1500,
      latest_signal: { seq: 12, tag: "review_pass", sender: "verifier", created_at: now, swarm_id: "sw-1" },
      last_activity_at: now,
      updated_at: now,
      usage: {
        turns: 2,
        tool_calls_count: 14,
        duration_ms: 90_000,
        avg_output_tps: 1.7,
        total_tokens: 1500,
        uncached_input_tokens: 300,
        cache_read_tokens: 1050,
        cache_write_tokens: 0,
        total_input_tokens: 1350,
        output_tokens: 150,
        reasoning_tokens: 0,
        cache_hit_rate: 1050 / 1350,
        known_cost_usd: 0.42,
        estimated_cost_usd: 0.08,
        priced_turns: 1,
        unpriced_turns: 1,
        exact_turns: 2,
        hook_turns: 0,
        estimated_turns: 0,
        by_backend: [
          {
            backend: "codex",
            model: "gpt-6.2-sol",
            turns: 1,
            total_tokens: 1300,
            uncached_input_tokens: 200,
            cache_read_tokens: 1000,
            cache_write_tokens: 0,
            output_tokens: 100,
            reasoning_tokens: 0,
            cache_hit_rate: 1000 / 1200,
            known_cost_usd: 0,
            estimated_cost_usd: 0.08,
            priced_turns: 0,
            unpriced_turns: 1,
            duration_ms: 60_000,
            tool_calls_count: 10,
          },
        ],
      },
      waves: [
        {
          swarm: { id: "sw-wf", title: "Workflow: Check", repo_root: "/tmp/repo-a", base_branch: "main", status: "done", plan_json: null, auto_created_by_workflow: 1, created_at: now, updated_at: now },
          team_id: "tm-1", team_name: "Team 1", team_status: "paused", is_workflow: true, is_manual_assignment: false,
          worker_count: 0, active_worker_count: 0, backends: ["codex"], known_cost_usd: 0, priced_turns: 0, unpriced_turns: 0, total_tokens: 200,
          latest_signal: null, last_activity_at: now,
          usage: {
            turns: 0, tool_calls_count: 0, duration_ms: 0, avg_output_tps: null, total_tokens: 200,
            uncached_input_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, total_input_tokens: 200,
            output_tokens: 0, reasoning_tokens: 0, cache_hit_rate: null, known_cost_usd: 0, estimated_cost_usd: 0,
            priced_turns: 0, unpriced_turns: 0, exact_turns: 0, hook_turns: 0, estimated_turns: 0, by_backend: [],
          },
        },
        {
          swarm: { id: "sw-1", title: "Main Wave", repo_root: "/tmp/repo-a", base_branch: "main", status: "active", plan_json: null, auto_created_by_workflow: 0, created_at: now - 1000, updated_at: now - 1000 },
          team_id: "tm-1", team_name: "Team 1", team_status: "active", is_workflow: false, is_manual_assignment: false,
          worker_count: 3, active_worker_count: 2, backends: ["codex", "cursor"], known_cost_usd: 0.42, priced_turns: 1, unpriced_turns: 0, total_tokens: 1300,
          latest_signal: { seq: 12, tag: "review_pass", sender: "verifier", created_at: now }, last_activity_at: now - 1000,
          usage: {
            turns: 1, tool_calls_count: 10, duration_ms: 60_000, avg_output_tps: 1.7, total_tokens: 1300,
            uncached_input_tokens: 200, cache_read_tokens: 1000, cache_write_tokens: 0, total_input_tokens: 1200,
            output_tokens: 100, reasoning_tokens: 0, cache_hit_rate: 1000 / 1200, known_cost_usd: 0.42, estimated_cost_usd: 0,
            priced_turns: 1, unpriced_turns: 0, exact_turns: 1, hook_turns: 0, estimated_turns: 0, by_backend: [],
          },
        },
      ],
    };
    const convOther: ConversationArchiveSummary = {
      ...convCur,
      conversation_id: "conv-222222",
      title: null,
      host_title: null,
      title_source: "none",
      is_current: false,
      bound_team_id: "tm-2",
      bound_swarm_id: "sw-2",
      repo_roots: ["/tmp/repo-b"],
      primary_repo_root: "/tmp/repo-b",
      team_ids: ["tm-2"],
      wave_count: 1,
      priced_turns: 0,
      known_cost_usd: 0,
      latest_signal: null,
      last_activity_at: now - 5000,
      usage: { ...convCur.usage, priced_turns: 0, known_cost_usd: 0, estimated_cost_usd: 0.12 },
      waves: [{ ...convCur.waves[1]!, swarm: { ...convCur.waves[1]!.swarm, id: "sw-2", title: "", repo_root: "/tmp/repo-b" } }],
    };

    assert.equal(pickDefaultReviewWave(convCur.waves)?.swarm.id, "sw-1");
    assert.equal(filterAndSortConversationArchives([convCur, convOther], { query: "repo-b", repo: "all", sort: "recent" }).length, 1);

    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const snap = makeSnapshot({
        conversation_archives: {
          sessions: [convCur, convOther],
          unassigned_waves: [{ ...convOther.waves[0]!, swarm: { ...convOther.waves[0]!.swarm, id: "sw-old", title: "Old Call" } }],
          total_sessions: 2,
          total_unassigned: 1,
        },
      });
      const baseState = {
        query: "", repoFilter: "all", sort: "recent" as const, viewMode: "cards" as const,
        selectedConvId: null, unassignedOpen: true, renamingConvId: null,
        busy: false, canSendMessage: false, canBackToSession: false,
        currentConversationId: "conv-111111", currentTeamId: "tm-1",
      };
      const listHtml = renderGlobalHistory(snap, baseState);
      assert.ok(listHtml.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
      assert.equal(listHtml.includes("<script>alert"), false);
      assert.ok(listHtml.includes("本窗口"));
      assert.ok(listHtml.includes("未命名会话 · conv-222"));
      assert.ok(listHtml.includes("缓存命中 78%"));
      assert.ok(listHtml.includes("未归属的历史调用"));
      assert.ok(listHtml.includes("Old Call"));
      assert.ok(listHtml.includes("#12 · 审校通过"));

      const detailGlobalHtml = renderGlobalHistory(snap, { ...baseState, selectedConvId: "conv-222222" });
      assert.ok(detailGlobalHtml.includes('data-action="copy-conv-id"'));
      assert.equal(detailGlobalHtml.includes('data-action="insert-conv-link"'), false);

      const detailAuxHtml = renderGlobalHistory(snap, { ...baseState, selectedConvId: "conv-222222", canSendMessage: true });
      assert.ok(detailAuxHtml.includes('data-action="insert-conv-link"'));

      const detailCurrentHtml = renderGlobalHistory(snap, { ...baseState, selectedConvId: "conv-111111", canBackToSession: true });
      assert.ok(detailCurrentHtml.includes('data-action="back-session"'));
      assert.ok(detailCurrentHtml.includes("Token 用量（外包团队）"));
      assert.ok(detailCurrentHtml.includes("缓存命中"));
      assert.ok(detailCurrentHtml.includes("未缓存输入"));
      assert.ok(detailCurrentHtml.includes("缓存读取"));
      assert.ok(detailCurrentHtml.includes("订阅参考估算"));
      assert.ok(detailCurrentHtml.includes("执行统计"));
      assert.ok(detailCurrentHtml.includes("gpt-6.2-sol"));

      const cardsHtml = renderTeamCards([
        {
          team: { id: "tm-1", name: "T1", goal: null, repo_root: "/tmp/repo-a", status: "active", active_swarm_id: "sw-1", created_at: now, updated_at: now },
          waves: [convCur.waves[1]!.swarm],
          wave_count: 1,
          bound_conversations: 1,
          is_bound_to_current: true,
          latest_blackboard: [boardMessage(2, "brief"), boardMessage(8, "done")],
          worker_count: 2,
          active_worker_count: 1,
          backends: ["codex"],
          known_cost_usd: 0,
          priced_turns: 0,
          unpriced_turns: 1,
          total_tokens: 500,
        },
      ], { density: "rail", intent: "attach" });
      assert.ok(cardsHtml.includes("is-rail"));
      assert.ok(cardsHtml.includes("启用"));
      assert.equal(cardsHtml.includes(">—<"), false);
    } finally {
      hydratePreferences(prior);
    }
  });

  it("separates the current team from its waves and keeps history read-only", () => {
    const base = makeSnapshot();
    const first = { ...base.swarm!, id: "first", title: "Initial repair", wave_index: 1, status: "done" as const };
    const current = { ...base.swarm!, id: "current", title: "Wave 3: Production validation", wave_index: 6 };
    const team = { id: "tm-proof", name: first.title, goal: null, repo_root: "/tmp/agent-knowledge-base",
      status: "active" as const, active_swarm_id: current.id, created_at: 1, updated_at: 1 };
    const counts = { active_worker_count: 0, backends: [], known_cost_usd: 0, priced_turns: 0, unpriced_turns: 0, total_tokens: 0 };
    const snap = makeSnapshot({ team, swarm: current, team_waves: [current, first], swarm_summaries: {
      [current.id]: { ...counts, worker_count: 2 },
      [first.id]: { ...counts, worker_count: 30 },
    } });
    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const switcher = renderTeamSwitcher(snap, team.id, false);
      assert.match(switcher, /agent-knowledge-base.*第 6 轮/);
      assert.doesNotMatch(switcher, /Wave 3:/);
      const live = renderTeamSummaryPreview(snap, { history: false, canManage: true, busy: false });
      assert.match(live, /本轮 <b>2<\/b> 席/);
      assert.match(live, /历史累计 <b>32<\/b> 席次/);
      assert.match(live, /data-action="open-history-swarm" data-swarm-id="first" data-team-id="tm-proof"/);
      assert.doesNotMatch(live, /data-action="open-history-swarm" data-swarm-id="current"/);
      assert.match(live, /id="team-new-wave-form" data-team-id="tm-proof"/);
      assert.match(live, /id="team-rename-form" data-team-id="tm-proof"/);
      const history = renderTeamSummaryPreview({ ...snap, swarm: first }, { history: true, canManage: false, busy: false });
      assert.match(history, /正在回看/);
      assert.doesNotMatch(history, /team-new-wave-form|team-rename-form|data-action="attach-team"/);
      assert.match(renderTeamSwitcher({ ...snap, team: { ...team, name: "AKB Platform" } }, team.id, false), /AKB Platform/);
    } finally {
      hydratePreferences(prior);
    }
  });

  it("renders per-wave and per-turn consumption in session people and per-model breakdowns in vendor campus", () => {
    const now = 1_700_000_000_000;
    const prior = getPreferences();
    try {
      hydratePreferences({ ...prior, language: "zh-CN" });
      const snap = makeSnapshot({
        session_usage_breakdown: {
          turns: 2,
          tool_calls_count: 9,
          duration_ms: 45_000,
          avg_output_tps: 12.4,
          total_tokens: 18_500,
          uncached_input_tokens: 2_500,
          cache_read_tokens: 15_000,
          cache_write_tokens: 200,
          total_input_tokens: 17_700,
          output_tokens: 700,
          reasoning_tokens: 100,
          cache_hit_rate: 15_000 / 17_700,
          known_cost_usd: 0.042,
          estimated_cost_usd: 0.015,
          priced_turns: 1,
          unpriced_turns: 1,
          exact_turns: 2,
          hook_turns: 0,
          estimated_turns: 0,
          by_backend: [
            {
              backend: "codex",
              model: "gpt-6.2-sol",
              turns: 1,
              total_tokens: 10_000,
              uncached_input_tokens: 1_500,
              cache_read_tokens: 8_000,
              cache_write_tokens: 0,
              output_tokens: 500,
              reasoning_tokens: 0,
              cache_hit_rate: 8_000 / 9_500,
              known_cost_usd: 0,
              estimated_cost_usd: 0.015,
              priced_turns: 0,
              unpriced_turns: 1,
              duration_ms: 30_000,
              tool_calls_count: 6,
            },
          ],
        },
        session_usage_by_worker: {
          "auditor-1": {
            turns: 1,
            tool_calls_count: 6,
            duration_ms: 30_000,
            avg_output_tps: 16.7,
            total_tokens: 10_000,
            uncached_input_tokens: 1_500,
            cache_read_tokens: 8_000,
            cache_write_tokens: 0,
            total_input_tokens: 9_500,
            output_tokens: 500,
            reasoning_tokens: 0,
            cache_hit_rate: 8_000 / 9_500,
            known_cost_usd: 0,
            estimated_cost_usd: 0.015,
            priced_turns: 0,
            unpriced_turns: 1,
            exact_turns: 1,
            hook_turns: 0,
            estimated_turns: 0,
            by_backend: [],
          },
        },
        session_turn_usages: [
          {
            turn_id: "turn-xss",
            worker_name: "auditor-1",
            backend: "codex",
            model: "gpt-6.2-sol",
            accuracy: "exact",
            status: "completed",
            trigger_seq: 11,
            prompt_preview: 'Run <script>alert("turn")</script> audit',
            uncached_input_tokens: 1_500,
            cache_read_tokens: 8_000,
            cache_write_tokens: 0,
            total_input_tokens: 9_500,
            output_tokens: 500,
            reasoning_tokens: 0,
            total_tokens: 10_000,
            cache_hit_rate: 8_000 / 9_500,
            cost_usd: null,
            estimated_cost_usd: 0.015,
            duration_ms: 30_000,
            tool_calls_count: 6,
            created_at: now,
          },
        ],
        global_usage_by_vendor: {
          codex: {
            backend: "codex",
            totals: {
              turns: 3,
              tool_calls_count: 18,
              duration_ms: 95_000,
              avg_output_tps: 14.2,
              total_tokens: 55_000,
              uncached_input_tokens: 5_000,
              cache_read_tokens: 48_000,
              cache_write_tokens: 500,
              total_input_tokens: 53_500,
              output_tokens: 1_300,
              reasoning_tokens: 200,
              cache_hit_rate: 48_000 / 53_500,
              known_cost_usd: 0.18,
              estimated_cost_usd: 0.064,
              priced_turns: 1,
              unpriced_turns: 2,
              exact_turns: 3,
              hook_turns: 0,
              estimated_turns: 0,
              by_backend: [],
            },
            models: [
              {
                backend: "codex",
                model: "gpt-6.2-sol",
                turns: 2,
                total_tokens: 45_000,
                uncached_input_tokens: 4_000,
                cache_read_tokens: 39_500,
                cache_write_tokens: 500,
                output_tokens: 900,
                reasoning_tokens: 100,
                cache_hit_rate: 39_500 / 44_000,
                known_cost_usd: 0,
                estimated_cost_usd: 0.064,
                priced_turns: 0,
                unpriced_turns: 2,
                duration_ms: 75_000,
                tool_calls_count: 14,
              },
              {
                backend: "codex",
                model: null,
                turns: 1,
                total_tokens: 10_000,
                uncached_input_tokens: 1_000,
                cache_read_tokens: 8_500,
                cache_write_tokens: 0,
                output_tokens: 400,
                reasoning_tokens: 100,
                cache_hit_rate: 8_500 / 9_500,
                known_cost_usd: 0.18,
                estimated_cost_usd: 0,
                priced_turns: 1,
                unpriced_turns: 0,
                duration_ms: 20_000,
                tool_calls_count: 4,
              },
            ],
          },
        },
      });

      const peopleHtml = renderSessionPeople(snap);
      assert.ok(peopleHtml.includes("当前一轮调用消耗"));
      assert.ok(peopleHtml.includes("本轮逐次调用明细"));
      assert.ok(peopleHtml.includes('data-action="open-worker-turn" data-worker="auditor-1" data-turn="turn-xss"'));
      assert.ok(peopleHtml.includes("18,500 tok"));
      assert.ok(peopleHtml.includes("&lt;script&gt;alert(&quot;turn&quot;)&lt;/script&gt;"));
      assert.equal(peopleHtml.includes("<script>alert"), false);

      const campusHtml = renderGlobalCompanies(snap, {
        selectedVendor: "codex",
        savingBackends: new Set(),
        backendModels: { codex: [{ id: "gpt-6.2-sol", label: "GPT 6.2 Sol", source: "detected", detected_at: now }] },
        modelsLoading: false,
        draft: () => ({ enabled: true, defaultModel: "", defaultEffort: "", customMode: false }),
        saved: () => ({ enabled: true }),
        isDirty: () => false,
      });
      assert.ok(campusHtml.includes("调用与计费统计 · 该公司总计"));
      assert.ok(campusHtml.includes("按模型统计明细 (2)"));
      assert.ok(campusHtml.includes("45,000 tok"));
      assert.ok(campusHtml.includes("gpt-6.2-sol"));
      assert.ok(campusHtml.includes("CLI 默认"));
      assert.ok(campusHtml.includes("缓存写入"));
      assert.ok(campusHtml.includes("推理思考"));
    } finally {
      hydratePreferences(prior);
    }
  });
});
