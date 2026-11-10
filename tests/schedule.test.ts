import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildSpec, cancel, listEntries, newId, parseRecurring, parseWhen, renderService, renderTimer, schedule, unitName, type Exec, type ScheduleEntry } from "../src/schedule/core.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmpEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sched-"));
  dirs.push(dir);
  process.env.PI_SCHEDULE_DIR = path.join(dir, "schedule");
  process.env.PI_SCHEDULE_UNITS_DIR = path.join(dir, "units");
  await fs.mkdir(path.join(dir, "units"), { recursive: true });
  return dir;
}

function fakeExec(log: string[][]): Exec {
  return (cmd, args) => {
    log.push([cmd, ...args]);
    return "";
  };
}

describe("parseWhen", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("parses relative times", () => {
    assert.equal(parseWhen("30m", now).toISOString(), "2026-11-10T12:30:00.000Z");
    assert.equal(parseWhen("2h", now).toISOString(), "2026-11-10T14:00:00.000Z");
    assert.equal(parseWhen("1d", now).toISOString(), "2026-11-11T12:00:00.000Z");
  });
  it("parses ISO datetimes", () => {
    assert.equal(parseWhen("2026-11-10T13:00:00Z", now).toISOString(), "2026-11-10T13:00:00.000Z");
  });
  it("rejects past, garbage, and far-future", () => {
    assert.throws(() => parseWhen("2020-01-01", now), /past/);
    assert.throws(() => parseWhen("tomorrow-ish", now), /unparseable/);
    assert.throws(() => parseWhen("400d", now), /more than a year/);
  });
});

describe("parseRecurring", () => {
  it("accepts simple names, HH:MM, and OnCalendar specs", () => {
    assert.equal(parseRecurring("daily"), "daily");
    assert.equal(parseRecurring("9:30"), "*-*-* 09:30:00");
    assert.equal(parseRecurring("Mon..Fri 09:30"), "Mon..Fri 09:30");
  });
  it("rejects junk", () => {
    assert.throws(() => parseRecurring("daily; rm -rf /"), /unparseable/);
  });
  it("rejects invalid calendar specs via systemd-analyze", async () => {
    await tmpEnv();
    const failing: Exec = () => { throw new Error("Failed to parse calendar: every day pls"); };
    const entry: ScheduleEntry = { id: newId("notification"), kind: "notification", spec: buildSpec({ recurring: "*-*-* 09:30" }), created: "", message: "x" };
    entry.spec = { type: "recurring", calendar: "every day pls" };
    assert.throws(() => schedule(entry, failing), /invalid calendar spec/);
  });
});

describe("buildSpec", () => {
  it("requires exactly one scheduling field", () => {
    assert.throws(() => buildSpec({}), /exactly one/);
    assert.throws(() => buildSpec({ when: "1h", recurring: "daily" }), /exactly one/);
  });
  it("sorts multi times and caps the count", () => {
    const spec = buildSpec({ times: ["2h", "30m"] });
    assert.equal(spec.type, "multi");
    if (spec.type === "multi") assert.ok(spec.ats[0] < spec.ats[1]);
    assert.throws(() => buildSpec({ times: ["1h"] }), /2–8/);
  });
});

describe("unit rendering", () => {
  it("renders a persistent one-shot timer (local time)", () => {
    const timer = renderTimer({ type: "once", at: new Date(2030, 0, 2, 3, 4, 5) }, "pi-notify-n-x.service");
    assert.match(timer, /OnCalendar=2030-01-02 03:04:00/);
    assert.match(timer, /Persistent=true/);
  });
  it("renders a service invoking the payload with dir, id, and unit base", () => {
    const svc = renderService("/x/notify-run.sh", "/sched", "n-abcd1234", "pi-notify-n-abcd1234");
    assert.match(svc, /ExecStart=\/x\/notify-run\.sh \/sched n-abcd1234 pi-notify-n-abcd1234/);
  });
  it("renders recurring calendars", () => {
    const spec = buildSpec({ recurring: "daily" });
    assert.match(renderTimer(spec, "s.service"), /OnCalendar=daily/);
  });
});

describe("schedule/list/cancel round-trip", () => {
  it("creates units + sidecar, lists, cancels", async () => {
    const dir = await tmpEnv();
    const units = path.join(os.homedir(), ".config", "systemd", "user");
    void units; // real home used for units; tests assert via exec log + sidecar only
    const log: string[][] = [];
    const entry: ScheduleEntry = {
      id: newId("notification"),
      kind: "notification",
      spec: buildSpec({ when: "2h" }),
      created: new Date().toISOString(),
      message: "hello",
    };
    const result = schedule(entry, fakeExec(log));
    assert.equal(result.units.length, 1);
    assert.ok(log.some((l) => l.join(" ").includes("daemon-reload")));
    assert.ok(log.some((l) => l.join(" ").includes(`enable --now --quiet ${result.units[0]}.timer`)));
    const listed = listEntries("notification");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].message, "hello");
    const removed = cancel(entry.id, fakeExec(log));
    assert.equal(removed.removed.length, 1);
    assert.equal(listEntries().length, 0);
  });

  it("multi creates one unit pair per time", async () => {
    await tmpEnv();
    const log: string[][] = [];
    const entry: ScheduleEntry = {
      id: newId("wake"),
      kind: "wake",
      spec: buildSpec({ times: ["1h", "2h", "3h"] }),
      created: new Date().toISOString(),
      session: "01a1b2eb-9c91-76fd-81ca-d7abdddb9e38",
      prompt: "check staging",
    };
    const result = schedule(entry, fakeExec(log));
    assert.equal(result.units.length, 3);
    assert.match(result.units[0], /-1$/);
    assert.match(result.units[2], /-3$/);
  });
});

describe("validation", () => {
  it("rejects oversized messages and bad session ids", async () => {
    await tmpEnv();
    const log: string[][] = [];
    assert.throws(() =>
      schedule({ id: newId("notification"), kind: "notification", spec: buildSpec({ when: "1h" }), created: "", message: "x".repeat(501) }, fakeExec(log)), /<= 500/);
    assert.throws(() =>
      schedule({ id: newId("wake"), kind: "wake", spec: buildSpec({ when: "1h" }), created: "", session: "bad id!", prompt: "x" }, fakeExec(log)), /session id/);
  });
});

describe("cancel", () => {
  it("rejects unknown ids and bad formats", async () => {
    await tmpEnv();
    const log: string[][] = [];
    assert.throws(() => cancel("n-00000000", fakeExec(log)), /no scheduled item/);
    assert.throws(() => cancel("bogus", fakeExec(log)), /must look like/);
  });
});
