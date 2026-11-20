import { readFileSync, writeFileSync } from "node:fs";
import { jobStatus, launchJob, listJobs, stopJob } from "./core.ts";
import type { JobInput } from "./core.ts";
import {
  approvePipeline,
  cancelPipeline,
  launchPipeline,
  listPipelines,
  pipelineStatus,
  type PipelineInput,
} from "./pipeline.ts";

type Request =
  | { operation: "launch"; input: JobInput }
  | { operation: "list"; input?: { group?: string; ownerSession?: string; allSessions?: boolean } }
  | { operation: "status"; input: { id: string } }
  | { operation: "stop"; input: { id: string; ownerSession?: string; allSessions?: boolean } }
  | { operation: "pipeline_launch"; input: PipelineInput }
  | { operation: "pipeline_list"; input?: { group?: string; ownerSession?: string; allSessions?: boolean } }
  | { operation: "pipeline_status"; input: { id: string; ownerSession?: string; allSessions?: boolean } }
  | { operation: "pipeline_approve"; input: { id: string; ownerSession?: string; allSessions?: boolean } }
  | { operation: "pipeline_cancel"; input: { id: string; ownerSession?: string; allSessions?: boolean } };

function run(request: Request) {
  switch (request.operation) {
    case "launch": return launchJob(request.input);
    case "list": return listJobs(request.input?.group, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    case "status": return jobStatus(request.input?.id);
    case "stop": return stopJob(request.input?.id, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    case "pipeline_launch": return launchPipeline(request.input);
    case "pipeline_list": return listPipelines(request.input?.group, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    case "pipeline_status": return pipelineStatus(request.input?.id, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    case "pipeline_approve": return approvePipeline(request.input?.id, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    case "pipeline_cancel": return cancelPipeline(request.input?.id, {
      ownerSession: request.input?.ownerSession,
      allSessions: request.input?.allSessions,
    });
    default: throw new Error(`unknown jobs operation: ${(request as Request).operation}`);
  }
}

const resultPath = process.argv[2];
if (!resultPath) {
  console.error("usage: cli.ts <result-path> (request JSON on stdin)");
  process.exit(2);
}

try {
  const request = JSON.parse(readFileSync(0, "utf8")) as Request;
  writeFileSync(resultPath, JSON.stringify(run(request)), { mode: 0o600 });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
