// Read-only TypeScript/JavaScript port of Dirac's inspect_ast operations; see NOTICE.
import { promises as fs } from "node:fs";
import path from "node:path";
import { Node, Project, type Node as AstNode, type SourceFile } from "ts-morph";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const MAX_OUTPUT_CHARS = 50_000;

type DefinitionKind = "function" | "class" | "method" | "interface" | "enum" | "module" | "type";

interface Definition {
	kind: DefinitionKind;
	simpleName: string;
	qualifiedName: string;
	line: number;
	declaration: string;
	implementation: string;
}

interface ParsedFile {
	path: string;
	definitions: Definition[];
}

export interface InspectAstArgs {
	operation: "outline" | "implementation";
	paths: string[];
	symbols?: string[];
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function declarationName(node: AstNode): string | undefined {
	const namedNode = node as AstNode & { getName?: () => string | undefined; getNameNode?: () => AstNode };
	const name = namedNode.getName?.() ?? namedNode.getNameNode?.().getText();
	return name?.replace(/^["']|["']$/g, "");
}

function isFunctionLike(node: AstNode): boolean {
	return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

function definitionFor(node: AstNode, scope: string[], sourceFile: SourceFile): Definition | undefined {
	let kind: DefinitionKind | undefined;
	let simpleName: string | undefined;
	let declarationNode = node;

	if (Node.isFunctionDeclaration(node)) {
		kind = "function";
		simpleName = declarationName(node);
	} else if (Node.isClassDeclaration(node)) {
		kind = "class";
		simpleName = declarationName(node);
	} else if (Node.isInterfaceDeclaration(node)) {
		kind = "interface";
		simpleName = declarationName(node);
	} else if (Node.isEnumDeclaration(node)) {
		kind = "enum";
		simpleName = declarationName(node);
	} else if (Node.isModuleDeclaration(node)) {
		kind = "module";
		simpleName = declarationName(node);
	} else if (Node.isTypeAliasDeclaration(node)) {
		kind = "type";
		simpleName = declarationName(node);
	} else if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) {
		kind = "method";
		simpleName = declarationName(node);
	} else if (Node.isPropertyDeclaration(node) && node.getInitializer() && isFunctionLike(node.getInitializer()!)) {
		kind = "method";
		simpleName = declarationName(node);
	} else if (Node.isPropertyAssignment(node) && isFunctionLike(node.getInitializer())) {
		kind = "method";
		simpleName = declarationName(node);
	} else if (Node.isVariableDeclaration(node) && node.getInitializer() && isFunctionLike(node.getInitializer()!)) {
		kind = "function";
		simpleName = declarationName(node);
		const declarationList = node.getParent();
		const statement = declarationList?.getParent();
		if (declarationList && Node.isVariableDeclarationList(declarationList) && statement && Node.isVariableStatement(statement)) {
			declarationNode = statement;
		}
	}

	if (!kind || !simpleName) return undefined;
	const qualifiedName = [...scope, simpleName].join(".");
	const line = (node as AstNode & { getNameNode?: () => AstNode }).getNameNode?.().getStartLineNumber() ?? node.getStartLineNumber();
	const sourceLines = sourceFile.getFullText().split(/\r?\n/);
	return {
		kind,
		simpleName,
		qualifiedName,
		line,
		declaration: sourceLines[line - 1]?.trim() ?? node.getText().split(/\r?\n/, 1)[0],
		implementation: declarationNode.getFullText().trimStart(),
	};
}

function collectDefinitions(sourceFile: SourceFile): Definition[] {
	const definitions: Definition[] = [];
	const scopeKinds = new Set<DefinitionKind>(["function", "class", "method", "interface", "enum", "module"]);
	const visit = (node: AstNode, scope: string[]) => {
		const definition = definitionFor(node, scope, sourceFile);
		if (definition) definitions.push(definition);

		let childScope = definition && scopeKinds.has(definition.kind)
			? [...scope, definition.simpleName]
			: scope;
		if (Node.isVariableDeclaration(node) && Node.isObjectLiteralExpression(node.getInitializer())) {
			const name = declarationName(node);
			if (name) childScope = [...scope, name];
		}
		node.forEachChild((child) => visit(child, childScope));
	};
	visit(sourceFile, []);
	return definitions.sort((left, right) => left.line - right.line || left.qualifiedName.localeCompare(right.qualifiedName));
}

async function parseFile(cwd: string, requestedPath: string, project: Project): Promise<ParsedFile> {
	const workspaceRoot = await fs.realpath(cwd);
	const requestedAbsolutePath = path.resolve(workspaceRoot, requestedPath);
	if (!isWithin(workspaceRoot, requestedAbsolutePath)) {
		throw new Error(`Path is outside the Pi working directory: ${requestedPath}`);
	}
	const absolutePath = await fs.realpath(requestedAbsolutePath);
	if (!isWithin(workspaceRoot, absolutePath)) {
		throw new Error(`Path resolves outside the Pi working directory: ${requestedPath}`);
	}
	if (!SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
		throw new Error(`Unsupported source file extension: ${path.extname(absolutePath) || "(none)"}`);
	}
	const stats = await fs.stat(absolutePath);
	if (!stats.isFile()) throw new Error(`Expected a source file: ${requestedPath}`);
	const content = await fs.readFile(absolutePath, "utf8");
	const sourceFile = project.createSourceFile(absolutePath, content, { overwrite: true });
	return { path: path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath), definitions: collectDefinitions(sourceFile) };
}

function matchesForSymbol(definitions: Definition[], symbol: string): Definition[] {
	const normalized = symbol.trim();
	const exact = definitions.filter((definition) => definition.qualifiedName === normalized);
	return exact.length > 0
		? exact
		: definitions.filter((definition) => definition.simpleName === normalized || definition.qualifiedName.endsWith(`.${normalized}`));
}

function formatOutline(file: ParsedFile): string {
	if (file.definitions.length === 0) return `${file.path}\nNo declarations found.`;
	const lines = file.definitions.map((definition) => `  ${definition.line}: ${definition.kind} ${definition.qualifiedName} - ${definition.declaration}`);
	return [file.path, ...lines].join("\n");
}

function formatImplementations(files: Array<ParsedFile | { path: string; error: string }>, symbols: string[]): string {
	return symbols.map((symbol) => {
		const sections: string[] = [];
		for (const file of files) {
			if ("error" in file) {
				sections.push(`${file.path}: ${file.error}`);
				continue;
			}
			const matches = matchesForSymbol(file.definitions, symbol);
			if (matches.length > 1) {
				sections.push(`${file.path}: ambiguous symbol '${symbol}' (${matches.map((match) => match.qualifiedName).join(", ")})`);
				continue;
			}
			if (matches.length === 1) sections.push(`${file.path}::${matches[0].qualifiedName}\n${matches[0].implementation}`);
		}
		return sections.length > 0 ? sections.join("\n\n---\n\n") : `${symbol}: no implementation found in the requested files.`;
	}).join("\n\n---\n\n");
}

export async function inspectAst(cwd: string, args: InspectAstArgs): Promise<string> {
	if (args.paths.length === 0) throw new Error("Provide at least one source path.");
	if (args.operation === "outline" && (args.symbols?.length ?? 0) > 0) {
		throw new Error("The outline operation does not accept symbols.");
	}
	if (args.operation === "implementation" && (args.symbols?.length ?? 0) === 0) {
		throw new Error("The implementation operation requires at least one symbol.");
	}

	const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true, noResolve: true } });
	const files: Array<ParsedFile | { path: string; error: string }> = [];
	for (const requestedPath of args.paths) {
		try {
			files.push(await parseFile(cwd, requestedPath, project));
		} catch (error) {
			files.push({ path: requestedPath, error: error instanceof Error ? error.message : String(error) });
		}
	}

	const output = args.operation === "outline"
		? files.map((file) => "error" in file ? `${file.path}: ${file.error}` : formatOutline(file)).join("\n\n---\n\n")
		: formatImplementations(files, args.symbols ?? []);
	return output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} characters.]` : output;
}
