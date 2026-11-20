import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { startController, type JobsController, type WakeDeliveryRequest } from "../src/jobs/controller.ts";
import {
  approvePipeline,
  cancelPipeline,
  launchPipeline,
  listPipelines,
  pipelineStatus,
} from "../src/jobs/pipeline.ts";
import { createPipelineSnapshot, stepPipeline } from "../src/jobs/pipeline-chart.ts";

let available = false;
try { execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }); available = true; } catch {}

const dirs: string[] = [];
const controllers: JobsController[] = [];

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-pipeline-"));
  dirs.push(dir);
  return { dir, options: { dir } };
}

async function until<T>(fn: () => T, done: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out; last value: ${JSON.stringify(fn())}`);
}

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("auto pipeline runs diagnose -> implement -> review with log bindings and delivers one wake", { skip: !available }, async () => {
  const { dir, options } = setup();
  const wakes: WakeDeliveryRequest[] = [];
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 100,
    backoffBaseMs: 30,
    deliverWake: async (req) => { wakes.push(req); return { ok: true }; },
    sendNotify: async () => { throw new Error("unexpected notify"); },
  });
  controllers.push(ctrl);

  const wfId = randomUUID();
  const reviewReport = path.join(dir, "review-summary.txt");
  launchPipeline({
    id: wfId,
    group: "pipe-auto",
    cwd: dir,
    ownerSession: "sess-pipe",
    diagnose: [process.execPath, "-e", "console.log('ROOT_CAUSE_42')"],
    implement: [
      process.execPath,
      "-e",
      "const fs=require('fs'); const diag=fs.readFileSync(process.argv[1],'utf8'); if(!diag.includes('ROOT_CAUSE_42')) process.exit(2); console.log('PATCH_APPLIED');",
      "{{diagnose.log}}",
    ],
    review: [
      process.execPath,
      "-e",
      "const fs=require('fs'); const d=fs.readFileSync(process.argv[1],'utf8').trim(); const i=fs.readFileSync(process.argv[2],'utf8').trim(); fs.writeFileSync(process.argv[3], d + ' -> ' + i); console.log('LGTM');",
      "{{diagnose.log}}",
      "{{implement.log}}",
      reviewReport,
    ],
    wake: { session: "sess-pipe", prompt: "pipeline done" },
  }, options);

  const done = await until(() => pipelineStatus(wfId, options), (p) => p.state === "completed" && p.delivery.state === "acked");
  assert.equal(done.activeJobId, null);
  assert.equal(done.stages.diagnose?.status, "succeeded");
  assert.equal(done.stages.implement?.status, "succeeded");
  assert.equal(done.stages.review?.status, "succeeded");
  assert.equal(readFileSync(reviewReport, "utf8"), "ROOT_CAUSE_42 -> PATCH_APPLIED");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].jobId, wfId);
  assert.equal(wakes[0].outcome, "succeeded");
});

test("approval-gated pipeline pauses after diagnose, enforces session ownership, then completes", { skip: !available }, async () => {
  const { dir, options } = setup();
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 100,
    backoffBaseMs: 30,
    deliverWake: async () => ({ ok: true }),
    sendNotify: async () => {},
  });
  controllers.push(ctrl);

  const wfId = randomUUID();
  launchPipeline({
    id: wfId,
    group: "pipe-gate",
    cwd: dir,
    ownerSession: "sess-owner",
    requireApproval: true,
    diagnose: ["/bin/true"],
    implement: ["/bin/true"],
    review: ["/bin/true"],
  }, options);

  const paused = await until(() => pipelineStatus(wfId, options), (p) => p.state === "awaiting_approval");
  assert.equal(paused.activeJobId, null);
  assert.equal(paused.stages.diagnose?.status, "succeeded");
  assert.equal(paused.stages.implement, undefined);

  // Session scoping check
  assert.equal(listPipelines(undefined, { dir, ownerSession: "sess-other" }).length, 0);
  assert.throws(() => approvePipeline(wfId, { dir, ownerSession: "sess-other" }), /owned by session sess-owner/);

  // Owner approves -> advances through implement -> review -> completed
  approvePipeline(wfId, { dir, ownerSession: "sess-owner" });
  const done = await until(() => pipelineStatus(wfId, options), (p) => p.state === "completed");
  assert.equal(done.stages.implement?.status, "succeeded");
  assert.equal(done.stages.review?.status, "succeeded");
});

test("stage retries within maxStageRetries recover transient worker failure", { skip: !available }, async () => {
  const { dir, options } = setup();
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 100,
    backoffBaseMs: 30,
    deliverWake: async () => ({ ok: true }),
    sendNotify: async () => {},
  });
  controllers.push(ctrl);

  const wfId = randomUUID();
  const flag = path.join(dir, "attempt-flag");
  launchPipeline({
    id: wfId,
    group: "pipe-retry",
    cwd: dir,
    maxStageRetries: 1,
    diagnose: ["/bin/true"],
    implement: [
      process.execPath,
      "-e",
      "const fs=require('fs'); if(!fs.existsSync(process.argv[1])){ fs.writeFileSync(process.argv[1],'1'); process.exit(1); }",
      flag,
    ],
    review: ["/bin/true"],
  }, options);

  const done = await until(() => pipelineStatus(wfId, options), (p) => p.state === "completed");
  assert.equal(done.stages.implement?.status, "succeeded");
  assert.equal(done.stages.implement?.attempts, 2);
});

test("cancelling a running pipeline stops its active child and delivers cancelled wake", { skip: !available }, async () => {
  const { dir, options } = setup();
  const wakes: WakeDeliveryRequest[] = [];
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 100,
    backoffBaseMs: 30,
    deliverWake: async (req) => { wakes.push(req); return { ok: true }; },
    sendNotify: async () => {},
  });
  controllers.push(ctrl);

  const wfId = randomUUID();
  launchPipeline({
    id: wfId,
    group: "pipe-cancel",
    cwd: dir,
    ownerSession: "sess-cancel",
    diagnose: ["/bin/sleep", "60"],
    implement: ["/bin/true"],
    review: ["/bin/true"],
    wake: { session: "sess-cancel", prompt: "pipeline cancelled" },
  }, options);

  await until(() => pipelineStatus(wfId, options), (p) => p.state === "diagnosing" && p.activeJobId !== null);
  const cancelled = cancelPipeline(wfId, { dir, ownerSession: "sess-cancel" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.activeJobId, null);

  await until(() => wakes.length, (n) => n === 1);
  assert.equal(wakes[0].outcome, "cancelled");
});

test("cancelling during reviewing reports cancelled (never completed) even if review exits 0", () => {
  const wfId = randomUUID();
  const j1 = randomUUID(), j2 = randomUUID(), j3 = randomUUID();
  const { snapshot: s0 } = createPipelineSnapshot({
    workflowId: wfId,
    group: "race-cancel",
    ownerSession: "sess-1",
    requireApproval: false,
    maxStageRetries: 0,
    specs: {
      diagnose: { argv: ["/bin/true"], cwd: "/tmp" },
      implement: { argv: ["/bin/true"], cwd: "/tmp" },
      review: { argv: ["/bin/true"], cwd: "/tmp" },
    },
    firstJobId: j1,
    wake: { session: "sess-1", prompt: "done", cwd: "/tmp" },
  });
  const s1 = stepPipeline(s0, { type: "job.terminal", jobId: j1, status: "succeeded", exitCode: 0, log: "/tmp/1.log", error: null, finished: "2026-01-01T00:00:01Z", nextJobId: j2 }).snapshot;
  const s2 = stepPipeline(s1, { type: "job.terminal", jobId: j2, status: "succeeded", exitCode: 0, log: "/tmp/2.log", error: null, finished: "2026-01-01T00:00:02Z", nextJobId: j3 }).snapshot;
  const s3 = stepPipeline(s2, { type: "cancel", finished: "2026-01-01T00:00:03Z" }).snapshot;
  // Review child exits 0 while pipeline is in cancelling
  const s4 = stepPipeline(s3, { type: "job.terminal", jobId: j3, status: "succeeded", exitCode: 0, log: "/tmp/3.log", error: null, finished: "2026-01-01T00:00:04Z", nextJobId: randomUUID() }).snapshot;
  const d = stepPipeline(s4, { type: "delivery.begin", now: "2026-01-01T00:00:05Z" });
  assert.equal(s4.context.terminalState, "cancelled");
  assert.deepEqual(d.effects, [{
    type: "wake.deliver",
    workflowId: wfId,
    attempt: 1,
    wake: { session: "sess-1", prompt: "done", cwd: "/tmp" },
    state: "cancelled",
  }]);
});

test("pipelineStatus enforces session scoping and launchPipeline rejects id conflicts & bad wake fields", { skip: !available }, async () => {
  const { dir } = setup();
  const wfId = randomUUID();
  launchPipeline({
    id: wfId,
    group: "scope-test",
    cwd: dir,
    ownerSession: "sess-owner",
    diagnose: ["/bin/true"],
    implement: ["/bin/true"],
    review: ["/bin/true"],
  }, { dir });

  assert.throws(() => pipelineStatus(wfId, { dir, ownerSession: "sess-other" }), /owned by session sess-owner/);
  assert.equal(pipelineStatus(wfId, { dir, ownerSession: "sess-other", allSessions: true }).id, wfId);

  assert.throws(() => launchPipeline({
    id: wfId,
    group: "scope-test",
    cwd: dir,
    ownerSession: "sess-owner",
    diagnose: ["/bin/false"],
    implement: ["/bin/true"],
    review: ["/bin/true"],
  }, { dir }), /conflict/);

  assert.throws(() => launchPipeline({
    id: randomUUID(),
    group: "scope-test",
    cwd: dir,
    diagnose: ["/bin/true"],
    implement: ["/bin/true"],
    review: ["/bin/true"],
    wake: { session: "sess-owner", prompt: "hi", extra: true } as any,
  }, { dir }), /unsupported wake field/);
});
