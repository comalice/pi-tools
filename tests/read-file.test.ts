import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatReadFileResult, readFile } from "../src/read-file.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-read-file-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("readFile", () => {
	it("reads an inclusive line range and reports its file coordinates", async () => {
		await fs.writeFile(path.join(cwd, "sample.txt"), "first\r\nsecond\r\nthird");
		const result = await readFile(cwd, "sample.txt", { startLine: 2, endLine: 2 });
		assert.deepEqual(result.lines, ["second"]);
		assert.equal(result.totalLineCount, 3);
		assert.equal(formatReadFileResult(result, false, true), "sample.txt\n[Lines: 2-2 of 3]\nsecond");
	});

	it("preserves anchors for unchanged lines across later reads", async () => {
		const filePath = path.join(cwd, "anchored.txt");
		await fs.writeFile(filePath, "alpha\nbeta\ngamma");
		const first = await readFile(cwd, "anchored.txt", { includeAnchors: true });
		await fs.writeFile(filePath, "inserted\nalpha\nbeta\ngamma");
		const second = await readFile(cwd, "anchored.txt", { includeAnchors: true });
		assert.deepEqual(second.anchors?.slice(1), first.anchors);
		assert.notEqual(second.anchors?.[0], first.anchors?.[0]);
		assert.match(formatReadFileResult(second, true), /^[^\n]+\n\[Total lines: 4\]\n[A-Z][a-zA-Z]*§inserted/m);
	});

	it("rejects paths outside the workspace and invalid ranges", async () => {
		await assert.rejects(readFile(cwd, "../outside.txt"), /outside the Pi working directory/);
		await fs.writeFile(path.join(cwd, "sample.txt"), "one\ntwo");
		await assert.rejects(readFile(cwd, "sample.txt", { startLine: 3 }), /exceeds file length/);
		await assert.rejects(readFile(cwd, "sample.txt", { startLine: 2, endLine: 1 }), /cannot be greater than/);
	});

	it("rejects binary and oversized selected content", async () => {
		await fs.writeFile(path.join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		await fs.writeFile(path.join(cwd, "large.txt"), "x".repeat(50 * 1024 + 1));
		await assert.rejects(readFile(cwd, "binary.dat"), /binary content/);
		await assert.rejects(readFile(cwd, "large.txt"), /51200-byte read limit/);
	});

	it("keeps anchor overhead within the model-facing output limit", async () => {
		await fs.writeFile(path.join(cwd, "many-lines.txt"), "\n".repeat(5999));
		const result = await readFile(cwd, "many-lines.txt", { includeAnchors: true });
		assert.equal(result.totalLineCount, 6000);
		assert.throws(() => formatReadFileResult(result, true), /Formatted output exceeds the 51200-byte read limit/);
	});
});
