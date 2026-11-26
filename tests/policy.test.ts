import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadPolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine } from "../src/core/engine.js";
import {
  BUILTIN_IDENTITIES,
  LAYER_WEIGHTS,
  inferVendorFamily,
  loadProjectPolicy,
  mergePolicyLayerPatch,
  resolveDispatchPolicy,
  resolveEffectiveModelAndEffort,
  resolveWorkerDispatch,
  sanitizePolicyLayer,
  saveProjectPolicy,
} from "../src/core/policy.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Four-Layer Weighted Dispatch Policy", () => {
  it("recognizes the model vendor across CLI wrappers and qualified model IDs", () => {
    assert.equal(inferVendorFamily("codex", null), "openai");
    assert.equal(inferVendorFamily("cursor", " OpenAI/GPT-6.2-sol "), "openai");
    assert.equal(inferVendorFamily("agy", "anthropic/claude-sonnet-4"), "anthropic");
    assert.equal(inferVendorFamily("cursor", "gemini-3.8-flash"), "google");
    assert.equal(inferVendorFamily("grok", "grok-4"), "xai");
    assert.equal(inferVendorFamily("codebuddy", "kimi-k3.1-pro"), "moonshot");
    assert.equal(inferVendorFamily("opencode", "deepseek/deepseek-v4-pro"), "deepseek");
    assert.equal(inferVendorFamily("trae", null), "bytedance");
    assert.equal(inferVendorFamily("codex", "trae-code"), "bytedance");
    assert.equal(inferVendorFamily("cursor", "volcengine/doubao-seed-code"), "bytedance");
    assert.equal(inferVendorFamily("trae", "seed-code"), "bytedance");
    assert.equal(inferVendorFamily("trae", "deepseek-v4.1"), "deepseek");
    assert.equal(inferVendorFamily("codebuddy", "minimax/minimax-m3.1-flash"), "minimax");
    assert.equal(inferVendorFamily("trae", "auto"), "bytedance");
    assert.equal(inferVendorFamily("trae", "doubao-seed-code"), "bytedance");
    assert.equal(inferVendorFamily("opencode", "minimax-cn/MiniMax-M3.1-Flash"), "minimax");
    assert.equal(inferVendorFamily("mock", "gpt-5"), "mock");
  });

  it("keeps all eight built-in readonly identities readonly across project, session and explicit dispatch", () => {
    const roles = {
      architect: "researcher", "tech-lead": "researcher", "product-analyst": "researcher", researcher: "researcher",
      verifier: "verifier", "sec-auditor": "verifier", "perf-reviewer": "verifier", "qa-challenger": "verifier",
    } as const;
    const config = loadPolySwarmConfig(path.join(makeTempDir("poly-readonly-identities-"), "backends.json"));
    const projectPolicy = { identities: Object.fromEntries(Object.keys(roles).map((id) => [id, { base_role: "author" as const }])) };
    const sessionPolicy = { identities: Object.fromEntries(Object.keys(roles).map((id) => [id, { base_role: "worker" as const }])) };
    const resolved = resolveDispatchPolicy({ config, projectPolicy, sessionPolicy });
    for (const [identity, role] of Object.entries(roles)) {
      const plan = resolveWorkerDispatch(resolved, { identity });
      assert.equal(plan.role, role, identity);
      assert.equal(plan.workspace_mode, "inherit", identity);
      assert.equal(plan.identity.require_cross_vendor, role === "verifier", identity);
      assert.throws(() => resolveWorkerDispatch(resolved, { identity, role: "author" }), /cannot be overridden to writable role/);
    }
  });

  it("inherits role skills between scopes, replaces the list at a higher scope, and rejects unsafe paths", () => {
    const config = loadPolySwarmConfig(path.join(makeTempDir("poly-role-skills-"), "backends.json"));
    const inherited = ".agents/skills/review/SKILL.md";
    const replacement = ".agents/skills/project-review/SKILL.md";
    config.identities = { verifier: { skill_paths: [inherited, inherited] } };
    const resolve = (skills: string[] | null) => resolveDispatchPolicy({
      config,
      sessionPolicy: { identities: { verifier: { skill_paths: skills } } },
    });
    assert.deepEqual(resolve(null).identities.verifier?.skill_paths, [inherited]);
    assert.deepEqual(resolve([]).identities.verifier?.skill_paths, []);
    assert.deepEqual(resolve([replacement]).identities.verifier?.skill_paths, [replacement]);

    for (const invalid of ["../SKILL.md", "/tmp/SKILL.md", "file://private/SKILL.md", "skills\n/ SKILL.md", "brief.md"]) {
      const policy = resolve([replacement, invalid]);
      assert.deepEqual(policy.identities.verifier?.skill_paths, [inherited]);
      assert.ok(policy.warnings.some((warning) => warning.includes("skill_paths")));
    }
  });

  it("resolves builtin -> global_ui -> project -> session -> worker_explicit with field provenance", () => {
    const dir = makeTempDir("poly-policy-cascade-");
    const cfgPath = path.join(dir, "backends.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        backends: {
          codex: { defaultModel: "gpt-global", defaultEffort: "medium" },
          qoder: { enabled: false },
        },
        identities: {
          author: {
            system_prompt: "L2 global guideline",
            model: "gpt-global-author",
          },
          "sec-audit": {
            label: "安全审计",
            base_role: "verifier",
            capability: "verifier",
            preferred_backends: ["grok", "codex"],
            model: "grok-4.7",
            system_prompt: "Audit security boundaries.",
          },
        },
        topology: [
          { from: "coordinator", to: "author", kind: "dispatch", label: "L2 dispatch" },
        ],
      }),
      "utf8",
    );

    const config = loadPolySwarmConfig(cfgPath);
    const repoDir = path.join(dir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    saveProjectPolicy(repoDir, {
      backends: {
        codex: { defaultModel: "gpt-project" },
      },
      identities: {
        author: {
          prompt_mode: "append",
          system_prompt: "L3 project rule",
          review_by: "sec-audit",
        },
        "sec-audit": {
          model: "grok-project-audit",
          reports_to: "architect",
        },
      },
      topology: [
        { from: "sec-audit", to: "author", kind: "review", label: "L3 security review" },
      ],
    });

    const resolved = resolveDispatchPolicy({
      config,
      repoRoot: repoDir,
      sessionPolicy: {
        backends: {
          codex: { defaultEffort: "xhigh" },
        },
        identities: {
          author: {
            model: "gpt-session-author",
          },
        },
      },
      swarmId: "sw-1",
    });

    assert.equal(Object.keys(BUILTIN_IDENTITIES).length, 16);
    assert.equal(resolved.layers.map((l) => l.weight).join(","), "100,200,300,400");

    // Backend field provenance: model from L3 project, effort from L4 session
    assert.equal(resolved.backends.codex?.defaultModel, "gpt-project");
    assert.equal(resolved.backends.codex?.model_source?.layer, "project");
    assert.equal(resolved.backends.codex?.defaultEffort, "xhigh");
    assert.equal(resolved.backends.codex?.effort_source?.layer, "session");
    assert.equal(resolved.backends.qoder?.globally_disabled, true);
    assert.equal(resolved.backends.qoder?.enabled, false);

    // Author identity merged across L2 + L3 (append) + L4
    const authorId = resolved.identities.author!;
    assert.equal(authorId.source, "session");
    assert.equal(authorId.weight, LAYER_WEIGHTS.session);
    assert.equal(authorId.model, "gpt-session-author");
    assert.equal(authorId.field_sources.model?.layer, "session");
    assert.equal(authorId.review_by, "sec-audit");
    assert.equal(authorId.field_sources.review_by?.layer, "project");
    assert.equal(authorId.system_prompt, "L2 global guideline\n\nL3 project rule");
    assert.deepEqual(authorId.prompt_layers, ["global_ui", "project"]);

    // Custom sec-audit identity merged L2 + L3
    const secId = resolved.identities["sec-audit"]!;
    assert.equal(secId.builtin, false);
    assert.equal(secId.source, "project");
    assert.equal(secId.model, "grok-project-audit");
    assert.equal(secId.reports_to, "architect");

    // Topology combined across L2 + L3
    assert.equal(resolved.topology.length, 2);
    assert.equal(resolved.topology[0]?.source, "global_ui");
    assert.equal(resolved.topology[1]?.source, "project");

    // Worker explicit (weight 500) overrides identity defaults
    const dispatchPlan = resolveWorkerDispatch(resolved, {
      identity: "author",
      model: "gpt-worker-override",
    });
    assert.equal(dispatchPlan.identity_id, "author");
    assert.equal(dispatchPlan.policy_source, "worker_explicit");
    const effExplicit = resolveEffectiveModelAndEffort({
      policy: resolved,
      identity: dispatchPlan.identity,
      backend: "codex",
      explicitModel: "gpt-worker-override",
      isFallback: false,
    });
    assert.equal(effExplicit.model, "gpt-worker-override");
    assert.equal(effExplicit.model_source.layer, "worker_explicit");

    // Fallback drops incompatible identity model and uses target backend default
    const effFallback = resolveEffectiveModelAndEffort({
      policy: resolved,
      identity: secId,
      backend: "codex",
      isFallback: true,
    });
    assert.equal(effFallback.model, "gpt-project");
    assert.equal(effFallback.model_source.layer, "project");
  });

  it("enforces security invariants on project & session layers and strips unsafe CLI fields", () => {
    const dir = makeTempDir("poly-policy-sec-");
    const cfgPath = path.join(dir, "backends.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        backends: {
          qoder: { enabled: false },
          codex: { defaultModel: "gpt-safe" },
        },
      }),
      "utf8",
    );
    const config = loadPolySwarmConfig(cfgPath);

    const sanitized = sanitizePolicyLayer(
      {
        backends: {
          codex: {
            command: "/tmp/evil.sh",
            extraArgs: ["--danger"],
            env: { SECRET: "1" },
            defaultModel: "gpt-proj",
          },
          qoder: { enabled: true },
        },
        identities: {
          verifier: {
            base_role: "author",
            system_prompt: "stay strict",
          },
          "bad id!": {
            label: "invalid",
          },
        },
      },
      { layer: "project" },
    );

    assert.ok(sanitized.warnings.some((w) => w.includes("command/extraArgs/env")));
    assert.equal(
      "command" in (sanitized.policy.backends?.codex ?? {}),
      false,
    );
    assert.equal(sanitized.policy.backends?.codex?.defaultModel, "gpt-proj");

    const resolved = resolveDispatchPolicy({
      config,
      projectPolicy: sanitized.policy,
      projectWarnings: sanitized.warnings,
      sessionPolicy: {
        backends: {
          qoder: { enabled: true },
        },
        identities: {
          researcher: { base_role: "worker" },
        },
      },
    });

    // Global disable cannot be re-enabled by project or session
    assert.equal(resolved.backends.qoder?.enabled, false);
    assert.equal(resolved.backends.qoder?.globally_disabled, true);
    assert.ok(resolved.warnings.some((w) => w.includes("不可重新启用")));

    // Built-in readonly identities cannot be downgraded to writable roles
    assert.equal(resolved.identities.verifier?.base_role, "verifier");
    assert.equal(resolved.identities.researcher?.base_role, "researcher");
    assert.ok(resolved.warnings.some((w) => w.includes("不可降级为可写角色")));
  });

  it("reads legacy .poly-swarm.json, writes .poly-swarm/config.json atomically, and merges/clears layer overrides", () => {
    const repoDir = makeTempDir("poly-policy-proj-");
    fs.writeFileSync(
      path.join(repoDir, ".poly-swarm.json"),
      JSON.stringify({
        backends: { grok: { defaultModel: "grok-legacy" } },
      }),
      "utf8",
    );

    const loadedLegacy = loadProjectPolicy(repoDir);
    assert.equal(loadedLegacy.policy?.backends?.grok?.defaultModel, "grok-legacy");

    const merged = mergePolicyLayerPatch(loadedLegacy.policy, {
      identities: {
        custom1: { label: "C1", base_role: "author" },
      },
    });
    const writtenPath = saveProjectPolicy(repoDir, merged);
    assert.equal(writtenPath, path.join(repoDir, ".poly-swarm", "config.json"));

    const loadedPrimary = loadProjectPolicy(repoDir);
    assert.equal(loadedPrimary.path, writtenPath);
    assert.equal(loadedPrimary.policy?.backends?.grok?.defaultModel, "grok-legacy");
    assert.equal(loadedPrimary.policy?.identities?.custom1?.label, "C1");

    // Clearing project policy removes BOTH .poly-swarm/config.json and legacy .poly-swarm.json
    saveProjectPolicy(repoDir, null);
    assert.equal(fs.existsSync(writtenPath), false);
    assert.equal(fs.existsSync(path.join(repoDir, ".poly-swarm.json")), false);
    assert.equal(loadProjectPolicy(repoDir).policy, null);
  });

  it("saves global role skills and clears backend defaults without dropping CLI launch settings", async () => {
    const dir = makeTempDir("poly-policy-clear-");
    const cfgPath = path.join(dir, "backends.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        backends: {
          codex: { command: "/usr/local/bin/codex", defaultModel: "gpt-6.2-sol", envFiles: { TEST_KEY: path.join(dir, "test-key") } },
        },
      }),
      "utf8",
    );
    const db = new PolySwarmDB(dir);
    const config = loadPolySwarmConfig(cfgPath);
    const engine = new PolySwarmEngine({ db, config });
    try {
      const skills = [".agents/skills/review/SKILL.md"];
      await engine.updateDispatchPolicy({ scope: "global_ui", patch: { identities: { verifier: { skill_paths: skills } } } });
      assert.deepEqual(engine.resolvePolicy().identities.verifier?.skill_paths, skills);
      assert.deepEqual(loadPolySwarmConfig(cfgPath).backends.codex?.envFiles, { TEST_KEY: path.join(dir, "test-key") });

      const resolved = await engine.updateDispatchPolicy({
        scope: "global_ui",
        patch: { backends: { codex: null } },
      });
      assert.equal(resolved.backends.codex?.defaultModel, undefined);
      assert.equal(engine.config.backends.codex?.defaultModel, undefined);
      assert.equal(engine.config.backends.codex?.command, "/usr/local/bin/codex");

      const reloaded = loadPolySwarmConfig(cfgPath);
      assert.equal(reloaded.backends.codex?.defaultModel, undefined);
      assert.equal(reloaded.backends.codex?.command, "/usr/local/bin/codex");
      assert.deepEqual(reloaded.identities?.verifier?.skill_paths, skills);
      assert.deepEqual(reloaded.backends.codex?.envFiles, { TEST_KEY: path.join(dir, "test-key") });
    } finally {
      engine.shutdown();
      db.close();
    }
  });
});
