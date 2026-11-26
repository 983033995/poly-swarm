import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_TESTS_DIR = path.join(ROOT, "dist-tests");
const BUILD_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

const NODE_ESM_BANNER = `import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);`;

async function buildSingleFileHtml(entryTs, cssFile, htmlTemplate, outName, withWorkbench = false) {
  const uiResult = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "ui", entryTs)],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    loader: { ".webp": "dataurl" },
    charset: "utf8",
    minify: true,
    legalComments: "none",
    define: {
      __POLY_SWARM_BUILD_ID__: JSON.stringify(BUILD_ID),
      __POLY_SWARM_EMBED_WORKBENCH__: JSON.stringify(withWorkbench),
    },
  });

  const jsCode = uiResult.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const cssCode = fs.readFileSync(path.join(ROOT, "src", "ui", cssFile), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "src", "ui", htmlTemplate), "utf8");

  const finalHtml = template
    .replace("/*__INLINE_CSS__*/", () => cssCode)
    .replace("<!--__WORKBENCH_STYLE__-->", () => withWorkbench
      ? `<style id="workbench-style" media="not all">${fs.readFileSync(path.join(ROOT, "src", "ui", "styles.css"), "utf8")}</style>` : "")
    .replace("<!--__WORKBENCH_ROOT__-->", withWorkbench ? `<div id="inline-workbench" hidden>
      <div class="app-shell"><div class="panel-card">Loading Poly Swarm...</div></div>
    </div>` : "")
    .replace("/*__INLINE_JS__*/", () => jsCode);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, outName);
  fs.writeFileSync(outPath, finalHtml, "utf8");
  console.error(`[build] wrote ${outPath} (${Buffer.byteLength(finalHtml, "utf8")} bytes)`);
}

async function buildUiHtml() {
  await Promise.all([
    buildSingleFileHtml("dashboard.ts", "styles.css", "index.html", "dashboard.html"),
    buildSingleFileHtml("inline.ts", "inline.css", "inline.html", "inline-nodes.html"),
    buildSingleFileHtml("inline.ts", "inline.css", "inline.html", "codex-inline-nodes.html", true),
  ]);
}

async function buildServer() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, "server.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "server", "index.ts")],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    external: ["node:*"],
    banner: { js: NODE_ESM_BANNER },
    sourcemap: false,
    define: {
      __POLY_SWARM_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  });
  console.error(`[build] wrote ${outPath}`);
}

async function buildHook() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, "hook.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "server", "hook_cli.ts")],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    external: ["node:*"],
    banner: { js: NODE_ESM_BANNER },
    sourcemap: false,
    define: {
      __POLY_SWARM_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  });
  console.error(`[build] wrote ${outPath}`);
}

async function buildTests() {
  const testsDir = path.join(ROOT, "tests");
  if (!fs.existsSync(testsDir)) return;
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));
  if (files.length === 0) return;

  fs.rmSync(DIST_TESTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_TESTS_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: files.map((f) => path.join(testsDir, f)),
    outdir: DIST_TESTS_DIR,
    outExtension: { ".js": ".mjs" },
    loader: { ".webp": "dataurl" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    external: ["node:*"],
    banner: { js: NODE_ESM_BANNER },
    define: {
      __POLY_SWARM_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  });
  console.error(`[build] wrote ${files.length} test bundle(s) to ${DIST_TESTS_DIR}`);
}

async function main() {
  const withTests = process.argv.includes("--tests");
  await buildUiHtml();
  await buildServer();
  await buildHook();
  if (withTests) {
    await buildTests();
  }
}

main().catch((err) => {
  console.error("[build] failed:", err);
  process.exit(1);
});
