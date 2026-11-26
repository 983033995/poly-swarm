import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceDiffResult, WorkspaceMode } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export interface ExecGitResult {
  stdout: string;
  stderr: string;
}

export async function runGit(cwd: string, args: string[]): Promise<ExecGitResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export interface FileSnapshotEntry {
  xy: string;
  sha256: string | null;
  content?: Buffer;
}

export interface RollbackReport {
  reverted: string[];
  unreverted: string[];
  skippedReason?: "head_changed" | "shared_strict_readonly_audit" | null;
  observedChanges?: string[];
  beforeHeadSha?: string | null;
  afterHeadSha?: string | null;
}

export class WorkspaceSnapshot extends Map<string, FileSnapshotEntry> {
  headSha: string | null = null;
  branch: string | null = null;
}

export interface PreparedWorkspace {
  workspacePath: string;
  worktreeBranch: string | null;
}

export interface MergeResult {
  ok: boolean;
  merged_commit?: string;
  conflicts: string[];
  message: string;
}

const MAX_SNAP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAP_TOTAL_BYTES = 16 * 1024 * 1024;

function dirtyPaths(status: string): string[] {
  const entries = status.split("\0");
  const files = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) files.add(entries[++i]!);
  }
  return [...files];
}

function readSnapshotFile(
  absPath: string,
  remainingBudget: number,
): { sha256: string | null; content?: Buffer; bytesUsed: number } {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { sha256: null, bytesUsed: 0 };
    const buf = fs.readFileSync(absPath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (buf.length <= MAX_SNAP_FILE_BYTES && buf.length <= remainingBudget) {
      return { sha256, content: buf, bytesUsed: buf.length };
    }
    return { sha256, bytesUsed: 0 };
  } catch {
    return { sha256: null, bytesUsed: 0 };
  }
}

export class WorkspaceManager {
  async isGitRepo(dir: string): Promise<boolean> {
    if (!fs.existsSync(dir)) return false;
    try {
      const { stdout } = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async getRepoRoot(dir: string): Promise<string | null> {
    if (!fs.existsSync(dir)) return null;
    try {
      const { stdout } = await runGit(dir, ["rev-parse", "--show-toplevel"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getCurrentBranch(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }

  private async ensurePolySwarmExcluded(repoRoot: string): Promise<void> {
    try {
      const { stdout } = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
      const commonDir = path.resolve(repoRoot, stdout.trim());
      const excludeFile = path.join(commonDir, "info", "exclude");
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
      const lines = existing.split(/\r?\n/);
      if (!lines.some((l) => l.trim() === ".poly-swarm/" || l.trim() === ".poly-swarm")) {
        const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(excludeFile, `${prefix}.poly-swarm/\n`, "utf8");
      }
    } catch (err) {
      console.error("[poly-swarm] failed to update .git/info/exclude:", err);
    }
  }

  async prepareWorkspace(
    repoRoot: string,
    swarmId: string,
    workerName: string,
    mode: WorkspaceMode,
  ): Promise<PreparedWorkspace> {
    if (mode === "inherit") {
      return { workspacePath: repoRoot, worktreeBranch: null };
    }

    const isGit = await this.isGitRepo(repoRoot);
    if (!isGit) {
      throw new Error(
        `Cannot create isolated workspace (${mode}) because '${repoRoot}' is not a git repository.`,
      );
    }

    try {
      await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    } catch (err) {
      const errText =
        err && typeof err === "object"
          ? `${(err as { message?: string }).message ?? ""} ${(err as { stderr?: string }).stderr ?? ""}`
          : String(err);
      if (/unknown revision|needed a single revision|not a valid object name/i.test(errText)) {
        throw new Error(
          `Cannot create isolated workspace (${mode}) because repository '${repoRoot}' has no commits yet. Create an initial commit first or use workspace_mode='inherit'.`,
        );
      }
      throw new Error(
        `Failed to inspect HEAD for '${repoRoot}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.ensurePolySwarmExcluded(repoRoot);
    const swarmShort = swarmId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);

    if (mode === "share") {
      const targetPath = path.join(repoRoot, ".poly-swarm", "worktrees", swarmShort, workerName);
      const branchName = `poly-swarm/${swarmShort}/${workerName}`;

      if (fs.existsSync(targetPath)) {
        const valid = await this.isGitRepo(targetPath);
        if (valid) {
          return { workspacePath: targetPath, worktreeBranch: branchName };
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      let branchExists = false;
      try {
        await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
        branchExists = true;
      } catch {
        branchExists = false;
      }

      if (branchExists) {
        await runGit(repoRoot, ["worktree", "add", targetPath, branchName]);
      } else {
        await runGit(repoRoot, ["worktree", "add", "-b", branchName, targetPath, "HEAD"]);
      }
      return { workspacePath: targetPath, worktreeBranch: branchName };
    }

    // mode === "branch": isolated local clone
    const clonePath = path.join(repoRoot, ".poly-swarm", "clones", swarmShort, workerName);
    const branchName = `poly-swarm/${swarmShort}/${workerName}`;
    if (fs.existsSync(clonePath)) {
      if (await this.isGitRepo(clonePath)) {
        return { workspacePath: clonePath, worktreeBranch: branchName };
      }
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(clonePath), { recursive: true });
    await runGit(repoRoot, ["clone", "--local", repoRoot, clonePath]);
    await runGit(clonePath, ["checkout", "-b", branchName]);
    return { workspacePath: clonePath, worktreeBranch: branchName };
  }

  async snapshotStatus(dir: string): Promise<WorkspaceSnapshot> {
    const snap = new WorkspaceSnapshot();
    if (!(await this.isGitRepo(dir))) {
      return snap;
    }
    const [headRes, branch, statusRes] = await Promise.all([
      runGit(dir, ["rev-parse", "HEAD"]).catch(() => null),
      this.getCurrentBranch(dir),
      runGit(dir, ["status", "--porcelain=v1", "-z", "-uall"]),
    ]);
    snap.headSha = headRes?.stdout.trim() || null;
    snap.branch = branch;
    const { stdout } = statusRes;
    if (!stdout) return snap;

    const entries = stdout.split("\0").filter((item) => item.length > 0);
    let totalBytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const relPath = entry.slice(3);
      // Rename/copy entries have an extra NUL-terminated source path next
      if (xy.startsWith("R") || xy.startsWith("C")) {
        i += 1;
      }
      const absPath = path.join(dir, relPath);
      const info = readSnapshotFile(absPath, Math.max(0, MAX_SNAP_TOTAL_BYTES - totalBytes));
      totalBytes += info.bytesUsed;
      snap.set(relPath, {
        xy,
        sha256: info.sha256,
        ...(info.content ? { content: info.content } : {}),
      });
    }
    return snap;
  }

  async detectAndRollbackUnauthorizedWrites(
    dir: string,
    before: WorkspaceSnapshot,
    options?: { dryRun?: boolean },
  ): Promise<RollbackReport> {
    if (!(await this.isGitRepo(dir))) {
      return { reverted: [], unreverted: [] };
    }
    const after = await this.snapshotStatus(dir);
    const changed: string[] = [];

    for (const [relPath, afterInfo] of after.entries()) {
      const beforeInfo = before.get(relPath);
      if (!beforeInfo) {
        changed.push(relPath);
      } else if (beforeInfo.xy !== afterInfo.xy || beforeInfo.sha256 !== afterInfo.sha256) {
        changed.push(relPath);
      }
    }
    for (const relPath of before.keys()) {
      if (!after.has(relPath) && !changed.includes(relPath)) {
        changed.push(relPath);
      }
    }

    if (before.headSha !== after.headSha || before.branch !== after.branch) {
      return {
        reverted: [],
        unreverted: [],
        skippedReason: "head_changed",
        observedChanges: changed,
        beforeHeadSha: before.headSha,
        afterHeadSha: after.headSha,
      };
    }

    if (changed.length === 0) return { reverted: [], unreverted: [] };

    if (options?.dryRun) {
      return {
        reverted: [],
        unreverted: [],
        skippedReason: "shared_strict_readonly_audit",
        observedChanges: changed,
        beforeHeadSha: before.headSha,
        afterHeadSha: after.headSha,
      };
    }

    const reverted: string[] = [];
    const unreverted: string[] = [];
    const rootWithSep = path.resolve(dir) + path.sep;

    for (const relPath of changed) {
      const beforeInfo = before.get(relPath);
      const afterInfo = after.get(relPath);
      const absPath = path.resolve(dir, relPath);
      if (!absPath.startsWith(rootWithSep)) {
        unreverted.push(relPath);
        continue;
      }
      if (!beforeInfo) {
        if (afterInfo?.xy === "??") {
          try {
            fs.rmSync(absPath, { recursive: true, force: true });
            reverted.push(relPath);
          } catch {
            unreverted.push(relPath);
          }
        } else {
          let restored = false;
          try {
            await runGit(dir, ["restore", "--staged", "--worktree", "--", relPath]);
            restored = true;
          } catch {
            try {
              await runGit(dir, ["checkout", "--", relPath]);
              restored = true;
            } catch {
              restored = false;
            }
          }
          if (restored) {
            reverted.push(relPath);
          } else {
            unreverted.push(relPath);
          }
        }
      } else if (beforeInfo.content) {
        try {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, beforeInfo.content);
          reverted.push(relPath);
        } catch {
          unreverted.push(relPath);
        }
      } else {
        // Pre-dirty file exceeded snapshot limits (2 MiB/file or 16 MiB total); content unavailable
        unreverted.push(relPath);
      }
    }

    return { reverted, unreverted };
  }

  async getWorkspaceStatus(dir: string): Promise<{
    branch: string | null;
    head_sha: string | null;
    dirty: boolean;
    dirty_files: string[];
  } | null> {
    if (!(await this.isGitRepo(dir))) return null;
    const [branch, head, status] = await Promise.all([
      this.getCurrentBranch(dir),
      runGit(dir, ["rev-parse", "--short", "HEAD"]).catch(() => null),
      runGit(dir, ["status", "--porcelain=v1", "-z", "-uall"]),
    ]);
    return {
      branch,
      head_sha: head?.stdout.trim() || null,
      dirty: status.stdout.length > 0,
      dirty_files: dirtyPaths(status.stdout),
    };
  }

  async collectDiff(dir: string, baseBranch?: string | null): Promise<WorkspaceDiffResult> {
    const status = await this.getWorkspaceStatus(dir);
    const target_branch = baseBranch ?? null;
    if (!status) {
      return {
        branch: null, head_sha: null, dirty: false, dirty_files: [], target_branch,
        stat: "", files: [], patch_preview: "", truncated: false,
      };
    }

    const { branch } = status;
    const filesSet = new Set(status.dirty_files);
    const statsParts: string[] = [];
    const patchParts: string[] = [];

    // 1. Committed changes relative to baseBranch if on a worker branch
    if (baseBranch && branch && branch !== baseBranch) {
      try {
        const { stdout: names } = await runGit(dir, [
          "diff",
          "--name-only",
          `${baseBranch}...HEAD`,
        ]);
        for (const f of names.split(/\r?\n/).filter(Boolean)) filesSet.add(f);

        const { stdout: stat } = await runGit(dir, ["diff", "--stat", `${baseBranch}...HEAD`]);
        if (stat.trim()) statsParts.push(`# Committed (${baseBranch}...HEAD)\n${stat.trim()}`);

        const { stdout: patch } = await runGit(dir, ["diff", `${baseBranch}...HEAD`]);
        if (patch.trim()) patchParts.push(patch);
      } catch {
        // baseBranch may not exist in an isolated clone or detached state
      }
    }

    // 2. Uncommitted working tree changes (including untracked)
    try {
      const { stdout: wtStat } = await runGit(dir, ["diff", "--stat", "HEAD"]);
      if (wtStat.trim()) statsParts.push(`# Uncommitted\n${wtStat.trim()}`);

      const { stdout: wtPatch } = await runGit(dir, ["diff", "HEAD"]);
      if (wtPatch.trim()) patchParts.push(wtPatch);
    } catch {
      // ignore if HEAD doesn't exist yet
    }

    const rawPatch = patchParts.join("\n");
    const MAX_PATCH_BYTES = 64 * 1024;
    const truncated = rawPatch.length > MAX_PATCH_BYTES;
    const patchPreview = truncated
      ? `${rawPatch.slice(0, MAX_PATCH_BYTES)}\n\n... [diff truncated at 64 KiB] ...`
      : rawPatch;

    return {
      ...status,
      target_branch,
      stat: statsParts.join("\n\n"),
      files: [...filesSet],
      patch_preview: patchPreview,
      truncated,
    };
  }

  async commitAllIfDirty(dir: string, message: string): Promise<boolean> {
    if (!(await this.isGitRepo(dir))) return false;
    const { stdout } = await runGit(dir, ["status", "--porcelain"]);
    if (!stdout.trim()) return false;
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-m", message]);
    return true;
  }

  async snapshotDirtyForHandoff(dir: string, label: string): Promise<boolean> {
    if (!(await this.isGitRepo(dir)) || !(await this.getCurrentBranch(dir))) {
      throw new Error(`Cannot snapshot handoff: '${dir}' has no checked-out Git branch.`);
    }
    return this.commitAllIfDirty(dir, `poly-swarm: wip handoff snapshot (${label})`);
  }

  async mergeWorkerBranch(
    repoRoot: string,
    branchName: string,
    workerWorkspace?: string,
    opts?: { targetBranch?: string | null; expectedSha?: string | null; beforeMerge?: () => void },
  ): Promise<MergeResult> {
    const reject = (message: string): MergeResult => ({ ok: false, conflicts: [], message });
    const checkTargetBranch = async (): Promise<MergeResult | null> => {
      if (opts?.targetBranch == null) return null;
      const current = await this.getCurrentBranch(repoRoot);
      return current === opts.targetBranch ? null : reject(
        `Current repo branch '${current ?? "(detached)"}' does not match target branch '${opts.targetBranch}'`,
      );
    };
    const wrongTarget = await checkTargetBranch();
    if (wrongTarget) return wrongTarget;

    const workspaceExists = workerWorkspace && fs.existsSync(workerWorkspace);
    const expectedSha = opts?.expectedSha;
    const branchRef = `refs/heads/${branchName}`;
    let mergeRef = branchRef;
    if (expectedSha != null) {
      if (workspaceExists) {
        const status = await this.getWorkspaceStatus(workerWorkspace);
        if (!status || status.branch !== branchName) {
          return reject(`Worker workspace is not checked out on branch '${branchName}'.`);
        }
        if (status.dirty) {
          return reject("Worker workspace has uncommitted changes. Commit and request a new review before merging.");
        }
      }
      const source = workspaceExists ? workerWorkspace : repoRoot;
      const { stdout } = await runGit(source, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
      const head = stdout.trim();
      const expected = expectedSha.toLowerCase();
      if (!/^[a-f0-9]{7,64}$/.test(expected) || !head.startsWith(expected)) {
        return reject(`Branch HEAD '${head}' does not match expected SHA '${expectedSha}'`);
      }
      if (expected !== head) {
        const matches = await runGit(source, ["rev-parse", `--disambiguate=${expected}`]);
        if (matches.stdout.trim() !== head) {
          return reject(`Expected SHA '${expectedSha}' is ambiguous; use the full commit SHA.`);
        }
      }
      if (workspaceExists && !(await runGit(repoRoot, ["cat-file", "-e", `${head}^{commit}`]).then(
        () => true,
        () => false,
      ))) {
        await runGit(repoRoot, ["fetch", "--no-tags", workerWorkspace, head]);
      }
      // Merge the exact checked object even if the source ref subsequently moves.
      mergeRef = head;
    } else {
      if (workspaceExists) {
        await this.commitAllIfDirty(workerWorkspace, `poly-swarm: commit changes on ${branchName}`);
      }
      // A branch-mode workspace is a separate clone; fetch its latest branch when needed.
      const branchKnown = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", branchRef]).then(
        () => true,
        () => false,
      );
      if (!branchKnown && workspaceExists) {
        await runGit(repoRoot, ["fetch", workerWorkspace, `${branchRef}:${branchRef}`]);
      }
    }

    const targetChanged = await checkTargetBranch();
    if (targetChanged) return targetChanged;

    // Synchronous final authorization: no awaits between this check and spawning Git.
    opts?.beforeMerge?.();
    try {
      await runGit(repoRoot, [
        "merge",
        "--no-ff",
        mergeRef,
        "-m",
        `poly-swarm: merge ${branchName}`,
      ]);
      const { stdout } = await runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
      return {
        ok: true,
        merged_commit: stdout.trim(),
        conflicts: [],
        message: `Merged ${branchName} at ${stdout.trim()}`,
      };
    } catch (err) {
      let conflicts: string[] = [];
      try {
        const { stdout } = await runGit(repoRoot, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        conflicts = stdout.split(/\r?\n/).filter(Boolean);
      } catch {
        // ignore
      }
      try {
        await runGit(repoRoot, ["merge", "--abort"]);
      } catch {
        // ignore
      }
      return {
        ok: false,
        conflicts,
        message: `Merge failed for ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async cleanupWorkspace(
    repoRoot: string,
    workspacePath: string,
    mode: WorkspaceMode,
    worktreeBranch?: string | null,
  ): Promise<void> {
    if (mode === "inherit") return;
    const allowedParent = path.resolve(repoRoot, ".poly-swarm");
    const resolvedTarget = path.resolve(workspacePath);
    if (!resolvedTarget.startsWith(allowedParent + path.sep)) {
      throw new Error(`Refusing to delete workspace outside .poly-swarm: ${resolvedTarget}`);
    }

    if (mode === "share") {
      try {
        await runGit(repoRoot, ["worktree", "remove", "--force", resolvedTarget]);
      } catch {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
        await runGit(repoRoot, ["worktree", "prune"]).catch(() => {});
      }
      if (worktreeBranch) {
        await runGit(repoRoot, ["branch", "-D", worktreeBranch]).catch(() => {});
      }
      return;
    }

    fs.rmSync(resolvedTarget, { recursive: true, force: true });
    if (worktreeBranch) {
      await runGit(repoRoot, ["branch", "-D", worktreeBranch]).catch(() => {});
    }
  }
}
