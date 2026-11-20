import { initialSnapshot, matches, step, type Chart, type DoneEvent, type Snapshot } from "../statechart/core.ts";
import type { DeliveryState, ExecutionOutcome, WakeTarget } from "./chart.ts";

export type PipelineStageName = "diagnose" | "implement" | "review";
export type PipelineState =
  | "diagnosing"
  | "awaiting_approval"
  | "implementing"
  | "reviewing"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface StageSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface StageRecord {
  readonly jobId: string;
  readonly log: string;
  readonly status: ExecutionOutcome;
  readonly exitCode: number | null;
  readonly attempts: number;
}

export interface PipelineContext {
  readonly workflowId: string;
  readonly group: string;
  readonly ownerSession: string | null;
  readonly requireApproval: boolean;
  readonly maxStageRetries: number;
  readonly specs: Readonly<Record<PipelineStageName, StageSpec>>;
  readonly activeJobId: string | null;
  readonly activeStage: PipelineStageName | null;
  readonly stageAttempts: number;
  readonly stages: Readonly<Partial<Record<PipelineStageName, StageRecord>>>;
  readonly terminalState: "completed" | "failed" | "cancelled" | null;
  readonly error: string | null;
  readonly finished: string | null;
  readonly wake: WakeTarget | null;
  readonly deliveryAttempts: number;
  readonly maxRetries: number;
  readonly nextDeliveryAt: string | null;
  readonly lastDeliveryError: string | null;
  readonly notified: boolean;
}

export type PipelineEvent =
  | { type: "job.terminal"; jobId: string; status: ExecutionOutcome; exitCode: number | null; log: string; error: string | null; finished: string; nextJobId: string }
  | { type: "approve"; nextJobId: string }
  | { type: "cancel"; finished: string }
  | { type: "delivery.begin"; now: string }
  | { type: "delivery.ack" }
  | { type: "delivery.fail"; error: string; retryAt: string | null }
  | DoneEvent;

export type PipelineEffect =
  | { type: "job.spawn"; workflowId: string; stage: PipelineStageName; jobId: string; group: string; argv: readonly string[]; cwd: string; ownerSession: string | null }
  | { type: "job.stop"; workflowId: string; jobId: string }
  | { type: "wake.deliver"; workflowId: string; attempt: number; wake: WakeTarget; state: "completed" | "failed" | "cancelled" }
  | { type: "notify.dead_letter"; workflowId: string; group: string; state: "completed" | "failed" | "cancelled"; error: string | null };

export function bindArgv(argv: readonly string[], stages: PipelineContext["stages"]): string[] {
  const vars: Record<string, string> = {
    "diagnose.log": stages.diagnose?.log ?? "",
    "diagnose.jobId": stages.diagnose?.jobId ?? "",
    "implement.log": stages.implement?.log ?? "",
    "implement.jobId": stages.implement?.jobId ?? "",
    "review.log": stages.review?.log ?? "",
    "review.jobId": stages.review?.jobId ?? "",
  };
  return argv.map((arg) =>
    arg.replace(/\{\{(diagnose|implement|review)\.(log|jobId)\}\}/g, (_m, s, k) => vars[`${s}.${k}`] ?? ""),
  );
}

function spawnEffect(ctx: PipelineContext, stage: PipelineStageName, jobId: string): PipelineEffect {
  const spec = ctx.specs[stage];
  return {
    type: "job.spawn",
    workflowId: ctx.workflowId,
    stage,
    jobId,
    group: ctx.group,
    argv: bindArgv(spec.argv, ctx.stages),
    cwd: spec.cwd,
    ownerSession: ctx.ownerSession,
  };
}

function isMatchingJob(ctx: PipelineContext, e: PipelineEvent): e is Extract<PipelineEvent, { type: "job.terminal" }> {
  return e.type === "job.terminal" && ctx.activeJobId === e.jobId;
}

function recordStage(ctx: PipelineContext, stage: PipelineStageName, e: Extract<PipelineEvent, { type: "job.terminal" }>): PipelineContext["stages"] {
  return {
    ...ctx.stages,
    [stage]: {
      jobId: e.jobId,
      log: e.log,
      status: e.status,
      exitCode: e.exitCode,
      attempts: ctx.stageAttempts,
    },
  };
}

export const pipelineChart: Chart<PipelineContext, PipelineEvent, PipelineEffect> = {
  id: "worker-pipeline",
  root: {
    type: "parallel",
    states: {
      stage: {
        type: "compound",
        initial: "active",
        states: {
          active: {
            type: "compound",
            initial: "diagnosing",
            on: {
              cancel: {
                target: "cancelling",
                guard: (c) => c.activeJobId !== null,
                effects: [(c) => (c.activeJobId ? { type: "job.stop", workflowId: c.workflowId, jobId: c.activeJobId } : null)],
              },
            },
            states: {
              diagnosing: {
                on: {
                  "job.terminal": [
                    {
                      target: "awaiting_approval",
                      guard: (c, e) => isMatchingJob(c, e) && e.status === "succeeded" && c.requireApproval,
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: null,
                          activeStage: null,
                          stageAttempts: 0,
                          stages: recordStage(c, "diagnose", e),
                        };
                      },
                    },
                    {
                      target: "implementing",
                      guard: (c, e) => isMatchingJob(c, e) && e.status === "succeeded" && !c.requireApproval,
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: e.nextJobId,
                          activeStage: "implement",
                          stageAttempts: 1,
                          stages: recordStage(c, "diagnose", e),
                        };
                      },
                      effects: [(c, e) => (e.type === "job.terminal" ? spawnEffect(c, "implement", e.nextJobId) : null)],
                    },
                    {
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded" && c.stageAttempts <= c.maxStageRetries,
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: e.nextJobId,
                          stageAttempts: c.stageAttempts + 1,
                          stages: recordStage(c, "diagnose", e),
                        };
                      },
                      effects: [(c, e) => (e.type === "job.terminal" ? spawnEffect(c, "diagnose", e.nextJobId) : null)],
                    },
                    {
                      target: "stage_failed",
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded",
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: null,
                          activeStage: null,
                          stages: recordStage(c, "diagnose", e),
                          terminalState: "failed",
                          error: e.error ?? `diagnose stage ${e.status}`,
                          finished: e.finished,
                        };
                      },
                    },
                  ],
                },
              },
              awaiting_approval: {
                on: {
                  approve: {
                    target: "implementing",
                    assign: (c, e) => {
                      if (e.type !== "approve") return c;
                      return {
                        ...c,
                        activeJobId: e.nextJobId,
                        activeStage: "implement",
                        stageAttempts: 1,
                      };
                    },
                    effects: [(c, e) => (e.type === "approve" ? spawnEffect(c, "implement", e.nextJobId) : null)],
                  },
                  cancel: {
                    target: "stage_cancelled",
                    assign: (c, e) => ({
                      ...c,
                      activeJobId: null,
                      activeStage: null,
                      terminalState: "cancelled",
                      finished: e.type === "cancel" ? e.finished : c.finished,
                    }),
                  },
                },
              },
              implementing: {
                on: {
                  "job.terminal": [
                    {
                      target: "reviewing",
                      guard: (c, e) => isMatchingJob(c, e) && e.status === "succeeded",
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: e.nextJobId,
                          activeStage: "review",
                          stageAttempts: 1,
                          stages: recordStage(c, "implement", e),
                        };
                      },
                      effects: [(c, e) => (e.type === "job.terminal" ? spawnEffect(c, "review", e.nextJobId) : null)],
                    },
                    {
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded" && c.stageAttempts <= c.maxStageRetries,
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: e.nextJobId,
                          stageAttempts: c.stageAttempts + 1,
                          stages: recordStage(c, "implement", e),
                        };
                      },
                      effects: [(c, e) => (e.type === "job.terminal" ? spawnEffect(c, "implement", e.nextJobId) : null)],
                    },
                    {
                      target: "stage_failed",
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded",
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: null,
                          activeStage: null,
                          stages: recordStage(c, "implement", e),
                          terminalState: "failed",
                          error: e.error ?? `implement stage ${e.status}`,
                          finished: e.finished,
                        };
                      },
                    },
                  ],
                },
              },
              reviewing: {
                on: {
                  "job.terminal": [
                    {
                      target: "stage_completed",
                      guard: (c, e) => isMatchingJob(c, e) && e.status === "succeeded",
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: null,
                          activeStage: null,
                          stages: recordStage(c, "review", e),
                          terminalState: "completed",
                          finished: e.finished,
                        };
                      },
                    },
                    {
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded" && c.stageAttempts <= c.maxStageRetries,
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: e.nextJobId,
                          stageAttempts: c.stageAttempts + 1,
                          stages: recordStage(c, "review", e),
                        };
                      },
                      effects: [(c, e) => (e.type === "job.terminal" ? spawnEffect(c, "review", e.nextJobId) : null)],
                    },
                    {
                      target: "stage_failed",
                      guard: (c, e) => isMatchingJob(c, e) && e.status !== "succeeded",
                      assign: (c, e) => {
                        if (e.type !== "job.terminal") return c;
                        return {
                          ...c,
                          activeJobId: null,
                          activeStage: null,
                          stages: recordStage(c, "review", e),
                          terminalState: "failed",
                          error: e.error ?? `review stage ${e.status}`,
                          finished: e.finished,
                        };
                      },
                    },
                  ],
                },
              },
              stage_completed: { type: "final" },
              stage_failed: { type: "final" },
              stage_cancelled: { type: "final" },
            },
          },
          cancelling: {
            on: {
              "job.terminal": {
                target: "cancelled",
                guard: (c, e) => isMatchingJob(c, e),
                assign: (c, e) => {
                  if (e.type !== "job.terminal") return c;
                  const stages = c.activeStage ? recordStage(c, c.activeStage, e) : c.stages;
                  return {
                    ...c,
                    activeJobId: null,
                    activeStage: null,
                    stages,
                    terminalState: "cancelled",
                    finished: e.finished,
                  };
                },
              },
            },
          },
          completed: { type: "final" },
          failed: { type: "final" },
          cancelled: { type: "final" },
        },
        on: {},
      },
      delivery: {
        type: "compound",
        initial: "armed",
        states: {
          armed: {
            on: {
              "done.stage": [
                {
                  target: "pending",
                  guard: (c) => c.wake !== null,
                  assign: (c) => ({ ...c, nextDeliveryAt: c.finished }),
                },
                { target: "skipped" },
              ],
            },
          },
          pending: {
            on: {
              "delivery.begin": {
                target: "delivering",
                guard: (c) => c.wake !== null && c.deliveryAttempts < c.maxRetries,
                assign: (c) => ({
                  ...c,
                  deliveryAttempts: c.deliveryAttempts + 1,
                  nextDeliveryAt: null,
                }),
                effects: [(c) => {
                  if (!c.wake || !c.terminalState) return null;
                  return { type: "wake.deliver", workflowId: c.workflowId, attempt: c.deliveryAttempts, wake: c.wake, state: c.terminalState };
                }],
              },
            },
          },
          delivering: {
            on: {
              "delivery.ack": {
                target: "acked",
                assign: (c) => ({ ...c, lastDeliveryError: null, nextDeliveryAt: null }),
              },
              "delivery.fail": [
                {
                  target: "pending",
                  guard: (c) => c.deliveryAttempts < c.maxRetries,
                  assign: (c, e) => ({
                    ...c,
                    lastDeliveryError: e.type === "delivery.fail" ? e.error : c.lastDeliveryError,
                    nextDeliveryAt: e.type === "delivery.fail" ? e.retryAt : c.nextDeliveryAt,
                  }),
                },
                {
                  target: "dead_lettered",
                  assign: (c, e) => ({
                    ...c,
                    lastDeliveryError: e.type === "delivery.fail" ? e.error : c.lastDeliveryError,
                    nextDeliveryAt: null,
                    notified: true,
                  }),
                  effects: [(c) => (
                    c.terminalState
                      ? { type: "notify.dead_letter", workflowId: c.workflowId, group: c.group, state: c.terminalState, error: c.lastDeliveryError }
                      : null
                  )],
                },
              ],
            },
          },
          acked: { type: "final" },
          dead_lettered: { type: "final" },
          skipped: { type: "final" },
        },
      },
    },
  },
};

// Wire done.active transitions on the active node cleanly
const activeNode = pipelineChart.root.states!.stage.states!.active as {
  on: Record<string, unknown>;
};
activeNode.on["done.active"] = [
  { target: "completed", guard: (_c: PipelineContext, e: PipelineEvent) => e.type === "done.active" && e.state === "stage_completed" },
  { target: "cancelled", guard: (_c: PipelineContext, e: PipelineEvent) => e.type === "done.active" && e.state === "stage_cancelled" },
  { target: "failed" },
];

export function createPipelineSnapshot(input: {
  workflowId: string;
  group: string;
  ownerSession: string | null;
  requireApproval: boolean;
  maxStageRetries: number;
  specs: Readonly<Record<PipelineStageName, StageSpec>>;
  firstJobId: string;
  wake: WakeTarget | null;
  maxRetries?: number;
}): { snapshot: Snapshot<PipelineContext>; initialEffect: PipelineEffect } {
  const ctx: PipelineContext = {
    workflowId: input.workflowId,
    group: input.group,
    ownerSession: input.ownerSession,
    requireApproval: input.requireApproval,
    maxStageRetries: input.maxStageRetries,
    specs: input.specs,
    activeJobId: input.firstJobId,
    activeStage: "diagnose",
    stageAttempts: 1,
    stages: {},
    terminalState: null,
    error: null,
    finished: null,
    wake: input.wake,
    deliveryAttempts: 0,
    maxRetries: input.maxRetries ?? 5,
    nextDeliveryAt: null,
    lastDeliveryError: null,
    notified: false,
  };
  const { snapshot } = initialSnapshot(pipelineChart, ctx);
  return {
    snapshot,
    initialEffect: spawnEffect(ctx, "diagnose", input.firstJobId),
  };
}

export function pipelineStateFromSnapshot(snapshot: Snapshot<PipelineContext>): PipelineState {
  if (matches(snapshot.value, "stage.active.diagnosing")) return "diagnosing";
  if (matches(snapshot.value, "stage.active.awaiting_approval")) return "awaiting_approval";
  if (matches(snapshot.value, "stage.active.implementing")) return "implementing";
  if (matches(snapshot.value, "stage.active.reviewing")) return "reviewing";
  if (matches(snapshot.value, "stage.cancelling")) return "cancelling";
  if (matches(snapshot.value, "stage.completed")) return "completed";
  if (matches(snapshot.value, "stage.failed")) return "failed";
  return "cancelled";
}

export function pipelineDeliveryFromSnapshot(snapshot: Snapshot<PipelineContext>): DeliveryState {
  if (matches(snapshot.value, "delivery.armed")) return "armed";
  if (matches(snapshot.value, "delivery.pending")) return "pending";
  if (matches(snapshot.value, "delivery.delivering")) return "delivering";
  if (matches(snapshot.value, "delivery.acked")) return "acked";
  if (matches(snapshot.value, "delivery.dead_lettered")) return "dead_lettered";
  return "skipped";
}

export function stepPipeline(snapshot: Snapshot<PipelineContext>, event: PipelineEvent) {
  return step(pipelineChart, snapshot, event);
}
