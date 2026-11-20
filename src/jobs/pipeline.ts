import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Snapshot } from "../statechart/core.ts";
import {
  checkGroup,
  checkId,
  checkSession,
  jobDir,
  launchJob,
  openDb,
  pokeController,
  stopJob,
  transaction,
  validateWake,
  type DeliveryInfo,
  type Options,
  type Row as JobRow,
  type WakeInput,
} from "./core.ts";
import type { DeliveryState, ExecutionOutcome, WakeTarget } from "./chart.ts";
import {
  bindArgv,
  createPipelineSnapshot,
  pipelineDeliveryFromSnapshot,
  pipelineStateFromSnapshot,
  stepPipeline,
  type PipelineContext,
  type PipelineEffect,
  type PipelineStageName,
  type PipelineState,
  type StageRecord,
  type StageSpec,
} from "./pipeline-chart.ts";

export interface PipelineInput {
  id: string;
  group: string;
  cwd: string;
  diagnose: string[];
  implement: string[];
  review: string[];
  requireApproval?: boolean;
  maxStageRetries?: number;
  ownerSession?: string;
  wake?: WakeInput;
}

export interface Pipeline {
  id: string;
  kind: "worker-pipeline";
  group: string;
  ownerSession: string | null;
  state: PipelineState;
  requireApproval: boolean;
  activeJobId: string | null;
  stages: Partial<Record<PipelineStageName, StageRecord>>;
  error: string | null;
  created: string;
  updated: string;
  finished: string | null;
  delivery: DeliveryInfo;
}

export interface WorkflowRow {
  id: string;
  kind: string;
  group_name: string;
  owner_session: string | null;
  state: PipelineState;
  active_job_id: string | null;
  snapshot_json: string;
  created: string;
  updated: string;
  finished: string | null;
  delivery_state: DeliveryState;
  delivery_attempts: number;
  delivery_max_retries: number;
  delivery_next_at: string | null;
  delivery_error: string | null;
  delivery_notified: number;
}

function checkArgv(argv: unknown, label: string) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 256 || argv.some(a => typeof a !== "string" || a.includes("\0") || a.length > 16384)) {
    throw new Error(`invalid ${label} argv`);
  }
  if (!path.isAbsolute(argv[0])) throw new Error(`${label} argv executable must be absolute`);
}

function validatePipelineInput(input: PipelineInput) {
  const allowed = new Set(["id", "group", "cwd", "diagnose", "implement", "review", "requireApproval", "maxStageRetries", "ownerSession", "wake"]);
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !allowed.has(k))) {
    throw new Error("unsupported pipeline input field");
  }
  checkId(input.id);
  checkGroup(input.group);
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory()) {
    throw new Error("cwd must be an absolute existing directory");
  }
  checkArgv(input.diagnose, "diagnose");
  checkArgv(input.implement, "implement");
  checkArgv(input.review, "review");
  if (input.maxStageRetries !== undefined && (!Number.isInteger(input.maxStageRetries) || input.maxStageRetries < 0 || input.maxStageRetries > 3)) {
    throw new Error("maxStageRetries must be an integer between 0 and 3");
  }
  if (input.ownerSession !== undefined) checkSession(input.ownerSession, "ownerSession");
  validateWake(input.wake);
}

export function ensureWorkflowSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    group_name TEXT NOT NULL,
    owner_session TEXT,
    state TEXT NOT NULL,
    active_job_id TEXT,
    snapshot_json TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    finished TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'skipped',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    delivery_max_retries INTEGER NOT NULL DEFAULT 5,
    delivery_next_at TEXT,
    delivery_error TEXT,
    delivery_notified INTEGER NOT NULL DEFAULT 0
  );`);
}

function getWorkflowRow(db: DatabaseSync, id: string): WorkflowRow {
  const r = db.prepare("SELECT * FROM workflows WHERE id=?").get(id) as unknown as WorkflowRow | undefined;
  if (!r) throw new Error(`pipeline not found: ${id}`);
  return r;
}

export function parseWorkflowSnapshot(r: WorkflowRow): Snapshot<PipelineContext> {
  return JSON.parse(r.snapshot_json) as Snapshot<PipelineContext>;
}

function toPipeline(r: WorkflowRow): Pipeline {
  const snap = parseWorkflowSnapshot(r);
  const ctx = snap.context;
  return {
    id: r.id,
    kind: "worker-pipeline",
    group: r.group_name,
    ownerSession: r.owner_session ?? null,
    state: r.state,
    requireApproval: ctx.requireApproval,
    activeJobId: r.active_job_id ?? null,
    stages: ctx.stages,
    error: ctx.error,
    created: r.created,
    updated: r.updated,
    finished: r.finished ?? null,
    delivery: {
      state: r.delivery_state,
      attempts: r.delivery_attempts,
      maxRetries: r.delivery_max_retries,
      nextAt: r.delivery_next_at ?? null,
      error: r.delivery_error ?? null,
      notified: !!r.delivery_notified,
      session: ctx.wake?.session ?? null,
    },
  };
}

function persistSnapshot(db: DatabaseSync, id: string, snap: Snapshot<PipelineContext>, now: string): void {
  const state = pipelineStateFromSnapshot(snap);
  const delivery = pipelineDeliveryFromSnapshot(snap);
  db.prepare(`UPDATE workflows SET
    state=?, active_job_id=?, snapshot_json=?, updated=?, finished=?,
    delivery_state=?, delivery_attempts=?, delivery_next_at=?, delivery_error=?, delivery_notified=?
    WHERE id=?`).run(
    state,
    snap.context.activeJobId,
    JSON.stringify(snap),
    now,
    snap.context.finished,
    delivery,
    snap.context.deliveryAttempts,
    snap.context.nextDeliveryAt,
    snap.context.lastDeliveryError,
    snap.context.notified ? 1 : 0,
    id,
  );
}

function failSpawn(dir: string, workflowId: string, jobId: string, error: string): void {
  const db = openDb(dir);
  const followUp: PipelineEffect[] = [];
  try {
    ensureWorkflowSchema(db);
    transaction(db, () => {
      const fresh = db.prepare("SELECT * FROM workflows WHERE id=?").get(workflowId) as unknown as WorkflowRow | undefined;
      if (!fresh || fresh.active_job_id !== jobId) return;
      const snap = parseWorkflowSnapshot(fresh);
      const res = stepPipeline(snap, {
        type: "job.terminal",
        jobId,
        status: "failed",
        exitCode: null,
        log: "",
        error,
        finished: new Date().toISOString(),
        nextJobId: randomUUID(),
      });
      if (res.changed) {
        persistSnapshot(db, workflowId, res.snapshot, new Date().toISOString());
        for (const eff of res.effects) followUp.push(eff);
      }
    });
  } finally {
    db.close();
  }
  if (followUp.length > 0) runPipelineEffects(followUp, dir);
}

function runPipelineEffects(effects: readonly PipelineEffect[], dir: string): void {
  for (const eff of effects) {
    if (eff.type === "job.spawn") {
      try {
        launchJob({
          id: eff.jobId,
          group: eff.group,
          argv: [...eff.argv],
          cwd: eff.cwd,
          ...(eff.ownerSession ? { ownerSession: eff.ownerSession } : {}),
        }, { dir });
      } catch (e) {
        failSpawn(dir, eff.workflowId, eff.jobId, `child job spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (eff.type === "job.stop") {
      try {
        stopJob(eff.jobId, { dir, allSessions: true });
      } catch {
        // Child may still be launching or already terminal; advanceWorkflows retries stop on cancelling workflows.
      }
    }
  }
}

export function launchPipeline(input: PipelineInput, options: Options = {}): Pipeline {
  validatePipelineInput(input);
  const dir = jobDir(options);
  const ownerSession = input.ownerSession ?? options.ownerSession ?? null;
  const wake: WakeTarget | null = input.wake
    ? {
        session: input.wake.session,
        prompt: input.wake.prompt,
        cwd: input.cwd,
        ...(input.wake.model ? { model: input.wake.model } : {}),
      }
    : null;
  const maxRetries = input.wake?.maxRetries ?? 5;
  const specs: Record<PipelineStageName, StageSpec> = {
    diagnose: { argv: [...input.diagnose], cwd: input.cwd },
    implement: { argv: [...input.implement], cwd: input.cwd },
    review: { argv: [...input.review], cwd: input.cwd },
  };

  let initialEffect: PipelineEffect | null = null;
  const db = openDb(dir);
  try {
    ensureWorkflowSchema(db);
    transaction(db, () => {
      const existing = db.prepare("SELECT * FROM workflows WHERE id=?").get(input.id) as unknown as WorkflowRow | undefined;
      if (existing) {
        const existingCtx = parseWorkflowSnapshot(existing).context;
        if (
          existing.group_name !== input.group ||
          JSON.stringify(existingCtx.specs) !== JSON.stringify(specs) ||
          existingCtx.requireApproval !== !!input.requireApproval ||
          existingCtx.maxStageRetries !== (input.maxStageRetries ?? 0) ||
          JSON.stringify(existingCtx.wake) !== JSON.stringify(wake)
        ) throw new Error("pipeline id conflict");
        return;
      }
      const now = new Date().toISOString();
      const firstJobId = randomUUID();
      const created = createPipelineSnapshot({
        workflowId: input.id,
        group: input.group,
        ownerSession,
        requireApproval: !!input.requireApproval,
        maxStageRetries: input.maxStageRetries ?? 0,
        specs,
        firstJobId,
        wake,
        maxRetries,
      });
      initialEffect = created.initialEffect;
      db.prepare(`INSERT INTO workflows(
        id, kind, group_name, owner_session, state, active_job_id, snapshot_json,
        created, updated, finished, delivery_state, delivery_attempts, delivery_max_retries
      ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,0,?)`).run(
        input.id,
        "worker-pipeline",
        input.group,
        ownerSession,
        pipelineStateFromSnapshot(created.snapshot),
        firstJobId,
        JSON.stringify(created.snapshot),
        now,
        now,
        pipelineDeliveryFromSnapshot(created.snapshot),
        maxRetries,
      );
    });
  } finally {
    db.close();
  }

  if (initialEffect) {
    runPipelineEffects([initialEffect], dir);
    pokeController(dir);
  }

  return pipelineStatus(input.id, options);
}

export function pipelineStatus(id: string, options: Options = {}): Pipeline {
  checkId(id);
  const db = openDb(jobDir(options));
  try {
    ensureWorkflowSchema(db);
    const r = getWorkflowRow(db, id);
    if (options.ownerSession && !options.allSessions && r.owner_session && r.owner_session !== options.ownerSession) {
      throw new Error(`pipeline ${id} is owned by session ${r.owner_session}; pass allSessions to override`);
    }
    return toPipeline(r);
  } finally {
    db.close();
  }
}

export function listPipelines(group?: string, options: Options = {}): Pipeline[] {
  if (group !== undefined) checkGroup(group);
  const db = openDb(jobDir(options));
  try {
    ensureWorkflowSchema(db);
    const scopeSession = options.ownerSession && !options.allSessions ? options.ownerSession : undefined;
    let rows: WorkflowRow[];
    if (group !== undefined && scopeSession !== undefined) {
      rows = db.prepare("SELECT * FROM workflows WHERE group_name=? AND owner_session=? ORDER BY created,id").all(group, scopeSession) as unknown as WorkflowRow[];
    } else if (group !== undefined) {
      rows = db.prepare("SELECT * FROM workflows WHERE group_name=? ORDER BY created,id").all(group) as unknown as WorkflowRow[];
    } else if (scopeSession !== undefined) {
      rows = db.prepare("SELECT * FROM workflows WHERE owner_session=? ORDER BY created,id").all(scopeSession) as unknown as WorkflowRow[];
    } else {
      rows = db.prepare("SELECT * FROM workflows ORDER BY created,id").all() as unknown as WorkflowRow[];
    }
    return rows.map(toPipeline);
  } finally {
    db.close();
  }
}

export function approvePipeline(id: string, options: Options = {}): Pipeline {
  checkId(id);
  const dir = jobDir(options);
  let effects: readonly PipelineEffect[] = [];
  const db = openDb(dir);
  try {
    ensureWorkflowSchema(db);
    transaction(db, () => {
      const r = getWorkflowRow(db, id);
      if (options.ownerSession && !options.allSessions && r.owner_session && r.owner_session !== options.ownerSession) {
        throw new Error(`pipeline ${id} is owned by session ${r.owner_session}; pass allSessions to override`);
      }
      if (r.state !== "awaiting_approval") {
        throw new Error(`pipeline ${id} is in state "${r.state}", not awaiting_approval`);
      }
      const snap = parseWorkflowSnapshot(r);
      const res = stepPipeline(snap, { type: "approve", nextJobId: randomUUID() });
      effects = res.effects;
      persistSnapshot(db, id, res.snapshot, new Date().toISOString());
    });
  } finally {
    db.close();
  }
  runPipelineEffects(effects, dir);
  pokeController(dir);
  return pipelineStatus(id, options);
}

export function cancelPipeline(id: string, options: Options = {}): Pipeline {
  checkId(id);
  const dir = jobDir(options);
  let effects: readonly PipelineEffect[] = [];
  const db = openDb(dir);
  try {
    ensureWorkflowSchema(db);
    transaction(db, () => {
      const r = getWorkflowRow(db, id);
      if (options.ownerSession && !options.allSessions && r.owner_session && r.owner_session !== options.ownerSession) {
        throw new Error(`pipeline ${id} is owned by session ${r.owner_session}; pass allSessions to override`);
      }
      if (["completed", "failed", "cancelled"].includes(r.state)) return;
      const snap = parseWorkflowSnapshot(r);
      const res = stepPipeline(snap, { type: "cancel", finished: new Date().toISOString() });
      if (res.changed) {
        effects = res.effects;
        persistSnapshot(db, id, res.snapshot, new Date().toISOString());
      }
    });
  } finally {
    db.close();
  }
  runPipelineEffects(effects, dir);
  // Immediately check if stopping the child made it terminal so status reflects cancellation promptly.
  advanceWorkflows(dir);
  pokeController(dir);
  return pipelineStatus(id, options);
}

export function advanceWorkflows(dir: string): void {
  const effectsToRun: PipelineEffect[] = [];
  const db = openDb(dir);
  try {
    ensureWorkflowSchema(db);
    const active = db.prepare(
      "SELECT * FROM workflows WHERE state NOT IN ('completed','failed','cancelled') AND active_job_id IS NOT NULL ORDER BY created,id",
    ).all() as unknown as WorkflowRow[];

    for (const wf of active) {
      if (!wf.active_job_id) continue;
      const child = db.prepare("SELECT * FROM jobs WHERE id=?").get(wf.active_job_id) as unknown as JobRow | undefined;
      if (!child) {
        // Missing child row: if cancelling, finalize cleanly; otherwise retry spawn or fail if unspawnable.
        if (wf.state === "cancelling") {
          transaction(db, () => {
            const fresh = getWorkflowRow(db, wf.id);
            if (fresh.active_job_id !== wf.active_job_id) return;
            const snap = parseWorkflowSnapshot(fresh);
            const res = stepPipeline(snap, {
              type: "job.terminal",
              jobId: wf.active_job_id!,
              status: "cancelled",
              exitCode: null,
              log: "",
              error: null,
              finished: new Date().toISOString(),
              nextJobId: randomUUID(),
            });
            if (res.changed) persistSnapshot(db, wf.id, res.snapshot, new Date().toISOString());
          });
        } else {
          const snap = parseWorkflowSnapshot(wf);
          const stage = snap.context.activeStage;
          if (stage) {
            const spec = snap.context.specs[stage];
            effectsToRun.push({
              type: "job.spawn",
              workflowId: wf.id,
              stage,
              jobId: wf.active_job_id,
              group: wf.group_name,
              argv: bindArgv(spec.argv, snap.context.stages),
              cwd: spec.cwd,
              ownerSession: wf.owner_session,
            });
          }
        }
        continue;
      }

      if (!["succeeded", "failed", "cancelled", "interrupted"].includes(child.state)) {
        // If cancelling and child is still active (e.g. previous stop failed during launching window), retry stop.
        if (wf.state === "cancelling") {
          effectsToRun.push({ type: "job.stop", workflowId: wf.id, jobId: child.id });
        }
        continue;
      }

      transaction(db, () => {
        const fresh = getWorkflowRow(db, wf.id);
        if (fresh.active_job_id !== child.id) return;
        const snap = parseWorkflowSnapshot(fresh);
        const res = stepPipeline(snap, {
          type: "job.terminal",
          jobId: child.id,
          status: child.state as ExecutionOutcome,
          exitCode: child.exit_code,
          log: child.log,
          error: child.error,
          finished: child.finished ?? new Date().toISOString(),
          nextJobId: randomUUID(),
        });
        if (res.changed) {
          persistSnapshot(db, wf.id, res.snapshot, new Date().toISOString());
          for (const eff of res.effects) effectsToRun.push(eff);
        }
      });
    }
  } finally {
    db.close();
  }

  if (effectsToRun.length > 0) {
    runPipelineEffects(effectsToRun, dir);
  }
}
