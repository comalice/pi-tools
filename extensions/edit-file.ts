// Pi extension adaptation of Dirac's anchored edit_file tool; see NOTICE.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { editFiles, type FileEditRequest } from "../src/edit-file.ts";

const Edit = Type.Object({
	edit_type: Type.Union([Type.Literal("replace"), Type.Literal("insert_after"), Type.Literal("insert_before")]),
	anchor: Type.String({ description: "One complete ANCHOR§CONTENT line copied exactly from read_file with include_anchors true." }),
	end_anchor: Type.Optional(Type.String({ description: "Required for replace; the complete inclusive end ANCHOR§CONTENT line." })),
	text: Type.String({ description: "Ordinary replacement/insertion source text. Do not include line anchors." }),
}, { additionalProperties: false });

const Parameters = Type.Object({
	files: Type.Array(Type.Object({
		path: Type.String({ minLength: 1, description: "A file path relative to the current working directory." }),
		edits: Type.Array(Edit, { minItems: 1, maxItems: 50 }),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit_file",
		label: "Edit File",
		description:
			"Apply non-overlapping replace, insert_after, or insert_before edits using complete ANCHOR§CONTENT lines copied from the current read_file output with include_anchors true. Anchor IDs are checked against current file contents; stale or mismatched coordinates fail without applying changes. Every edit displays its complete diff and requires explicit user confirmation. This tool refuses to write in non-interactive modes.",
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("edit_file requires an interactive Pi UI to obtain explicit user approval.");
			const message = await editFiles(ctx.cwd, params.files as FileEditRequest[], (preview) =>
				ctx.ui.confirm("Apply anchored file edits?", preview),
			);
			return {
				content: [{ type: "text", text: message }],
				details: { files: params.files.map((file) => file.path) },
			};
		},
	});
}
