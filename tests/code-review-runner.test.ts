import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const runner = resolve("skills/code-review/scripts/run-axis.sh");

test("review axis starts isolated pi with the committed diff and supported flags", () => {
	const dir = mkdtempSync(join(tmpdir(), "review runner "));
	try {
		const repo = join(dir, "repo");
		const bin = join(dir, "bin");
		mkdirSync(repo);
		mkdirSync(bin);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Review Test");
		writeFileSync(join(repo, "file.txt"), "before\n");
		git("add", "file.txt");
		git("commit", "-qm", "first");
		writeFileSync(join(repo, "file.txt"), "after\n");
		git("commit", "-qam", "second");
		writeFileSync(join(repo, "brief.md"), "Review the diff.\n");
		const pi = join(bin, "pi");
		writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--no-mcp')) { console.error('Unknown option: --no-mcp'); process.exit(2); }
const match = args.at(-1).match(/^Read (.*)\\/prompt\\.md and follow its instructions exactly\\.$/);
if (!match) process.exit(3);
const dir = match[1];
console.log(JSON.stringify({ args, prompt: fs.readFileSync(dir + '/prompt.md', 'utf8'), diff: fs.readFileSync(dir + '/diff.patch', 'utf8'), commits: fs.readFileSync(dir + '/commits.txt', 'utf8') }));
`);
		chmodSync(pi, 0o755);
		// PI_REVIEW_MODEL is unset (not empty): the script must launch pi
		// without --model, exercising the empty-argument path.
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		delete env.PI_REVIEW_MODEL;
		const out = join(repo, "output.md");
		execFileSync("bash", [runner, "HEAD~1", join(repo, "brief.md"), out], { cwd: repo, env });
		const result = JSON.parse(readFileSync(out, "utf8"));
		for (const flag of ["--print", "--no-session", "--no-skills", "--no-extensions", "--no-context-files"]) assert.ok(result.args.includes(flag));
		assert.ok(!result.args.includes("--no-mcp"));
		assert.ok(!result.args.includes("--model"));
		assert.equal(result.args[result.args.indexOf("--tools") + 1], "read,bash");
		assert.match(result.prompt, /Review the diff/);
		assert.match(result.diff, /\+after/);
		assert.match(result.commits, /second/);
		const modelOut = join(repo, "model-output.md");
		execFileSync("bash", [runner, "HEAD~1", join(repo, "brief.md"), modelOut], { cwd: repo, env: { ...env, PI_REVIEW_MODEL: "test/model" } });
		const modelResult = JSON.parse(readFileSync(modelOut, "utf8"));
		assert.equal(modelResult.args[modelResult.args.indexOf("--model") + 1], "test/model");
		assert.ok(modelResult.args.includes("--no-context-files"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
