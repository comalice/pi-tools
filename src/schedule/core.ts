/**
 * Scheduling core for agent-created alerts and session wakes.
 *
 * Backend: durable systemd user units (Persistent=true, survive reboot and
 * suspend) plus a JSON sidecar registry under PI_SCHEDULE_DIR
 * (~/.pi/agent/schedule). One-shot and multi-up items self-clean after
 * their last fire; recurring items persist until cancelled.
 *
 * The exec layer is injected so tests can verify unit assembly without
 * touching systemd.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ScheduleKind = "notification" | "wake";
export type ScheduleSpec =
  | { type: "once"; at: Date }
  | { type: "multi"; ats: Date[] }
  | { type: "recurring"; calendar: string };

export interface ScheduleEntry {
  id: string;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  created: string;
  // notification payload
  title?: string;
  message?: string;
  // wake payload
  session?: string;
  prompt?: string;
  model?: string;
  timeoutMinutes?: number;
}

export interface Exec {
  (cmd: string, args: string[]): string;
}

const MAX_MESSAGE = 500;
const MAX_PROMPT = 2000;
const MAX_MULTI = 8;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

const SIMPLE_CALENDAR: Record<string, string> = {
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};
const CALENDAR_SPEC = /^[\w*:,\/.-]+( [\w*:,\/.-]+){0,2}$/;

export function scheduleDir(): string {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return process.env.PI_SCHEDULE_DIR || path.join(agent, "schedule");
}

export function unitsDir(): string {
  return process.env.PI_SCHEDULE_UNITS_DIR || path.join(os.homedir(), ".config", "systemd", "user");
}

/** Parse a --when value: ISO datetime or relative like 30m, 2h, 1d. */
export function parseWhen(input: string, now = Date.now()): Date {
  const rel = input.trim().match(/^(\d{1,4})([smhd])$/);
  let at: Date;
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === "s" ? n * 1_000 : rel[2] === "m" ? n * 60_000 : rel[2] === "h" ? n * 3_600_000 : n * 86_400_000;
    at = new Date(now + ms);
  } else {
    at = new Date(input);
  }
  if (Number.isNaN(at.valueOf())) throw new Error(`unparseable time: "${input}" (use ISO 8601 or relative like 30m, 2h, 1d)`);
  if (at.getTime() <= now - 60_000) throw new Error(`time is in the past: "${input}"`);
  if (at.getTime() > now + MAX_FUTURE_MS) throw new Error("time is more than a year out");
  return at;
}

/** Validate and normalize a recurring calendar expression. */
export function parseRecurring(input: string): string {
  const trimmed = input.trim();
  if (SIMPLE_CALENDAR[trimmed]) return SIMPLE_CALENDAR[trimmed];
  // Accept a daily HH:MM shorthand.
  const hm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return `*-*-* ${hm[1].padStart(2, "0")}:${hm[2]}:00`;
  if (CALENDAR_SPEC.test(trimmed) && trimmed.length <= 60) return trimmed;
  throw new Error(`unparseable calendar: "${input}" (use daily|weekly|hourly|monthly, HH:MM, or a systemd OnCalendar spec)`);
}

export function buildSpec(opts: { when?: string; times?: string[]; recurring?: string }): ScheduleSpec {
  const chosen = [opts.when, opts.times?.length, opts.recurring].filter(Boolean).length;
  if (chosen !== 1) throw new Error("exactly one of when, times, recurring is required");
  if (opts.when) return { type: "once", at: parseWhen(opts.when) };
  if (opts.times) {
    if (!Array.isArray(opts.times) || opts.times.length < 2 || opts.times.length > MAX_MULTI) {
      throw new Error(`times must be 2–${MAX_MULTI} entries`);
    }
    const ats = opts.times.map((t) => parseWhen(t));
    ats.sort((a, b) => a.getTime() - b.getTime());
    return { type: "multi", ats };
  }
  return { type: "recurring", calendar: parseRecurring(opts.recurring!) };
}

export function newId(kind: ScheduleKind): string {
  return `${kind === "notification" ? "n" : "w"}-${randomUUID().slice(0, 8)}`;
}

export function unitName(entry: Pick<ScheduleEntry, "kind" | "id">, suffix = ""): string {
  return `pi-${entry.kind === "notification" ? "notify" : "wake"}-${entry.id}${suffix}`;
}

function calendarLine(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
}

export function renderTimer(spec: ScheduleSpec, serviceName: string): string {
  const lines =
    spec.type === "once"
      ? [`OnCalendar=${calendarLine(spec.at)}`]
      : spec.type === "multi"
        ? spec.ats.map((at) => `OnCalendar=${calendarLine(at)}`)
        : [`OnCalendar=${spec.calendar}`];
  return ["[Unit]", "Description=pi scheduled item", "", "[Timer]", ...lines, "Persistent=true", "", "[Install]", "WantedBy=timers.target", ""].join("\n");
}

export function renderService(script: string, dir: string, entryId: string, unitBase: string): string {
  return ["[Unit]", "Description=pi scheduled item", "", "[Service]", "Type=oneshot", `ExecStart=${script} ${dir} ${entryId} ${unitBase}`, ""].join("\n");
}

export const NOTIFY_SCRIPT = `#!/bin/bash
# pi scheduled notification payload. One-shot units self-clean; multi-up
# entries clean the sidecar only after the final firing.
set -u
DIR="$1"; ID="$2"; UNIT="$3"
SIDE="$DIR/$ID.json"
MSG=$(python3 -c "import json,sys; d=json.load(open('$SIDE')); print(d.get('message',''))")
TITLE=$(python3 -c "import json,sys; d=json.load(open('$SIDE')); print(d.get('title','pi alert'))")
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
notify-send -u normal -i appointment "$TITLE" "$MSG"
if python3 -c "import json,sys; sys.exit(0 if json.load(open('$SIDE'))['spec']['type']=='recurring' else 1)"; then exit 0; fi
systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user/$UNIT.timer" "$HOME/.config/systemd/user/$UNIT.service"
# sidecar goes only when all sibling units are gone
if ! ls "$HOME/.config/systemd/user/" | grep -q "^pi-notify-$ID"; then
  rm -f "$SIDE"
fi
systemctl --user daemon-reload >/dev/null 2>&1
`;

export const WAKE_SCRIPT = `#!/bin/bash
# pi scheduled session wake payload. One wake per session at a time; one-shot items self-clean.
set -u
DIR="$1"; ID="$2"; UNIT="$3"
SIDE="$DIR/$ID.json"
read -r SESSION PROMPT MODEL TIMEOUT < <(python3 -c "
import json, base64
d = json.load(open('$SIDE'))
print(d['session'], base64.b64encode(d['prompt'].encode()).decode(), d.get('model') or '', d.get('timeoutMinutes') or 30)")
PROMPT=$(echo "$PROMPT" | base64 -d)
LOCK="$DIR/wake-$SESSION.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) wake $ID skipped: session $SESSION busy" >> "$DIR/logs/$ID.log"
  exit 0
fi
mkdir -p "$DIR/logs"
ENV_PATH=$(echo "$PATH" | tr ':' '\\n' | grep -v 'node_modules/.bin' | paste -sd:)
OUT="$DIR/logs/$ID-$(date +%s).log"
echo "$(date -Is) wake $ID: resuming $SESSION" >> "$OUT"
if [ -n "$MODEL" ]; then MODEL_ARGS=(--model "$MODEL"); else MODEL_ARGS=(); fi
PATH="$ENV_PATH" timeout "$((TIMEOUT * 60))" /usr/bin/pi --session "$SESSION" --print "\${MODEL_ARGS[@]}" "$PROMPT" >> "$OUT" 2>&1
echo "$(date -Is) wake $ID: exit $?" >> "$OUT"
if python3 -c "import json,sys; sys.exit(0 if json.load(open('$SIDE'))['spec']['type']=='recurring' else 1)"; then exit 0; fi
systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user/$UNIT.timer" "$HOME/.config/systemd/user/$UNIT.service"
if ! ls "$HOME/.config/systemd/user/" | grep -q "^pi-wake-$ID"; then
  rm -f "$SIDE"
fi
systemctl --user daemon-reload >/dev/null 2>&1
`;

function ensurePayloadScripts(dir: string): { notifyScript: string; wakeScript: string } {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const notifyScript = path.join(binDir, "notify-run.sh");
  const wakeScript = path.join(binDir, "wake-run.sh");
  if (!existsSync(notifyScript) || readFileSync(notifyScript, "utf8") !== NOTIFY_SCRIPT) writeFileSync(notifyScript, NOTIFY_SCRIPT, { mode: 0o700 });
  if (!existsSync(wakeScript) || readFileSync(wakeScript, "utf8") !== WAKE_SCRIPT) writeFileSync(wakeScript, WAKE_SCRIPT, { mode: 0o700 });
  return { notifyScript, wakeScript };
}

export function validateEntry(entry: ScheduleEntry): void {
  if (entry.kind === "notification") {
    if (typeof entry.message !== "string" || !entry.message.trim()) throw new Error("message is required");
    if (entry.message.length > MAX_MESSAGE) throw new Error(`message must be <= ${MAX_MESSAGE} chars`);
    if (entry.title && entry.title.length > 120) throw new Error("title must be <= 120 chars");
  } else {
    if (typeof entry.session !== "string" || !/^[0-9a-zA-Z_-]{8,80}$/.test(entry.session)) throw new Error("session must be a session id");
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) throw new Error("prompt is required");
    if (entry.prompt.length > MAX_PROMPT) throw new Error(`prompt must be <= ${MAX_PROMPT} chars`);
    if (entry.timeoutMinutes !== undefined && (!Number.isInteger(entry.timeoutMinutes) || entry.timeoutMinutes < 1 || entry.timeoutMinutes > 240)) {
      throw new Error("timeoutMinutes must be 1–240");
    }
  }
}

export function schedule(entry: ScheduleEntry, exec: Exec): { id: string; units: string[] } {
  validateEntry(entry);
  if (entry.spec.type === "recurring") {
    // systemd itself is the authority on calendar grammar — don't hand-validate.
    try {
      exec("systemd-analyze", ["calendar", entry.spec.calendar]);
    } catch (error) {
      throw new Error(`invalid calendar spec "${entry.spec.calendar}": ${(error as Error).message.split("\n")[0]}`);
    }
  }
  const dir = scheduleDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scripts = ensurePayloadScripts(dir);
  const script = entry.kind === "notification" ? scripts.notifyScript : scripts.wakeScript;
  writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 1), { mode: 0o600 });

  const units: string[] = [];
  const specs: { suffix: string; spec: ScheduleSpec }[] =
    entry.spec.type === "multi" ? entry.spec.ats.map((at, i) => ({ suffix: `-${i + 1}`, spec: { type: "once", at } as ScheduleSpec })) : [{ suffix: "", spec: entry.spec }];
  for (const { suffix, spec } of specs) {
    const base = unitName(entry, suffix);
    writeFileSync(path.join(unitsDir(), `${base}.timer`), renderTimer(spec, `${base}.service`), { mode: 0o644 });
    writeFileSync(path.join(unitsDir(), `${base}.service`), renderService(script, dir, entry.id, base), { mode: 0o644 });
    units.push(base);
  }
  exec("systemctl", ["--user", "daemon-reload"]);
  for (const base of units) exec("systemctl", ["--user", "enable", "--now", "--quiet", `${base}.timer`]);
  return { id: entry.id, units };
}

export function listEntries(kind?: ScheduleKind): (ScheduleEntry & { unitCount: number })[] {
  const dir = scheduleDir();
  if (!existsSync(dir)) return [];
  const out: (ScheduleEntry & { unitCount: number })[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as ScheduleEntry;
      if (kind && entry.kind !== kind) continue;
      const base = unitName(entry);
      const unitCount = entry.spec.type === "multi" ? entry.spec.ats.length : 1;
      out.push({ ...entry, unitCount });
    } catch { /* skip unreadable sidecar */ }
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

export function cancel(id: string, exec: Exec): { removed: string[] } {
  if (!/^[nw]-[0-9a-f-]{4,12}$/.test(id)) throw new Error("id must look like n-xxxxxxxx or w-xxxxxxxx");
  const dir = scheduleDir();
  const sidecar = path.join(dir, `${id}.json`);
  if (!existsSync(sidecar)) throw new Error(`no scheduled item with id ${id}`);
  const kindPrefix = id.startsWith("n-") ? "pi-notify" : "pi-wake";
  const removed: string[] = [];
  for (const name of readdirSync(unitsDir())) {
    if (!name.startsWith(`${kindPrefix}-${id}`)) continue;
    if (!name.endsWith(".timer") && !name.endsWith(".service")) continue;
    const base = name.replace(/\.(timer|service)$/, "");
    if (name.endsWith(".timer")) {
      try { exec("systemctl", ["--user", "disable", "--now", "--quiet", `${base}.timer`]); } catch { /* already gone */ }
    }
    rmSync(path.join(unitsDir(), name), { force: true });
    if (!removed.includes(base)) removed.push(base);
  }
  rmSync(sidecar, { force: true });
  exec("systemctl", ["--user", "daemon-reload"]);
  return { removed };
}

/** Short fingerprint of entry content, for dedupe hints in tool output. */
export function entryHash(entry: ScheduleEntry): string {
  return createHash("sha256").update(JSON.stringify([entry.kind, entry.message, entry.session, entry.prompt, entry.spec])).digest("hex").slice(0, 8);
}
