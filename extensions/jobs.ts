import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runJobOperation } from "../src/jobs/bridge.ts";

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
    async execute(_id, p, _signal, _update, ctx) { return result(runJobOperation("launch", { ...p, cwd: p.cwd ?? ctx.sessionManager.getCwd() })); },
  });
  pi.registerTool({
    name: "job_list", label: "List Managed Jobs",
    description: "List owned jobs, including historical outcomes, optionally filtered by project/group.",
    parameters: Type.Object({ group: Type.Optional(Type.String()) }),
    async execute(_id, p) { return result(runJobOperation("list", p)); },
  });
  pi.registerTool({
    name: "job_status", label: "Managed Job Status",
    description: "Get an owned job's state, terminal event, exit status, error and log path; missing service evidence is interrupted, not success. Terminal events are not delivered as wakes.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) { return result(runJobOperation("status", p)); },
  });
  pi.registerTool({
    name: "job_stop", label: "Stop Managed Job",
    description: "Stop one owned job's systemd cgroup, retaining history. Systemd stop is name-based and can stop a replacement unit if another same-user process replaces it between verification and stop; do not use when such interference is possible. Use job_list to select a group and stop jobs individually.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) { return result(runJobOperation("stop", p)); },
  });
}
