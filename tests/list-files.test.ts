import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listFiles } from "../src/list-files.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-tools-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("listFiles", () => {
	it("lists text line counts and skips generated and hidden content", async () => {
		await fs.mkdir(path.join(cwd, "src"));
		await fs.mkdir(path.join(cwd, "node_modules"));
		await fs.mkdir(path.join(cwd, ".git"));
		await fs.writeFile(path.join(cwd, "src", "main.ts"), "first\nsecond\n");
		await fs.writeFile(path.join(cwd, "debug.log"), "ignored");
		await fs.writeFile(path.join(cwd, ".hidden"), "ignored");
		await fs.writeFile(path.join(cwd, "node_modules", "ignored.js"), "ignored");

		const result = await listFiles(cwd, ".", true);

		assert.deepEqual(result.files.map((file) => file.path).sort(), ["src", "src/main.ts"]);
		assert.equal(result.files.find((file) => file.path === "src/main.ts")?.lineCount, 3);
		assert.equal(result.didHitLimit, false);
	});

	it("walks breadth-first and returns details for a directly requested file", async () => {
		await fs.mkdir(path.join(cwd, "nested"));
		await fs.writeFile(path.join(cwd, "root.txt"), "root");
		await fs.writeFile(path.join(cwd, "nested", "child.txt"), "child\n");

		const recursive = await listFiles(cwd, ".", true);
		assert.ok(recursive.files.findIndex((file) => file.path === "nested") < recursive.files.findIndex((file) => file.path === path.join("nested", "child.txt")));

		const file = await listFiles(cwd, "root.txt");
		assert.deepEqual(file.files.map(({ path: filePath, lineCount }) => ({ path: filePath, lineCount })), [{ path: "root.txt", lineCount: 1 }]);
	});

	it("rejects paths outside the working directory", async () => {
		await assert.rejects(listFiles(cwd, "../outside"), /outside the Pi working directory/);
	});

	it("caps results at 200 entries", async () => {
		await Promise.all(Array.from({ length: 205 }, (_, index) => fs.writeFile(path.join(cwd, `file-${index}.txt`), "x")));
		const result = await listFiles(cwd, ".");
		assert.equal(result.files.length, 200);
		assert.equal(result.didHitLimit, true);
	});

	it("does not traverse a symlink that escapes the working directory", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-outside-"));
		try {
			await fs.writeFile(path.join(outside, "secret.txt"), "secret");
			await fs.symlink(outside, path.join(cwd, "linked"));
			const result = await listFiles(cwd, ".", true);
			assert.equal(result.files.some((file) => file.path.startsWith(`linked${path.sep}`)), false);
			await assert.rejects(listFiles(cwd, "linked"), /resolves outside the Pi working directory/);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});
