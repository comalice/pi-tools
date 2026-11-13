import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type JobOperation = "launch" | "list" | "status" | "stop";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

export function runJobOperation<T = unknown>(operation: JobOperation, input?: unknown): T {
  try {
    const output = execFileSync("node", ["--experimental-strip-types", cli], {
      input: JSON.stringify({ operation, input }),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output) as T;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const message = stderr?.toString().trim();
    if (message) throw new Error(message);
    throw error;
  }
}
