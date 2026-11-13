import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jobStatus, launchJob, listJobs, stopJob } from "../src/jobs/core.ts";

function result(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: text.length > 12000 ? `${text.slice(0, 12000)}\n[Output truncated; use job_status for individual jobs or inspect the jobs registry.]` : text }], details: value };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "job_launch", label: "Launch Managed Job",
    description: "Launch an owned systemd user service. Supply a new UUID v4 as an idempotency key and reuse it for retries. Runs argv directly, without a shell; specify a shell explicitly if needed. Completion wakes are not supported. Never launch training without user approval.",
    parameters: Type.Object({
      id: Type.String({ description: "Caller-generated lowercase UUID v4; never reuse for different inputs." }),
      group: Type.String({ description: "Project/group label (letters, digits, dot, underscore, hyphen)." }),
      argv: Type.Array(Type.String(), { minItems: 1, maxItems: 256, description: "Executable and arguments; executable must be an absolute path." }),
      cwd: Type.Optional(Type.String({ description: "Absolute working directory; defaults to the current session cwd." })),
    }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) { return result(launchJob({ ...p, cwd: p.cwd ?? ctx.sessionManager.getCwd() })); },
  });
  pi.registerTool({
    name: "job_list", label: "List Managed Jobs",
    description: "List owned jobs, including historical outcomes, optionally filtered by project/group.",
    parameters: Type.Object({ group: Type.Optional(Type.String()) }),
    async execute(_id, p) { return result(listJobs(p.group)); },
  });
  pi.registerTool({
    name: "job_status", label: "Managed Job Status",
    description: "Get an owned job's state, terminal event, exit status, error and log path; missing service evidence is interrupted, not success. Terminal events are not delivered as wakes.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) { return result(jobStatus(p.id)); },
  });
  pi.registerTool({
    name: "job_stop", label: "Stop Managed Job",
    description: "Stop one owned job's entire systemd cgroup, retaining history. Use job_list to select a group and then stop its jobs by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) { return result(stopJob(p.id)); },
  });
}
