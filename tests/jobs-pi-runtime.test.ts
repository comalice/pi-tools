import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const extension = fileURLToPath(new URL("../extensions/jobs.ts", import.meta.url));
const piAvailable = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;

test("jobs extension and Node bridge work in Pi's runtime", { skip: !piAvailable }, () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-runtime-"));
  const bridge = fileURLToPath(new URL("../src/jobs/bridge.ts", import.meta.url));
  const probe = path.join(configDir, "probe.ts");
  const resultPath = path.join(configDir, "jobs.json");
  writeFileSync(probe, `
    import { writeFileSync } from "node:fs";
    import { runJobOperation } from ${JSON.stringify(bridge)};
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(runJobOperation("list")));
    export default function () {}
  `);
  try {
    const result = spawnSync("pi", [
      "--no-session", "--no-extensions", "--extension", extension, "--extension", probe,
      "--provider", "__missing_test_provider__", "--model", "unavailable", "-p", "test",
    ], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_JOBS_DIR: path.join(configDir, "jobs") },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, result.error?.message);
    assert.match(output, /Unknown provider "__missing_test_provider__"/);
    assert.doesNotMatch(output, /Failed to load extension.*node:sqlite/s);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), []);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
