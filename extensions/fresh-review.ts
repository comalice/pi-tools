import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runFreshReview, type ReviewUsage } from "../src/fresh-review.ts";

const Parameters = Type.Object({
	tasks: Type.Array(Type.Object({
		label: Type.String({ minLength: 1, maxLength: 80, description: "Short name for this independent review." }),
		task: Type.String({ minLength: 1, maxLength: 12000, description: "Self-contained task with scope and absolute skill/reference paths when needed." }),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 3, description: "One to three independent reviews to run in parallel." }),
}, { additionalProperties: false });

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fresh_review",
		label: "Fresh Review",
		description: "Run one to three independent read-only review tasks in parallel, each in a fresh ephemeral Pi process using the current model. Workers have read/grep/find/ls only; shell, editing, extensions, skills discovery, and MCP are disabled. Supply all scope and skill-file paths in each task; workers cannot see the parent conversation or run git. This is not an OS sandbox: workers can read files accessible to the Pi user. Results are hypotheses to verify. Each task incurs model cost; output is capped and failures are explicit.",
		parameters: Parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const results = await Promise.all(params.tasks.map((task) => runFreshReview(task, {
				cwd: ctx.cwd, model, thinking: ctx.thinkingLevel, signal,
			})));
			const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			for (const result of results) {
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += result.usage[key];
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += result.usage.cost[key];
			}
			return {
				content: [{ type: "text", text: results.map((result) => `## ${result.label} — ${result.ok ? "complete" : "failed"}\n\n${result.ok ? result.output : result.error}`).join("\n\n---\n\n") }],
				details: { model, results }, usage, isError: results.some((result) => !result.ok),
			};
		},
	});
}
