import type { BackendHealth, BackendId, RealBackendId } from "../../shared/types.js";
import type { PolySwarmConfig } from "../config.js";
import type { PolySwarmDB } from "../db.js";
import { AgyAdapter } from "./agy.js";
import type { WorkerAdapter } from "./base.js";
import { CodeBuddyAdapter } from "./codebuddy.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { GrokAdapter } from "./grok.js";
import { MockAdapter } from "./mock.js";
import { OpenCodeAdapter } from "./opencode.js";
import { QoderAdapter } from "./qoder.js";
import { TraeAdapter } from "./trae.js";

export const REAL_BACKEND_IDS: RealBackendId[] = [
  "agy",
  "cursor",
  "grok",
  "opencode",
  "codex",
  "qoder",
  "codebuddy",
  "trae",
];

export class AdapterRegistry {
  private readonly adapters = new Map<BackendId, WorkerAdapter>();

  constructor() {
    const list: WorkerAdapter[] = [
      new AgyAdapter(),
      new CursorAdapter(),
      new GrokAdapter(),
      new OpenCodeAdapter(),
      new CodexAdapter(),
      new QoderAdapter(),
      new CodeBuddyAdapter(),
      new TraeAdapter(),
      new MockAdapter(),
    ];
    for (const adapter of list) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: BackendId): WorkerAdapter {
    const found = this.adapters.get(id);
    if (!found) {
      throw new Error(`Unknown backend adapter: '${id}'`);
    }
    return found;
  }

  listIds(includeMock = false): BackendId[] {
    return includeMock ? [...REAL_BACKEND_IDS, "mock"] : [...REAL_BACKEND_IDS];
  }

  async detectAllBackends(
    db: PolySwarmDB,
    config: PolySwarmConfig,
    includeMock = false,
  ): Promise<BackendHealth[]> {
    const ids = this.listIds(includeMock);
    const checks = await Promise.all(
      ids.map(async (id) => {
        const adapter = this.get(id);
        const override = config.backends[id];
        const supports_strict_readonly = adapter.capabilities.supportsStrictReadonly ? 1 : 0;
        if (override?.enabled === false) {
          return {
            backend: id,
            installed: 0,
            binary_path: null,
            version: "disabled in config",
            supports_acp: adapter.capabilities.supportsAcp ? 1 : 0,
            cli_supports_acp: adapter.capabilities.cliSupportsAcp ? 1 : 0,
            active_protocol: adapter.capabilities.activeProtocol ?? "headless_cli",
            supports_headless: adapter.capabilities.supportsHeadless ? 1 : 0,
            supports_resume: adapter.capabilities.supportsResume ? 1 : 0,
            supports_exact_usage: adapter.capabilities.supportsExactUsage ? 1 : 0,
            supports_strict_readonly,
            last_checked_at: Date.now(),
          };
        }
        return { ...(await adapter.checkHealth(override)), supports_strict_readonly };
      }),
    );

    for (const item of checks) {
      db.upsertBackendHealth(item);
    }
    return db.listBackendHealth();
  }
}
