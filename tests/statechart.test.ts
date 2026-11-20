import assert from "node:assert/strict";
import { test } from "node:test";
import { initialSnapshot, matches, step, type Chart, type DoneEvent } from "../src/statechart/core.ts";

interface JobCtx {
  attempts: number;
  maxRetries: number;
  outcome: string | null;
}

type JobEvent =
  | { type: "unit.started" }
  | { type: "runner.claimed" }
  | { type: "command.exited"; ok: boolean }
  | { type: "cgroup.drained" }
  | { type: "cancel" }
  | { type: "unit.lost" }
  | { type: "delivery.start" }
  | { type: "delivery.ack" }
  | { type: "delivery.fail" }
  | DoneEvent;

type JobEffect =
  | { type: "start_unit" }
  | { type: "stop_unit" }
  | { type: "attempt_wake"; attempt: number }
  | { type: "notify_dead_letter" };

const jobChart: Chart<JobCtx, JobEvent, JobEffect> = {
  id: "job",
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
              cancel: { target: "cancelled", assign: (c) => ({ ...c, outcome: "cancelled" }) },
            },
          },
          active: {
            type: "compound",
            initial: "launching",
            on: {
              cancel: { target: "cancelling", effects: [{ type: "stop_unit" }] },
              "unit.lost": { target: "interrupted", assign: (c) => ({ ...c, outcome: "interrupted" }) },
              "done.active": [
                { target: "succeeded", guard: (_c, e) => e.type === "done.active" && e.state === "done_ok" },
                { target: "failed" },
              ],
            },
            states: {
              launching: {
                on: { "runner.claimed": { target: "running" } },
              },
              running: {
                on: {
                  "command.exited": {
                    target: "draining",
                    assign: (c, e) => ({ ...c, outcome: e.type === "command.exited" && e.ok ? "succeeded" : "failed" }),
                  },
                },
              },
              draining: {
                on: {
                  "cgroup.drained": [
                    { target: "done_ok", guard: (c) => c.outcome === "succeeded" },
                    { target: "done_err" },
                  ],
                },
              },
              done_ok: { type: "final" },
              done_err: { type: "final" },
            },
          },
          cancelling: {
            type: "atomic",
            on: {
              "cgroup.drained": { target: "cancelled", assign: (c) => ({ ...c, outcome: "cancelled" }) },
              "unit.lost": { target: "interrupted", assign: (c) => ({ ...c, outcome: "interrupted" }) },
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
            type: "atomic",
            on: {
              "done.execution": { target: "pending" },
            },
          },
          pending: {
            type: "atomic",
            on: {
              "delivery.start": {
                target: "delivering",
                guard: (c) => c.attempts < c.maxRetries,
                assign: (c) => ({ ...c, attempts: c.attempts + 1 }),
                effects: [(c) => ({ type: "attempt_wake", attempt: c.attempts })],
              },
            },
          },
          delivering: {
            type: "atomic",
            on: {
              "delivery.ack": { target: "acked" },
              "delivery.fail": [
                { target: "pending", guard: (c) => c.attempts < c.maxRetries },
                { target: "dead_lettered", effects: [{ type: "notify_dead_letter" }] },
              ],
            },
          },
          acked: { type: "final" },
          dead_lettered: { type: "final" },
        },
      },
    },
  },
};

test("parallel regions, compound bubbling, and atomic done.<region> microstep", () => {
  const init = initialSnapshot(jobChart, { attempts: 0, maxRetries: 2, outcome: null });
  assert.ok(matches(init.snapshot.value, "execution.reserved"));
  assert.ok(matches(init.snapshot.value, "delivery.armed"));

  // Cancel from reserved transitions execution -> cancelled AND atomically delivery -> pending
  const r1 = step(jobChart, init.snapshot, { type: "cancel" });
  assert.equal(r1.changed, true);
  assert.ok(matches(r1.snapshot.value, "execution.cancelled"));
  assert.ok(matches(r1.snapshot.value, "delivery.pending"));
  assert.equal(r1.trace.length, 2);
  assert.equal(r1.trace[1].event, "done.execution");
});

test("compound parent handles cancel from any active substate", () => {
  let snap = initialSnapshot(jobChart, { attempts: 0, maxRetries: 2, outcome: null }).snapshot;
  snap = step(jobChart, snap, { type: "unit.started" }).snapshot;
  assert.ok(matches(snap.value, "execution.active.launching"));

  snap = step(jobChart, snap, { type: "runner.claimed" }).snapshot;
  assert.ok(matches(snap.value, "execution.active.running"));

  // Cancel bubbles from running -> active -> cancelling
  const cancelling = step(jobChart, snap, { type: "cancel" });
  assert.ok(matches(cancelling.snapshot.value, "execution.cancelling"));
  assert.ok(matches(cancelling.snapshot.value, "delivery.armed"));
  assert.deepEqual(cancelling.effects, [{ type: "stop_unit" }]);

  // Unconfirmed unit loss while cancelling -> interrupted (never falsely cancelled) + delivery pending
  const lost = step(jobChart, cancelling.snapshot, { type: "unit.lost" });
  assert.ok(matches(lost.snapshot.value, "execution.interrupted"));
  assert.ok(matches(lost.snapshot.value, "delivery.pending"));
});

test("delivery retries with bounded attempts and notifies on dead-letter", () => {
  let snap = initialSnapshot(jobChart, { attempts: 0, maxRetries: 2, outcome: null }).snapshot;
  snap = step(jobChart, snap, { type: "cancel" }).snapshot;
  assert.ok(matches(snap.value, "delivery.pending"));

  const d1 = step(jobChart, snap, { type: "delivery.start" });
  assert.ok(matches(d1.snapshot.value, "delivery.delivering"));
  assert.deepEqual(d1.effects, [{ type: "attempt_wake", attempt: 1 }]);

  const f1 = step(jobChart, d1.snapshot, { type: "delivery.fail" });
  assert.ok(matches(f1.snapshot.value, "delivery.pending"));
  assert.deepEqual(f1.effects, []);

  const d2 = step(jobChart, f1.snapshot, { type: "delivery.start" });
  assert.deepEqual(d2.effects, [{ type: "attempt_wake", attempt: 2 }]);

  const f2 = step(jobChart, d2.snapshot, { type: "delivery.fail" });
  assert.ok(matches(f2.snapshot.value, "delivery.dead_lettered"));
  assert.deepEqual(f2.effects, [{ type: "notify_dead_letter" }]);
});

test("chained done.<parent> microsteps resolve active.done_ok -> succeeded -> delivery.pending", () => {
  let snap = initialSnapshot(jobChart, { attempts: 0, maxRetries: 2, outcome: null }).snapshot;
  snap = step(jobChart, snap, { type: "unit.started" }).snapshot;
  snap = step(jobChart, snap, { type: "runner.claimed" }).snapshot;
  snap = step(jobChart, snap, { type: "command.exited", ok: true }).snapshot;
  assert.ok(matches(snap.value, "execution.active.draining"));

  const done = step(jobChart, snap, { type: "cgroup.drained" });
  assert.ok(matches(done.snapshot.value, "execution.succeeded"));
  assert.ok(matches(done.snapshot.value, "delivery.pending"));
  assert.deepEqual(done.trace.map((t) => t.event), ["cgroup.drained", "done.active", "done.execution"]);
});

test("entry/exit effects run in bottom-up exit, transition, top-down entry order", () => {
  const chart: Chart<Record<string, never>, { type: "go" }, string> = {
    id: "order",
    root: {
      type: "compound",
      initial: "a",
      states: {
        a: {
          type: "compound",
          initial: "a1",
          exit: ["exit:a"],
          on: { go: { target: "b", effects: ["trans:go"] } },
          states: {
            a1: { exit: ["exit:a1"] },
          },
        },
        b: {
          type: "compound",
          initial: "b1",
          entry: ["entry:b"],
          states: {
            b1: { entry: ["entry:b1"] },
          },
        },
      },
    },
  };
  const init = initialSnapshot(chart, {});
  const res = step(chart, init.snapshot, { type: "go" });
  assert.deepEqual(res.effects, ["exit:a1", "exit:a", "trans:go", "entry:b", "entry:b1"]);
});
