/**
 * Agent scheduling tools: desktop notifications and session wakes, backed by
 * durable systemd user timers (survive reboot/suspend; one-shot items
 * self-clean after firing).
 *
 * - schedule_notification: one-shot, multi-up, or recurring desktop alert
 * - schedule_wake: resume a session headlessly at a later time
 * - list_scheduled: query active alerts and wakes
 * - cancel_scheduled: remove one by id
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { buildSpec, cancel, listEntries, newId, schedule, type Exec, type ScheduleEntry } from "../src/schedule/core.ts";

const exec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000 });

const WhenFields = {
  when: Type.Optional(Type.String({ description: "Fire once at this time: ISO 8601 or relative like 30m, 2h, 1d." })),
  times: Type.Optional(Type.Array(Type.String(), { description: `Fire at each of these times (2–8 entries, same formats as when).` })),
  recurring: Type.Optional(Type.String({ description: "Recurring schedule: daily, weekly, hourly, monthly, HH:MM (daily), or a systemd OnCalendar spec." })),
};

function describeEntry(e: ReturnType<typeof listEntries>[number]): string {
  const spec =
    e.spec.type === "once" ? `once at ${e.spec.at}`
      : e.spec.type === "multi" ? `${e.spec.ats.length} times (${e.spec.ats.map((d) => d).join(", ")})`
        : `recurring ${e.spec.calendar}`;
  const what = e.kind === "notification" ? `notify "${(e.message ?? "").slice(0, 80)}"` : `wake session ${e.session}: "${(e.prompt ?? "").slice(0, 80)}"`;
  return `${e.id} [${e.kind}] ${spec} — ${what}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "schedule_notification",
    label: "Schedule Notification",
    description: "Schedule a desktop notification (once, multi-up, or recurring). Durable across reboots; one-shot items clean themselves up after firing. Use list_scheduled to see active items.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 500, description: "Notification body." }),
      title: Type.Optional(Type.String({ maxLength: 120, description: "Notification title (default: pi alert)." })),
      ...WhenFields,
    }),
    async execute(_id, params) {
      const entry: ScheduleEntry = {
        id: newId("notification"),
        kind: "notification",
        spec: buildSpec(params),
        created: new Date().toISOString(),
        title: params.title,
        message: params.message,
      };
      const result = schedule(entry, exec);
      return {
        content: [{ type: "text", text: `Scheduled notification ${result.id} (${result.units.length} unit${result.units.length === 1 ? "" : "s"}: ${result.units.join(", ")}).\n${describeEntry({ ...entry, unitCount: result.units.length })}` }],
        details: { id: result.id, units: result.units },
      };
    },
  });

  pi.registerTool({
    name: "schedule_wake",
    label: "Schedule Session Wake",
    description: "Schedule a headless resume of a pi session (default: this one) with a wake prompt — once, multi-up, or recurring. One wake per session at a time (busy sessions are skipped and logged); wakes time out after timeoutMinutes (default 30). Logs live under the schedule dir. Use list_scheduled to see active items.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 2000, description: "The wake instruction injected as the next user message. Make it self-describing: why this wake exists and what to check." }),
      session: Type.Optional(Type.String({ description: "Session id to wake (default: the current session)." })),
      model: Type.Optional(Type.String({ description: "Model override for the wake run." })),
      timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240, description: "Hard cap on the wake run (default 30)." })),
      ...WhenFields,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = params.session ?? ctx.sessionManager.getSessionId();
      const entry: ScheduleEntry = {
        id: newId("wake"),
        kind: "wake",
        spec: buildSpec(params),
        created: new Date().toISOString(),
        session,
        prompt: params.prompt,
        model: params.model,
        timeoutMinutes: params.timeoutMinutes,
        cwd: ctx.sessionManager.getCwd(),
      };
      const result = schedule(entry, exec);
      return {
        content: [{ type: "text", text: `Scheduled wake ${result.id} (${result.units.length} unit${result.units.length === 1 ? "" : "s"}: ${result.units.join(", ")}).\n${describeEntry({ ...entry, unitCount: result.units.length })}` }],
        details: { id: result.id, units: result.units },
      };
    },
  });

  pi.registerTool({
    name: "list_scheduled",
    label: "List Scheduled Items",
    description: "List active scheduled notifications and session wakes (id, kind, schedule, payload). Use cancel_scheduled with an id to remove one.",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal("notification"), Type.Literal("wake")], { description: "Filter by kind; omit for both." })),
    }),
    async execute(_id, params) {
      const entries = listEntries(params.kind);
      const text = entries.length ? entries.map(describeEntry).join("\n") : "Nothing scheduled.";
      return {
        content: [{ type: "text", text }],
        details: { entries: entries.map((e) => ({ id: e.id, kind: e.kind, spec: e.spec, session: e.session, message: e.message, prompt: e.prompt, created: e.created })) },
      };
    },
  });

  pi.registerTool({
    name: "cancel_scheduled",
    label: "Cancel Scheduled Item",
    description: "Cancel a scheduled notification or wake by id (from list_scheduled). Removes its systemd units and registry entry.",
    parameters: Type.Object({
      id: Type.String({ minLength: 4, maxLength: 16, description: "The item id, e.g. n-1a2b3c4d or w-1a2b3c4d." }),
    }),
    async execute(_id, params) {
      const result = cancel(params.id, exec);
      return {
        content: [{ type: "text", text: `Cancelled ${params.id}: removed ${result.removed.length} unit${result.removed.length === 1 ? "" : "s"} (${result.removed.join(", ") || "none found"}).` }],
        details: result,
      };
    },
  });
}
