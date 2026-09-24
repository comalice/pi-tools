// Pi extension adaptation of Dirac's search_files tool; see NOTICE.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchFiles } from "../src/search-files.ts";

const Parameters = Type.Object({
	paths: Type.Array(Type.String({ minLength: 1 }), {
		description: "Files or directories relative to the current working directory.",
		minItems: 1,
		maxItems: 20,
	}),
	regex: Type.String({ minLength: 1, description: "Regular expression using ripgrep's Rust regex syntax." }),
	file_pattern: Type.Optional(Type.String({ description: "Optional ripgrep glob filter, such as '*.ts'." })),
	context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Context lines before and after each match." })),
	include_anchors: Type.Optional(Type.Boolean({ description: "Return current ANCHOR§CONTENT coordinates suitable for edit_file." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "search_files",
		label: "Search Files",
		description:
			"Search one or more files/directories with a ripgrep regular expression and optional glob/context. Hidden, ignored, and common generated/vendor content is excluded. Results are capped at 30 matches and 100 KiB. Set include_anchors true to get exact line coordinates for edit_file; if a matched or context line changed during search, that file's anchored results are omitted. Paths outside the current working directory are rejected.",
		parameters: Parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const text = await searchFiles(ctx.cwd, params, signal);
			return {
				content: [{ type: "text", text }],
				details: {
					paths: params.paths,
					regex: params.regex,
					file_pattern: params.file_pattern,
					context_lines: params.context_lines ?? 0,
					include_anchors: params.include_anchors ?? false,
				},
			};
		},
	});
}
