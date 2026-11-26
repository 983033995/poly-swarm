import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = path.join(import.meta.dirname, "..");
const home = os.homedir();
const base = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "poly-swarm");
const runtime = path.join(base, "runtime");
const marketplace = path.join(base, "marketplace");
const marketplaceName = "poly-swarm-local";
const plugin = path.join(marketplace, "plugins", "poly-swarm");
const label = "com.poly-swarm.codex";
const launchAgents = path.join(home, "Library", "LaunchAgents");
const plist = path.join(launchAgents, `${label}.plist`);
const domain = `gui/${process.getuid?.()}`;
const socket = path.join(base, "mcp.sock");
const bundle = path.join(runtime, "server.mjs");
const port = "18799";

const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const command = (bin, args) => execFileSync(bin, args, { encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "pipe"] });

function isListening(address) {
  return new Promise((resolve) => {
    const client = net.createConnection(address);
    client.once("connect", () => { client.destroy(); resolve(true); });
    client.once("error", () => resolve(false));
    client.setTimeout(500, () => { client.destroy(); resolve(false); });
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Codex desktop installation requires macOS launchd.");
  command("codex", ["plugin", "marketplace", "list"]);
  let running = false;
  try { command("launchctl", ["print", `${domain}/${label}`]); running = true; } catch (err) {
    if (err.status === null) throw err;
  }
  if (!running && await isListening({ host: "127.0.0.1", port: Number(port) })) {
    throw new Error(`The Poly Swarm workbench port ${port} is already in use.`);
  }

  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const file of ["server.mjs", "dashboard.html", "inline-nodes.html"]) {
    const from = path.join(root, "dist", file === "inline-nodes.html" ? "codex-inline-nodes.html" : file);
    const to = path.join(runtime, file);
    fs.copyFileSync(from, `${to}.next`);
    fs.renameSync(`${to}.next`, to);
  }
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.cpSync(path.join(root, "plugin-codex"), plugin, { recursive: true });
  json(path.join(plugin, ".mcp.json"), {
    mcpServers: { "poly-swarm-codex": { command: process.execPath, args: [bundle, "--mcp-connect", socket] } },
  });
  const catalog = path.join(marketplace, ".agents", "plugins");
  fs.mkdirSync(catalog, { recursive: true });
  json(path.join(catalog, "marketplace.json"), {
    name: marketplaceName,
    interface: { displayName: "Poly Swarm Local" },
    plugins: [{
      name: "poly-swarm", source: { source: "local", path: "./plugins/poly-swarm" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity",
    }],
  });

  const argv = [process.execPath, bundle, "--mcp-socket", socket, "--http-port", port,
    "--data-dir", path.join(base, "data"), "--config", path.join(base, "backends.json"), "--share-talent"];
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${xml(path.join(base, "service.log"))}</string>
</dict></plist>\n`, { mode: 0o600 });
  command("plutil", ["-lint", plist]);
  if (!running) command("launchctl", ["bootstrap", domain, plist]);
  for (let attempt = 0; !(await isListening(socket)); attempt += 1) {
    if (attempt >= 30) throw new Error(`Poly Swarm did not start; inspect ${path.join(base, "service.log")}`);
    await delay(200);
  }

  const sources = command("codex", ["plugin", "marketplace", "list"]);
  if (!sources.split("\n").some((line) => line.trim().split(/\s+/)[0] === marketplaceName)) {
    command("codex", ["plugin", "marketplace", "add", marketplace]);
  }
  console.error(command("codex", ["plugin", "add", `poly-swarm@${marketplaceName}`]).trim());
  console.error(`[poly-swarm] Codex hub: http://127.0.0.1:${port}/?surface=global`);
  if (running) console.error("[poly-swarm] Existing service was left running; updated code loads on its next start.");
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
