import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { editFiles } from "../src/edit-file.ts";
import { searchFiles } from "../src/search-files.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-search-files-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("searchFiles", () => {
	it("searches regexes with glob and context while excluding hidden/vendor paths", async () => {
		await fs.mkdir(path.join(cwd, "src"));
		await fs.mkdir(path.join(cwd, "node_modules"));
		await fs.mkdir(path.join(cwd, ".hidden"));
		await fs.writeFile(path.join(cwd, "src", "app.ts"), "before\nconst needle = true;\nafter\n");
		await fs.writeFile(path.join(cwd, "src", "app.js"), "const needle = false;\n");
		await fs.writeFile(path.join(cwd, "node_modules", "dep.ts"), "const needle = false;\n");
		await fs.writeFile(path.join(cwd, ".hidden", "secret.ts"), "const needle = false;\n");

		const output = await searchFiles(cwd, {
			paths: ["."],
			regex: "needle",
			file_pattern: "*.ts",
			context_lines: 1,
		});

		assert.match(output, /Found 1 result/);
		assert.match(output, /src\/app\.ts/);
		assert.match(output, /│before\n│const needle = true;\n│after/);
		assert.doesNotMatch(output, /node_modules|secret\.ts|app\.js/);
	});

	it("returns search anchors that edit_file can apply", async () => {
		const filePath = path.join(cwd, "sample.ts");
		await fs.writeFile(filePath, "const selected = true;\nconst untouched = 1;\n");
		const output = await searchFiles(cwd, {
			paths: ["sample.ts"],
			regex: "selected",
			include_anchors: true,
		});
		const anchorLine = output.split("\n").find((line) => /^[A-Z][a-zA-Z]*§const selected = true;$/.test(line));
		assert.ok(anchorLine);
		await editFiles(cwd, [{
			path: "sample.ts",
			edits: [{ edit_type: "replace", anchor: anchorLine!, end_anchor: anchorLine!, text: "const selected = false;" }],
		}], async () => true);
		assert.equal(await fs.readFile(filePath, "utf8"), "const selected = false;\nconst untouched = 1;\n");
	});

	it("rejects search anchors after the source line changes", async () => {
		const filePath = path.join(cwd, "sample.ts");
		await fs.writeFile(filePath, "const before = true;\n");
		const output = await searchFiles(cwd, { paths: ["sample.ts"], regex: "before", include_anchors: true });
		const oldAnchor = output.split("\n").find((line) => /^[A-Z][a-zA-Z]*§const before = true;$/.test(line));
		assert.ok(oldAnchor);
		await fs.writeFile(filePath, "const changed = true;\n");
		await assert.rejects(editFiles(cwd, [{
			path: "sample.ts",
			edits: [{ edit_type: "replace", anchor: oldAnchor!, end_anchor: oldAnchor!, text: "const changed = false;" }],
		}], async () => true), /ID was not found/);
		assert.equal(await fs.readFile(filePath, "utf8"), "const changed = true;\n");
	});

	it("reports invalid regex and rejects paths outside the working directory", async () => {
		await fs.writeFile(path.join(cwd, "sample.ts"), "text\n");
		const invalidRegex = await searchFiles(cwd, { paths: ["sample.ts"], regex: "[" });
		assert.match(invalidRegex, /ripgrep failed/);
		const outside = await searchFiles(cwd, { paths: ["../outside"], regex: "text" });
		assert.match(outside, /outside the Pi working directory/);
	});
});
