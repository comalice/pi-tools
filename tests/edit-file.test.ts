import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { editFiles, type FileEditRequest } from "../src/edit-file.ts";
import { readFile } from "../src/read-file.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-pi-edit-file-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

async function anchorLine(filePath: string, line: number): Promise<string> {
	const result = await readFile(cwd, filePath, { startLine: line, endLine: line, includeAnchors: true });
	return `${result.anchors![0]}§${result.lines[0]}`;
}

describe("editFiles", () => {
	it("replaces anchored content after explicit approval and preserves other line IDs", async () => {
		await fs.writeFile(path.join(cwd, "sample.ts"), "first\r\nsecond\r\nthird\r\n");
		const firstAnchor = await anchorLine("sample.ts", 1);
		const thirdAnchor = await anchorLine("sample.ts", 3);
		let preview = "";
		const result = await editFiles(cwd, [{
			path: "sample.ts",
			edits: [{ edit_type: "replace", anchor: firstAnchor, end_anchor: firstAnchor, text: "updated" }],
		}], async (diff) => {
			preview = diff;
			return true;
		});

		assert.match(preview, /-first/);
		assert.match(preview, /\+updated/);
		assert.match(result, /Applied 1 anchored edit/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.ts"), "utf8"), "updated\r\nsecond\r\nthird\r\n");
		assert.equal(await anchorLine("sample.ts", 3), thirdAnchor);
	});

	it("inserts after an anchored line and denies writes when the user rejects", async () => {
		await fs.writeFile(path.join(cwd, "sample.txt"), "one\ntwo");
		const first = await anchorLine("sample.txt", 1);
		const request: FileEditRequest[] = [{
			path: "sample.txt",
			edits: [{ edit_type: "insert_after", anchor: first, text: "between" }],
		}];
		assert.match(await editFiles(cwd, request, async () => false), /cancelled/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "one\ntwo");
		assert.match(await editFiles(cwd, request, async () => true), /Applied 1 anchored edit/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "one\nbetween\ntwo");
	});

	it("rejects stale anchors and conflicting edits without writing", async () => {
		await fs.writeFile(path.join(cwd, "sample.txt"), "alpha\nbeta\ngamma");
		const alpha = await anchorLine("sample.txt", 1);
		const beta = await anchorLine("sample.txt", 2);
		await fs.writeFile(path.join(cwd, "sample.txt"), "changed\nbeta\ngamma");
		await assert.rejects(editFiles(cwd, [{
			path: "sample.txt",
			edits: [{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "replace" }],
		}], async () => true), /ID was not found/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "changed\nbeta\ngamma");

		const currentAlpha = await anchorLine("sample.txt", 1);
		await assert.rejects(editFiles(cwd, [{
			path: "sample.txt",
			edits: [
				{ edit_type: "replace", anchor: currentAlpha, end_anchor: currentAlpha, text: "x" },
				{ edit_type: "replace", anchor: currentAlpha, end_anchor: beta, text: "y" },
			],
		}], async () => true), /overlap/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "changed\nbeta\ngamma");
	});

	it("rechecks each target after approval before writing", async () => {
		const absolutePath = path.join(cwd, "sample.txt");
		await fs.writeFile(absolutePath, "before");
		const anchor = await anchorLine("sample.txt", 1);
		await assert.rejects(editFiles(cwd, [{
			path: "sample.txt",
			edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "approved" }],
		}], async () => {
			await fs.writeFile(absolutePath, "changed externally");
			return true;
		}), /changed while waiting for approval/);
		assert.equal(await fs.readFile(absolutePath, "utf8"), "changed externally");
	});

	it("rejects workspace escapes and refuses anchor-like replacement text", async () => {
		await fs.writeFile(path.join(cwd, "sample.txt"), "alpha");
		const alpha = await anchorLine("sample.txt", 1);
		await assert.rejects(editFiles(cwd, [{ path: "../outside", edits: [{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "x" }] }], async () => true), /outside the Pi working directory/);
		await assert.rejects(editFiles(cwd, [{
			path: "sample.txt",
			edits: [{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "Another§line" }],
		}], async () => true), /without line anchors/);
		assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "alpha");
	});
});
