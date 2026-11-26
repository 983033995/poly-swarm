import fs from "node:fs";
import path from "node:path";

export function resolveWorktreeGitCommonDir(cwd: string): string | null {
  try {
    const dotGit = path.join(cwd, ".git");
    if (!fs.statSync(dotGit).isFile()) return null;
    const raw = fs.readFileSync(dotGit, "utf8");
    const match = raw.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return null;
    const gitDir = path.resolve(cwd, match[1].trim());
    const commonDirFile = path.join(gitDir, "commondir");
    let targetDir = gitDir;
    if (fs.existsSync(commonDirFile)) {
      const rel = fs.readFileSync(commonDirFile, "utf8").trim();
      if (rel) targetDir = path.resolve(gitDir, rel);
    }
    return fs.statSync(targetDir).isDirectory() ? targetDir : null;
  } catch {
    return null;
  }
}
