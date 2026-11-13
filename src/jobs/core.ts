import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export interface JobInput { id: string; group: string; argv: string[]; cwd: string }
export interface Options { dir?: string }
export type State = "launching" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface TerminalEvent { jobId: string; group: string; status: "succeeded" | "failed" | "cancelled" | "interrupted"; finished: string }
export interface Job extends JobInput { state: State; exitCode: number | null; signal: string | null; created: string; finished: string | null; log: string; cancelRequested: boolean; error: string | null; terminalEvent: TerminalEvent | null }
type Row = { id: string; group_name: string; argv: string; cwd: string; token: string; state: State; exit_code: number | null; signal: string | null; created: string; finished: string | null; log: string; cancel_requested: number; error: string | null };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function checkId(id: string) { if (typeof id !== "string" || !idPattern.test(id)) throw new Error("id must be a lowercase UUID v4"); }
function checkGroup(group: string) { if (typeof group !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(group)) throw new Error("invalid group"); }
function validate(input: JobInput) {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !["id", "group", "argv", "cwd"].includes(key))) throw new Error("unsupported job input field; completion wakes are not supported");
  checkId(input.id); checkGroup(input.group);
  if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 256 || input.argv.some(a => typeof a !== "string" || a.includes("\0") || a.length > 16384)) throw new Error("invalid argv");
  if (!path.isAbsolute(input.argv[0])) throw new Error("argv executable must be absolute");
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error("cwd must be an absolute existing directory");
}
export function jobDir(options: Options = {}) { return path.resolve(options.dir ?? process.env.PI_JOBS_DIR ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "jobs")); }
export function openDb(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error("jobs directory must be owned by this user and private (0700)");
  const db = new DatabaseSync(path.join(dir, "jobs.sqlite"));
  chmodSync(path.join(dir, "jobs.sqlite"), 0o600);
  db.exec(`PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, group_name TEXT NOT NULL, argv TEXT NOT NULL, cwd TEXT NOT NULL, token TEXT NOT NULL,
    state TEXT NOT NULL, exit_code INTEGER, signal TEXT, created TEXT NOT NULL, finished TEXT,
    log TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE IF NOT EXISTS terminal_events (
    job_id TEXT PRIMARY KEY, group_name TEXT NOT NULL, status TEXT NOT NULL, finished TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS jobs_terminal_event AFTER UPDATE OF state ON jobs
  WHEN NEW.state IN ('succeeded','failed','cancelled','interrupted')
  BEGIN
    INSERT OR IGNORE INTO terminal_events(job_id, group_name, status, finished)
    VALUES(NEW.id, NEW.group_name, NEW.state, NEW.finished);
  END;
  INSERT OR IGNORE INTO terminal_events(job_id, group_name, status, finished)
    SELECT id, group_name, state, COALESCE(finished, created) FROM jobs
    WHERE state IN ('succeeded','failed','cancelled','interrupted');`);
  return db;
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function row(db: DatabaseSync, id: string): Row {
  const r = db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as Row | undefined;
  if (!r) throw new Error(`job not found: ${id}`);
  return r;
}
function convert(db: DatabaseSync, r: Row): Job {
  const event = db.prepare("SELECT job_id, group_name, status, finished FROM terminal_events WHERE job_id=?").get(r.id) as { job_id: string; group_name: string; status: TerminalEvent["status"]; finished: string } | undefined;
  return { id: r.id, group: r.group_name, argv: JSON.parse(r.argv), cwd: r.cwd, state: r.state, exitCode: r.exit_code, signal: r.signal, created: r.created, finished: r.finished, log: r.log, cancelRequested: !!r.cancel_requested, error: r.error, terminalEvent: event ? { jobId: event.job_id, group: event.group_name, status: event.status, finished: event.finished } : null };
}
function unit(id: string) { return `pi-owned-job-${id}.service`; }
function systemctl(args: string[]) { return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }); }
function reconcile(db: DatabaseSync, r: Row): Row {
  if (r.state !== "running" && r.state !== "launching") return r;
  // The launching owner may be between committing its reservation and starting
  // systemd. Do not classify that window as a missing unit.
  if (r.state === "launching" && Date.now() - Date.parse(r.created) < 30_000) return r;
  const output = systemctl(["show", unit(r.id), "--property=LoadState", "--property=ActiveState", "--property=Description"]);
  const props = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (!props.LoadState || !props.ActiveState) throw new Error("systemd returned incomplete unit status");
  if (props.LoadState === "not-found" || props.Description !== `pi-owned-job ${r.token}` || ["inactive", "failed"].includes(props.ActiveState)) {
    const state = r.cancel_requested ? "cancelled" : "interrupted";
    db.prepare("UPDATE jobs SET state=?, finished=?, error=? WHERE id=?").run(state, new Date().toISOString(), state === "interrupted" ? (r.error || "owned unit missing, replaced, or stopped without a recorded command exit") : null, r.id);
    return row(db, r.id);
  }
  if (r.state === "launching") {
    db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(r.id);
    return row(db, r.id);
  }
  return r;
}
export function launchJob(input: JobInput, options: Options = {}): Job {
  validate(input);
  const dir = jobDir(options), db = openDb(dir);
  try {
    // Persist the reservation before starting: a crash must never cause a second launch.
    const created = transaction(db, () => {
      const existing = db.prepare("SELECT * FROM jobs WHERE id=?").get(input.id) as unknown as Row | undefined;
      if (existing) {
        if (existing.group_name !== input.group || existing.cwd !== input.cwd || existing.argv !== JSON.stringify(input.argv)) throw new Error("job id conflict");
        return false;
      }
      db.prepare("INSERT INTO jobs(id, group_name, argv, cwd, token, state, created, log) VALUES(?,?,?,?,?,?,?,?)").run(input.id, input.group, JSON.stringify(input.argv), input.cwd, randomUUID(), "launching", new Date().toISOString(), path.join(dir, `${input.id}.log`));
      return true;
    });
    return transaction(db, () => {
      const r = row(db, input.id);
      if (!created || r.state !== "launching") return convert(db, reconcile(db, r));
      const runner = fileURLToPath(new URL("./runner.ts", import.meta.url));
      let startAttempted = false;
      try {
        const existingUnit = systemctl(["show", unit(input.id), "--property=LoadState"]);
        if (existingUnit.trim() !== "LoadState=not-found") throw new Error("unit name already exists; refusing to adopt it");
        startAttempted = true;
        execFileSync("systemd-run", ["--user", "--quiet", "--expand-environment=no", `--unit=${unit(input.id)}`, `--description=pi-owned-job ${r.token}`, "--property=Type=exec", "--property=RemainAfterExit=yes", "--property=KillMode=control-group", "--property=TimeoutStopSec=3s", process.execPath, "--experimental-strip-types", runner, dir, input.id], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
        db.prepare("UPDATE jobs SET state='running' WHERE id=? AND state='launching'").run(input.id);
      } catch (e) {
        // Once systemd-run was invoked its outcome can be ambiguous. Status
        // verifies the identity token before treating a unit as ours.
        db.prepare("UPDATE jobs SET state=?, finished=?, error=? WHERE id=?").run(startAttempted ? "running" : "interrupted", startAttempted ? null : new Date().toISOString(), `systemd start ${startAttempted ? "uncertain" : "failed"}: ${String(e)}`, input.id);
      }
      return convert(db, row(db, input.id));
    });
  } finally { db.close(); }
}
export function jobStatus(id: string, options: Options = {}): Job {
  checkId(id); const db = openDb(jobDir(options));
  try { return transaction(db, () => convert(db, reconcile(db, row(db, id)))); } finally { db.close(); }
}
export function listJobs(group?: string, options: Options = {}): Job[] {
  if (group !== undefined) checkGroup(group);
  const db = openDb(jobDir(options));
  try { return transaction(db, () => {
    const rows = (group === undefined ? db.prepare("SELECT * FROM jobs ORDER BY created,id").all() : db.prepare("SELECT * FROM jobs WHERE group_name=? ORDER BY created,id").all(group)) as unknown as Row[];
    return rows.map(r => convert(db, reconcile(db, r)));
  }); } finally { db.close(); }
}
export function stopJob(id: string, options: Options = {}): Job {
  checkId(id); const db = openDb(jobDir(options));
  try { return transaction(db, () => {
    const r = reconcile(db, row(db, id));
    if (r.state !== "running" && r.state !== "launching") return convert(db, r);
    if (r.state === "launching") throw new Error("job launch is still being reconciled; retry stop shortly");
    db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(id);
    // If stopping fails, rollback the request and expose the error to the caller.
    systemctl(["stop", unit(id)]);
    db.prepare("UPDATE jobs SET state='cancelled', finished=? WHERE id=? AND state IN ('running','launching')").run(new Date().toISOString(), id);
    return convert(db, row(db, id));
  }); } finally { db.close(); }
}
