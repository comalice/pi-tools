import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { listSessions } from "../memory/store.ts";
import { resolveBindAddress } from "../shared/bind.ts";

// Dream runner: enumerates archived conversation sessions in a window and runs
// one isolated dream worker per session with bounded concurrency, persisting
// progress so a run can resume after interruption. Serves a loopback-by-default
// admin console under a per-startup random URL; the URL is printed on stdout
// so it lands in the launching conversation's log.

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workerScript = path.join(repo, "src/dream/worker.ts");
const WORKER_TIMEOUT_MS = 45 * 60 * 1000;
const KEEP_ALIVE_AFTER_DONE_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 2;

const ENTRY_ID_FORMAT: Record<string, string> = {
  pi: "the `id` fields of `message` records in the session JSONL (one record per line).",
  claude: "the `uuid` fields of messages in `chat_messages` (a claude.ai export JSON document).",
  opencode: "the `id` fields of message rows (`msg_…`) in the OpenCode SQLite store.",
};

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error("Usage: dream [--since 30d] [--model gladiator/nemotron-3-super] [--parallel 3] [--max 500] [--port 6339] [--bind ADDR] [--state-dir DIR] [--index FILE]");
    out[argv[i]] = argv[i + 1];
  }
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return {
    since: out["--since"] ?? "30d",
    model: out["--model"] ?? "gladiator/nemotron-3-super",
    parallel: Math.min(8, Math.max(1, Number(out["--parallel"] ?? 3) || 3)),
    max: Math.min(5000, Math.max(1, Number(out["--max"] ?? 500) || 500)),
    port: Math.min(65535, Math.max(1024, Number(out["--port"] ?? process.env.PI_DREAM_ADMIN_PORT ?? 6339) || 6339)),
    bind: resolveBindAddress(out["--bind"], process.env.PI_DREAM_ADMIN_BIND),
    stateDir: out["--state-dir"] ?? path.join(agent, "dream"),
    index: out["--index"] ?? process.env.PI_MEMORY_INDEX ?? path.join(agent, "memory", "archive.sqlite"),
  };
}

type SessionStatus = "pending" | "running" | "done" | "failed" | "skipped";
type SessionState = { status: SessionStatus; source: string; project: string; file: string; first?: string; last?: string; attempts?: number; startedAt?: string; finishedAt?: string; summary?: string; error?: string };
type State = { startedAt: string; model: string; since: string; token: string; done: boolean; sessions: Record<string, SessionState> };

const config = parseArgs(process.argv.slice(2));
mkdirSync(path.join(config.stateDir, "out"), { recursive: true, mode: 0o700 });
const stateFile = path.join(config.stateDir, "state.json");

let state: State;
if (existsSync(stateFile)) {
  state = JSON.parse(readFileSync(stateFile, "utf8"));
  // A new startup gets a new token: the admin console moves, by design.
  state.token = randomUUID();
  for (const session of Object.values(state.sessions)) if (session.status === "running") session.status = "pending";
} else {
  state = { startedAt: new Date().toISOString(), model: config.model, since: config.since, token: randomUUID(), done: false, sessions: {} };
}

function save() {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, stateFile);
}

function enumerate() {
  const raw = config.since.match(/^(\d+)d$/);
  const hadPending = Object.values(state.sessions).some(s => s.status === "pending");
  const since = raw ? new Date(Date.now() - Number(raw[1]) * 24 * 60 * 60 * 1000) : new Date(config.since);
  if (Number.isNaN(since.valueOf())) throw new Error("--since must be an ISO date or a day count like 30d");
  const db = new DatabaseSync(config.index, { readOnly: true });
  db.exec("PRAGMA query_only=ON;");
  try {
    const rows = listSessions(db, since.toISOString(), 5000);
    // OpenCode sessions are assembled from its SQLite store: row.file is the
    // session id, so resolve the registered store path as the readable file.
    const opencodeRoot = (db.prepare("SELECT root FROM source_config WHERE source='opencode'").get() as any)?.root as string | undefined;
    let considered = 0;
    for (const row of rows) {
      const existing = state.sessions[row.session_id];
      if (existing && existing.status !== "pending") continue;
      const file = row.source === "opencode" ? opencodeRoot : row.file;
      if (!ENTRY_ID_FORMAT[row.source] || !file || !existsSync(file)) {
        state.sessions[row.session_id] = { status: "skipped", source: row.source, project: row.project, file: row.file ?? "", error: "no readable session file for this source" };
        continue;
      }
      row.file = file;
      if (considered >= config.max) continue;
      considered++;
      state.sessions[row.session_id] = { status: "pending", source: row.source, project: row.project, file: row.file, first: row.first, last: row.last };
    }
  } finally { db.close(); }
  // A resumed invocation with fresh work starts a new run.
  if (!hadPending && Object.values(state.sessions).some(s => s.status === "pending")) {
    state.done = false;
    state.startedAt = new Date().toISOString();
  }
}

// Single-instance lock: a PID file prevents a timer-triggered runner from
// doubling up alongside a live run. A stale PID file (dead process) is taken
// over; the lock is released on exit.
const pidFile = path.join(config.stateDir, "runner.pid");
function acquireLock() {
  if (existsSync(pidFile)) {
    const prior = Number(readFileSync(pidFile, "utf8").trim());
    let alive = false;
    if (Number.isSafeInteger(prior) && prior > 0) {
      try { process.kill(prior, 0); alive = true; } catch { /* dead */ }
    }
    if (alive) {
      console.log(`[dream] another runner is active (pid ${prior}); exiting`);
      process.exit(0);
    }
  }
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
  process.on("exit", () => { try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* already gone */ } });
}

const running = new Set<string>();
function pump() {
  if (state.done) return;
  const pending = Object.entries(state.sessions).filter(([, s]) => s.status === "pending");
  for (const [id, session] of pending) {
    if (running.size >= config.parallel) return;
    running.add(id);
    session.status = "running";
    session.attempts = (session.attempts ?? 0) + 1;
    session.startedAt = new Date().toISOString();
    const out = path.join(config.stateDir, "out", `${id}.json`);
    save();
    const child = spawn(process.execPath, ["--experimental-strip-types", workerScript, "--file", session.file, "--source", session.source, "--session", id, "--project", session.project, "--model", config.model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, WORKER_TIMEOUT_MS);
    child.on("close", code => {
      clearTimeout(killer);
      running.delete(id);
      session.finishedAt = new Date().toISOString();
      let summary: any = null;
      try { summary = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { /* malformed worker output */ }
      if (code === 0 && summary?.ok) {
        session.status = "done";
        writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
        session.summary = out;
        session.error = summary.chunkFailures?.length ? `chunk warnings: ${summary.chunkFailures.join(" | ").slice(0, 300)}` : undefined;
      } else {
        session.status = "failed";
        session.error = (code === null ? "worker timed out" : summary?.error ?? `worker exited ${code}`) + (stderr.trim() ? `: ${stderr.trim().slice(-300)}` : "");
      }
      save();
      pump();
    });
  }
  if (running.size > 0 || Object.values(state.sessions).some(s => s.status === "pending" || s.status === "running")) return;
  // Retry round: sessions that failed get one more attempt automatically.
  const retryable = Object.values(state.sessions).filter(s => s.status === "failed" && (s.attempts ?? 1) < MAX_ATTEMPTS);
  if (retryable.length) {
    console.log(`[dream] retrying ${retryable.length} failed sessions (attempt ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS})`);
    for (const session of retryable) session.status = "pending";
    save();
    pump();
    return;
  }
  finish();
}

let finishedAt: string | null = null;
function finish() {
  if (state.done) return;
  state.done = true;
  finishedAt = new Date().toISOString();
  save();
  const counts = countByStatus();
  console.log(`[dream] run complete: ${JSON.stringify(counts)} — admin console stays up for ${KEEP_ALIVE_AFTER_DONE_MS / 3600000}h`);
  setTimeout(() => process.exit(0), KEEP_ALIVE_AFTER_DONE_MS).unref();
}

function countByStatus() {
  const counts: Record<string, number> = {};
  for (const s of Object.values(state.sessions)) counts[s.status] = (counts[s.status] ?? 0) + 1;
  return counts;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(): string {
  const counts = countByStatus();
  const rows = Object.entries(state.sessions)
    .sort((a, b) => (a[1].startedAt ?? "").localeCompare(b[1].startedAt ?? ""))
    .reverse()
    .map(([id, s]) => `<tr class="${s.status}"><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.source)}</td><td title="${escapeHtml(id)}">${escapeHtml(id.slice(0, 8))}</td><td>${escapeHtml(s.project)}</td><td>${escapeHtml(s.startedAt?.slice(11, 19) ?? "")}</td><td>${escapeHtml(s.finishedAt?.slice(11, 19) ?? "")}</td><td>${escapeHtml(s.error ?? "")}</td></tr>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>dream runner</title>
<style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}.running{background:#fff3cd}.failed{background:#f8d7da}.done{background:#d4edda}.skipped{color:#888}</style>
<h1>dream runner</h1>
<p>model <b>${escapeHtml(state.model)}</b> · window <b>${escapeHtml(state.since)}</b> · started ${escapeHtml(state.startedAt)} · ${state.done ? `<b>complete</b> at ${escapeHtml(finishedAt ?? "")}` : "<b>running</b>"}</p>
<p>${Object.entries(counts).map(([k, v]) => `${k}: <b>${v}</b>`).join(" · ")}</p>
<table><tr><th>status</th><th>source</th><th>session</th><th>project</th><th>started</th><th>finished</th><th>error</th></tr>${rows}</table>`;
}

function startServer(port: number, bind: string, attempt = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `/admin/${state.token}/`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page());
    } else if (url.pathname === `/admin/${state.token}/state.json`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...state, token: undefined }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("error", (error: any) => {
    if (error?.code === "EADDRINUSE" && attempt < 9) startServer(port + 1, bind, attempt + 1);
    else throw error;
  });
  server.listen(port, bind, () => {
    const host = bind.includes(":") ? `[${bind}]` : bind;
    console.log(`[dream] admin console: http://${host}:${port}/admin/${state.token}/`);
  });
}

acquireLock();
enumerate();
save();
const counts = countByStatus();
console.log(`[dream] window ${config.since}: ${JSON.stringify(counts)} · model ${config.model} · parallel ${config.parallel}`);
startServer(config.port, config.bind);
pump();
