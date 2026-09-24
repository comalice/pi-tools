// Read-only text/range port of Dirac's read_file behavior; see NOTICE.
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { clearLineAnchors, reconcileLineAnchors } from "./line-anchors.ts";

export const MAX_SELECTED_BYTES = 50 * 1024;
export const MAX_ANCHORED_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ANCHORED_FILE_LINES = 50_000;
const MAX_SINGLE_LINE_BYTES = 2 * 1024 * 1024;
const NON_EDITABLE_RICH_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"]);

export interface ReadFileOptions {
	startLine?: number;
	endLine?: number;
	includeAnchors?: boolean;
}

export interface ReadFileResult {
	path: string;
	lines: string[];
	startLine: number;
	endLine: number;
	totalLineCount: number;
	anchors?: string[];
	anchorUnavailableReason?: string;
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isBinarySample(sample: Buffer): boolean {
	if (sample.includes(0)) return true;
	let controlBytes = 0;
	for (const byte of sample) {
		if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 9) controlBytes++;
	}
	return sample.length > 0 && controlBytes / sample.length > 0.1;
}

async function inspectFileBytes(filePath: string, fileSize: number): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const sample = Buffer.alloc(Math.min(8192, fileSize));
		if (sample.length > 0) await handle.read(sample, 0, sample.length, 0);
		if (isBinarySample(sample)) throw new Error("Cannot read binary content as text.");
		if (fileSize === 0) return true;
		const lastByte = Buffer.alloc(1);
		await handle.read(lastByte, 0, 1, fileSize - 1);
		return lastByte[0] === 10;
	} finally {
		await handle.close();
	}
}

export async function readFile(
	cwd: string,
	requestedPath: string,
	options: ReadFileOptions = {},
): Promise<ReadFileResult> {
	const startLine = options.startLine ?? 1;
	const endLine = options.endLine;
	if (!Number.isInteger(startLine) || startLine < 1) throw new Error("start_line must be an integer >= 1.");
	if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) throw new Error("end_line must be an integer >= 1.");
	if (endLine !== undefined && startLine > endLine) throw new Error("start_line cannot be greater than end_line.");

	const workspaceRoot = await fs.realpath(cwd);
	const requestedAbsolutePath = path.resolve(workspaceRoot, requestedPath);
	if (!isWithin(workspaceRoot, requestedAbsolutePath)) throw new Error(`Path is outside the Pi working directory: ${requestedPath}`);
	const absolutePath = await fs.realpath(requestedAbsolutePath);
	if (!isWithin(workspaceRoot, absolutePath)) throw new Error(`Path resolves outside the Pi working directory: ${requestedPath}`);
	if (NON_EDITABLE_RICH_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
		throw new Error("Rich-document and image extraction is not included in this Pi port; read the text/source file instead.");
	}

	const before = await fs.stat(absolutePath);
	if (!before.isFile()) throw new Error(`Expected a file: ${requestedPath}`);
	const endsWithNewline = await inspectFileBytes(absolutePath, before.size);
	const requestedAnchors = options.includeAnchors === true;
	let anchorLines: string[] | undefined = requestedAnchors && before.size <= MAX_ANCHORED_FILE_BYTES ? [] : undefined;
	const selectedLines: string[] = [];
	let selectedBytes = 0;
	let totalLineCount = 0;
	const source = createReadStream(absolutePath, { encoding: "utf8" });
	const lineReader = createInterface({ input: source, crlfDelay: Infinity });

	const consumeLine = (line: string) => {
		if (line.includes("\0")) throw new Error("Cannot read binary content as text.");
		if (Buffer.byteLength(line, "utf8") > MAX_SINGLE_LINE_BYTES) {
			throw new Error(`A source line exceeds the ${MAX_SINGLE_LINE_BYTES}-byte line limit.`);
		}
		totalLineCount++;
		if (anchorLines) {
			if (totalLineCount > MAX_ANCHORED_FILE_LINES) anchorLines = undefined;
			else anchorLines.push(line);
		}
		if (totalLineCount < startLine || (endLine !== undefined && totalLineCount > endLine)) return;
		selectedBytes += Buffer.byteLength(line, "utf8") + (selectedLines.length > 0 ? 1 : 0);
		if (selectedBytes > MAX_SELECTED_BYTES) {
			throw new Error(`Selected text exceeds the ${MAX_SELECTED_BYTES}-byte read limit. Specify a smaller line range.`);
		}
		selectedLines.push(line);
	};

	try {
		for await (const line of lineReader) consumeLine(line);
		if (endsWithNewline) consumeLine("");
	} catch (error) {
		lineReader.close();
		source.destroy();
		throw error;
	}

	const after = await fs.stat(absolutePath);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
		throw new Error("File changed while it was being read; retry the read before editing.");
	}
	if (startLine > totalLineCount) {
		throw new Error(`start_line ${startLine} exceeds file length (${totalLineCount} lines). No content in specified range.`);
	}

	const selectedEndLine = Math.min(endLine ?? totalLineCount, totalLineCount);
	let anchors: string[] | undefined;
	let anchorUnavailableReason: string | undefined;
	if (requestedAnchors) {
		if (before.size > MAX_ANCHORED_FILE_BYTES) {
			anchorUnavailableReason = `File exceeds the ${MAX_ANCHORED_FILE_BYTES / 1024 / 1024} MiB anchor limit.`;
			clearLineAnchors(absolutePath);
		} else if (totalLineCount > MAX_ANCHORED_FILE_LINES || !anchorLines) {
			anchorUnavailableReason = `File exceeds the ${MAX_ANCHORED_FILE_LINES.toLocaleString()}-line anchor limit.`;
			clearLineAnchors(absolutePath);
		} else {
			const allAnchors = reconcileLineAnchors(absolutePath, anchorLines);
			anchors = allAnchors.slice(startLine - 1, selectedEndLine);
		}
	}

	return {
		path: path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath),
		lines: selectedLines,
		startLine,
		endLine: selectedEndLine,
		totalLineCount,
		...(anchors ? { anchors } : {}),
		...(anchorUnavailableReason ? { anchorUnavailableReason } : {}),
	};
}

export function formatReadFileResult(result: ReadFileResult, includeAnchors = false, rangeRequested = false): string {
	const header = rangeRequested
		? `[Lines: ${result.startLine}-${result.endLine} of ${result.totalLineCount}]`
		: `[Total lines: ${result.totalLineCount}]`;
	const unavailable = result.anchorUnavailableReason
		? `\n[Hash anchoring unavailable: ${result.anchorUnavailableReason}]`
		: "";
	const content = includeAnchors && result.anchors
		? result.lines.map((line, index) => `${result.anchors![index]}§${line}`).join("\n")
		: result.lines.join("\n");
	const output = `${result.path}\n${header}${unavailable}\n${content}`;
	if (Buffer.byteLength(output, "utf8") > MAX_SELECTED_BYTES) {
		throw new Error(`Formatted output exceeds the ${MAX_SELECTED_BYTES}-byte read limit. Specify a smaller line range.`);
	}
	return output;
}
