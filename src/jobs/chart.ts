import { initialSnapshot, matches, step, type Chart, type DoneEvent, type Snapshot } from "../statechart/core.ts";

export type ExecutionOutcome = "succeeded" | "failed" | "cancelled" | "interrupted";
export type DeliveryState = "armed" | "pending" | "delivering" | "acked" | "dead_lettered" | "skipped";

export interface WakeTarget {
  readonly session: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
}

export interface JobChartContext {
  readonly jobId: string;
  readonly group: string;
  readonly ownerSession: string | null;
  readonly outcome: ExecutionOutcome | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly finished: string | null;
  readonly wake: WakeTarget | null;
  readonly deliveryAttempts: number;
  readonly maxRetries: number;
  readonly nextDeliveryAt: string | null;
  readonly lastDeliveryError: string | null;
  readonly notified: boolean;
}

export type JobChartEvent =
  | { type: "unit.started" }
  | { type: "runner.claimed" }
  | { type: "command.exited"; exitCode: number | null; signal: string | null; error: string | null }
  | { type: "cgroup.drained"; finished: string }
  | { type: "cancel"; finished?: string }
  | { type: "unit.lost"; finished: string; error: string }
  | { type: "delivery.begin"; now: string }
  | { type: "delivery.ack" }
  | { type: "delivery.fail"; error: string; retryAt: string | null }
  | DoneEvent;

export type JobChartEffect =
  | { type: "unit.stop"; jobId: string }
  | { type: "wake.deliver"; jobId: string; attempt: number; wake: WakeTarget; outcome: ExecutionOutcome }
  | { type: "notify.dead_letter"; jobId: string; group: string; outcome: ExecutionOutcome; error: string | null };

function isSuccess(exitCode: number | null, signal: string | null, error: string | null): boolean {
  return exitCode === 0 && !signal && !error;
}

export const jobChart: Chart<JobChartContext, JobChartEvent, JobChartEffect> = {
  id: "managed-job",
  root: {
    type: "parallel",
    states: {
      execution: {
        type: "compound",
        initial: "reserved",
        states: {
          reserved: {
            on: {
              "unit.started": { target: "active.launching" },
              cancel: {
                target: "cancelled",
                assign: (c, e) => ({
                  ...c,
                  outcome: "cancelled",
                  finished: e.type === "cancel" ? (e.finished ?? new Date().toISOString()) : c.finished,
                }),
              },
            },
          },
          active: {
            type: "compound",
            initial: "launching",
            on: {
              cancel: {
                target: "cancelling",
                effects: [(c) => ({ type: "unit.stop", jobId: c.jobId })],
              },
              "unit.lost": {
                target: "interrupted",
                assign: (c, e) => ({
                  ...c,
                  outcome: "interrupted",
                  finished: e.type === "unit.lost" ? e.finished : c.finished,
                  error: e.type === "unit.lost" ? (c.error ?? e.error) : c.error,
                }),
              },
              "done.active": [
                {
                  target: "succeeded",
                  guard: (_c, e) => e.type === "done.active" && e.state === "done_ok",
                },
                { target: "failed" },
              ],
            },
            states: {
              launching: {
                on: {
                  "runner.claimed": { target: "running" },
                },
              },
              running: {
                on: {
                  "command.exited": {
                    target: "draining",
                    assign: (c, e) => {
                      if (e.type !== "command.exited") return c;
                      return {
                        ...c,
                        exitCode: e.exitCode,
                        signal: e.signal,
                        error: e.error,
                        outcome: isSuccess(e.exitCode, e.signal, e.error) ? "succeeded" : "failed",
                      };
                    },
                  },
                },
              },
              draining: {
                on: {
                  "cgroup.drained": [
                    {
                      target: "done_ok",
                      guard: (c) => c.outcome === "succeeded",
                      assign: (c, e) => ({
                        ...c,
                        finished: e.type === "cgroup.drained" ? e.finished : c.finished,
                      }),
                    },
                    {
                      target: "done_err",
                      assign: (c, e) => ({
                        ...c,
                        finished: e.type === "cgroup.drained" ? e.finished : c.finished,
                      }),
                    },
                  ],
                },
              },
              done_ok: { type: "final" },
              done_err: { type: "final" },
            },
          },
          cancelling: {
            on: {
              "cgroup.drained": {
                target: "cancelled",
                assign: (c, e) => ({
                  ...c,
                  outcome: "cancelled",
                  error: null,
                  finished: e.type === "cgroup.drained" ? e.finished : c.finished,
                }),
              },
              "unit.lost": {
                target: "interrupted",
                assign: (c, e) => ({
                  ...c,
                  outcome: "interrupted",
                  finished: e.type === "unit.lost" ? e.finished : c.finished,
                  error: e.type === "unit.lost" ? (c.error ?? e.error) : c.error,
                }),
              },
            },
          },
          succeeded: { type: "final" },
          failed: { type: "final" },
          cancelled: { type: "final" },
          interrupted: { type: "final" },
        },
      },
      delivery: {
        type: "compound",
        initial: "armed",
        states: {
          armed: {
            on: {
              "done.execution": [
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
                effects: [(c) => (
                  c.wake && c.outcome
                    ? { type: "wake.deliver", jobId: c.jobId, attempt: c.deliveryAttempts, wake: c.wake, outcome: c.outcome }
                    : null
                )],
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
                    c.outcome
                      ? { type: "notify.dead_letter", jobId: c.jobId, group: c.group, outcome: c.outcome, error: c.lastDeliveryError }
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

export function createJobSnapshot(input: {
  jobId: string;
  group: string;
  ownerSession: string | null;
  wake: WakeTarget | null;
  maxRetries?: number;
}): Snapshot<JobChartContext> {
  return initialSnapshot(jobChart, {
    jobId: input.jobId,
    group: input.group,
    ownerSession: input.ownerSession,
    outcome: null,
    exitCode: null,
    signal: null,
    error: null,
    finished: null,
    wake: input.wake,
    deliveryAttempts: 0,
    maxRetries: input.maxRetries ?? 5,
    nextDeliveryAt: null,
    lastDeliveryError: null,
    notified: false,
  }).snapshot;
}

export function deliveryStateFromSnapshot(snapshot: Snapshot<JobChartContext>): DeliveryState {
  if (matches(snapshot.value, "delivery.armed")) return "armed";
  if (matches(snapshot.value, "delivery.pending")) return "pending";
  if (matches(snapshot.value, "delivery.delivering")) return "delivering";
  if (matches(snapshot.value, "delivery.acked")) return "acked";
  if (matches(snapshot.value, "delivery.dead_lettered")) return "dead_lettered";
  return "skipped";
}

export function stepJob(snapshot: Snapshot<JobChartContext>, event: JobChartEvent) {
  return step(jobChart, snapshot, event);
}
