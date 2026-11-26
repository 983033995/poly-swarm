import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import type { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

async function removeStaleSocket(socketPath: string): Promise<void> {
  const before = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!before) return;
  if (!before.isSocket()) throw new Error(`MCP socket path is not a socket: ${socketPath}`);

  await new Promise<void>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(1000, () => probe.destroy(new Error(`MCP socket did not respond: ${socketPath}`)));
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`An MCP server already owns ${socketPath}`));
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") resolve();
      else reject(err);
    });
  });

  const current = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!current) return;
  if (!current.isSocket() || current.ino !== before.ino || current.dev !== before.dev) {
    throw new Error(`MCP socket changed during startup: ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

/** Each Codex client gets its own MCP protocol session and shares the running engine. */
export async function listenForCodexMcp(socketPath: string, createServer: () => McpServer): Promise<net.Server> {
  if (!path.isAbsolute(socketPath)) throw new Error("--mcp-socket requires an absolute path");
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  const server = net.createServer((socket) => {
    const session = createServer();
    const close = () => void session.close().catch((err) => console.error("[poly-swarm] MCP close:", err));
    socket.once("close", close);
    socket.on("error", (err) => console.error("[poly-swarm] MCP connection:", err.message));
    void session.connect(new StdioServerTransport(socket, socket)).catch((err) => socket.destroy(err));
  });
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  return server;
}

/** A Codex STDIO MCP registration can reconnect without starting or stopping workers. */
export function bridgeCodexMcp(socketPath: string): void {
  const socket = net.createConnection(socketPath);
  socket.on("error", (err) => {
    console.error(`[poly-swarm] Cannot connect to the local service at ${socketPath}: ${err.message}`);
    process.exitCode = 1;
  });
  socket.once("close", () => {
    process.stdin.unpipe(socket);
    process.stdin.pause();
  });
  process.stdout.once("error", () => socket.destroy());
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}
