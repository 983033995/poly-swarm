import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SRC = path.join(ROOT, "plugin");
const DIST_SRC = path.join(ROOT, "dist");
const TARGET_DIR = path.join(os.homedir(), ".gemini", "config", "plugins", "poly-swarm");

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main() {
  const serverBundle = path.join(DIST_SRC, "server.mjs");
  const hookBundle = path.join(DIST_SRC, "hook.mjs");
  const uiBundle = path.join(DIST_SRC, "dashboard.html");
  const inlineBundle = path.join(DIST_SRC, "inline-nodes.html");
  if (!fs.existsSync(serverBundle) || !fs.existsSync(hookBundle) || !fs.existsSync(uiBundle) || !fs.existsSync(inlineBundle)) {
    throw new Error("dist/server.mjs, dist/hook.mjs, dist/dashboard.html, or dist/inline-nodes.html missing; run build first.");
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  copyRecursive(PLUGIN_SRC, TARGET_DIR);

  const hookWrapper = path.join(TARGET_DIR, "scripts", "post-invocation-hook.sh");
  if (fs.existsSync(hookWrapper)) {
    fs.chmodSync(hookWrapper, 0o755);
  }

  const targetDist = path.join(TARGET_DIR, "dist");
  fs.mkdirSync(targetDist, { recursive: true });
  fs.copyFileSync(serverBundle, path.join(targetDist, "server.mjs"));
  fs.copyFileSync(hookBundle, path.join(targetDist, "hook.mjs"));
  fs.copyFileSync(uiBundle, path.join(targetDist, "dashboard.html"));
  fs.copyFileSync(inlineBundle, path.join(targetDist, "inline-nodes.html"));

  const readmeSrc = path.join(ROOT, "README.md");
  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, path.join(TARGET_DIR, "README.md"));
  }

  console.error(`[install-plugin] Installed poly-swarm plugin to ${TARGET_DIR}`);
}

main();
