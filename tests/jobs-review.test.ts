import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { launchJob, jobStatus, stopJob } from "../src/jobs/core.ts";

let available = false;
try { execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }); available = true; } catch {}
const dirs: string[] = [], ids: string[] = [], children: ChildProcess[] = [];
const realSystemctl = execFileSync("which", ["systemctl"], { encoding: "utf8" }).trim();
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), "pi-job-review-")); dirs.push(dir); const id = randomUUID(); ids.push(id); return { dir, id }; }
function units(id: string) {
  return execFileSync(realSystemctl, ["--user", "list-units", "--all", "--plain", "--no-legend", `pi-owned-job-${id}*.service`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/)[0]);
}
function unit(id: string) { const found = units(id); assert.equal(found.length, 1, `expected exactly one test unit: ${found}`); return found[0]; }
async function until<T>(fn: () => T, done: (v: T) => boolean, ms = 12000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (done(v)) return v; await new Promise(r => setTimeout(r, 50)); } throw new Error("timed out"); }
function child(script: string, env: NodeJS.ProcessEnv = process.env) { const p = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, stdio: "ignore" }); children.push(p); return p; }
async function exited(p: ChildProcess) { if (p.exitCode !== null || p.signalCode !== null) return; await new Promise<void>(r => p.once("exit", () => r())); }
const core = new URL("../src/jobs/core.ts", import.meta.url).href;
afterEach(async () => {
  for (const p of children.splice(0)) { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); await exited(p); }
  for (const id of ids.splice(0)) for (const name of units(id)) {
    try { execFileSync(realSystemctl, ["--user", "stop", name], { stdio: "ignore", timeout: 12000 }); } catch {}
    try { execFileSync(realSystemctl, ["--user", "reset-failed", name], { stdio: "ignore" }); } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("completion is not successful while a background descendant lives", { skip: !available }, async () => {
  const { id, dir } = setup(), pidFile = path.join(dir, "pid");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "sleep 30 & echo $! > \"$1\"", "sh", pidFile], cwd: dir }, { dir });
  await until(() => existsSync(pidFile), Boolean);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise(r => setTimeout(r, 600));
  const state = jobStatus(id, { dir });
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.ok(!(state.state === "succeeded" && alive), "success reported while background process lives");
  assert.equal(stopJob(id, { dir }).state, "cancelled");
  const stat = (() => { try { return readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return ""; } })();
  assert.ok(!stat || /^\d+ \(.*\) Z /.test(stat), "descendant must be gone before cancellation is reported");
});

test("stop cleans up a live descendant from a historical terminal job", { skip: !available }, async () => {
  const { id, dir } = setup(), token = randomUUID(), pidFile = path.join(dir, "pid"), name = `pi-owned-job-${id}.service`;
  const db = new DatabaseSync(path.join(dir, "jobs.sqlite"));
  try {
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, group_name TEXT NOT NULL, argv TEXT NOT NULL, cwd TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER, signal TEXT, created TEXT NOT NULL, finished TEXT, log TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT)`);
    db.prepare("INSERT INTO jobs(id,group_name,argv,cwd,token,state,exit_code,created,finished,log) VALUES(?,?,?,?,?,'succeeded',0,?,?,?)").run(id, "review", JSON.stringify(["/bin/true"]), dir, token, new Date().toISOString(), new Date().toISOString(), path.join(dir, "log"));
  } finally { db.close(); }
  execFileSync("systemd-run", ["--user", "--quiet", `--unit=${name}`, `--description=pi-owned-job ${token}`, "--property=Type=exec", "--property=RemainAfterExit=yes", "--property=KillMode=control-group", "/bin/sh", "-c", 'sleep 30 & echo $! > "$1"', "sh", pidFile]);
  await until(() => existsSync(pidFile), Boolean);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(stopJob(id, { dir }).state, "succeeded");
  const stat = (() => { try { return readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return ""; } })();
  assert.ok(!stat || /^\\d+ \\(.*\\) Z /.test(stat), "historical descendant must be gone");
});

test("completion waits for background descendants to exit", { skip: !available }, async () => {
  const { id, dir } = setup(), marker = path.join(dir, "done");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "(sleep 1; echo done > \"$1\") &", "sh", marker], cwd: dir }, { dir });
  const result = await until(() => jobStatus(id, { dir }), j => j.state === "succeeded");
  assert.equal(result.exitCode, 0); assert.equal(readFileSync(marker, "utf8").trim(), "done");
});

test("manual service restart cannot execute the command twice", { skip: !available }, async () => {
  const { id, dir } = setup(), marker = path.join(dir, "marker");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "echo x >> \"$1\"", "sh", marker], cwd: dir }, { dir });
  await until(() => jobStatus(id, { dir }), j => j.state === "succeeded");
  try { execFileSync(realSystemctl, ["--user", "restart", unit(id)], { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 600));
  assert.equal(readFileSync(marker, "utf8"), "x\n");
});

test("restarting a running service cannot execute its command again", { skip: !available }, async () => {
  const { id, dir } = setup(), marker = path.join(dir, "marker");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "echo x >> \"$1\"; sleep 30", "sh", marker], cwd: dir }, { dir });
  await until(() => existsSync(marker), Boolean);
  try { execFileSync(realSystemctl, ["--user", "restart", unit(id)], { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 500));
  assert.equal(readFileSync(marker, "utf8"), "x\n");
  assert.notEqual(jobStatus(id, { dir }).state, "succeeded");
});

test("a long sqlite writer does not discard the observed exit code", { skip: !available }, async () => {
  const { id, dir } = setup(), gate = path.join(dir, "gate"), locked = path.join(dir, "locked");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "while [ ! -e \"$1\" ]; do sleep .05; done; exit 23", "sh", gate], cwd: dir }, { dir });
  const script = `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs'; const db=new DatabaseSync(${JSON.stringify(path.join(dir, "jobs.sqlite"))}); db.exec('BEGIN IMMEDIATE'); writeFileSync(${JSON.stringify(locked)},'1'); setTimeout(()=>{db.exec('COMMIT');db.close()},18000);`;
  const p = child(script); await until(() => existsSync(locked), Boolean); writeFileSync(gate, "go"); await exited(p);
  const result = await until(() => jobStatus(id, { dir }), j => !["running", "launching"].includes(j.state), 10000);
  assert.equal(result.state, "failed"); assert.equal(result.exitCode, 23);
});

test("slow systemd status does not block a runner recording its exit", { skip: !available }, async () => {
  const { id, dir } = setup(), gate = path.join(dir, "gate"), started = path.join(dir, "started"), bin = path.join(dir, "bin");
  launchJob({ id, group: "review", argv: ["/bin/sh", "-c", "while [ ! -e \"$1\" ]; do sleep .05; done; exit 23", "sh", gate], cwd: dir }, { dir });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 5\nexec ${realSystemctl} "$@"\n`);
  chmodSync(path.join(bin, "systemctl"), 0o755);
  const p = child(`import {jobStatus} from ${JSON.stringify(core)}; jobStatus(${JSON.stringify(id)}, {dir:${JSON.stringify(dir)}});`, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  await until(() => existsSync(started), Boolean); writeFileSync(gate, "go");
  const result = await until(() => jobStatus(id, { dir }), j => j.state === "failed", 3000);
  assert.equal(result.exitCode, 23); await exited(p);
});

test("cancellation intent survives death of the caller during systemd stop", { skip: !available }, async () => {
  const { id, dir } = setup(), ready = path.join(dir, "ready"), term = path.join(dir, "term");
  launchJob({ id, group: "review", argv: [process.execPath, "-e", "process.on('SIGTERM',()=>require('fs').writeFileSync(process.argv[2],'term')); require('fs').writeFileSync(process.argv[1],'ready'); setInterval(()=>{},1000)", ready, term], cwd: dir }, { dir });
  await until(() => existsSync(ready), Boolean);
  const p = child(`import {stopJob} from ${JSON.stringify(core)}; stopJob(${JSON.stringify(id)}, {dir:${JSON.stringify(dir)}});`);
  await until(() => existsSync(term), Boolean);
  const pending = jobStatus(id, { dir });
  assert.equal(pending.cancelRequested, true);
  assert.equal(pending.state, "running", "a still-live process must not be reported cancelled");
  p.kill("SIGKILL"); await exited(p);
  const result = await until(() => jobStatus(id, { dir }), j => !["running", "launching"].includes(j.state), 12000);
  assert.equal(result.cancelRequested, true); assert.equal(result.state, "cancelled");
});

test("follow-up cancellation does not report success with a populated replacement cgroup", { skip: !available }, async () => {
  const { id, dir } = setup();
  launchJob({ id, group: "review", argv: ["/bin/sleep", "60"], cwd: dir }, { dir });
  const name = unit(id);
  assert.equal(stopJob(id, { dir }).state, "cancelled");
  execFileSync("systemd-run", ["--user", "--quiet", `--unit=${name}`, "--description=foreign-test-unit", "--property=Type=exec", "/bin/sleep", "60"]);
  assert.throws(() => stopJob(id, { dir }), /populated|unconfirmed/);
  assert.equal(execFileSync(realSystemctl, ["--user", "is-active", name], { encoding: "utf8" }).trim(), "active");
});

test("replacement between ownership check and stop is not stopped", { skip: !available, todo: "systemd stop has no atomic unit-generation predicate; exact-name replacement remains unsafe" }, async () => {
  const { id, dir } = setup(), ready = path.join(dir, "ready"), swapped = path.join(dir, "swapped");
  launchJob({ id, group: "review", argv: ["/bin/sleep", "60"], cwd: dir }, { dir });
  const name = unit(id), bin = path.join(dir, "bin");
  mkdirSync(bin);
  const wrapper = `#!/bin/sh\n${realSystemctl} "$@"\nstatus=$?\ncase "$*" in *"show ${name}"*"Description"*)\n if [ ! -e ${JSON.stringify(swapped)} ]; then\n  ${realSystemctl} --user stop ${name} >/dev/null 2>&1\n  ${realSystemctl} --user reset-failed ${name} >/dev/null 2>&1\n  systemd-run --user --quiet --unit=${name} --description=foreign-test-unit --property=Type=exec /bin/sleep 60\n  touch ${JSON.stringify(swapped)}\n fi;; esac\nexit $status\n`;
  writeFileSync(path.join(bin, "systemctl"), wrapper); chmodSync(path.join(bin, "systemctl"), 0o755);
  const p = child(`import {stopJob} from ${JSON.stringify(core)}; try {stopJob(${JSON.stringify(id)}, {dir:${JSON.stringify(dir)}})} catch {} `, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  await exited(p); assert.ok(existsSync(swapped), "replacement interleaving executed");
  assert.equal(execFileSync(realSystemctl, ["--user", "is-active", name], { encoding: "utf8" }).trim(), "active");
});
