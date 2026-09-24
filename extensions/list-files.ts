// Pi extension adaptation of Dirac's list_files tool; see NOTICE for attribution.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listFiles, type ListedFile } from "../src/list-files.ts";

const Parameters = Type.Object({
	paths: Type.Array(Type.String(), { description: "Paths relative to the current working directory." }),
	recursive: Type.Optional(Type.Boolean({ description: "List nested entries breadth-first." })),
});

function formatFiles(files: ListedFile[], didHitLimit: boolean): string {
	if (files.length === 0) return "No files found.";
	const rows = files.map((file) => {
		const displayPath = file.isDirectory ? `${file.path}/` : file.path;
		return `${displayPath}${file.lineCount === undefined ? "" : ` ${file.lineCount} lines`}`;
	});
	const summary = didHitLimit
		? `${files.length} elements listed (limit reached):`
		: `${files.length} elements listed:`;
	const suffix = didHitLimit ? "\n\n(File list truncated. List a specific subdirectory to explore further.)" : "";
	return `[Entries sorted by most recently modified first within each directory.]\n\n${summary}\n\n${rows.join("\n")}${suffix}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_files",
		label: "List Files",
		description:
			"List one or more paths in the current working directory. Optionally recurse breadth-first. Skips hidden and common generated/vendor content unless the requested root is hidden, orders each directory by modification time, and includes line counts for text files. Results are capped at 200 entries. Paths outside the current working directory are rejected.",
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sections: string[] = [];
			let filesFound = 0;
			for (const requestedPath of params.paths) {
				const result = await listFiles(ctx.cwd, requestedPath, params.recursive ?? false);
				filesFound += result.files.length;
				sections.push(`Contents of ${requestedPath}:\n${formatFiles(result.files, result.didHitLimit)}`);
			}
			return {
				content: [{ type: "text", text: sections.join("\n\n====================\n\n") }],
				details: { paths: params.paths, recursive: params.recursive ?? false, filesFound },
			};
		},
	});
}
