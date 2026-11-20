import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  controllerSocketPath,
  jobDir,
  loadDeliverySnapshot,
  openDb,
  reconcile,
  row,
  transaction,
  type Row,
} from "./core.ts";
import {
  deliveryStateFromSnapshot,
  stepJob,
  type ExecutionOutcome,
  type WakeTarget,
} from "./chart.ts";

export interface WakeDeliveryRequest {
  jobId: string;
  group: string;
  attempt: number;
  outcome: ExecutionOutcome;
  wake: WakeTarget;
  log: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export type WakeDeliveryResult =
  | { ok: true }
  | { ok: false; busy?: boolean; error: string };

export interface DeadLetterNotice {
  jobId: string;
  group: string;
  outcome: ExecutionOutcome;
  error: string | null;
}

export interface ControllerOptions {
  dir?: string;
  reconcileIntervalMs?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  deliverWake?: (req: WakeDeliveryRequest) => Promise<WakeDeliveryResult>;
  sendNotify?: (notice: DeadLetterNotice) => Promise<void>;
}

function scheduleDir(): string {
  return path.resolve(
    process.env.PI_SCHEDULE_DIR ??
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "schedule"),
  );
}

function buildWakePrompt(req: WakeDeliveryRequest): string {
  const details = [
    `[Managed job ${req.jobId} (${req.group}) finished: ${req.outcome}]`,
    req.exitCode !== null ? `exitCode=${req.exitCode}` : null,
    req.signal ? `signal=${req.signal}` : null,
    req.error ? `error=${req.error}` : null,
    `log=${req.log}`,
  ].filter(Boolean).join(" | ");
  return `${details}\n\n${req.wake.prompt}`;
}

export function defaultDeliverWake(req: WakeDeliveryRequest): Promise<WakeDeliveryResult> {
  return new Promise((resolve) => {
    const locksDir = path.join(scheduleDir(), "locks");
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(locksDir, `session-${req.wake.session}.lock`);
    const piBin = process.env.PI_BIN || "/usr/bin/pi";
    const piArgs = ["--session", req.wake.session];
    if (req.wake.model) piArgs.push("--model", req.wake.model);
    piArgs.push("--print", buildWakePrompt(req));

    const child = spawn(
      "flock",
      ["-n", "-E", "75", lockFile, "timeout", "--kill-after=2s", "30m", piBin, ...piArgs],
      { cwd: req.wake.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.once("error", (err) => {
      resolve({ ok: false, error: `wake spawn failed: ${err.message}` });
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
      } else if (code === 75) {
        resolve({ ok: false, busy: true, error: "session busy (flock exit 75)" });
      } else {
        const msg = stderr.trim() || `wake exited ${code ?? signal}`;
        resolve({ ok: false, error: msg.slice(0, 500) });
      }
    });
  });
}

export function defaultSendNotify(notice: DeadLetterNotice): Promise<void> {
  return new Promise((resolve) => {
    const title = `pi job wake failed (${notice.group})`;
    const body = `Job ${notice.jobId} finished (${notice.outcome}) but wake delivery dead-lettered: ${notice.error ?? "unknown error"}`;
    const child = spawn("notify-send", [title, body], { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export class JobsController {
  readonly dir: string;
  private readonly reconcileIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly deliverWake: (req: WakeDeliveryRequest) => Promise<WakeDeliveryResult>;
  private readonly sendNotify: (notice: DeadLetterNotice) => Promise<void>;

  private server: net.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private pendingTick = false;
  private activeTickPromise: Promise<void> | null = null;

  constructor(options: ControllerOptions = {}) {
    this.dir = jobDir(options);
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.backoffBaseMs = options.backoffBaseMs ?? 5000;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    this.deliverWake = options.deliverWake ?? defaultDeliverWake;
    this.sendNotify = options.sendNotify ?? defaultSendNotify;
  }

  private computeRetryAt(attempt: number): string {
    const delay = Math.min(this.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)), this.maxBackoffMs);
    return new Date(Date.now() + delay).toISOString();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Ensure DB & migrations exist and recover any mid-delivery jobs from a prior crash.
    await this.recoverInFlightDeliveries();

    const sockPath = controllerSocketPath(this.dir);
    try { unlinkSync(sockPath); } catch {}
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((conn) => {
        conn.on("data", () => { this.poke(); });
        conn.on("error", () => {});
        conn.end();
      });
      server.once("error", reject);
      server.listen(sockPath, () => {
        try { chmodSync(sockPath, 0o600); } catch {}
        this.server = server;
        resolve();
      });
    });

    this.poke();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    try { unlinkSync(controllerSocketPath(this.dir)); } catch {}
    if (this.activeTickPromise) {
      await this.activeTickPromise;
    }
  }

  poke(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.pendingTick = true;
      return;
    }
    this.activeTickPromise = this.runTickLoop();
  }

  private async runTickLoop(): Promise<void> {
    this.ticking = true;
    try {
      do {
        this.pendingTick = false;
        await this.tickOnce();
      } while (this.running && this.pendingTick);
    } finally {
      this.ticking = false;
      this.activeTickPromise = null;
      if (this.running) this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;

    let delay = this.reconcileIntervalMs;
    const db = openDb(this.dir);
    try {
      const next = db.prepare(
        "SELECT MIN(delivery_next_at) AS next_at FROM jobs WHERE delivery_state='pending' AND delivery_next_at IS NOT NULL",
      ).get() as { next_at: string | null } | undefined;
      if (next?.next_at) {
        const ms = Math.max(10, Date.parse(next.next_at) - Date.now());
        delay = Math.min(delay, ms);
      }
    } finally {
      db.close();
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.poke();
    }, delay);
    this.timer.unref?.();
  }

  async recoverInFlightDeliveries(): Promise<void> {
    const notices: DeadLetterNotice[] = [];
    const db = openDb(this.dir);
    try {
      const stuck = db.prepare("SELECT * FROM jobs WHERE delivery_state='delivering'").all() as unknown as Row[];
      for (const r of stuck) {
        const snap = loadDeliverySnapshot(r);
        const retryAt = this.computeRetryAt(r.delivery_attempts || 1);
        const res = stepJob(snap, {
          type: "delivery.fail",
          error: "controller restarted during delivery",
          retryAt,
        });
        const nextState = deliveryStateFromSnapshot(res.snapshot);
        transaction(db, () => {
          db.prepare(
            "UPDATE jobs SET delivery_state=?, delivery_next_at=?, delivery_error=?, delivery_notified=? WHERE id=? AND delivery_state='delivering'",
          ).run(
            nextState,
            res.snapshot.context.nextDeliveryAt,
            res.snapshot.context.lastDeliveryError,
            res.snapshot.context.notified ? 1 : 0,
            r.id,
          );
        });
        for (const eff of res.effects) {
          if (eff.type === "notify.dead_letter") {
            notices.push({
              jobId: eff.jobId,
              group: eff.group,
              outcome: eff.outcome,
              error: eff.error,
            });
          }
        }
      }
    } finally {
      db.close();
    }
    for (const notice of notices) {
      await this.sendNotify(notice);
    }
  }

  async tickOnce(): Promise<void> {
    // 1. Reconcile active jobs against systemd so missing units / crashes are detected automatically.
    const db = openDb(this.dir);
    let dueRows: Row[] = [];
    try {
      const active = db.prepare("SELECT * FROM jobs WHERE state IN ('launching','running')").all() as unknown as Row[];
      for (const r of active) {
        try {
          reconcile(db, r);
        } catch {
          // Transient systemctl error: try again on the next tick.
        }
      }
      const nowIso = new Date().toISOString();
      dueRows = db.prepare(
        "SELECT * FROM jobs WHERE delivery_state='pending' AND (delivery_next_at IS NULL OR delivery_next_at <= ?) ORDER BY created,id",
      ).all(nowIso) as unknown as Row[];
    } finally {
      db.close();
    }

    // 2. Process due wake deliveries through the statechart.
    for (const due of dueRows) {
      if (!this.running) break;
      await this.processDelivery(due.id);
    }
  }

  private async processDelivery(jobId: string): Promise<void> {
    let wakeReq: WakeDeliveryRequest | null = null;
    const nowIso = new Date().toISOString();

    const dbStart = openDb(this.dir);
    try {
      transaction(dbStart, () => {
        const r = row(dbStart, jobId);
        if (r.delivery_state !== "pending") return;
        const snap = loadDeliverySnapshot(r);
        const res = stepJob(snap, { type: "delivery.begin", now: nowIso });
        if (!res.changed) return;
        const nextState = deliveryStateFromSnapshot(res.snapshot);
        dbStart.prepare(
          "UPDATE jobs SET delivery_state=?, delivery_attempts=?, delivery_next_at=? WHERE id=? AND delivery_state='pending'",
        ).run(
          nextState,
          res.snapshot.context.deliveryAttempts,
          res.snapshot.context.nextDeliveryAt,
          jobId,
        );
        for (const eff of res.effects) {
          if (eff.type === "wake.deliver") {
            wakeReq = {
              jobId: r.id,
              group: r.group_name,
              attempt: eff.attempt,
              outcome: eff.outcome,
              wake: eff.wake,
              log: r.log,
              exitCode: r.exit_code,
              signal: r.signal,
              error: r.error,
            };
          }
        }
      });
    } finally {
      dbStart.close();
    }

    if (!wakeReq) return;
    const req: WakeDeliveryRequest = wakeReq;
    let outcome: WakeDeliveryResult;
    try {
      outcome = await this.deliverWake(req);
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const notices: DeadLetterNotice[] = [];
    const dbFinish = openDb(this.dir);
    try {
      transaction(dbFinish, () => {
        const r = row(dbFinish, jobId);
        if (r.delivery_state !== "delivering") return;
        const snap = loadDeliverySnapshot(r);
        const evt = outcome.ok
          ? ({ type: "delivery.ack" } as const)
          : ({
              type: "delivery.fail",
              error: outcome.error,
              retryAt: this.computeRetryAt(r.delivery_attempts),
            } as const);
        const res = stepJob(snap, evt);
        const nextState = deliveryStateFromSnapshot(res.snapshot);
        dbFinish.prepare(
          "UPDATE jobs SET delivery_state=?, delivery_next_at=?, delivery_error=?, delivery_notified=? WHERE id=? AND delivery_state='delivering'",
        ).run(
          nextState,
          res.snapshot.context.nextDeliveryAt,
          res.snapshot.context.lastDeliveryError,
          res.snapshot.context.notified ? 1 : 0,
          jobId,
        );
        for (const eff of res.effects) {
          if (eff.type === "notify.dead_letter") {
            notices.push({
              jobId: eff.jobId,
              group: eff.group,
              outcome: eff.outcome,
              error: eff.error,
            });
          }
        }
      });
    } finally {
      dbFinish.close();
    }

    for (const notice of notices) {
      await this.sendNotify(notice);
    }
  }
}

export async function startController(options: ControllerOptions = {}): Promise<JobsController> {
  const controller = new JobsController(options);
  await controller.start();
  return controller;
}
