import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inspectAst } from "../src/inspect-ast.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-inspect-ast-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("inspectAst", () => {
	it("outlines declarations and qualified class methods", async () => {
		await fs.writeFile(path.join(cwd, "sample.ts"), [
			"export interface Store { get(id: string): string }",
			"export class MemoryStore implements Store {",
			"  get(id: string) { return id; }",
			"  clear = () => {};",
			"}",
			"export const load = async () => true;",
		].join("\n"));

		const output = await inspectAst(cwd, { operation: "outline", paths: ["sample.ts"] });
		assert.match(output, /interface Store/);
		assert.match(output, /class MemoryStore/);
		assert.match(output, /method MemoryStore\.get/);
		assert.match(output, /method MemoryStore\.clear/);
		assert.match(output, /function load/);
	});

	it("returns complete named implementations and resolves exact qualified names", async () => {
		await fs.writeFile(path.join(cwd, "sample.ts"), [
			"class Store {",
			"  load(key: string) {",
			"    return `value:${key}`;",
			"  }",
			"}",
		].join("\n"));

		const output = await inspectAst(cwd, {
			operation: "implementation",
			paths: ["sample.ts"],
			symbols: ["Store.load"],
		});
		assert.match(output, /sample\.ts::Store\.load/);
		assert.match(output, /return `value:\$\{key\}`;/);
	});

	it("reports ambiguous unqualified symbols rather than choosing one", async () => {
		await fs.writeFile(path.join(cwd, "sample.ts"), [
			"class Alpha { run() {} }",
			"class Beta { run() {} }",
		].join("\n"));

		const output = await inspectAst(cwd, { operation: "implementation", paths: ["sample.ts"], symbols: ["run"] });
		assert.match(output, /ambiguous symbol 'run'/);
		assert.match(output, /Alpha\.run/);
		assert.match(output, /Beta\.run/);
	});

	it("rejects paths outside the working directory and reports unsupported extensions", async () => {
		const outside = await inspectAst(cwd, { operation: "outline", paths: ["../outside.ts"] });
		assert.match(outside, /outside the Pi working directory/);
		await fs.writeFile(path.join(cwd, "notes.py"), "def run(): pass");
		const output = await inspectAst(cwd, { operation: "outline", paths: ["notes.py"] });
		assert.match(output, /Unsupported source file extension/);
	});
});
