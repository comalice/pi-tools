// Regex search port of Dirac's search_files behavior; see NOTICE.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_ANCHORED_FILE_BYTES, MAX_ANCHORED_FILE_LINES } from "./read-file.ts";
import { reconcileLineAnchors } from "./line-anchors.ts";

const MAX_MATCHES = 30;
const MAX_RIPGREP_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 100 * 1024;
const MAX_PLAIN_LINE_LENGTH = 300;
const EXCLUDED_GLOBS = [
	"!**/node_modules/**",
	"!**/__pycache__/**",
	"!**/env/**",
	"!**/venv/**",
	"!**/.venv/**",
	"!**/target/dependency/**",
	"!**/build/dependencies/**",
	"!**/dist/**",
	"!**/out/**",
	"!**/bundle/**",
	"!**/vendor/**",
	"!**/tmp/**",
	"!**/temp/**",
	"!**/deps/**",
	"!**/Pods/**",
	"!**/*.log",
];

export interface SearchFilesArgs {
	paths: string[];
	regex: string;
	file_pattern?: string;
	context_lines?: number;
	include_anchors?: boolean;
}

interface ResultLine {
	lineNumber: number;
	content: string;
	isMatch: boolean;
}

interface SearchFileResult {
	absolutePath: string;
	relativePath: string;
	lines: Map<number, ResultLine>;
}

interface RipgrepResult {
	output: string;
	truncated: boolean;
}

interface AnchoredFile {
	lines: string[];
	anchors: string[];
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasHiddenPath(root: string, target: string): boolean {
	return path.relative(root, target).split(path.sep).some((part) => part !== "" && part !== "." && part !== ".." && part.startsWith("."));
}

async function resolveSearchPath(workspaceRoot: string, requestedPath: string): Promise<string> {
	const lexicalPath = path.resolve(workspaceRoot, requestedPath);
	if (!isWithin(workspaceRoot, lexicalPath)) throw new Error(`Path is outside the Pi working directory: ${requestedPath}`);
	const absolutePath = await fs.realpath(lexicalPath);
	if (!isWithin(workspaceRoot, absolutePath)) throw new Error(`Path resolves outside the Pi working directory: ${requestedPath}`);
	const stats = await fs.stat(absolutePath);
	if (!stats.isDirectory() && !stats.isFile()) throw new Error(`Path is not a regular file or directory: ${requestedPath}`);
	return absolutePath;
}

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<RipgrepResult> {
	return new Promise((resolve, reject) => {
		const process = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let errorOutput = "";
		let truncated = false;
		let settled = false;

		const finish = (error?: Error, result?: RipgrepResult) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(result!);
		};
		const abort = () => {
			process.kill();
			finish(signal?.reason instanceof Error ? signal.reason : new Error("Search aborted."));
		};

		process.stdout.on("data", (chunk: Buffer) => {
			if (settled || truncated) return;
			const availableBytes = MAX_RIPGREP_OUTPUT_BYTES - outputBytes;
			if (chunk.length > availableBytes) {
				if (availableBytes > 0) chunks.push(chunk.subarray(0, availableBytes));
				outputBytes = MAX_RIPGREP_OUTPUT_BYTES;
				truncated = true;
				process.kill();
				return;
			}
			chunks.push(chunk);
			outputBytes += chunk.length;
		});
		process.stderr.on("data", (chunk: Buffer) => {
			if (errorOutput.length < 16 * 1024) errorOutput += chunk.toString("utf8").slice(0, 16 * 1024 - errorOutput.length);
		});
		process.on("error", (error) => finish(new Error(`Unable to start ripgrep: ${error.message}`)));
		process.on("close", (code) => {
			if (truncated) {
				finish(undefined, { output: Buffer.concat(chunks).toString("utf8"), truncated: true });
				return;
			}
			if (code === 0 || code === 1) {
				finish(undefined, { output: Buffer.concat(chunks).toString("utf8"), truncated: false });
				return;
			}
			finish(new Error(`ripgrep failed with exit code ${code}: ${errorOutput.trim()}`));
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

function parseRipgrepOutput(output: string, workspaceRoot: string, files: Map<string, SearchFileResult>, matches: Set<string>): void {
	for (const line of output.split("\n")) {
		if (!line) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "match" && event.type !== "context") continue;
		const data = event.data;
		if (typeof data?.path?.text !== "string" || typeof data.line_number !== "number" || typeof data.lines?.text !== "string") continue;
		const absolutePath = path.resolve(workspaceRoot, data.path.text);
		if (!isWithin(workspaceRoot, absolutePath)) continue;
		let file = files.get(absolutePath);
		if (!file) {
			file = { absolutePath, relativePath: path.relative(workspaceRoot, absolutePath), lines: new Map() };
			files.set(absolutePath, file);
		}
		const lineNumber = data.line_number as number;
		const isMatch = event.type === "match";
		const content = (data.lines.text as string).replace(/\r?\n$/, "");
		const previous = file.lines.get(lineNumber);
		if (isMatch || !previous) file.lines.set(lineNumber, { lineNumber, content, isMatch });
		if (isMatch) matches.add(`${absolutePath}\0${lineNumber}`);
	}
}

async function prepareAnchoredFile(file: SearchFileResult): Promise<AnchoredFile | string> {
	try {
		const absolutePath = await fs.realpath(file.absolutePath);
		const stats = await fs.stat(absolutePath);
		if (stats.size > MAX_ANCHORED_FILE_BYTES) return "Anchors unavailable: file exceeds the 20 MiB anchor limit.";
		const bytes = await fs.readFile(absolutePath);
		if (bytes.includes(0)) return "Anchors unavailable: file is binary.";
		const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		const lines = content.split(/\r?\n/);
		if (lines.length > MAX_ANCHORED_FILE_LINES) return "Anchors unavailable: file exceeds the 50,000-line anchor limit.";
		for (const resultLine of file.lines.values()) {
			if (lines[resultLine.lineNumber - 1] !== resultLine.content) {
				return "Anchored results omitted because the file changed during search. Rerun search_files for current coordinates.";
			}
		}
		return { lines, anchors: reconcileLineAnchors(absolutePath, lines) };
	} catch {
		return "Anchored results unavailable because the file could not be reread. Rerun search_files.";
	}
}

async function formatResults(
	files: SearchFileResult[],
	matchCount: number,
	contextLines: number,
	includeAnchors: boolean,
	truncatedInput: boolean,
): string {
	const shownMatches = new Map<string, Set<number>>();
	let remaining = MAX_MATCHES;
	for (const file of files) {
		const matchLines = [...file.lines.values()].filter((line) => line.isMatch).map((line) => line.lineNumber);
		const selected = matchLines.slice(0, remaining);
		if (selected.length > 0) shownMatches.set(file.absolutePath, new Set(selected));
		remaining -= selected.length;
	}

	const countHeader = truncatedInput
		? `Showing first ${Math.min(matchCount, MAX_MATCHES)}+ results (ripgrep output limit reached).\n\n`
		: matchCount > MAX_MATCHES
			? `Showing first ${MAX_MATCHES} of ${matchCount.toLocaleString()} results.\n\n`
			: `Found ${matchCount === 1 ? "1 result" : `${matchCount.toLocaleString()} results`}.\n\n`;
	let output = countHeader;
	let outputBytes = Buffer.byteLength(output, "utf8");
	let truncated = false;
	const append = (text: string): boolean => {
		const bytes = Buffer.byteLength(text, "utf8");
		if (outputBytes + bytes > MAX_RESULT_BYTES) {
			truncated = true;
			return false;
		}
		output += text;
		outputBytes += bytes;
		return true;
	};

	for (const file of files) {
		const matchLines = shownMatches.get(file.absolutePath);
		if (!matchLines) continue;
		let anchors: AnchoredFile | undefined;
		if (includeAnchors) {
			const anchorResult = await prepareAnchoredFile(file);
			if (typeof anchorResult === "string") {
				if (!append(`${file.relativePath}\n[${anchorResult}]\n\n`)) break;
				continue;
			}
			anchors = anchorResult;
		}

		if (!append(`${file.relativePath}\n│----\n`)) break;
		const selectedLineNumbers = [...file.lines.keys()]
			.filter((lineNumber) => [...matchLines].some((matchLine) => lineNumber === matchLine || Math.abs(lineNumber - matchLine) <= contextLines))
			.sort((left, right) => left - right);
		const matchSummary = selectedLineNumbers
			.filter((lineNumber) => matchLines.has(lineNumber))
			.map((lineNumber) => {
				const content = anchors?.lines[lineNumber - 1] ?? file.lines.get(lineNumber)!.content;
				return `${lineNumber} ${JSON.stringify(content)}`;
			});
		if (matchSummary.length > 0 && matchSummary.length <= 5 && !append(`Matches: ${matchSummary.join(", ")}\n`)) break;

		let previousLineNumber: number | undefined;
		let skippedLongMatches = 0;
		for (const lineNumber of selectedLineNumbers) {
			const line = file.lines.get(lineNumber)!;
			const content = anchors?.lines[lineNumber - 1] ?? line.content;
			if (!includeAnchors && content.length > MAX_PLAIN_LINE_LENGTH) {
				if (line.isMatch) skippedLongMatches++;
				continue;
			}
			if (previousLineNumber !== undefined && lineNumber > previousLineNumber + 1) {
				if (!append(`--- ${lineNumber - previousLineNumber - 1} lines skipped ---\n`)) break;
			}
			const rendered = includeAnchors
				? `${line.isMatch ? `--- match at line ${lineNumber} ---\n` : ""}${anchors!.anchors[lineNumber - 1]}§${content}\n`
				: `│${content}\n`;
			if (!append(rendered)) break;
			previousLineNumber = lineNumber;
		}
		if (truncated) break;
		if (skippedLongMatches > 0 && !append(`│ (${skippedLongMatches} result(s) skipped due to line length limits)\n`)) break;
		if (!append("│----\n\n")) break;
	}

	if (truncated) output += "\n[Results truncated at 100 KiB. Use a narrower pattern, path, or context range.]";
	return output.replace(/\n+$/, "");
}

export async function searchFiles(cwd: string, args: SearchFilesArgs, signal?: AbortSignal): Promise<string> {
	if (args.paths.length === 0) throw new Error("Provide at least one path to search.");
	if (!args.regex) throw new Error("Provide a non-empty regex pattern.");
	const workspaceRoot = await fs.realpath(cwd);
	const contextLines = Number.isFinite(args.context_lines)
		? Math.max(0, Math.min(10, Math.trunc(args.context_lines!)))
		: 0;
	const files = new Map<string, SearchFileResult>();
	const matches = new Set<string>();
	const errors: string[] = [];
	let truncatedInput = false;

	for (const requestedPath of args.paths) {
		try {
			const absolutePath = await resolveSearchPath(workspaceRoot, requestedPath);
			if (hasHiddenPath(workspaceRoot, absolutePath)) continue;
			const rgArgs = ["--json", "--context", String(contextLines)];
			if (args.file_pattern) rgArgs.push("--glob", args.file_pattern);
			for (const glob of EXCLUDED_GLOBS) rgArgs.push("--glob", glob);
			const relativePath = path.relative(workspaceRoot, absolutePath) || ".";
			rgArgs.push("-e", args.regex, "--", relativePath);
			const result = await runRipgrep(rgArgs, workspaceRoot, signal);
			truncatedInput ||= result.truncated;
			parseRipgrepOutput(result.output, workspaceRoot, files, matches);
		} catch (error) {
			errors.push(`${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const output = errors.length === args.paths.length
		? ""
		: await formatResults([...files.values()], matches.size, contextLines, args.include_anchors === true, truncatedInput);
	return [output, ...errors.map((error) => `Search failed: ${error}`)].filter(Boolean).join("\n\n");
}
