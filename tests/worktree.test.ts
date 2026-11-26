import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runGit, WorkspaceManager } from "../src/core/worktree.js";

const tmpDirs: string[] = [];

async function initTempRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-wt-"));
  tmpDirs.push(dir);
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Poly Test"]);
  await runGit(dir, ["config", "user.email", "poly@example.com"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
  fs.writeFileSync(path.join(dir, "shared.txt"), "line1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WorkspaceManager (git worktree & readonly guard)", () => {
  it("creates isolated share worktree, excludes .poly-swarm, collects diff, and merges", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();

    const prep = await wm.prepareWorkspace(repo, "sw-test01", "author1", "share");
    assert.ok(prep.worktreeBranch);
    assert.ok(fs.existsSync(prep.workspacePath));

    // Main repo status stays clean because .poly-swarm/ is added to .git/info/exclude
    const mainStatus = await runGit(repo, ["status", "--porcelain"]);
    assert.equal(mainStatus.stdout.trim(), "");

    fs.writeFileSync(path.join(prep.workspacePath, "feature.ts"), "export const ok = true;\n", "utf8");
    const diff = await wm.collectDiff(prep.workspacePath, "main");
    assert.ok(diff.files.includes("feature.ts"));

    const mergeRes = await wm.mergeWorkerBranch(repo, prep.worktreeBranch!, prep.workspacePath);
    assert.equal(mergeRes.ok, true);
    assert.ok(fs.existsSync(path.join(repo, "feature.ts")));

    await wm.cleanupWorkspace(repo, prep.workspacePath, "share", prep.worktreeBranch);
    assert.equal(fs.existsSync(prep.workspacePath), false);
  });

  it("detects and rolls back unauthorized writes by readonly verifiers", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();

    // Existing uncommitted edits (both tracked & untracked) that verifier did NOT make
    fs.writeFileSync(path.join(repo, "README.md"), "hello-existing\n", "utf8");
    fs.writeFileSync(path.join(repo, "notes.txt"), "keep-my-notes\n", "utf8");
    const snap = await wm.snapshotStatus(repo);

    // Unauthorized writes AND pre-dirty file tampering/deletion during verifier turn
    fs.writeFileSync(path.join(repo, "evil.txt"), "bad\n", "utf8");
    fs.writeFileSync(path.join(repo, "shared.txt"), "tampered\n", "utf8");
    fs.writeFileSync(path.join(repo, "README.md"), "verifier-overwrote\n", "utf8");
    fs.rmSync(path.join(repo, "notes.txt"));

    const rollback = await wm.detectAndRollbackUnauthorizedWrites(repo, snap);
    assert.ok(rollback.reverted.includes("evil.txt"));
    assert.ok(rollback.reverted.includes("shared.txt"));
    assert.ok(rollback.reverted.includes("README.md"));
    assert.ok(rollback.reverted.includes("notes.txt"));
    assert.deepEqual(rollback.unreverted, []);
    assert.equal(fs.existsSync(path.join(repo, "evil.txt")), false);
    assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), "line1\n");
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello-existing\n");
    assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8"), "keep-my-notes\n");
  });

  it("merges only the reviewed HEAD into the target branch and never commits dirty reviewed work", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();
    const { workspacePath, worktreeBranch } = await wm.prepareWorkspace(repo, "sw-reviewed", "dev", "share");
    const branch = worktreeBranch!;
    const head = async (dir: string) => (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const base = await head(repo);
    fs.writeFileSync(path.join(workspacePath, "reviewed.txt"), "reviewed\n");
    await wm.commitAllIfDirty(workspacePath, "reviewed change");
    const reviewed = await head(workspacePath);
    const opts = { targetBranch: "main", expectedSha: reviewed };

    const wrongTarget = await wm.mergeWorkerBranch(repo, branch, workspacePath, { ...opts, targetBranch: "release" });
    assert.equal(wrongTarget.ok, false);
    assert.match(wrongTarget.message, /does not match target branch 'release'/);
    assert.equal(await wm.getCurrentBranch(repo), "main");

    fs.writeFileSync(path.join(workspacePath, "unreviewed file.txt"), "unreviewed\n");
    const diff = await wm.collectDiff(workspacePath, "main");
    assert.equal(diff.head_sha, reviewed.slice(0, diff.head_sha?.length));
    assert.equal(diff.target_branch, "main");
    assert.equal(diff.dirty, true);
    assert.deepEqual(diff.dirty_files, ["unreviewed file.txt"]);
    const dirty = await wm.mergeWorkerBranch(repo, branch, workspacePath, opts);
    assert.equal(dirty.ok, false);
    assert.match(dirty.message, /uncommitted changes/);
    assert.equal(await head(workspacePath), reviewed);
    assert.equal(fs.readFileSync(path.join(workspacePath, "unreviewed file.txt"), "utf8"), "unreviewed\n");

    await wm.commitAllIfDirty(workspacePath, "changed after review");
    const stale = await wm.mergeWorkerBranch(repo, branch, workspacePath, opts);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /does not match expected SHA/);
    assert.equal(await head(repo), base);
    assert.equal(fs.existsSync(path.join(repo, "reviewed.txt")), false);

    const latest = await head(workspacePath);
    const tooShort = await wm.mergeWorkerBranch(repo, branch, workspacePath, {
      ...opts, expectedSha: latest.slice(0, 1),
    });
    assert.equal(tooShort.ok, false);
    assert.match(tooShort.message, /does not match expected SHA/);
    assert.equal(await head(repo), base);
    const merged = await wm.mergeWorkerBranch(repo, branch, workspacePath, {
      ...opts, expectedSha: latest.slice(0, 12),
    });
    assert.equal(merged.ok, true, merged.message);
    assert.equal((await runGit(repo, ["rev-parse", "HEAD^2"])).stdout.trim(), latest);
    assert.equal(fs.readFileSync(path.join(repo, "reviewed.txt"), "utf8"), "reviewed\n");
  });

  it("reports oversized (>2MiB) pre-dirty modifications and deletions as unreverted instead of silently passing or misreporting", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();
    const bigMod = path.join(repo, "big-mod.bin");
    const bigDel = path.join(repo, "big-del.bin");
    fs.writeFileSync(bigMod, Buffer.alloc(2 * 1024 * 1024 + 64, 0x41));
    fs.writeFileSync(bigDel, Buffer.alloc(2 * 1024 * 1024 + 64, 0x42));

    const snap = await wm.snapshotStatus(repo);
    assert.equal(snap.get("big-mod.bin")?.content, undefined);
    assert.equal(snap.get("big-del.bin")?.content, undefined);

    fs.writeFileSync(bigMod, Buffer.alloc(2 * 1024 * 1024 + 64, 0x43));
    fs.rmSync(bigDel);

    const rollback = await wm.detectAndRollbackUnauthorizedWrites(repo, snap);
    assert.deepEqual(rollback.reverted, []);
    assert.ok(rollback.unreverted.includes("big-mod.bin"));
    assert.ok(rollback.unreverted.includes("big-del.bin"));
  });

  it("aborts cleanly on merge conflict and returns conflict list", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();

    const prep = await wm.prepareWorkspace(repo, "sw-conf", "w1", "share");
    fs.writeFileSync(path.join(prep.workspacePath, "shared.txt"), "worker-change\n", "utf8");
    await wm.commitAllIfDirty(prep.workspacePath, "worker commit");

    // Conflicting commit on main
    fs.writeFileSync(path.join(repo, "shared.txt"), "main-change\n", "utf8");
    await runGit(repo, ["add", "shared.txt"]);
    await runGit(repo, ["commit", "-m", "main conflict"]);

    const mergeRes = await wm.mergeWorkerBranch(repo, prep.worktreeBranch!, prep.workspacePath);
    assert.equal(mergeRes.ok, false);
    assert.ok(mergeRes.conflicts.includes("shared.txt"));

    // Repo must not stay in mid-merge state
    const status = await runGit(repo, ["status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
  });

  it("rejects isolated workspace creation with a clear message on unborn repository without commits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-wt-unborn-"));
    tmpDirs.push(dir);
    await runGit(dir, ["init", "-b", "main"]);
    const wm = new WorkspaceManager();

    await assert.rejects(
      () => wm.prepareWorkspace(dir, "sw-unborn", "w1", "share"),
      /no commits yet/i,
    );
  });

  it("skips rollback when git HEAD changes concurrently during readonly turn", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();
    fs.writeFileSync(path.join(repo, "wip.ts"), "export const wip = 1;\n", "utf8");
    const before = await wm.snapshotStatus(repo);
    assert.ok(before.headSha);

    // Concurrent commit advances HEAD while readonly worker is running
    fs.writeFileSync(path.join(repo, "committed.ts"), "export const committed = true;\n", "utf8");
    await runGit(repo, ["add", "committed.ts"]);
    await runGit(repo, ["commit", "-m", "external concurrent commit"]);

    const report = await wm.detectAndRollbackUnauthorizedWrites(repo, before);
    assert.equal(report.skippedReason, "head_changed");
    assert.deepEqual(report.reverted, []);
    assert.deepEqual(report.unreverted, []);
    assert.notEqual(report.beforeHeadSha, report.afterHeadSha);
    assert.equal(fs.readFileSync(path.join(repo, "committed.ts"), "utf8"), "export const committed = true;\n");
  });

  it("audits without modifying files when dryRun is enabled on shared workspace", async () => {
    const repo = await initTempRepo();
    const wm = new WorkspaceManager();
    const before = await wm.snapshotStatus(repo);

    fs.writeFileSync(path.join(repo, "README.md"), "concurrent human edit\n", "utf8");
    fs.writeFileSync(path.join(repo, "scratch.tmp"), "keep me\n", "utf8");

    const report = await wm.detectAndRollbackUnauthorizedWrites(repo, before, { dryRun: true });
    assert.equal(report.skippedReason, "shared_strict_readonly_audit");
    assert.deepEqual(report.reverted, []);
    assert.deepEqual(report.unreverted, []);
    assert.ok(report.observedChanges?.includes("README.md"));
    assert.ok(report.observedChanges?.includes("scratch.tmp"));
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "concurrent human edit\n");
    assert.equal(fs.readFileSync(path.join(repo, "scratch.tmp"), "utf8"), "keep me\n");
  });
});
