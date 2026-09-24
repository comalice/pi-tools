// Pi extension adaptation of Dirac's read-only inspect_ast operations; see NOTICE.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectAst } from "../src/inspect-ast.ts";

const Parameters = Type.Object({
	operation: Type.Union([Type.Literal("outline"), Type.Literal("implementation")]),
	paths: Type.Array(Type.String({ minLength: 1 }), {
		description: "Source-file paths relative to the current working directory. Supports JavaScript and TypeScript files.",
		minItems: 1,
		maxItems: 20,
	}),
	symbols: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		description: "Names to resolve for implementation, optionally qualified such as Widget.load.",
		maxItems: 40,
	})),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "inspect_ast",
		label: "Inspect AST",
		description:
			"Read-only JavaScript/TypeScript AST inspection. Use operation 'outline' with paths to list declarations, or 'implementation' with paths and symbols to retrieve complete named definitions. Supports functions, classes, methods, interfaces, enums, namespaces, type aliases, and arrow-function declarations. Qualified names disambiguate nested symbols. Paths must stay within the current working directory. Output is capped at 50,000 characters.",
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: await inspectAst(ctx.cwd, params) }],
				details: { operation: params.operation, paths: params.paths, symbols: params.symbols ?? [] },
			};
		},
	});
}
