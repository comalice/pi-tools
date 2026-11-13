import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { launchJob, listJobs, jobStatus, stopJob } from "../src/jobs/core.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-owned-jobs-"));
const ids: string[] = [];
const options = { dir };
let available = false;
try { execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }); available = true; } catch {}
after(() => {
  for (const id of ids) {
    try { execFileSync("systemctl", ["--user", "stop", `pi-owned-job-${id}.service`], { stdio: "ignore" }); } catch {}
    try { execFileSync("systemctl", ["--user", "reset-failed", `pi-owned-job-${id}.service`], { stdio: "ignore" }); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});
function id() { const value = randomUUID(); ids.push(value); return value; }
async function until<T>(fn: () => T, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const v = fn(); if (done(v)) return v; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("timed out waiting for job");
}

test("managed lifecycle, argv quoting, history, duplicate id and groups", { skip: !available }, async () => {
  const job = { id: id(), group: "project-a", argv: [process.execPath, "-e", "console.log(process.argv[1])", "$(echo unsafe) 'a b'"], cwd: dir };
  const first = launchJob(job, options);
  assert.equal(first.id, job.id);
  const completed = await until(() => jobStatus(job.id, options), s => s.state === "succeeded");
  assert.equal(completed.exitCode, 0);
  assert.match(readFileSync(completed.log, "utf8"), /\$\(echo unsafe\) 'a b'/);
  assert.equal(launchJob(job, options).id, first.id);
  assert.throws(() => launchJob({ ...job, argv: ["/bin/false"] }, options), /conflict/i);
  assert.equal(listJobs("project-a", options).filter(j => j.id === job.id).length, 1);
  assert.equal(statSync(dir).mode & 0o077, 0);
  assert.equal(statSync(completed.log).mode & 0o077, 0);
});

test("concurrent duplicate launches start only once", { skip: !available }, async () => {
  const job = id();
  const marker = path.join(dir, "concurrent");
  const input = { id: job, group: "concurrent", argv: [process.execPath, "-e", "require('fs').appendFileSync(process.argv[1], 'x')", marker], cwd: dir };
  const moduleUrl = new URL("../src/jobs/core.ts", import.meta.url).href;
  const script = `import {launchJob} from ${JSON.stringify(moduleUrl)}; launchJob(${JSON.stringify(input)}, {dir:${JSON.stringify(dir)}});`;
  const { spawn } = await import("node:child_process");
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "ignore" });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`launcher exit ${code}`)));
  });
  await Promise.all([run(), run(), run()]);
  await until(() => jobStatus(job, options), s => s.state === "succeeded");
  assert.equal(readFileSync(marker, "utf8"), "x");
});

test("failure and process-group cancellation retain evidence", { skip: !available }, async () => {
  const failed = id();
  launchJob({ id: failed, group: "project-b", argv: ["/bin/sh", "-c", "exit 23"], cwd: dir }, options);
  assert.equal((await until(() => jobStatus(failed, options), s => s.state === "failed")).exitCode, 23);
  const running = id();
  launchJob({ id: running, group: "project-b", argv: ["/bin/sleep", "60"], cwd: dir }, options);
  stopJob(running, options);
  const stopped = await until(() => jobStatus(running, options), s => s.state === "cancelled");
  assert.equal(stopped.state, "cancelled");
  assert.equal(stopJob(running, options).state, "cancelled");
  assert.equal(listJobs("project-b", options).length, 2);
});

test("spawn failure is recorded and stopping one group member leaves another running", { skip: !available }, async () => {
  const missing = id();
  launchJob({ id: missing, group: "select", argv: [path.join(dir, "does-not-exist")], cwd: dir }, options);
  const failed = await until(() => jobStatus(missing, options), s => s.state === "failed");
  assert.match(failed.error ?? "", /ENOENT/);
  assert.equal(failed.exitCode, null);
  const a = id(), b = id();
  launchJob({ id: a, group: "select", argv: ["/bin/sleep", "60"], cwd: dir }, options);
  launchJob({ id: b, group: "other", argv: ["/bin/sleep", "60"], cwd: dir }, options);
  assert.deepEqual(listJobs("select", options).map(j => j.id).sort(), [missing, a].sort());
  assert.equal(stopJob(a, options).state, "cancelled");
  assert.equal(jobStatus(b, options).state, "running");
  stopJob(b, options);
});

test("literal job directory and working directory survive systemd argument handling", { skip: !available }, async () => {
  const strange = path.join(dir, "space $HOME 'percent%'");
  mkdirSync(strange, { mode: 0o700 });
  const job = id();
  launchJob({ id: job, group: "quotes", argv: [process.execPath, "-e", "console.log(process.cwd())"], cwd: strange }, { dir: strange });
  const status = await until(() => jobStatus(job, { dir: strange }), s => s.state === "succeeded" || s.state === "interrupted");
  assert.equal(status.state, "succeeded", status.error ?? "");
  assert.equal(readFileSync(status.log, "utf8").trim(), strange);
});

test("status is durable across a fresh process and duplicates never rerun", { skip: !available }, async () => {
  const job = id();
  const marker = path.join(dir, "runs");
  const input = { id: job, group: "restart", argv: [process.execPath, "-e", "require('fs').appendFileSync(process.argv[1], 'x')", marker], cwd: dir };
  launchJob(input, options);
  await until(() => jobStatus(job, options), s => s.state === "succeeded");
  const moduleUrl = new URL("../src/jobs/core.ts", import.meta.url).href;
  const script = `import {launchJob,jobStatus} from ${JSON.stringify(moduleUrl)}; launchJob(${JSON.stringify(input)}, {dir:${JSON.stringify(dir)}}); console.log(jobStatus(${JSON.stringify(job)}, {dir:${JSON.stringify(dir)}}).state);`;
  assert.match(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" }), /succeeded/);
  assert.equal(readFileSync(marker, "utf8"), "x");
});

test("cancellation stops descendants in the service cgroup", { skip: !available }, async () => {
  const job = id();
  const marker = path.join(dir, "child-ran");
  launchJob({ id: job, group: "tree", argv: ["/bin/sh", "-c", "(sleep 2; echo bad > \"$1\") & wait", "sh", marker], cwd: dir }, options);
  await new Promise(r => setTimeout(r, 300));
  stopJob(job, options);
  await new Promise(r => setTimeout(r, 2400));
  assert.equal(existsSync(marker), false);
});

test("stop escalates for a job that ignores SIGTERM", { skip: !available }, async () => {
  const job = id();
  const ready = path.join(dir, "signal-ready");
  launchJob({ id: job, group: "signals", argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{}); require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(()=>{},1000)", ready], cwd: dir }, options);
  await until(() => existsSync(ready), Boolean);
  assert.equal(stopJob(job, options).state, "cancelled");
});

test("invalid input and unowned ids are rejected", () => {
  assert.throws(() => jobStatus("../../x", options), /id/i);
  assert.throws(() => stopJob(randomUUID(), options), /not found/i);
  assert.throws(() => launchJob({ id: id(), group: "bad group", argv: ["/bin/true"], cwd: dir }, options), /group/i);
  assert.throws(() => launchJob({ id: id(), group: "x", argv: ["true"], cwd: dir }, options), /absolute/i);
  const unsafe = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-unsafe-"));
  try { chmodSync(unsafe, 0o755); assert.throws(() => listJobs(undefined, { dir: unsafe }), /private/); } finally { rmSync(unsafe, { recursive: true, force: true }); }
});

test("an existing same-named unit is not adopted or stopped", { skip: !available }, () => {
  const job = id();
  execFileSync("systemd-run", ["--user", "--quiet", `--unit=pi-owned-job-${job}.service`, "--property=Type=exec", "/bin/sleep", "60"]);
  const result = launchJob({ id: job, group: "collision", argv: ["/bin/true"], cwd: dir }, options);
  assert.equal(result.state, "interrupted");
  stopJob(job, options);
  assert.match(execFileSync("systemctl", ["--user", "is-active", `pi-owned-job-${job}.service`], { encoding: "utf8" }), /active/);
});

test("missing live unit is interrupted, not successful", { skip: !available }, async () => {
  const job = id();
  launchJob({ id: job, group: "project-c", argv: ["/bin/sleep", "60"], cwd: dir }, options);
  execFileSync("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=KILL", `pi-owned-job-${job}.service`]);
  const status = await until(() => jobStatus(job, options), s => s.state === "interrupted");
  assert.equal(status.exitCode, null);
});
