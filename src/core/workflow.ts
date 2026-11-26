import type {
  BackendId,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowStepDef,
} from "../shared/types.js";
import type { PolySwarmEngine } from "./engine.js";

function interpolateTemplate(template: string, results: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_full, key: string) => {
    if (!(key in results)) return `{{${key}}}`;
    const val = results[key];
    return typeof val === "string" ? val : JSON.stringify(val, null, 2);
  });
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const candidate = fenceMatch?.[1]?.trim() ?? trimmed;
  return JSON.parse(candidate);
}

export function validateJsonSchemaLite(
  value: unknown,
  schema: Record<string, unknown>,
  pathLabel = "$",
): string | null {
  const expectedType = schema.type;
  if (typeof expectedType === "string") {
    const actualType = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    if (expectedType === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${pathLabel}: expected integer, got ${actualType}`;
      }
    } else if (expectedType === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${pathLabel}: expected number, got ${actualType}`;
      }
    } else if (actualType !== expectedType) {
      return `${pathLabel}: expected ${expectedType}, got ${actualType}`;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${pathLabel}: value must be one of ${JSON.stringify(schema.enum)}`;
  }

  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey === "string" && !(reqKey in obj)) {
          return `${pathLabel}.${reqKey}: missing required property`;
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      for (const [k, propSchema] of Object.entries(props)) {
        if (k in obj && propSchema && typeof propSchema === "object") {
          const err = validateJsonSchemaLite(obj[k], propSchema, `${pathLabel}.${k}`);
          if (err) return err;
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    const itemSchema = schema.items as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      const err = validateJsonSchemaLite(value[i], itemSchema, `${pathLabel}[${i}]`);
      if (err) return err;
    }
  }

  return null;
}

const ALLOWED_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  const seenIds = new Set<string>();
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      const id = (step.id ?? "").trim();
      if (!id) {
        throw new Error(`Workflow phase '${phase.name}' contains a step with empty id.`);
      }
      if (seenIds.has(id)) {
        throw new Error(`Duplicate workflow step id '${id}'. Step IDs must be unique.`);
      }
      seenIds.add(id);

      if (step.readonly === false) {
        throw new Error(
          `Workflow write steps (readonly=false) are disabled in v0.5 for workspace isolation safety (step '${id}'). Use poly_swarm_dispatch with role='author' and workspace_mode='share' instead.`,
        );
      }

      if (step.json_schema !== undefined) {
        if (!step.json_schema || typeof step.json_schema !== "object" || Array.isArray(step.json_schema)) {
          throw new Error(`Workflow step '${id}' json_schema must be a plain object.`);
        }
        const t = (step.json_schema as Record<string, unknown>).type;
        if (t !== undefined && (typeof t !== "string" || !ALLOWED_SCHEMA_TYPES.has(t))) {
          throw new Error(`Workflow step '${id}' json_schema has unsupported type '${String(t)}'.`);
        }
      }
    }
  }
}

export class WorkflowRunner {
  private readonly engine: PolySwarmEngine;

  constructor(engine: PolySwarmEngine) {
    this.engine = engine;
  }

  async run(definition: WorkflowDefinition): Promise<WorkflowRecord> {
    validateWorkflowDefinition(definition);

    let swarmId = definition.swarm_id ?? null;
    const createdByWorkflow = !swarmId;
    let cwd = definition.repo_root || process.cwd();

    if (swarmId) {
      const existing = this.engine.db.getSwarm(swarmId);
      if (!existing) {
        throw new Error(`Swarm '${swarmId}' not found for workflow.`);
      }
      if (definition.team_id && existing.team_id !== definition.team_id) {
        throw new Error(`Swarm '${swarmId}' does not belong to team '${definition.team_id}'.`);
      }
      if (!definition.repo_root) cwd = existing.repo_root;
    } else {
      const team = definition.team_id ? this.engine.db.getTeam(definition.team_id) : null;
      const swarm = await this.engine.createSwarm({
        title: `Workflow: ${definition.description}`,
        repo_root: definition.repo_root || team?.repo_root || cwd,
        team_id: definition.team_id,
        conversation_id: definition.conversation_id,
        auto_created_by_workflow: true,
      });
      swarmId = swarm.id;
      cwd = swarm.repo_root;
    }

    const wf = this.engine.db.createWorkflow({
      swarm_id: swarmId,
      description: definition.description,
      definition,
    });

    const results: Record<string, unknown> = {};
    const appendLog = (msg: string) => {
      this.engine.db.appendWorkflowLog(wf.id, `[${new Date().toISOString()}] ${msg}`);
    };

    try {
      for (const phase of definition.phases) {
        appendLog(`Phase '${phase.name}' (${phase.mode}, ${phase.steps.length} step(s))`);

        if (phase.mode === "parallel") {
          const phaseAbort = new AbortController();
          let firstError: unknown = null;
          await Promise.allSettled(
            phase.steps.map((step) =>
              this.engine.runWithConcurrencySlot(async () => {
                if (phaseAbort.signal.aborted) {
                  appendLog(`Step '${step.id}' skipped (phase aborted)`);
                  return;
                }
                try {
                  const out = await this.executeStep(
                    wf.id,
                    swarmId!,
                    cwd,
                    step,
                    results,
                    appendLog,
                    phaseAbort.signal,
                  );
                  results[step.id] = out;
                } catch (err) {
                  if (firstError === null) {
                    firstError = err;
                  }
                  phaseAbort.abort();
                  throw err;
                }
              }),
            ),
          );
          if (firstError !== null) {
            throw firstError;
          }
        } else {
          for (const step of phase.steps) {
            const out = await this.engine.runWithConcurrencySlot(() =>
              this.executeStep(wf.id, swarmId!, cwd, step, results, appendLog),
            );
            results[step.id] = out;
          }
        }
      }

      this.engine.db.completeWorkflow(wf.id, { status: "completed", results });
      return this.engine.db.getWorkflow(wf.id)!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog(`FAILED: ${message}`);
      this.engine.db.completeWorkflow(wf.id, {
        status: "failed",
        results,
        error: message,
      });
      return this.engine.db.getWorkflow(wf.id)!;
    } finally {
      if (createdByWorkflow) {
        this.engine.db.transaction(() => {
          const swarm = this.engine.db.getSwarm(swarmId);
          if (swarm?.status !== "active") return;
          this.engine.db.updateSwarmStatus(swarmId, "done");
          const teamId = swarm.team_id;
          if (teamId && this.engine.db.getTeam(teamId)?.active_swarm_id === swarmId) {
            const previous = this.engine.db.getLatestRealActiveSwarm(teamId);
            this.engine.db.updateTeam(teamId, {
              status: previous?.status === "active" ? "active" : "paused",
              active_swarm_id: previous?.id ?? swarmId,
            });
          }
        });
      }
    }
  }

  private async executeStep(
    workflowId: string,
    swarmId: string,
    cwd: string,
    step: WorkflowStepDef,
    results: Record<string, unknown>,
    appendLog: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const policy = this.engine.resolvePolicy({ swarmId, repoRoot: cwd });
    const backend: BackendId =
      step.backend ??
      (await this.engine.selectBackend({
        capability: step.capability ?? "fanout",
        requireReadonly: true,
        policy,
      }));
    const adapter = this.engine.registry.get(backend);
    if (!adapter.capabilities.supportsStrictReadonly) {
      throw new Error(
        `Backend '${backend}' does not enforce strict readonly mode and cannot run workflow step '${step.id}'.`,
      );
    }
    const polBackend = policy.backends[backend];
    if (polBackend?.enabled === false) {
      throw new Error(
        `Backend '${backend}' is disabled in Poly Swarm policy (${polBackend.enabled_source.layer}).`,
      );
    }
    const mode: "readonly" = "readonly";

    let prompt = interpolateTemplate(step.prompt, results);
    if (step.json_schema && backend !== "agy" && backend !== "grok") {
      prompt = `${prompt}\n\nRespond ONLY with valid JSON matching this JSON Schema:\n${JSON.stringify(step.json_schema)}`;
    }

    const workerLabel = `wf:${step.id}`;
    const effectiveModel = step.model ?? polBackend?.defaultModel ?? null;
    const effectiveEffort = step.effort ?? polBackend?.defaultEffort ?? null;
    const turn = this.engine.db.createTurn({
      swarm_id: swarmId,
      worker_name: workerLabel,
      backend,
      model: effectiveModel,
      mode,
      trigger_seq: null,
      prompt_preview: prompt,
      session_id_used: null,
      owner_instance_id: this.engine.instanceId,
    });

    this.engine.db.insertDispatchEdge({
      swarm_id: swarmId,
      from_node: "coordinator",
      to_node: workerLabel,
      kind: "dispatch",
      turn_id: turn.id,
      label: `workflow (${backend})`,
    });
    const depMatches = new Set<string>();
    const depRe = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
    let depMatch: RegExpExecArray | null;
    while ((depMatch = depRe.exec(step.prompt)) !== null) {
      if (depMatch[1] && depMatch[1] in results) {
        depMatches.add(depMatch[1]);
      }
    }
    for (const dep of depMatches) {
      this.engine.db.insertDispatchEdge({
        swarm_id: swarmId,
        from_node: `wf:${dep}`,
        to_node: workerLabel,
        kind: "depends_on",
        turn_id: turn.id,
        label: `{{${dep}}}`,
      });
    }

    appendLog(`Step '${step.id}' started on backend '${backend}' (${turn.id})`);

    const rawOv = this.engine.config.backends[backend];
    const effectiveOverride = (() => {
      const baseOv = rawOv ? { ...rawOv } : {};
      if (polBackend) {
        if (polBackend.defaultModel) baseOv.defaultModel = polBackend.defaultModel;
        else delete baseOv.defaultModel;
        if (polBackend.defaultEffort) baseOv.defaultEffort = polBackend.defaultEffort;
        else delete baseOv.defaultEffort;
      }
      return Object.keys(baseOv).length > 0 ? baseOv : undefined;
    })();

    let seqInTurn = 0;
    const res = await adapter.runTurn({
      cwd,
      prompt,
      mode,
      model: effectiveModel,
      effort: effectiveEffort,
      jsonSchema: step.json_schema ?? null,
      timeoutMs: step.timeout_ms ?? this.engine.config.defaultTurnTimeoutMs,
      idleTimeoutMs: this.engine.config.defaultIdleTimeoutMs,
      hookMetricsDir: this.engine.config.hookMetricsDir,
      override: effectiveOverride,
      signal,
      onEvent: (ev) => {
        seqInTurn += 1;
        this.engine.db.insertEvent({
          turn_id: turn.id,
          swarm_id: swarmId,
          worker_name: workerLabel,
          seq_in_turn: seqInTurn,
          kind: ev.kind,
          title: ev.title ?? null,
          content: ev.content,
          meta: ev.meta ?? null,
        });
      },
    });

    this.engine.db.insertUsage({
      turn_id: turn.id,
      swarm_id: swarmId,
      worker_name: workerLabel,
      backend,
      model: effectiveModel,
      accuracy: res.usage.accuracy,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      reasoning_tokens: res.usage.reasoning_tokens,
      cache_read_tokens: res.usage.cache_read_tokens,
      cache_write_tokens: res.usage.cache_write_tokens,
      total_tokens: res.usage.total_tokens,
      cost_usd: res.usage.cost_usd,
      duration_ms: res.durationMs,
      tool_calls_count: res.toolCallsCount,
    });

    let parsedSchemaResult: unknown;
    let schemaFailureMsg: string | null = null;
    if (res.ok && step.json_schema) {
      try {
        parsedSchemaResult = res.structuredJson
          ? JSON.parse(res.structuredJson)
          : extractJsonPayload(res.outputText);
        const validationErr = validateJsonSchemaLite(parsedSchemaResult, step.json_schema);
        if (validationErr) {
          schemaFailureMsg = `Workflow step '${step.id}' schema validation failed: ${validationErr}`;
        }
      } catch (err) {
        schemaFailureMsg = `Workflow step '${step.id}' did not return valid JSON (${workflowId}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const turnFailed = !res.ok || Boolean(schemaFailureMsg);
    this.engine.db.completeTurn(turn.id, {
      status: turnFailed ? "failed" : "completed",
      error_kind: res.ok ? (schemaFailureMsg ? "unknown" : res.errorKind) : res.errorKind,
      error_message: schemaFailureMsg ?? res.errorMessage,
      output_text: res.outputText,
      structured_json: res.structuredJson,
      session_id_returned: res.sessionId,
      duration_ms: res.durationMs,
      tool_calls_count: res.toolCallsCount,
    });

    if (!res.ok) {
      throw new Error(
        `Workflow step '${step.id}' (${backend}) failed [${res.errorKind}]: ${res.errorMessage ?? "unknown error"}`,
      );
    }

    if (schemaFailureMsg) {
      throw new Error(schemaFailureMsg);
    }

    if (step.json_schema) {
      appendLog(`Step '${step.id}' completed (JSON verified, ${res.durationMs}ms)`);
      return parsedSchemaResult;
    }

    appendLog(`Step '${step.id}' completed (${res.durationMs}ms)`);
    return res.outputText;
  }
}
