import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildSpec, newId, schedule, type ScheduleEntry } from "../src/schedule/core.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wake-test-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const dir = path.join(root, "schedule ' space");
  const units = path.join(root, "custom units");
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "project with spaces");
  await Promise.all([home, units, bin, cwd].map((p) => fs.mkdir(p, { recursive: true })));
  process.env.PI_SCHEDULE_DIR = dir;
  process.env.PI_SCHEDULE_UNITS_DIR = units;
  await fs.writeFile(path.join(bin, "timeout"), `#!/bin/bash\nwhile [[ "$1" = --* ]]; do shift; done\nprintf '%s' "$1" > "$TEST_ROOT/timeout"\nshift\nargs=("$@"); for i in "\${!args[@]}"; do [ "\${args[$i]}" != /usr/bin/pi ] || args[$i]="$TEST_ROOT/bin/pi"; done\n[ "\${TIMEOUT_STATUS:-0}" = 0 ] || exit "$TIMEOUT_STATUS"\nexec "\${args[@]}"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "pi"), `#!/usr/bin/python3\nimport json, os, sys\nwith open(os.path.join(os.environ['TEST_ROOT'], 'pi.json'), 'w') as f: json.dump({'cwd': os.getcwd(), 'args': sys.argv[1:]}, f)\nwith open(os.path.join(os.environ['TEST_ROOT'], 'pi-path'), 'w') as f: f.write(os.environ['PATH'])\nprint('pi output ' + 'x' * 100000)\nsys.exit(int(os.environ.get('PI_STATUS', '0')))\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "systemctl"), "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$TEST_ROOT/systemctl\"\nexit \"${SYSTEMCTL_STATUS:-0}\"\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "flock"), "#!/bin/bash\nexit \"${FLOCK_STATUS:-0}\"\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "notify-send"), "#!/bin/bash\nexit 91\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${root}/node_modules/.bin:/usr/bin:/bin`, TEST_ROOT: root };
  return { root, home, dir, units, cwd, env };
}

test("a wake without a model resumes its session in the scheduled cwd with the exact prompt", async () => {
  const t = await setup();
  const prompt = "  check staging\nnext line  \n";
  const entry: ScheduleEntry = { id: newId("wake"), kind: "wake", spec: buildSpec({ when: "1h" }), created: "", session: "01a1b2eb-9c91-76fd-81ca-d7abdddb9e38", prompt, cwd: t.cwd };
  const result = schedule(entry, () => "");
  const service = await fs.readFile(path.join(t.units, result.units[0] + ".service"), "utf8");
  assert.ok(service.includes(`"${t.dir}/bin/wake-run.sh" "${t.dir}" "${entry.id}" "${result.units[0]}" "${t.units}"`));
  const verify = spawnSync("systemd-analyze", ["verify", path.join(t.units, result.units[0] + ".service")], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  // Parse the generated ExecStart arguments, then execute that payload with external boundaries stubbed.
  const parsed = spawnSync("python3", ["-c", "import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))", service.split("ExecStart=")[1].trim()], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const [program, ...args] = JSON.parse(parsed.stdout) as string[];
  const run = spawnSync(program, args, { cwd: t.home, env: t.env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const call = JSON.parse(await fs.readFile(path.join(t.root, "pi.json"), "utf8"));
  assert.deepEqual(call, { cwd: t.cwd, args: ["--session", entry.session, "--print", "--", prompt] });
  assert.equal(await fs.readFile(path.join(t.root, "timeout"), "utf8"), "1800");
});

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}

function runWake(t: Awaited<ReturnType<typeof setup>>, entry: ScheduleEntry, unit: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", [path.join(t.dir, "bin/wake-run.sh"), t.dir, entry.id, unit, t.units], {
    cwd: t.home, env: { ...t.env, ...env }, encoding: "utf8",
  });
}

function wake(t: Awaited<ReturnType<typeof setup>>, spec = buildSpec({ recurring: "daily" })): ScheduleEntry {
  return { id: newId("wake"), kind: "wake", spec, created: "", session: "01234567-abcd", prompt: "--check $HOME; $(touch nope)\n", cwd: t.cwd };
}

test("recurring wakes preserve the model, timeout and complete output", async () => {
  const t = await setup();
  const entry = { ...wake(t), model: "vendor/model with space;$(bad)", timeoutMinutes: 7 };
  const { units } = schedule(entry, () => "");
  const run = runWake(t, entry, units[0]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(t.root, "pi.json"), "utf8")), {
    cwd: t.cwd, args: ["--session", entry.session, "--print", "--model", entry.model, "--", entry.prompt],
  });
  assert.equal(await fs.readFile(path.join(t.root, "timeout"), "utf8"), "420");
  assert.ok(!(await fs.readFile(path.join(t.root, "pi-path"), "utf8")).includes("node_modules/.bin"));
  const logs = await fs.readdir(path.join(t.dir, "logs"));
  const output = await fs.readFile(path.join(t.dir, "logs", logs[0]), "utf8");
  assert.ok(output.includes("pi output " + "x".repeat(100000)));
  assert.ok(await exists(path.join(t.dir, entry.id + ".json")));
  assert.ok(await exists(path.join(t.units, units[0] + ".timer")));
  assert.equal(await exists(path.join(t.cwd, "nope")), false);
});

test("one-shot and multi wakes clean up their own units after nonzero exit", async () => {
  const t = await setup();
  const entry = wake(t, buildSpec({ times: ["1h", "2h"] }));
  const { units } = schedule(entry, () => "");
  assert.equal(runWake(t, entry, units[0], { PI_STATUS: "42" }).status, 42);
  assert.equal(await exists(path.join(t.units, units[0] + ".timer")), false);
  assert.ok(await exists(path.join(t.dir, entry.id + ".json")));
  assert.ok(await exists(path.join(t.units, units[1] + ".timer")));
  const logs = await fs.readdir(path.join(t.dir, "logs"));
  assert.match(await fs.readFile(path.join(t.dir, "logs", logs[0]), "utf8"), /exit 42/);
  assert.equal(runWake(t, entry, units[1], { TIMEOUT_STATUS: "124" }).status, 124);
  assert.equal(await exists(path.join(t.dir, entry.id + ".json")), false);
  assert.equal(await exists(path.join(t.units, units[1] + ".service")), false);
});

test("a busy one-shot is logged, fails and is consumed rather than silently reported as delivered", async () => {
  const t = await setup();
  const entry = wake(t, buildSpec({ when: "1h" }));
  const { units } = schedule(entry, () => "");
  assert.equal(runWake(t, entry, units[0], { FLOCK_STATUS: "75" }).status, 75);
  assert.match(await fs.readFile(path.join(t.dir, "logs", entry.id + ".log"), "utf8"), /busy/);
  assert.equal(await exists(path.join(t.root, "pi.json")), false);
  assert.equal(await exists(path.join(t.dir, entry.id + ".json")), false);
  assert.equal(await exists(path.join(t.units, units[0] + ".timer")), false);
});

test("a missing cwd fails rather than resuming in a different project", async () => {
  const t = await setup();
  const entry = { ...wake(t), cwd: path.join(t.root, "missing") };
  const { units } = schedule(entry, () => "");
  assert.notEqual(runWake(t, entry, units[0]).status, 0);
  assert.equal(await exists(path.join(t.root, "pi.json")), false);
  assert.ok(await exists(path.join(t.dir, entry.id + ".json")));
});

test("legacy three-argument units still clean up in the default user units directory", async () => {
  const t = await setup();
  const entry = wake(t, buildSpec({ when: "1h" }));
  const { units } = schedule(entry, () => "");
  const oldUnits = path.join(t.home, ".config/systemd/user");
  await fs.mkdir(oldUnits, { recursive: true });
  for (const ext of ["timer", "service"]) await fs.rename(path.join(t.units, units[0] + "." + ext), path.join(oldUnits, units[0] + "." + ext));
  const run = spawnSync("/bin/bash", [path.join(t.dir, "bin/wake-run.sh"), t.dir, entry.id, units[0]], { cwd: t.home, env: t.env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await exists(path.join(oldUnits, units[0] + ".timer")), false);
  assert.equal(await exists(path.join(t.dir, entry.id + ".json")), false);
});

test("a recurring failure returns the exit status and leaves the schedule in place", async () => {
  const t = await setup();
  const entry = wake(t);
  const { units } = schedule(entry, () => "");
  assert.equal(runWake(t, entry, units[0], { PI_STATUS: "23" }).status, 23);
  assert.ok(await exists(path.join(t.units, units[0] + ".timer")));
  assert.ok(await exists(path.join(t.dir, entry.id + ".json")));
  assert.equal(await exists(path.join(t.root, "systemctl")), false);
});

test("wake input rejects argument and registry path ambiguity", async () => {
  const t = await setup();
  const entry = wake(t);
  assert.throws(() => schedule({ ...entry, prompt: "@secrets" }, () => ""), /cannot start with @/);
  assert.throws(() => schedule({ ...entry, prompt: "bad\0prompt" }, () => ""), /NUL/);
  assert.throws(() => schedule({ ...entry, id: "w-../../bad" }, () => ""), /invalid wake id/);
});

test("wake units escape systemd specifiers and environment variables in paths", async () => {
  const t = await setup();
  process.env.PI_SCHEDULE_DIR = path.join(t.root, "schedule %n $HOME");
  process.env.PI_SCHEDULE_UNITS_DIR = path.join(t.root, "units %n $HOME");
  await fs.mkdir(process.env.PI_SCHEDULE_UNITS_DIR, { recursive: true });
  const entry = wake(t);
  const { units } = schedule(entry, () => "");
  const file = path.join(process.env.PI_SCHEDULE_UNITS_DIR, units[0] + ".service");
  const service = await fs.readFile(file, "utf8");
  assert.ok(service.includes('schedule %%n $$HOME'));
  const verify = spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
});

test("a timed out wake stops TERM-resistant Pi and its child", async () => {
  const t = await setup();
  // Keep GNU timeout, its process-group signaling and flock real; accelerate the minute boundary.
  await fs.rm(path.join(t.root, "bin/flock"));
  await fs.writeFile(path.join(t.root, "bin/timeout"), `#!/bin/bash
printf '%s' "$$" > "$TEST_ROOT/timeout-pid"
args=()
while [[ "$1" = --* ]]; do args+=("$1"); shift; done
shift # duration
cmd=("$@"); for i in "\${!cmd[@]}"; do [ "\${cmd[$i]}" != /usr/bin/pi ] || cmd[$i]="$TEST_ROOT/bin/pi"; done
exec /usr/bin/timeout "\${args[@]}" 0.5 "\${cmd[@]}"
`, { mode: 0o755 });
  await fs.writeFile(path.join(t.root, "bin/pi"), `#!/bin/bash
trap '' TERM
printf '%s' "$$" > "$TEST_ROOT/parent-pid"
/bin/bash -c 'trap "" TERM; echo $$ > "$TEST_ROOT/child-pid"; while :; do sleep 1; done' &
wait
`, { mode: 0o755 });
  const entry = { ...wake(t, buildSpec({ when: "1h" })), timeoutMinutes: 1 };
  const { units } = schedule(entry, () => "");
  try {
    const started = Date.now();
    const run = spawnSync("/bin/bash", [path.join(t.dir, "bin/wake-run.sh"), t.dir, entry.id, units[0], t.units], {
      cwd: t.home, env: t.env, encoding: "utf8", timeout: 6000,
    });
    assert.equal(run.error, undefined, `wake did not finish: ${run.error}`);
    assert.ok(Date.now() - started < 5500);
    assert.notEqual(run.status, 0);
    for (const name of ["parent-pid", "child-pid"]) {
      const pid = Number(await fs.readFile(path.join(t.root, name), "utf8"));
      let stat = "";
      try { stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); } catch { /* gone */ }
      assert.ok(!stat || /\) Z /.test(stat), `${name} ${pid} is still running`);
    }
    assert.equal(await exists(path.join(t.dir, entry.id + ".json")), false);
    const lock = spawnSync("/usr/bin/flock", ["-n", path.join(t.dir, `wake-${entry.session}.lock`), "true"]);
    assert.equal(lock.status, 0, "session lock was not released");
  } finally {
    // Also clean up if the implementation never escalates.
    try { process.kill(-Number(await fs.readFile(path.join(t.root, "timeout-pid"), "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
});

test("a timed out wake stops a TERM-resistant child even if Pi exits on TERM", async () => {
  const t = await setup();
  await fs.writeFile(path.join(t.root, "bin/timeout"), `#!/bin/bash
printf '%s' "$$" > "$TEST_ROOT/timeout-pid"
args=(); while [[ "$1" = --* ]]; do args+=("$1"); shift; done
shift
cmd=("$@"); for i in "\${!cmd[@]}"; do [ "\${cmd[$i]}" != /usr/bin/pi ] || cmd[$i]="$TEST_ROOT/bin/pi"; done
exec /usr/bin/timeout "\${args[@]}" 0.5 "\${cmd[@]}"
`, { mode: 0o755 });
  await fs.writeFile(path.join(t.root, "bin/pi"), `#!/bin/bash
/bin/bash -c 'trap "" TERM; echo $$ > "$TEST_ROOT/child-pid"; while :; do sleep 1; done' &
wait
`, { mode: 0o755 });
  const entry = { ...wake(t), timeoutMinutes: 1 };
  const { units } = schedule(entry, () => "");
  try {
    const run = spawnSync("/bin/bash", [path.join(t.dir, "bin/wake-run.sh"), t.dir, entry.id, units[0], t.units], {
      cwd: t.home, env: t.env, encoding: "utf8", timeout: 6000,
    });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0);
    const pid = Number(await fs.readFile(path.join(t.root, "child-pid"), "utf8"));
    let stat = "";
    try { stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); } catch { /* gone */ }
    assert.ok(!stat || /\) Z /.test(stat), `child ${pid} is still running`);
  } finally {
    try { process.kill(-Number(await fs.readFile(path.join(t.root, "timeout-pid"), "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
});

test("cleanup failure logs the failed operations and final service status without diagnostics", async () => {
  const t = await setup();
  await fs.writeFile(path.join(t.root, "bin/systemctl"), `#!/bin/bash
echo 'sensitive diagnostic: SECRET' >&2
if [ "$2" = disable ]; then exit 4; fi
if [ "$2" = daemon-reload ]; then exit 6; fi
exit 0
`, { mode: 0o755 });
  const entry = { ...wake(t, buildSpec({ when: "1h" })), prompt: "SECRET prompt" };
  const { units } = schedule(entry, () => "");
  const run = runWake(t, entry, units[0]);
  assert.equal(run.status, 1);
  assert.ok(await exists(path.join(t.root, "pi.json")));
  const logs = await fs.readdir(path.join(t.dir, "logs"));
  const output = await fs.readFile(path.join(t.dir, "logs", logs[0]), "utf8");
  assert.match(output, /cleanup.*disable.*4/i);
  assert.match(output, /cleanup.*daemon-reload.*6/i);
  assert.match(output, /final.*(?:status|exit).*1/i);
  assert.doesNotMatch(output, /SECRET/);
});

test("cleanup file failures retain the execution status and identify the operation", async () => {
  const t = await setup();
  await fs.writeFile(path.join(t.root, "bin/rm"), `#!/bin/bash
case "$*" in *.timer*) echo 'SECRET' >&2; exit 13;; esac
exec /bin/rm "$@"
`, { mode: 0o755 });
  const entry = wake(t, buildSpec({ when: "1h" }));
  const { units } = schedule(entry, () => "");
  assert.equal(runWake(t, entry, units[0], { PI_STATUS: "42" }).status, 42);
  const logs = await fs.readdir(path.join(t.dir, "logs"));
  const output = await fs.readFile(path.join(t.dir, "logs", logs[0]), "utf8");
  assert.match(output, /cleanup remove unit files failed \(exit 13\)/);
  assert.match(output, /final status 42/);
  assert.doesNotMatch(output, /SECRET/);
  assert.ok(await exists(path.join(t.dir, entry.id + ".json")));
});

test("absent or empty optional string fields preserve legacy defaults", async () => {
  const t = await setup();
  for (const fields of [{}, { cwd: "", model: "" }]) {
    const entry: ScheduleEntry = { ...wake(t), cwd: undefined, ...fields };
    const { units } = schedule(entry, () => "");
    assert.equal(runWake(t, entry, units[0]).status, 0);
    const call = JSON.parse(await fs.readFile(path.join(t.root, "pi.json"), "utf8"));
    assert.equal(call.cwd, t.home);
    assert.deepEqual(call.args, ["--session", entry.session, "--print", "--", entry.prompt]);
    assert.equal(await fs.readFile(path.join(t.root, "timeout"), "utf8"), "1800");
  }
});

test("falsey invalid sidecar fields fail without running Pi or cleaning the one-shot", async () => {
  const t = await setup();
  for (const [field, value] of [["cwd", false], ["cwd", []], ["cwd", null], ["model", false], ["model", null], ["timeoutMinutes", 0], ["timeoutMinutes", false], ["timeoutMinutes", null]] as const) {
    const entry = wake(t, buildSpec({ when: "1h" }));
    const { units } = schedule(entry, () => "");
    const side = path.join(t.dir, entry.id + ".json");
    await fs.writeFile(side, JSON.stringify({ ...entry, [field]: value }));
    assert.notEqual(runWake(t, entry, units[0]).status, 0, `${field}: ${JSON.stringify(value)}`);
    assert.equal(await exists(path.join(t.root, "pi.json")), false);
    assert.ok(await exists(side));
    assert.ok(await exists(path.join(t.units, units[0] + ".timer")));
  }
});

test("a lock command failure is not reported as a busy session", async () => {
  const t = await setup();
  const entry = wake(t);
  const { units } = schedule(entry, () => "");
  assert.equal(runWake(t, entry, units[0], { FLOCK_STATUS: "2" }).status, 2);
  const logs = await fs.readdir(path.join(t.dir, "logs"));
  const output = await fs.readFile(path.join(t.dir, "logs", logs[0]), "utf8");
  assert.match(output, /lock.*2/);
  assert.doesNotMatch(output, /busy/);
  assert.equal(await exists(path.join(t.root, "pi.json")), false);
});
