import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type JobOperation = "launch" | "list" | "status" | "stop";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
let pathNode: string | undefined;

function findNode(): string {
  // An explicit override wins and is validated by the call itself, so callers
  // can recover from a bad PATH without a restart.
  if (process.env.PI_JOBS_NODE) return process.env.PI_JOBS_NODE;
  if (pathNode) return pathNode;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    const probe = spawnSync(candidate, ["--experimental-strip-types", "-e", ""], { stdio: "ignore", timeout: 5000 });
    if (!probe.error && probe.status === 0) { pathNode = candidate; return candidate; }
  }
  throw new Error("no compatible Node executable on PATH (needs --experimental-strip-types support); set PI_JOBS_NODE to one");
}

export function runJobOperation<T = unknown>(operation: JobOperation, input?: unknown): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-jobs-io-"));
  const resultPath = path.join(dir, "result.json");
  try {
    // The result rides a private temp file, not stdout: no buffer cap, and a
    // wrapper-script banner or stray diagnostic cannot corrupt the payload.
    const child = spawnSync(findNode(), ["--experimental-strip-types", cli, resultPath], {
      input: JSON.stringify({ operation, input }),
      timeout: 120_000,
      // stdout ignored on purpose; stderr carries the error message. Scrub
      // NODE_OPTIONS so --require hooks cannot print or inject into the child.
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      const stderr = child.stderr?.toString().trim();
      throw new Error(stderr || `jobs CLI exited ${child.status}`);
    }
    return JSON.parse(readFileSync(resultPath, "utf8")) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
