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
  cwd?: string;
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

export function renderService(script: string, dir: string, entryId: string, unitBase: string, wakeUnitsDir?: string): string {
  // Systemd expands specifiers and environment variables even inside quotes.
  const quote = (arg: string) => {
    if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error("control characters are not allowed in unit arguments");
    return `"${arg.replace(/%/g, "%%").replace(/\$/g, "$$$$").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };
  const args = wakeUnitsDir === undefined
    ? `${script} ${dir} ${entryId} ${unitBase}`
    : `/bin/bash ${[script, dir, entryId, unitBase, wakeUnitsDir].map(quote).join(" ")}`;
  return ["[Unit]", "Description=pi scheduled item", "", "[Service]", "Type=oneshot", `ExecStart=${args}`, ""].join("\n");
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
# pi scheduled session wake payload. Existing units pass three arguments.
set -u
umask 077
DIR="$1"; ID="$2"; UNIT="$3"
UNITS_DIR="\${4:-$HOME/.config/systemd/user}"
SIDE="$DIR/$ID.json"
mkdir -p "$DIR/logs" || exit 1
OUT="$DIR/logs/$ID-$(date +%s).log"
FIELDS=$(mktemp "$DIR/.wake-fields.XXXXXXXX") || exit 1
trap 'rm -f "$FIELDS"' EXIT
# NUL framing preserves empty fields, whitespace and trailing newlines.
if ! python3 - "$SIDE" > "$FIELDS" <<'PYTHON'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    d = json.load(f)
session = d['session']
prompt = d['prompt']
model = d.get('model', '')
timeout = d.get('timeoutMinutes', 30)
cwd = d.get('cwd', '')
kind = d['spec']['type']
if (not isinstance(session, str) or not re.fullmatch(r'[0-9a-zA-Z_-]{8,80}', session)
    or not isinstance(prompt, str) or not prompt.strip() or prompt.startswith('@')
    or not isinstance(model, str) or not isinstance(cwd, str)
    or type(timeout) is not int or not 1 <= timeout <= 240
    or kind not in ('once', 'multi', 'recurring')
    or any('\\0' in s for s in (session, prompt, model, cwd))):
    raise ValueError('invalid wake payload')
for value in (session, prompt, model, str(timeout), cwd, kind):
    sys.stdout.buffer.write(value.encode('utf-8') + b'\\0')
PYTHON
then
  echo "$(date -Is) wake $ID: invalid payload" >> "$OUT"
  echo "$(date -Is) wake $ID: final status 1" >> "$OUT"
  exit 1
fi
mapfile -d '' -t FIELDS_ARRAY < "$FIELDS"
if [ "\${#FIELDS_ARRAY[@]}" -ne 6 ]; then exit 1; fi
SESSION="\${FIELDS_ARRAY[0]}"; PROMPT="\${FIELDS_ARRAY[1]}"; MODEL="\${FIELDS_ARRAY[2]}"
TIMEOUT="\${FIELDS_ARRAY[3]}"; CWD="\${FIELDS_ARRAY[4]}"; KIND="\${FIELDS_ARRAY[5]}"
rm -f "$FIELDS"
LOCK="$DIR/wake-$SESSION.lock"
exec 9>"$LOCK" || exit 1
STATUS=0
LOCK_STATUS=0
flock -n -E 75 9 || LOCK_STATUS=$?
if [ "$LOCK_STATUS" -eq 75 ]; then
  echo "$(date -Is) wake $ID skipped: session $SESSION busy" >> "$DIR/logs/$ID.log"
  STATUS=75
elif [ "$LOCK_STATUS" -ne 0 ]; then
  echo "$(date -Is) wake $ID: lock failed: $LOCK_STATUS" >> "$OUT"
  STATUS=$LOCK_STATUS
elif [ -n "$CWD" ] && ! cd -- "$CWD" 2>/dev/null; then
  echo "$(date -Is) wake $ID: cannot enter saved cwd" >> "$OUT"
  STATUS=1
else
  ENV_PATH=$(echo "$PATH" | tr ':' '\\n' | grep -v 'node_modules/.bin' | paste -sd:)
  echo "$(date -Is) wake $ID: resuming $SESSION" >> "$OUT"
  if [ -n "$MODEL" ]; then MODEL_ARGS=(--model "$MODEL"); else MODEL_ARGS=(); fi
  # Keep the timeout process group alive until escalation even if Pi exits on TERM.
  PATH="$ENV_PATH" timeout --kill-after=2s "$((TIMEOUT * 60))" /bin/bash -c 'trap "while :; do sleep 1; done" TERM; "$@" & wait "$!"' wake /usr/bin/pi --session "$SESSION" --print "\${MODEL_ARGS[@]}" -- "$PROMPT" >> "$OUT" 2>&1 || STATUS=$?
  echo "$(date -Is) wake $ID: execution exit $STATUS" >> "$OUT"
fi
cleanup_failed() {
  local operation="$1" code="$2"
  echo "$(date -Is) wake $ID: cleanup $operation failed (exit $code); inspect unit and registry permissions and systemd user manager" >> "$OUT"
  [ "$STATUS" -ne 0 ] || STATUS=1
}
if [ "$KIND" != recurring ]; then
  systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1 || cleanup_failed 'systemctl disable' "$?"
  rm -f "$UNITS_DIR/$UNIT.timer" "$UNITS_DIR/$UNIT.service" 2>/dev/null || cleanup_failed 'remove unit files' "$?"
  # Only remove the registry entry after every sibling unit has gone.
  shopt -s nullglob
  siblings=("$UNITS_DIR/pi-wake-$ID"-[0-9]*.timer "$UNITS_DIR/pi-wake-$ID"-[0-9]*.service)
  if [ ! -e "$UNITS_DIR/pi-wake-$ID.timer" ] && [ ! -e "$UNITS_DIR/pi-wake-$ID.service" ] && [ "\${#siblings[@]}" -eq 0 ]; then
    rm -f "$SIDE" 2>/dev/null || cleanup_failed 'remove sidecar' "$?"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || cleanup_failed 'systemctl daemon-reload' "$?"
fi
echo "$(date -Is) wake $ID: final status $STATUS" >> "$OUT"
exit "$STATUS"
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
    if (!/^w-[0-9a-f-]{4,12}$/.test(entry.id)) throw new Error("invalid wake id");
    if (typeof entry.session !== "string" || !/^[0-9a-zA-Z_-]{8,80}$/.test(entry.session)) throw new Error("session must be a session id");
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) throw new Error("prompt is required");
    if (entry.prompt.length > MAX_PROMPT) throw new Error(`prompt must be <= ${MAX_PROMPT} chars`);
    if (entry.prompt.startsWith("@")) throw new Error("prompt cannot start with @ (Pi treats it as a file argument)");
    for (const value of [entry.prompt, entry.model, entry.cwd]) {
      if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) throw new Error("wake fields must be strings without NUL characters");
    }
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
  const dir = path.resolve(scheduleDir());
  const unitDir = path.resolve(unitsDir());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scripts = ensurePayloadScripts(dir);
  const script = entry.kind === "notification" ? scripts.notifyScript : scripts.wakeScript;
  writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 1), { mode: 0o600 });

  const units: string[] = [];
  const specs: { suffix: string; spec: ScheduleSpec }[] =
    entry.spec.type === "multi" ? entry.spec.ats.map((at, i) => ({ suffix: `-${i + 1}`, spec: { type: "once", at } as ScheduleSpec })) : [{ suffix: "", spec: entry.spec }];
  for (const { suffix, spec } of specs) {
    const base = unitName(entry, suffix);
    writeFileSync(path.join(unitDir, `${base}.timer`), renderTimer(spec, `${base}.service`), { mode: 0o644 });
    writeFileSync(path.join(unitDir, `${base}.service`), renderService(script, dir, entry.id, base, entry.kind === "wake" ? unitDir : undefined), { mode: 0o644 });
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
