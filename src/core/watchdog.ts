import { parseMessageSignals } from "./db.js";
import type { PolySwarmEngine } from "./engine.js";

export class StallWatchdog {
  private readonly engine: PolySwarmEngine;
  private timer: NodeJS.Timeout | null = null;
  private readonly alertedKeyToSeq = new Map<string, number>();

  constructor(engine: PolySwarmEngine) {
    this.engine = engine;
  }

  start(intervalMs = this.engine.config.watchdogIntervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(now = Date.now()): Promise<Array<{ swarm_id: string; reason: string }>> {
    const alerts: Array<{ swarm_id: string; reason: string }> = [];
    const swarms = this.engine.db.listSwarms(50).filter((s) => s.status === "active");

    for (const swarm of swarms) {
      const workers = this.engine.db.listWorkers(swarm.id).filter((w) => w.state !== "killed");
      if (workers.length === 0) continue;

      const waitingWorkers = workers.filter((w) => w.state === "waiting");
      if (waitingWorkers.length === 0) continue;

      const tail = this.engine.db.readBoardTail(swarm.id, 15);
      const lastMsg = tail[tail.length - 1];
      if (!lastMsg) continue;
      if (lastMsg.sender === "coordinator" && lastMsg.tag === "done") continue;

      // A worker can still be "waiting" after its dispatch was recorded or claimed:
      // drainWorkerQueue only starts the turn after a global concurrency slot opens.
      const queued = new Map(this.engine.db.listPendingDispatches(undefined, swarm.id)
        .map((dispatch) => [dispatch.worker_name, dispatch.trigger_seq]));

      // 1. Per-worker check: detect waiting workers with an unanswered direct/channel @mention past threshold
      let unansweredTarget: { workerName: string; seq: number; ageMs: number } | null = null;
      for (const w of waitingWorkers) {
        let workerChannels: string[] = ["main"];
        try {
          const parsed = JSON.parse(w.channels_json || '["main"]') as unknown;
          if (Array.isArray(parsed)) {
            workerChannels = parsed.filter((c): c is string => typeof c === "string");
          }
        } catch {
          workerChannels = ["main"];
        }

        for (let i = tail.length - 1; i >= 0; i--) {
          const m = tail[i]!;
          if (m.seq <= Math.max(w.last_post_seq, queued.get(w.name) ?? 0)) break;
          if (m.suppress_wake === 1) continue;
          if (m.sender === w.name || m.sender === "watchdog") continue;
          const mAge = now - m.created_at;
          if (mAge < this.engine.config.stallThresholdMs) continue;

          const sig = parseMessageSignals(m.text);
          const matched =
            sig.mentions.includes(w.name.toLowerCase()) ||
            sig.hasAll ||
            sig.channelMentions.some((ch) => workerChannels.includes(ch));
          if (matched) {
            const dedupKey = `${swarm.id}:w:${w.name}`;
            if (this.alertedKeyToSeq.get(dedupKey) === m.seq) break;
            unansweredTarget = { workerName: w.name, seq: m.seq, ageMs: mAge };
            break;
          }
        }
        if (unansweredTarget) break;
      }

      if (unansweredTarget) {
        const msg = `@coordinator [stall] Worker '${unansweredTarget.workerName}' has not answered #${unansweredTarget.seq} (idle ${Math.round(unansweredTarget.ageMs / 1000)}s).`;
        this.alertedKeyToSeq.set(
          `${swarm.id}:w:${unansweredTarget.workerName}`,
          unansweredTarget.seq,
        );
        await this.engine.postMessage({
          swarm_id: swarm.id,
          sender: "watchdog",
          channel: "main",
          tag: "stall",
          text: msg,
          suppressWake: true,
        });
        alerts.push({ swarm_id: swarm.id, reason: msg });
        continue;
      }

      // 2. Swarm-wide idle check when no worker is actively running
      if (workers.some((w) => w.state === "working")) continue;
      if (waitingWorkers.some((w) => queued.has(w.name))) continue;
      if (lastMsg.suppress_wake === 1) continue;
      if (lastMsg.sender === "watchdog" && lastMsg.tag === "stall") continue;

      const ageMs = now - lastMsg.created_at;
      if (ageMs < this.engine.config.stallThresholdMs) continue;

      const headDedupKey = `${swarm.id}:head`;
      if (this.alertedKeyToSeq.get(headDedupKey) === lastMsg.seq) continue;

      const sig = parseMessageSignals(lastMsg.text);
      const hasCoordinator = sig.mentions.includes("coordinator");
      const hasLiveWorker = sig.mentions.some((m) => workers.some((w) => w.name === m));
      if (!hasCoordinator && !hasLiveWorker && lastMsg.tag !== "done") {
        const msg = `@coordinator [stall] #${lastMsg.seq} (from ${lastMsg.sender}) addressed nobody; all workers waiting (${Math.round(ageMs / 1000)}s).`;
        this.alertedKeyToSeq.set(headDedupKey, lastMsg.seq);
        await this.engine.postMessage({
          swarm_id: swarm.id,
          sender: "watchdog",
          channel: "main",
          tag: "stall",
          text: msg,
          suppressWake: true,
        });
        alerts.push({ swarm_id: swarm.id, reason: msg });
      }
    }

    return alerts;
  }
}
