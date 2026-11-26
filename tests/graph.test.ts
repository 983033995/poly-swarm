import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadPolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine } from "../src/core/engine.js";
import { buildDispatchGraph, formatDispatchGraphSummary } from "../src/core/graph.js";
import { resolveDispatchPolicy } from "../src/core/policy.js";
import { runGit } from "../src/core/worktree.js";
import { layoutDispatchGraph, projectDispatchReplay, renderDispatchGraphSvg } from "../src/ui/graph_view.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function initTempRepo(): Promise<string> {
  const dir = makeTempDir("poly-graph-repo-");
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Poly Graph"]);
  await runGit(dir, ["config", "user.email", "graph@example.com"]);
  fs.writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

async function waitForCondition(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Dispatch Flow Graph & Planned Overlay", () => {
  it("records runtime organization edges, overlays planned topology, and renders XSS-safe SVG", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-graph-data-");
    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig("/nonexistent-path");
    const engine = new PolySwarmEngine({ db, config });

    try {
      const swarm = await engine.createSwarm({
        title: "Org Graph Swarm",
        repo_root: repo,
        policy: {
          identities: {
            "sec-audit": {
              label: "安全审计<script>",
              base_role: "verifier",
              capability: "verifier",
              system_prompt: "Check auth & XSS",
            },
          },
          topology: [
            { from: "coordinator", to: "dev", kind: "dispatch", label: "派发开发" },
            { from: "sec-audit", to: "dev", kind: "review", label: "预期安全审计" },
            { from: "dev", to: "lead", kind: "reports_to", label: "预期汇报" },
          ],
        },
      });

      // Before sec-audit is dispatched, planned-only sec-audit & repo appear in overlay
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "dev",
        role: "author",
        backend: "mock",
        workspace_mode: "share",
        reports_to: "lead",
        brief:
          'Write module [MOCK:{"writeFile":{"path":"feat.ts","content":"export const ok = true;\\n"},"text":"@coordinator [done] feat.ts ready"}]',
      });
      await waitForCondition(() => db.getWorker(swarm.id, "dev")?.state === "waiting");

      const graphMid = engine.getDispatchGraph(swarm.id);
      assert.equal(graphMid.backfilled, false);
      assert.ok(graphMid.nodes.some((n) => n.id === "plan:sec-audit" && n.is_planned_only));
      assert.ok(graphMid.nodes.some((n) => n.id === "plan:lead" && n.is_planned_only));
      assert.ok(
        graphMid.edges.some(
          (e) => e.mode === "planned" && e.from === "plan:sec-audit" && e.to === "dev" && e.kind === "review",
        ),
      );
      // Dispatch coordinator -> dev already happened in actual edges -> not duplicated in planned
      assert.equal(
        graphMid.edges.some((e) => e.mode === "planned" && e.from === "coordinator" && e.to === "dev"),
        false,
      );

      // Dispatch sec-audit using custom identity, plus lead, switch backend once, post review_pass, then merge dev
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "lead",
        identity: "architect",
        backend: "mock",
        brief: 'Lead review [MOCK:{"text":"@coordinator [done] lead ready"}]',
      });
      await waitForCondition(() => db.getWorker(swarm.id, "lead")?.state === "waiting");

      await engine.addWorker({
        swarm_id: swarm.id,
        name: "sec1",
        identity: "sec-audit",
        backend: "mock",
        review_of: "dev",
        depends_on: ["dev"],
        brief: 'Review dev [MOCK:{"text":"@dev [review_pass] LGTM"}]',
      });
      await waitForCondition(() => db.getWorker(swarm.id, "sec1")?.state === "waiting");

      await engine.switchWorkerBackend({
        swarm_id: swarm.id,
        name: "dev",
        backend: "mock",
        reason: "test switch edge",
      });

      const mergeRes = await engine.mergeWorker(swarm.id, "dev");
      assert.equal(mergeRes.ok, true);

      const graphFinal = engine.getDispatchGraph(swarm.id);
      assert.equal(graphFinal.summary.planned_only_count, 0);
      assert.equal(graphFinal.summary.worker_count, 3);
      assert.equal(graphFinal.summary.review_pass_count, 1);
      assert.equal(graphFinal.summary.fallback_count, 1);
      assert.equal(graphFinal.summary.merge_count, 1);

      const edgeKinds = new Set(graphFinal.edges.map((e) => e.kind));
      for (const expectedKind of [
        "dispatch",
        "reports_to",
        "depends_on",
        "review",
        "review_pass",
        "handoff",
        "fallback",
        "merge",
      ] as const) {
        assert.ok(edgeKinds.has(expectedKind), `Missing edge kind '${expectedKind}'`);
      }

      const summaryText = formatDispatchGraphSummary(graphFinal);
      assert.ok(summaryText.includes("Org Graph Swarm"));
      assert.ok(summaryText.includes("review_pass"));

      // SVG layout & XSS escaping check
      const layoutAll = layoutDispatchGraph(graphFinal, "all");
      assert.ok(layoutAll.nodes.length >= 4);
      assert.ok(layoutAll.edges.length >= 6);
      const svg = renderDispatchGraphSvg(graphFinal, {
        filterMode: "all",
        selectedNodeId: "dev",
      });
      assert.ok(svg.startsWith("<svg"));
      assert.equal(svg.includes("<script>"), false);
      // Semantic engineering lane titles & path isolation assertions
      assert.ok(svg.includes("01 / 调度核心"));
      assert.ok(svg.includes("研发执行") || svg.includes("独立审校"));
      assert.ok(svg.includes("graph-edge-flow"));
      assert.equal(svg.match(/class="graph-edge-pulse"/g) ?? null, null);
      assert.ok(svg.includes("is-dim"));

      const zoomedSvg = renderDispatchGraphSvg(graphFinal, {
        filterMode: "actual",
        zoom: 1.3,
      });
      assert.ok(zoomedSvg.startsWith("<svg"));
      assert.ok(zoomedSvg.includes("is-zoomed"));
      assert.equal(zoomedSvg.includes("NaN"), false);

      const opening = projectDispatchReplay(graphFinal, 0);
      const first = projectDispatchReplay(graphFinal, 1);
      const firstEvent = graphFinal.timeline[0]!;
      assert.deepEqual(opening.edges, []);
      assert.equal(first.edges.length, 1);
      assert.deepEqual(first.edges.map((e) => [e.from, e.to, e.kind, e.mode, e.seq, e.count]),
        [[firstEvent.from_node, firstEvent.to_node, firstEvent.kind, "actual", firstEvent.seq, 1]]);
      assert.equal(first.nodes.some((n) => n.review_status === "pass"), false);
      const activeEdge = first.edges[0]!;
      const replaySvg = renderDispatchGraphSvg(first, { filterMode: "actual", activeEdgeIds: new Set([activeEdge.id]) });
      assert.equal(replaySvg.match(/class="graph-edge-pulse"/g)?.length, 1);
      assert.equal(replaySvg.includes("is-planned"), false);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("backfills dispatch graph from legacy swarms without dispatch_edges rows", () => {
    const dataDir = makeTempDir("poly-graph-backfill-");
    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig("/nonexistent-path");
    try {
      const swarm = db.createSwarm({ title: "Legacy Swarm", repo_root: dataDir });
      db.addWorker({
        swarm_id: swarm.id,
        name: "coder",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "share",
        workspace_path: dataDir,
      });
      db.addWorker({
        swarm_id: swarm.id,
        name: "checker",
        role: "verifier",
        capability: "verifier",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: dataDir,
        review_of: "coder",
      });
      db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        tag: "brief",
        text: "@coder build",
      });
      db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "checker",
        tag: "review_pass",
        text: "@coder @coordinator [review_pass] all good",
      });
      db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        tag: "done",
        text: "[merged] @coder branch merged",
      });

      const policy = resolveDispatchPolicy({ config, swarmId: swarm.id });
      const graph = buildDispatchGraph({
        swarm,
        workers: db.listWorkers(swarm.id),
        boardMessages: db.readBoardMessages({ swarm_id: swarm.id, since: 0 }),
        persistedEdges: db.listDispatchEdges(swarm.id),
        workflows: [],
        policy,
      });

      assert.equal(graph.backfilled, true);
      assert.equal(graph.summary.worker_count, 2);
      assert.equal(graph.summary.review_pass_count, 1);
      assert.ok(graph.edges.some((e) => e.from === "coordinator" && e.to === "coder" && e.kind === "dispatch"));
      assert.ok(graph.edges.some((e) => e.from === "checker" && e.to === "coder" && e.kind === "review_pass"));

      // Filter mode "actual" vs "planned"
      const actualOnly = layoutDispatchGraph(graph, "actual");
      assert.ok(actualOnly.edges.every((pe) => pe.edge.mode === "actual"));
      const plannedOnly = layoutDispatchGraph(graph, "planned");
      assert.equal(plannedOnly.edges.length, 0);

      // Cross-layer routing check: verifier (layer 3) -> coordinator (layer 0) across author (layer 2)
      assert.ok(
        actualOnly.edges.some((pe) => pe.isCrossLayer && Number.isFinite(pe.labelX) && Number.isFinite(pe.labelY)),
      );
      const crossSvg = renderDispatchGraphSvg(graph, { filterMode: "actual" });
      assert.ok(crossSvg.startsWith("<svg"));
      assert.equal(crossSvg.includes("NaN"), false);
      assert.equal(crossSvg.includes("is-planned"), false);
    } finally {
      db.close();
    }
  });
});
