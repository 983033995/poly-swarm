import type {
  BackendId,
  BoardMessage,
  DispatchEdgeRecord,
  DispatchGraph,
  DispatchGraphEdge,
  DispatchGraphNode,
  GraphEdgeKind,
  PolicyLayer,
  ResolvedDispatchPolicy,
  SwarmRecord,
  UsageAggregate,
  WorkerPolicySnapshot,
  WorkerRecord,
  WorkflowDefinition,
  WorkflowRecord,
} from "../shared/types.js";
import { parseMessageSignals } from "./db.js";

function parseJsonSafe<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function workerLayer(role: WorkerRecord["role"], identityId?: string | null): number {
  if (identityId === "architect" || role === "researcher") return 1;
  if (role === "verifier") return 3;
  return 2;
}

function identityLayer(role: WorkerRecord["role"], identityId: string): number {
  if (identityId === "architect" || role === "researcher") return 1;
  if (role === "verifier") return 3;
  return 2;
}

function pickPlannedBackend(
  policy: ResolvedDispatchPolicy,
  identityId: string,
): { backend: BackendId | null; model: string | null; policySource: PolicyLayer | null } {
  const ident = policy.identities[identityId];
  if (!ident) {
    return { backend: null, model: null, policySource: null };
  }
  const candidates =
    ident.preferred_backends && ident.preferred_backends.length > 0
      ? ident.preferred_backends
      : policy.routes[ident.capability] ?? policy.routes.author;
  const chosen =
    candidates.find((b) => policy.backends[b]?.enabled !== false) ?? candidates[0] ?? null;
  const model =
    ident.model ?? (chosen ? policy.backends[chosen]?.defaultModel ?? null : null);
  return {
    backend: chosen,
    model,
    policySource: ident.source,
  };
}

function backfillEdgesFromHistory(input: {
  swarm: SwarmRecord;
  workers: WorkerRecord[];
  boardMessages: BoardMessage[];
  workflows: WorkflowRecord[];
}): DispatchEdgeRecord[] {
  const out: DispatchEdgeRecord[] = [];
  let syntheticId = 1;
  const workerSet = new Set(input.workers.map((w) => w.name));
  const workerByName = new Map(input.workers.map((w) => [w.name, w]));

  const pushEdge = (e: {
    from_node: string;
    to_node: string;
    kind: GraphEdgeKind;
    seq?: number | null;
    turn_id?: string | null;
    label?: string | null;
    meta?: Record<string, unknown> | null;
    created_at: number;
  }) => {
    out.push({
      id: syntheticId++,
      swarm_id: input.swarm.id,
      from_node: e.from_node,
      to_node: e.to_node,
      kind: e.kind,
      seq: e.seq ?? null,
      turn_id: e.turn_id ?? null,
      label: e.label ?? null,
      meta_json: e.meta ? JSON.stringify(e.meta) : null,
      created_at: e.created_at,
    });
  };

  for (const w of input.workers) {
    const briefMsg = input.boardMessages.find((m) => {
      if (m.tag !== "brief" || m.sender !== "coordinator") return false;
      return parseMessageSignals(m.text).mentions.includes(w.name.toLowerCase());
    });
    const snap = parseJsonSafe<WorkerPolicySnapshot>(w.resolved_policy_json);
    pushEdge({
      from_node: w.parent_node || "coordinator",
      to_node: w.name,
      kind: "dispatch",
      seq: briefMsg?.seq ?? null,
      label: `${w.identity_id || w.role} (${w.backend})`,
      created_at: briefMsg?.created_at ?? w.created_at,
    });
    if (snap?.reports_to && snap.reports_to !== (w.parent_node || "coordinator")) {
      pushEdge({
        from_node: w.name,
        to_node: snap.reports_to,
        kind: "reports_to",
        created_at: w.created_at,
      });
    }
    if (w.review_of && workerSet.has(w.review_of)) {
      pushEdge({
        from_node: w.name,
        to_node: w.review_of,
        kind: "review",
        label: "只读审校",
        created_at: w.created_at,
      });
    }
  }

  for (const m of input.boardMessages) {
    if (m.tag === "brief") continue;
    const sig = parseMessageSignals(m.text);

    if (m.tag === "system") {
      if (m.text.startsWith("[handoff]") || m.text.startsWith("[switch]")) {
        const target = sig.mentions.find((n) => workerSet.has(n));
        if (target) {
          pushEdge({
            from_node: target,
            to_node: target,
            kind: "fallback",
            seq: m.seq,
            label: m.text.slice(0, 80),
            created_at: m.created_at,
          });
        }
      } else if (m.text.startsWith("[merged]")) {
        const target = sig.mentions.find((n) => workerSet.has(n));
        if (target) {
          pushEdge({
            from_node: target,
            to_node: "repo",
            kind: "merge",
            seq: m.seq,
            label: "合并到主干",
            meta: { ok: true },
            created_at: m.created_at,
          });
        }
      }
      continue;
    }

    const senderWorker = workerByName.get(m.sender);
    if (m.tag === "review_pass" || m.tag === "review_fail") {
      const target =
        senderWorker?.review_of && workerSet.has(senderWorker.review_of)
          ? senderWorker.review_of
          : sig.mentions.find((n) => workerSet.has(n) && n !== m.sender);
      if (target) {
        pushEdge({
          from_node: m.sender,
          to_node: target,
          kind: m.tag,
          seq: m.seq,
          turn_id: m.turn_id,
          label: m.tag === "review_pass" ? "审校通过" : "审校打回",
          created_at: m.created_at,
        });
      }
    }

    const targets = sig.hasAll
      ? input.workers.map((w) => w.name).filter((n) => n !== m.sender)
      : sig.mentions.filter(
          (n) => (workerSet.has(n) || n === "coordinator") && n !== m.sender,
        );
    for (const target of targets) {
      if (
        (m.tag === "review_pass" || m.tag === "review_fail") &&
        senderWorker?.review_of === target
      ) {
        continue;
      }
      pushEdge({
        from_node: m.sender,
        to_node: target,
        kind: target === "coordinator" ? "handoff" : "handoff",
        seq: m.seq,
        turn_id: m.turn_id,
        label: m.tag !== "update" ? `[${m.tag}]` : undefined,
        created_at: m.created_at,
      });
    }
  }

  for (const wf of input.workflows) {
    const def = parseJsonSafe<WorkflowDefinition>(wf.definition_json);
    if (!def) continue;
    for (const phase of def.phases) {
      for (const step of phase.steps) {
        const nodeId = `wf:${step.id}`;
        pushEdge({
          from_node: "coordinator",
          to_node: nodeId,
          kind: "dispatch",
          label: `${phase.name} (${phase.mode})`,
          created_at: wf.started_at,
        });
        const refs = new Set<string>();
        const re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(step.prompt)) !== null) {
          if (match[1]) refs.add(match[1]);
        }
        for (const dep of refs) {
          pushEdge({
            from_node: `wf:${dep}`,
            to_node: nodeId,
            kind: "depends_on",
            label: `{{${dep}}}`,
            created_at: wf.started_at,
          });
        }
      }
    }
  }

  return out;
}

export function buildDispatchGraph(input: {
  swarm: SwarmRecord;
  workers: WorkerRecord[];
  boardMessages: BoardMessage[];
  persistedEdges: DispatchEdgeRecord[];
  workflows: WorkflowRecord[];
  policy: ResolvedDispatchPolicy;
  usageByWorker?: UsageAggregate[];
}): DispatchGraph {
  const usageMap = new Map((input.usageByWorker ?? []).map((u) => [u.key, u]));
  const hasPersisted = input.persistedEdges.length > 0;
  const actualRecords = hasPersisted
    ? input.persistedEdges
    : backfillEdgesFromHistory({
        swarm: input.swarm,
        workers: input.workers,
        boardMessages: input.boardMessages,
        workflows: input.workflows,
      });
  const backfilled = !hasPersisted && actualRecords.length > 0;

  const nodesMap = new Map<string, DispatchGraphNode>();
  nodesMap.set("coordinator", {
    id: "coordinator",
    label: "协调者 (Coordinator)",
    kind: "coordinator",
    layer: 0,
    is_planned_only: false,
    state: input.swarm.status === "done" ? "completed" : "active",
  });

  const hasUserInteraction =
    input.boardMessages.some((m) => m.sender === "user") ||
    actualRecords.some((e) => e.from_node === "user" || e.to_node === "user");
  if (hasUserInteraction) {
    nodesMap.set("user", {
      id: "user",
      label: "用户 (User)",
      kind: "user",
      layer: 0,
      is_planned_only: false,
      state: "active",
    });
  }

  // Review status per worker computed chronologically from actualRecords + boardMessages
  const reviewStatusByTarget = new Map<string, "pending" | "pass" | "fail">();
  const reviewStatusByVerifier = new Map<string, "pending" | "pass" | "fail">();
  for (const w of input.workers) {
    if (w.review_of) {
      if (!reviewStatusByTarget.has(w.review_of)) {
        reviewStatusByTarget.set(w.review_of, "pending");
      }
      if (!reviewStatusByVerifier.has(w.name)) {
        reviewStatusByVerifier.set(w.name, "pending");
      }
    }
  }
  for (const rec of actualRecords) {
    if (rec.kind === "review") {
      if (!reviewStatusByTarget.has(rec.to_node)) {
        reviewStatusByTarget.set(rec.to_node, "pending");
      }
      if (!reviewStatusByVerifier.has(rec.from_node)) {
        reviewStatusByVerifier.set(rec.from_node, "pending");
      }
    } else if (rec.kind === "review_pass") {
      reviewStatusByTarget.set(rec.to_node, "pass");
      reviewStatusByVerifier.set(rec.from_node, "pass");
    } else if (rec.kind === "review_fail") {
      reviewStatusByTarget.set(rec.to_node, "fail");
      reviewStatusByVerifier.set(rec.from_node, "fail");
    }
  }

  for (const w of input.workers) {
    const snap = parseJsonSafe<WorkerPolicySnapshot>(w.resolved_policy_json);
    const usage = usageMap.get(w.name);
    const identityId = w.identity_id ?? snap?.identity_id ?? w.role;
    nodesMap.set(w.name, {
      id: w.name,
      label: `@${w.name}`,
      kind: "worker",
      layer: workerLayer(w.role, identityId),
      is_planned_only: false,
      identity_id: identityId,
      role: w.role,
      capability: w.capability,
      backend: w.backend,
      model: w.model,
      effort: w.effort,
      state: w.state,
      workspace_mode: w.workspace_mode,
      worktree_branch: w.worktree_branch,
      review_of: w.review_of,
      reports_to: snap?.reports_to ?? w.parent_node ?? "coordinator",
      policy_source: w.policy_source ?? snap?.policy_source ?? null,
      turns: usage?.turns ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      cost_usd: usage?.cost_usd ?? 0,
      review_status:
        w.role === "verifier"
          ? reviewStatusByVerifier.get(w.name) ?? null
          : reviewStatusByTarget.get(w.name) ?? null,
    });
  }

  for (const wf of input.workflows) {
    const def = parseJsonSafe<WorkflowDefinition>(wf.definition_json);
    if (!def) continue;
    const wfState =
      wf.status === "running" ? "running" : wf.status === "completed" ? "completed" : "failed";
    for (const phase of def.phases) {
      for (const step of phase.steps) {
        const nodeId = `wf:${step.id}`;
        if (!nodesMap.has(nodeId)) {
          nodesMap.set(nodeId, {
            id: nodeId,
            label: step.id,
            kind: "workflow_step",
            layer: 2,
            is_planned_only: false,
            backend: step.backend ?? null,
            model: step.model ?? null,
            effort: step.effort ?? null,
            state: wfState,
          });
        }
      }
    }
  }

  const mergeRecords = actualRecords.filter((r) => r.kind === "merge");
  if (mergeRecords.length > 0) {
    const anyMerged = mergeRecords.some((r) => {
      const m = parseJsonSafe<{ ok?: boolean }>(r.meta_json);
      return m?.ok !== false;
    });
    nodesMap.set("repo", {
      id: "repo",
      label: `主干 (${input.swarm.base_branch || "HEAD"})`,
      kind: "repo",
      layer: 4,
      is_planned_only: false,
      state: anyMerged ? "merged" : "active",
    });
  }

  // Aggregate actual edges by (from, to, kind)
  const actualEdgeMap = new Map<string, DispatchGraphEdge>();
  for (const rec of actualRecords) {
    // Ensure referenced non-worker endpoints exist cleanly
    if (!nodesMap.has(rec.from_node)) {
      nodesMap.set(rec.from_node, {
        id: rec.from_node,
        label: rec.from_node,
        kind: rec.from_node.startsWith("wf:") ? "workflow_step" : "worker",
        layer: rec.from_node.startsWith("wf:") ? 2 : 1,
        is_planned_only: false,
        state: "active",
      });
    }
    if (!nodesMap.has(rec.to_node)) {
      nodesMap.set(rec.to_node, {
        id: rec.to_node,
        label: rec.to_node === "repo" ? `主干 (${input.swarm.base_branch || "HEAD"})` : rec.to_node,
        kind: rec.to_node === "repo" ? "repo" : rec.to_node.startsWith("wf:") ? "workflow_step" : "worker",
        layer: rec.to_node === "repo" ? 4 : 2,
        is_planned_only: false,
        state: "active",
      });
    }

    const key = `actual::${rec.from_node}::${rec.to_node}::${rec.kind}`;
    const existing = actualEdgeMap.get(key);
    const meta = parseJsonSafe<Record<string, unknown>>(rec.meta_json);
    if (existing) {
      existing.count += 1;
      existing.seq = rec.seq ?? existing.seq;
      existing.turn_id = rec.turn_id ?? existing.turn_id;
      existing.label = rec.label ?? existing.label;
      existing.created_at = rec.created_at;
      existing.meta = meta ?? existing.meta;
    } else {
      actualEdgeMap.set(key, {
        id: key,
        from: rec.from_node,
        to: rec.to_node,
        kind: rec.kind,
        mode: "actual",
        count: 1,
        ...(rec.label ? { label: rec.label } : {}),
        seq: rec.seq,
        turn_id: rec.turn_id,
        created_at: rec.created_at,
        meta,
      });
    }
  }

  const edges: DispatchGraphEdge[] = [...actualEdgeMap.values()];

  // Helper to resolve a planned topology node reference onto concrete or virtual planned nodes
  const resolvePlannedRefs = (rawRef: string): string[] => {
    const ref = rawRef.trim().toLowerCase();
    if (!ref) return [];
    if (ref === "coordinator") return ["coordinator"];
    if (ref === "user") {
      if (!nodesMap.has("user")) {
        nodesMap.set("user", {
          id: "user",
          label: "用户 (User)",
          kind: "user",
          layer: 0,
          is_planned_only: true,
          state: "planned",
        });
      }
      return ["user"];
    }
    if (ref === "repo") {
      if (!nodesMap.has("repo")) {
        nodesMap.set("repo", {
          id: "repo",
          label: `主干 (${input.swarm.base_branch || "HEAD"})`,
          kind: "repo",
          layer: 4,
          is_planned_only: true,
          state: "planned",
        });
      }
      return ["repo"];
    }

    // Exact worker name match
    const exactWorker = input.workers.find((w) => w.name === ref);
    if (exactWorker) return [exactWorker.name];

    // Identity match among active workers
    const byIdentity = input.workers.filter((w) => (w.identity_id ?? w.role) === ref);
    if (byIdentity.length > 0) {
      return byIdentity.map((w) => w.name);
    }

    // Create virtual planned-only node
    const planId = `plan:${ref}`;
    if (!nodesMap.has(planId)) {
      const ident = input.policy.identities[ref];
      const picked = pickPlannedBackend(input.policy, ref);
      nodesMap.set(planId, {
        id: planId,
        label: ident ? `${ident.label} (${ref})` : `待派发: ${ref}`,
        kind: "planned",
        layer: ident ? identityLayer(ident.base_role, ref) : 2,
        is_planned_only: true,
        identity_id: ident ? ident.id : ref,
        role: ident?.base_role ?? null,
        capability: ident?.capability ?? null,
        backend: picked.backend,
        model: picked.model,
        effort: ident?.effort ?? null,
        state: "planned",
        policy_source: picked.policySource,
      });
    }
    return [planId];
  };

  const hasFulfilledActualEdge = (from: string, to: string, kind: GraphEdgeKind): boolean => {
    if (from.startsWith("plan:") || to.startsWith("plan:")) return false;
    return edges.some((e) => {
      if (e.mode !== "actual" || e.from !== from || e.to !== to) return false;
      if (e.kind === kind) return true;
      if (kind === "review" && (e.kind === "review_pass" || e.kind === "review_fail")) {
        return true;
      }
      return false;
    });
  };

  const plannedEdgeMap = new Map<string, DispatchGraphEdge>();
  const addPlannedEdge = (link: {
    from: string;
    to: string;
    kind: GraphEdgeKind;
    label?: string;
    source_layer?: PolicyLayer | null;
  }) => {
    const fromNodes = resolvePlannedRefs(link.from);
    const toNodes = resolvePlannedRefs(link.to);
    for (const f of fromNodes) {
      for (const t of toNodes) {
        if (f === t) continue;
        if (hasFulfilledActualEdge(f, t, link.kind)) continue;
        const key = `planned::${f}::${t}::${link.kind}`;
        if (!plannedEdgeMap.has(key)) {
          plannedEdgeMap.set(key, {
            id: key,
            from: f,
            to: t,
            kind: link.kind,
            mode: "planned",
            count: 1,
            ...(link.label ? { label: link.label } : {}),
            source_layer: link.source_layer ?? null,
          });
        }
      }
    }
  };

  // Overlay 1: explicit topology links from 4-layer policy
  for (const link of input.policy.topology) {
    addPlannedEdge({
      from: link.from,
      to: link.to,
      kind: link.kind,
      label: link.label,
      source_layer: link.source ?? null,
    });
  }

  // Overlay 2: identity-level `review_by` for active workers without an assigned reviewer yet
  for (const w of input.workers) {
    const snap = parseJsonSafe<WorkerPolicySnapshot>(w.resolved_policy_json);
    const reviewBy = snap?.review_by ?? input.policy.identities[w.identity_id ?? w.role]?.review_by;
    if (!reviewBy) continue;
    const alreadyReviewed = input.workers.some((other) => other.review_of === w.name);
    if (!alreadyReviewed) {
      addPlannedEdge({
        from: reviewBy,
        to: w.name,
        kind: "review",
        label: "预期审校",
        source_layer: w.policy_source ?? null,
      });
    }
  }

  edges.push(...plannedEdgeMap.values());

  const nodes = [...nodesMap.values()].sort(
    (a, b) => a.layer - b.layer || Number(a.is_planned_only) - Number(b.is_planned_only) || a.id.localeCompare(b.id),
  );

  const workerNodes = nodes.filter((n) => n.kind === "worker");
  const reviewPassCount = workerNodes.filter(
    (n) => n.role !== "verifier" && n.review_status === "pass",
  ).length;
  const reviewFailCount = workerNodes.filter(
    (n) => n.role !== "verifier" && n.review_status === "fail",
  ).length;
  const pendingReviewCount = workerNodes.filter(
    (n) => n.role !== "verifier" && n.review_status === "pending",
  ).length;
  const fallbackCount = actualRecords.filter((r) => r.kind === "fallback").length;
  const mergeCount = actualRecords.filter((r) => {
    if (r.kind !== "merge") return false;
    const m = parseJsonSafe<{ ok?: boolean }>(r.meta_json);
    return m?.ok !== false;
  }).length;

  return {
    swarm_id: input.swarm.id,
    title: input.swarm.title,
    backfilled,
    nodes,
    edges,
    timeline: [...actualRecords].sort((a, b) => a.created_at - b.created_at || a.id - b.id),
    summary: {
      worker_count: workerNodes.length,
      planned_only_count: nodes.filter((n) => n.is_planned_only).length,
      actual_edge_count: edges.filter((e) => e.mode === "actual").length,
      planned_edge_count: edges.filter((e) => e.mode === "planned").length,
      review_pass_count: reviewPassCount,
      review_fail_count: reviewFailCount,
      pending_review_count: pendingReviewCount,
      fallback_count: fallbackCount,
      merge_count: mergeCount,
    },
    generated_at: Date.now(),
  };
}

export function formatDispatchGraphSummary(graph: DispatchGraph): string {
  const s = graph.summary;
  const lines: string[] = [
    `Dispatch Graph for '${graph.title}' (${graph.swarm_id})${graph.backfilled ? " [backfilled from history]" : ""}:`,
    `Nodes: ${s.worker_count} active worker(s), ${s.planned_only_count} planned node(s) | Edges: ${s.actual_edge_count} actual, ${s.planned_edge_count} planned`,
    `Review status: ${s.review_pass_count} pass, ${s.review_fail_count} fail, ${s.pending_review_count} pending | Fallbacks: ${s.fallback_count} | Merges: ${s.merge_count}`,
    "",
    "Nodes:",
  ];

  for (const n of graph.nodes) {
    const parts = [
      `- ${n.id} [${n.kind}/${n.state}]`,
      n.identity_id ? `id=${n.identity_id}` : "",
      n.backend ? `${n.backend}${n.model ? `/${n.model}` : ""}` : "",
      n.policy_source ? `src=${n.policy_source}` : "",
      n.review_status ? `review=${n.review_status}` : "",
      n.is_planned_only ? "(planned-only)" : "",
    ].filter(Boolean);
    lines.push(parts.join(" "));
  }

  lines.push("", "Edges:");
  for (const e of graph.edges) {
    lines.push(
      `- [${e.mode}] ${e.from} --(${e.kind}${e.count > 1 ? ` x${e.count}` : ""})--> ${e.to}${e.label ? ` | ${e.label}` : ""}${e.seq ? ` (#${e.seq})` : ""}`,
    );
  }

  return lines.join("\n");
}
