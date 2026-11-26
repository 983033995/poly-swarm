import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { once } from "node:events";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadPolySwarmConfig } from "../core/config.js";
import { PolySwarmDB } from "../core/db.js";
import { PolySwarmEngine } from "../core/engine.js";
import { StallWatchdog } from "../core/watchdog.js";
import { startDashboardHttpServer } from "./http.js";
import { createPolySwarmMcpServer } from "./mcp.js";
import { bridgeCodexMcp, listenForCodexMcp } from "./codex_socket.js";

function parseCliFlags(argv: string[]): {
  dataDir: string;
  configPath?: string;
  httpPort?: number;
  mcpSocket?: string;
  mcpConnect?: string;
  shareTalent: boolean;
} {
  let dataDir = path.join(os.homedir(), ".poly-swarm", "data");
  let configPath: string | undefined;
  let httpPort: number | undefined;
  let mcpSocket: string | undefined;
  let mcpConnect: string | undefined;
  let shareTalent = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i]!;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--config" && argv[i + 1]) {
      configPath = argv[++i]!;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--share-talent") {
      shareTalent = true;
    } else if (arg === "--http-port" && argv[i + 1]) {
      httpPort = Number(argv[++i]!);
    } else if (arg.startsWith("--http-port=")) {
      httpPort = Number(arg.slice("--http-port=".length));
    } else if (arg === "--mcp-socket" || arg === "--mcp-connect") {
      const socketPath = argv[++i];
      if (!socketPath || !path.isAbsolute(socketPath)) throw new Error(`${arg} requires an absolute socket path`);
      if (arg === "--mcp-socket") mcpSocket = socketPath;
      else mcpConnect = socketPath;
    }
  }

  if (httpPort !== undefined && (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535)) {
    throw new Error("--http-port must be an integer from 0 (automatic) to 65535");
  }
  if (mcpSocket && (mcpConnect || httpPort === undefined)) {
    throw new Error("--mcp-socket requires --http-port and cannot be combined with --mcp-connect");
  }
  return { dataDir, configPath, httpPort, mcpSocket, mcpConnect, shareTalent };
}

async function main(): Promise<void> {
  const flags = parseCliFlags(process.argv.slice(2));
  if (flags.mcpConnect) {
    bridgeCodexMcp(flags.mcpConnect);
    return;
  }
  if (flags.mcpSocket) process.umask(0o077);
  const config = loadPolySwarmConfig(flags.configPath);
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const db = new PolySwarmDB(flags.dataDir, flags.shareTalent ? {
    file: path.join(home, ".poly-swarm", "talent.db"),
    legacyFiles: [
      path.join(codexHome, "poly-swarm", "data", "poly-swarm.db"),
      path.join(home, ".gemini", "antigravity", "plugin_data", "poly-swarm", "poly-swarm.db"),
    ],
  } : undefined);
  const engine = new PolySwarmEngine({ db, config });
  const watchdog = new StallWatchdog(engine);
  watchdog.start();

  const httpServer =
    flags.httpPort !== undefined
      ? startDashboardHttpServer(engine, flags.httpPort)
      : null;

  const createMcpServer = () => createPolySwarmMcpServer(engine, (swarmId) => {
    const address = httpServer?.address();
    return typeof address === "object" && address
      ? `http://127.0.0.1:${address.port}${swarmId
        ? `/codex?${new URLSearchParams({ swarm_id: swarmId })}`
        : "/?surface=global"}`
      : undefined;
  }, Boolean(flags.mcpSocket));
  let socketServer: net.Server | undefined;

  const cleanup = () => {
    watchdog.stop();
    engine.shutdown();
    socketServer?.close();
    httpServer?.close();
    try {
      db.close();
    } catch {
      // ignore close errors during shutdown
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    if (httpServer) await once(httpServer, "listening");
    if (flags.mcpSocket) {
      socketServer = await listenForCodexMcp(flags.mcpSocket, createMcpServer);
      console.error(`[poly-swarm] Codex service ready (${flags.mcpSocket})`);
    } else {
      await createMcpServer().connect(new StdioServerTransport());
      console.error(`[poly-swarm] MCP server started (dataDir=${flags.dataDir})`);
    }
  } catch (err) {
    cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error("[poly-swarm] fatal error:", err);
  process.exit(1);
});
