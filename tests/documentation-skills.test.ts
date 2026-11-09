import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = ["documentation-review", "technical-writing"];

describe("documentation skills", () => {
	it("are exposed through the package's skills directory", async () => {
		const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
		assert.ok(manifest.pi.skills.includes("./skills"));
	});

	for (const name of names) {
		it(`${name} has valid routing metadata and resolvable local references`, async () => {
			const directory = path.join(root, "skills", name);
			const contents = await readFile(path.join(directory, "SKILL.md"), "utf8");
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(contents)?.[1];
			assert.ok(frontmatter, "missing frontmatter");
			assert.match(frontmatter, new RegExp(`^name: ${name}$`, "m"));
			const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
			assert.ok(description && description.length <= 1024, "missing or oversized description");

			const references = [...contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
			assert.ok(references.length > 0, "expected a link to shared guidance");
			for (const reference of references) {
				if (/^(?:https?:|#)/.test(reference)) continue;
				const target = path.resolve(directory, reference.split("#")[0]);
				assert.ok(target.startsWith(root + path.sep), `reference escapes package: ${reference}`);
				assert.ok((await stat(target)).isFile(), `not a file: ${reference}`);
			}
		});
	}
});
