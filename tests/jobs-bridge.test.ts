import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { runJobOperation } from "../src/jobs/bridge.ts";
import type { Job } from "../src/jobs/core.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-bridge-"));
const originalJobsDir = process.env.PI_JOBS_DIR;
process.env.PI_JOBS_DIR = dir;
const ids = [randomUUID(), randomUUID()];
let available = false;
try {
  execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
  execFileSync("node", ["--experimental-strip-types", "-e", ""], { stdio: "ignore" });
  available = true;
} catch {}

after(() => {
  if (available) {
    for (const id of ids) {
      const units = execFileSync("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `pi-owned-job-${id}*.service`], { encoding: "utf8" });
      for (const line of units.trim().split("\n").filter(Boolean)) {
        const unit = line.trim().split(/\s+/)[0];
        try { execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" }); } catch {}
        try { execFileSync("systemctl", ["--user", "reset-failed", unit], { stdio: "ignore" }); } catch {}
      }
    }
  }
  if (originalJobsDir === undefined) delete process.env.PI_JOBS_DIR;
  else process.env.PI_JOBS_DIR = originalJobsDir;
  rmSync(dir, { recursive: true, force: true });
});

test("Node bridge launches and observes a managed job", { skip: !available }, async () => {
  const [id, runningId] = ids;
  const input = { id, group: "bridge-test", argv: ["/bin/true"], cwd: dir };
  const launched = runJobOperation<Job>("launch", input);
  assert.equal(launched.id, id);

  const deadline = Date.now() + 10000;
  let status = runJobOperation<Job>("status", { id });
  while (status.state === "launching" || status.state === "running") {
    if (Date.now() >= deadline) throw new Error("timed out waiting for bridged job");
    await new Promise(resolve => setTimeout(resolve, 100));
    status = runJobOperation<Job>("status", { id });
  }
  assert.equal(status.state, "succeeded", status.error ?? "");
  assert.equal(status.exitCode, 0);

  runJobOperation("launch", { id: runningId, group: "bridge-test", argv: ["/bin/sleep", "30"], cwd: dir });
  assert.equal(runJobOperation<Job>("stop", { id: runningId }).state, "cancelled");
  assert.equal(runJobOperation<Job[]>("list", { group: "bridge-test" }).length, 2);
});

test("bridge tolerates a printing NODE_OPTIONS hook and rejects a bad PI_JOBS_NODE", { skip: !available }, () => {
  const hook = path.join(dir, "hook.cjs");
  writeFileSync(hook, "console.log('BANNER-NOISE');");
  const originalOptions = process.env.NODE_OPTIONS, originalNode = process.env.PI_JOBS_NODE;
  try {
    process.env.NODE_OPTIONS = `--require ${hook}`;
    assert.deepEqual(runJobOperation<Job[]>("list", { group: "bridge-test" }).length, 2);

    process.env.PI_JOBS_NODE = "/bin/false";
    assert.throws(() => runJobOperation("list"), /jobs CLI/);
  } finally {
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
    if (originalNode === undefined) delete process.env.PI_JOBS_NODE; else process.env.PI_JOBS_NODE = originalNode;
  }
});
