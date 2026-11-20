import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { jobStatus, launchJob, listJobs, openDb, stopJob } from "../src/jobs/core.ts";
import { startController, type DeadLetterNotice, type JobsController, type WakeDeliveryRequest } from "../src/jobs/controller.ts";

let available = false;
try { execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }); available = true; } catch {}

const dirs: string[] = [];
const ids: string[] = [];
const controllers: JobsController[] = [];

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-ctrl-"));
  dirs.push(dir);
  return { dir, options: { dir } };
}

function newId() {
  const id = randomUUID();
  ids.push(id);
  return id;
}

async function until<T>(fn: () => T, done: (v: T) => boolean, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out; last value: ${JSON.stringify(fn())}`);
}

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const id of ids.splice(0)) {
    try {
      const units = execFileSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `pi-owned-job-${id}*.service`], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/)[0]);
      for (const u of units) {
        try { execFileSync("systemctl", ["--user", "stop", u], { stdio: "ignore", timeout: 10000 }); } catch {}
        try { execFileSync("systemctl", ["--user", "reset-failed", u], { stdio: "ignore" }); } catch {}
      }
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("push-driven completion wake is delivered and acked", { skip: !available }, async () => {
  const { dir, options } = setup();
  const delivered: WakeDeliveryRequest[] = [];
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 60_000,
    backoffBaseMs: 30,
    deliverWake: async (req) => {
      delivered.push(req);
      return { ok: true };
    },
    sendNotify: async () => { throw new Error("unexpected dead-letter notify"); },
  });
  controllers.push(ctrl);

  const id = newId();
  launchJob({
    id,
    group: "ctrl-test",
    argv: [process.execPath, "-e", "console.log('hi')"],
    cwd: dir,
    ownerSession: "sess-a",
    wake: { session: "sess-a", prompt: "inspect result" },
  }, options);

  const done = await until(() => jobStatus(id, options), (j) => j.delivery.state === "acked");
  assert.equal(done.state, "succeeded");
  assert.equal(done.delivery.attempts, 1);
  assert.equal(done.delivery.notified, false);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].outcome, "succeeded");
  assert.equal(delivered[0].wake.session, "sess-a");
});

test("busy session retries with backoff and eventually acks", { skip: !available }, async () => {
  const { dir, options } = setup();
  let calls = 0;
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 60_000,
    backoffBaseMs: 40,
    deliverWake: async () => {
      calls++;
      if (calls < 3) return { ok: false, busy: true, error: "session busy (flock exit 75)" };
      return { ok: true };
    },
    sendNotify: async () => { throw new Error("unexpected notify"); },
  });
  controllers.push(ctrl);

  const id = newId();
  launchJob({
    id,
    group: "retry-test",
    argv: ["/bin/true"],
    cwd: dir,
    ownerSession: "sess-busy",
    wake: { session: "sess-busy", prompt: "check job", maxRetries: 4 },
  }, options);

  const done = await until(() => jobStatus(id, options), (j) => j.delivery.state === "acked");
  assert.equal(done.delivery.attempts, 3);
  assert.equal(done.delivery.error, null);
  assert.equal(calls, 3);
});

test("exhausted retries dead-letter and fire desktop notification", { skip: !available }, async () => {
  const { dir, options } = setup();
  const notices: DeadLetterNotice[] = [];
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 60_000,
    backoffBaseMs: 30,
    deliverWake: async () => ({ ok: false, error: "pi exited 1" }),
    sendNotify: async (notice) => { notices.push(notice); },
  });
  controllers.push(ctrl);

  const id = newId();
  launchJob({
    id,
    group: "dlq-test",
    argv: ["/bin/false"],
    cwd: dir,
    ownerSession: "sess-dlq",
    wake: { session: "sess-dlq", prompt: "handle failure", maxRetries: 2 },
  }, options);

  const done = await until(() => jobStatus(id, options), (j) => j.delivery.state === "dead_lettered");
  assert.equal(done.state, "failed");
  assert.equal(done.delivery.attempts, 2);
  assert.equal(done.delivery.notified, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].jobId, id);
  assert.equal(notices[0].outcome, "failed");
});

test("controller restart recovers a job stuck in delivering", async () => {
  const { dir, options } = setup();
  const id = newId();
  const now = new Date().toISOString();
  const db = openDb(dir);
  try {
    db.prepare(`INSERT INTO jobs(
      id, group_name, argv, cwd, token, state, exit_code, created, finished, log,
      execution_claimed, unit_generation, owner_session, wake_json,
      delivery_state, delivery_attempts, delivery_max_retries
    ) VALUES(?,?,?,?,?,'succeeded',0,?,?,?,1,1,?,?, 'delivering', 1, 3)`).run(
      id, "crash-test", JSON.stringify(["/bin/true"]), dir, randomUUID(),
      now, now, path.join(dir, `${id}.log`), "sess-crash",
      JSON.stringify({ session: "sess-crash", prompt: "recover", cwd: dir }),
    );
  } finally {
    db.close();
  }

  let delivered = 0;
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 60_000,
    backoffBaseMs: 30,
    deliverWake: async () => {
      delivered++;
      return { ok: true };
    },
    sendNotify: async () => {},
  });
  controllers.push(ctrl);

  const done = await until(() => jobStatus(id, options), (j) => j.delivery.state === "acked");
  assert.equal(done.delivery.attempts, 2);
  assert.equal(delivered, 1);
});

test("session-scoped ownership isolates listJobs and stopJob across sessions", { skip: !available }, async () => {
  const { dir } = setup();
  const idA = newId();
  launchJob({
    id: idA,
    group: "shared-group",
    argv: ["/bin/sleep", "30"],
    cwd: dir,
    ownerSession: "session-a",
  }, { dir });

  assert.equal(listJobs(undefined, { dir, ownerSession: "session-a" }).length, 1);
  assert.equal(listJobs(undefined, { dir, ownerSession: "session-b" }).length, 0);
  assert.equal(listJobs(undefined, { dir, ownerSession: "session-b", allSessions: true }).length, 1);

  assert.throws(
    () => stopJob(idA, { dir, ownerSession: "session-b" }),
    /owned by session session-a/,
  );

  // Explicit override or owner session can stop it
  const stopped = stopJob(idA, { dir, ownerSession: "session-a" });
  assert.equal(stopped.state, "cancelled");
});

test("active reconciler detects killed unit and delivers interrupted wake without polling", { skip: !available }, async () => {
  const { dir, options } = setup();
  const delivered: WakeDeliveryRequest[] = [];
  const ctrl = await startController({
    dir,
    reconcileIntervalMs: 150,
    backoffBaseMs: 30,
    deliverWake: async (req) => {
      delivered.push(req);
      return { ok: true };
    },
    sendNotify: async () => {},
  });
  controllers.push(ctrl);

  const id = newId();
  launchJob({
    id,
    group: "reconcile-test",
    argv: ["/bin/sleep", "60"],
    cwd: dir,
    ownerSession: "sess-rec",
    wake: { session: "sess-rec", prompt: "unit died" },
  }, options);

  await until(() => jobStatus(id, options), (j) => j.state === "running");
  const [unitName] = execFileSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `pi-owned-job-${id}*.service`], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/)[0]);
  execFileSync("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=KILL", unitName]);

  // Notice: we don't call jobStatus in a loop to trigger reconcile — we wait for delivered!
  await until(() => delivered.length, (n) => n === 1);
  assert.equal(delivered[0].outcome, "interrupted");
  const final = jobStatus(id, options);
  assert.equal(final.state, "interrupted");
  assert.equal(final.delivery.state, "acked");
});
