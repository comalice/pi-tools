// Pi extension adaptation of Dirac's read_file tool; see NOTICE.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatReadFileResult, MAX_SELECTED_BYTES, readFile } from "../src/read-file.ts";

const Parameters = Type.Object({
	paths: Type.Array(Type.String({ minLength: 1 }), {
		description: "File paths relative to the current working directory.",
		minItems: 1,
		maxItems: 20,
	}),
	start_line: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)." })),
	end_line: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to return (inclusive)." })),
	include_anchors: Type.Optional(Type.Boolean({ description: "Return file-scoped ANCHOR§CONTENT lines for later anchored edits." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_file",
		label: "Read File",
		description:
			"Read text files or a 1-based inclusive line range from files in the current working directory. Output is limited to 50 KiB. Set include_anchors true to receive ANCHOR§CONTENT coordinates stable across reads in this running Pi process; unchanged lines preserve their IDs when the file changes. Anchors are available only for files up to 20 MiB and 50,000 lines. Rich-document extraction is not included. Paths outside the current working directory are rejected.",
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rangeRequested = params.start_line !== undefined || params.end_line !== undefined;
			const sections: string[] = [];
			for (const requestedPath of params.paths) {
				try {
					const result = await readFile(ctx.cwd, requestedPath, {
						startLine: params.start_line,
						endLine: params.end_line,
						includeAnchors: params.include_anchors,
					});
					sections.push(formatReadFileResult(result, params.include_anchors, rangeRequested));
				} catch (error) {
					sections.push(`${requestedPath}\nError reading file: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const text = sections.join("\n\n---\n\n");
			if (Buffer.byteLength(text, "utf8") > MAX_SELECTED_BYTES) {
				throw new Error(`Combined file output exceeds the ${MAX_SELECTED_BYTES}-byte read limit. Read fewer files or smaller ranges.`);
			}
			return {
				content: [{ type: "text", text }],
				details: { paths: params.paths, start_line: params.start_line, end_line: params.end_line, include_anchors: params.include_anchors ?? false },
			};
		},
	});
}
