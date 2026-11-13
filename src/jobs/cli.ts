import { readFileSync } from "node:fs";
import { jobStatus, launchJob, listJobs, stopJob } from "./core.ts";
import type { JobInput } from "./core.ts";

type Request =
  | { operation: "launch"; input: JobInput }
  | { operation: "list"; input?: { group?: string } }
  | { operation: "status"; input: { id: string } }
  | { operation: "stop"; input: { id: string } };

function run(request: Request) {
  switch (request.operation) {
    case "launch": return launchJob(request.input);
    case "list": return listJobs(request.input?.group);
    case "status": return jobStatus(request.input?.id);
    case "stop": return stopJob(request.input?.id);
    default: throw new Error(`unknown jobs operation: ${request.operation}`);
  }
}

try {
  const request = JSON.parse(readFileSync(0, "utf8")) as Request;
  process.stdout.write(JSON.stringify(run(request)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
