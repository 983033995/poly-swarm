import { z } from "zod";
import type { PolySwarmEngine } from "../core/engine.js";

export const SURFACE = z.enum(["workbench", "inline", "global"]);
export const SESSION_FIELDS = {
  swarm_id: z.string().optional(),
  team_id: z.string().optional(),
  conversation_id: z.string().optional(),
  conversation_title: z.string().optional(),
  repo_root: z.string().optional(),
};

export const TEAM_ACTION_SCHEMA = z.object({
  ...SESSION_FIELDS,
  action: z.enum(["list", "attach", "reopen", "new_wave", "rename", "rename_conversation", "assign_conversation"]),
  title: z.string().optional(),
  name: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  target_conversation_id: z.string().nullable().optional(),
  reopen: z.boolean().optional(),
  base_branch: z.string().optional(),
  surface: SURFACE.optional(),
});

export class TeamActionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function runTeamAction(engine: PolySwarmEngine, input: z.infer<typeof TEAM_ACTION_SCHEMA>) {
  const teamId = input.team_id?.trim();
  const swarmId = input.swarm_id?.trim();
  switch (input.action) {
    case "list":
      return { teams: engine.db.listTeamSummaries(30, input.conversation_id?.trim()) };
    case "reopen": {
      if (!swarmId) throw new TeamActionError(400, "reopen requires 'swarm_id'.");
      const record = engine.db.getSwarm(swarmId);
      if (!record) throw new TeamActionError(404, `Swarm '${swarmId}' not found.`);
      if (teamId && record.team_id !== teamId) {
        throw new TeamActionError(400, `Swarm '${swarmId}' does not belong to team '${teamId}'.`);
      }
      if (record.status === "archived") throw new TeamActionError(409, `Swarm '${swarmId}' is archived. Start a new wave instead.`);
      const swarm = await engine.reopenSwarm(swarmId);
      const snapshot = await engine.getDashboardSnapshot(swarm.id, {
        conversationId: input.conversation_id, repoRoot: input.repo_root, surface: input.surface,
      });
      return { swarm, snapshot };
    }
    case "rename_conversation": {
      const targetId = input.target_conversation_id?.trim();
      if (!targetId) throw new TeamActionError(400, "rename_conversation requires 'target_conversation_id'.");
      const conversation_archives = engine.renameConversation(targetId, input.name ?? null);
      return { conversation_archives };
    }
    case "assign_conversation": {
      if (!swarmId) throw new TeamActionError(400, "assign_conversation requires 'swarm_id'.");
      try {
        return engine.assignSwarmConversation(
          swarmId,
          input.target_conversation_id?.trim() || null,
          input.conversation_id?.trim() || null,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) throw new TeamActionError(404, msg);
        throw new TeamActionError(409, msg);
      }
    }
  }
  if (!teamId) throw new TeamActionError(400, `${input.action} requires 'team_id'.`);
  if (!engine.db.getTeam(teamId)) throw new TeamActionError(404, `Team '${teamId}' not found.`);
  switch (input.action) {
    case "attach":
      if (swarmId && engine.db.getSwarm(swarmId)?.team_id !== teamId) {
        throw new TeamActionError(400, `Swarm '${swarmId}' does not belong to team '${teamId}'.`);
      }
      return { ...await engine.attachSessionToTeam({ ...input, team_id: teamId }) };
    case "new_wave": {
      const swarm = await engine.startNewWave({ ...input, team_id: teamId });
      const snapshot = await engine.getDashboardSnapshot(swarm.id, {
        conversationId: input.conversation_id, surface: input.surface,
      });
      return { team: snapshot.team, swarm, snapshot };
    }
    case "rename":
      if (!input.name?.trim()) throw new TeamActionError(400, "rename requires a non-empty 'name'.");
      return { team: engine.renameTeam(teamId, input.name, input.goal) };
  }
}
