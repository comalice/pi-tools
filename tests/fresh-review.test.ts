import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runFreshReview } from "../src/fresh-review.ts";

const cwd = process.cwd();
const worker = (script: string) => ({ cwd, command: process.execPath, prefixArgs: ["-e", script, "--"], timeoutMs: 2000 });
const event = (message: unknown) => `console.log(JSON.stringify({type:'message_end',message:${JSON.stringify(message)}}))`;

describe("fresh review worker", () => {
	it("captures final text, usage and read-only isolation flags", async () => {
		const script = `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({args:process.argv,input})}],usage:{input:4,output:2,cost:{total:0.1}}}})))`;
		const result = await runFreshReview({ label: "check", task: "Review only" }, worker(script));
		assert.equal(result.ok, true);
		const { args, input }: { args: string[]; input: string } = JSON.parse(result.output);
		for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-mcp"]) assert.ok(args.includes(flag));
		assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
		assert.ok(input.includes("Review only"));
		assert.ok(!args.includes("Review only"));
		assert.equal(result.usage.input, 4);
		assert.equal(result.usage.cost.total, 0.1);
	});

	it("reports model errors even when the process exits zero", async () => {
		const script = event({ role: "assistant", stopReason: "error", errorMessage: "model unavailable", content: [] });
		const result = await runFreshReview({ label: "check", task: "Review" }, worker(script));
		assert.equal(result.ok, false);
		assert.match(result.error!, /model unavailable/);
	});

	it("does not treat a partial response as a completed review", async () => {
		const script = event({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "partial" }] });
		const result = await runFreshReview({ label: "check", task: "Review" }, worker(script));
		assert.equal(result.ok, false);
		assert.match(result.error!, /did not complete/);
	});

	it("reports missing and non-zero processes", async () => {
		const missing = await runFreshReview({ label: "check", task: "Review" }, { cwd, command: "/not/a/pi/executable", timeoutMs: 2000 });
		assert.equal(missing.ok, false);
		assert.match(missing.error!, /Could not start/);
		const failed = await runFreshReview({ label: "check", task: "Review" }, worker("console.error('failed');process.exit(2)"));
		assert.equal(failed.ok, false);
		assert.match(failed.error!, /exited 2: failed/);
	});

	it("bounds output and makes truncation visible", async () => {
		const script = event({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(25000) }] });
		const result = await runFreshReview({ label: "check", task: "Review" }, worker(script));
		assert.equal(result.ok, true);
		assert.equal(result.truncated, true);
		assert.match(result.output, /Output truncated/);
	});

	it("terminates timed-out and cancelled workers", async () => {
		const timeout = await runFreshReview({ label: "check", task: "Review" }, { ...worker("setTimeout(()=>{},10000)"), timeoutMs: 50 });
		assert.match(timeout.error!, /timed out/);
		const controller = new AbortController();
		const pending = runFreshReview({ label: "check", task: "Review" }, { ...worker("setTimeout(()=>{},10000)"), signal: controller.signal });
		controller.abort();
		assert.match((await pending).error!, /Cancelled/);
	});
});
