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
    description: "Launch an owned systemd user service. Supply a new UUID v4 as an idempotency key and reuse it for retries. Runs argv directly, without a shell; specify a shell explicitly if needed. Optionally supply wake for durable at-least-once completion delivery via pi-jobs-controller. Never launch training without user approval.",
    parameters: Type.Object({
      id: Type.String({ description: "Caller-generated lowercase UUID v4; never reuse for different inputs." }),
      group: Type.String({ description: "Project/group label (letters, digits, dot, underscore, hyphen)." }),
      argv: Type.Array(Type.String(), { minItems: 1, maxItems: 256, description: "Executable and arguments; executable must be an absolute path." }),
      cwd: Type.Optional(Type.String({ description: "Absolute working directory; defaults to the current session cwd." })),
      wake: Type.Optional(Type.Object({
        session: Type.Optional(Type.String({ description: "Session id to wake on terminal state (default: current session)." })),
        prompt: Type.String({ minLength: 1, maxLength: 4000, description: "Idempotent wake prompt delivered when the job reaches a terminal state." }),
        maxRetries: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum wake delivery attempts before dead-letter + desktop notification (default 5)." })),
        model: Type.Optional(Type.String({ description: "Optional model override for the wake run." })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      const wake = p.wake
        ? { ...p.wake, session: p.wake.session ?? ownerSession }
        : undefined;
      return result(runJobOperation("launch", {
        ...p,
        cwd: p.cwd ?? ctx.sessionManager.getCwd(),
        ...(ownerSession ? { ownerSession } : {}),
        ...(wake ? { wake } : {}),
      }));
    },
  });
  pi.registerTool({
    name: "job_list", label: "List Managed Jobs",
    description: "List owned jobs, including historical outcomes and delivery state. Scoped to the current session by default; set allSessions true to view jobs from other sessions.",
    parameters: Type.Object({
      group: Type.Optional(Type.String()),
      allSessions: Type.Optional(Type.Boolean({ description: "Include jobs owned by other sessions (default false)." })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("list", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });
  pi.registerTool({
    name: "job_status", label: "Managed Job Status",
    description: "Get an owned job's state, terminal event, delivery status, exit status, error and log path; missing service evidence is interrupted, not success.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) { return result(runJobOperation("status", p)); },
  });
  pi.registerTool({
    name: "job_stop", label: "Stop Managed Job",
    description: "Stop one owned job's systemd cgroup, retaining history. Refuses to stop jobs owned by another session unless allSessions is true. Use job_list to select a group and stop jobs individually.",
    parameters: Type.Object({
      id: Type.String(),
      allSessions: Type.Optional(Type.Boolean({ description: "Allow stopping a job owned by a different session (default false)." })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("stop", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "pipeline_launch", label: "Launch Worker Pipeline",
    description: "Launch a statechart-driven diagnose -> [optional approval] -> implement -> review worker pipeline managed by pi-jobs-controller. Stage argv entries may reference {{diagnose.log}}, {{diagnose.jobId}}, {{implement.log}}, {{implement.jobId}}.",
    parameters: Type.Object({
      id: Type.String({ description: "Caller-generated lowercase UUID v4 idempotency key." }),
      group: Type.String({ description: "Project/group label." }),
      cwd: Type.Optional(Type.String({ description: "Absolute working directory; defaults to current session cwd." })),
      diagnose: Type.Array(Type.String(), { minItems: 1, maxItems: 256, description: "Argv for the diagnose stage (absolute executable)." }),
      implement: Type.Array(Type.String(), { minItems: 1, maxItems: 256, description: "Argv for the implement stage (may use {{diagnose.log}})." }),
      review: Type.Array(Type.String(), { minItems: 1, maxItems: 256, description: "Argv for the review stage (may use {{diagnose.log}}, {{implement.log}})." }),
      requireApproval: Type.Optional(Type.Boolean({ description: "Pause in awaiting_approval after diagnose until pipeline_approve is called (default false)." })),
      maxStageRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Bounded retries per stage on worker failure (default 0)." })),
      wake: Type.Optional(Type.Object({
        session: Type.Optional(Type.String({ description: "Session id to wake when the pipeline reaches a terminal state (default: current session)." })),
        prompt: Type.String({ minLength: 1, maxLength: 4000, description: "Idempotent wake prompt delivered on pipeline completion/failure/cancellation." }),
        maxRetries: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        model: Type.Optional(Type.String()),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      const wake = p.wake ? { ...p.wake, session: p.wake.session ?? ownerSession } : undefined;
      return result(runJobOperation("pipeline_launch", {
        ...p,
        cwd: p.cwd ?? ctx.sessionManager.getCwd(),
        ...(ownerSession ? { ownerSession } : {}),
        ...(wake ? { wake } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "pipeline_status", label: "Worker Pipeline Status",
    description: "Inspect a worker pipeline's current stage, child job records/logs, and completion delivery state. Scoped to the current session by default.",
    parameters: Type.Object({
      id: Type.String(),
      allSessions: Type.Optional(Type.Boolean({ description: "Allow inspecting a pipeline owned by a different session (default false)." })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("pipeline_status", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "pipeline_list", label: "List Worker Pipelines",
    description: "List worker pipelines, scoped to the current session by default.",
    parameters: Type.Object({
      group: Type.Optional(Type.String()),
      allSessions: Type.Optional(Type.Boolean({ description: "Include pipelines owned by other sessions (default false)." })),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("pipeline_list", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "pipeline_approve", label: "Approve Worker Pipeline",
    description: "Approve a pipeline paused in awaiting_approval so it advances to the implement stage.",
    parameters: Type.Object({
      id: Type.String(),
      allSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("pipeline_approve", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "pipeline_cancel", label: "Cancel Worker Pipeline",
    description: "Cancel a worker pipeline, stopping any active child worker job first.",
    parameters: Type.Object({
      id: Type.String(),
      allSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const ownerSession = ctx.sessionManager.getSessionId?.() || undefined;
      return result(runJobOperation("pipeline_cancel", {
        ...p,
        ...(ownerSession ? { ownerSession } : {}),
      }));
    },
  });
}
