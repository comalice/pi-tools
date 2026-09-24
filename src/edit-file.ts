// Anchored edit port of Dirac's edit_file tool; see NOTICE.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { MAX_ANCHORED_FILE_BYTES, MAX_ANCHORED_FILE_LINES } from "./read-file.ts";
import { reconcileLineAnchors } from "./line-anchors.ts";

const MAX_FILES = 8;
const MAX_EDITS_PER_FILE = 50;
const MAX_PREVIEW_BYTES = 24 * 1024;
const ANCHOR_DELIMITER = "§";

type EditType = "replace" | "insert_after" | "insert_before";

export interface AnchoredEdit {
	edit_type: EditType;
	anchor: string;
	end_anchor?: string;
	text: string;
}

export interface FileEditRequest {
	path: string;
	edits: AnchoredEdit[];
}

interface ResolvedEdit {
	edit: AnchoredEdit;
	editIndex: number;
	startIndex: number;
	endIndex: number;
	spliceIndex: number;
}

interface FilePlan {
	path: string;
	absolutePath: string;
	originalContent: string;
	updatedContent: string;
	updatedLines: string[];
	editCount: number;
	preview: string;
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseAnchor(value: string): { id: string; content: string } | undefined {
	if (value.includes("\n") || value.includes("\r")) return undefined;
	const delimiterIndex = value.indexOf(ANCHOR_DELIMITER);
	if (delimiterIndex < 1) return undefined;
	const id = value.slice(0, delimiterIndex);
	if (!/^[A-Z][a-zA-Z]*$/.test(id)) return undefined;
	return { id, content: value.slice(delimiterIndex + ANCHOR_DELIMITER.length) };
}

function hasAnchoredSourceLine(text: string): boolean {
	return text.split(/\r?\n/).some((line) => parseAnchor(line) !== undefined);
}

function resolveAnchor(value: string, lines: string[], anchors: string[], editIndex: number, field: string): number {
	const parsed = parseAnchor(value);
	if (!parsed) throw new Error(`edits[${editIndex}].${field} must be one complete ANCHOR§CONTENT line copied from read_file.`);
	const index = anchors.indexOf(parsed.id);
	if (index < 0) throw new Error(`edits[${editIndex}].${field} ID was not found in the current file. Reread the relevant range with include_anchors: true.`);
	if (anchors.lastIndexOf(parsed.id) !== index) throw new Error(`edits[${editIndex}].${field} ID is not unique in the current file.`);
	if (lines[index] !== parsed.content) throw new Error(`edits[${editIndex}].${field} content does not match the current source line. Reread the relevant range with include_anchors: true.`);
	return index;
}

function insertionBoundary(edit: AnchoredEdit, lineIndex: number, lines: string[]): number {
	if (edit.edit_type === "insert_before") return lineIndex;
	if (lineIndex === lines.length - 1 && lines.length > 1 && lines[lineIndex] === "") return lineIndex;
	return lineIndex + 1;
}

function editsConflict(left: ResolvedEdit, right: ResolvedEdit): boolean {
	const leftReplace = left.edit.edit_type === "replace";
	const rightReplace = right.edit.edit_type === "replace";
	if (leftReplace && rightReplace) return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
	if (!leftReplace && !rightReplace) return left.spliceIndex === right.spliceIndex;
	const replacement = leftReplace ? left : right;
	const insertion = leftReplace ? right : left;
	return insertion.spliceIndex >= replacement.startIndex && insertion.spliceIndex <= replacement.endIndex + 1;
}

function splitLines(content: string): string[] {
	return content.split(/\r?\n/);
}

function applyResolvedEdits(lines: string[], edits: ResolvedEdit[]): string[] {
	const result = [...lines];
	const ordered = [...edits].sort((left, right) => right.spliceIndex - left.spliceIndex);
	for (const resolved of ordered) {
		const { edit, spliceIndex } = resolved;
		const removeCount = edit.edit_type === "replace" ? resolved.endIndex - resolved.startIndex + 1 : 0;
		const replacementLines = edit.text === "" ? [] : splitLines(edit.text);
		if (edit.text.endsWith("\n") && spliceIndex + removeCount < lines.length) replacementLines.pop();
		result.splice(spliceIndex, removeCount, ...replacementLines);
	}
	return result;
}

function prepareEdits(file: FileEditRequest, absolutePath: string, content: string): FilePlan {
	const lines = splitLines(content);
	if (Buffer.byteLength(content, "utf8") > MAX_ANCHORED_FILE_BYTES) {
		throw new Error(`${file.path} exceeds the ${MAX_ANCHORED_FILE_BYTES / 1024 / 1024} MiB edit limit.`);
	}
	if (lines.length > MAX_ANCHORED_FILE_LINES) {
		throw new Error(`${file.path} exceeds the ${MAX_ANCHORED_FILE_LINES.toLocaleString()}-line edit limit.`);
	}
	if (file.edits.length === 0 || file.edits.length > MAX_EDITS_PER_FILE) {
		throw new Error(`${file.path} must have between 1 and ${MAX_EDITS_PER_FILE} edits.`);
	}

	const anchors = reconcileLineAnchors(absolutePath, lines);
	const resolved: ResolvedEdit[] = file.edits.map((edit, editIndex) => {
		if (!edit || !["replace", "insert_after", "insert_before"].includes(edit.edit_type)) {
			throw new Error(`edits[${editIndex}].edit_type must be replace, insert_after, or insert_before.`);
		}
		if (typeof edit.text !== "string") throw new Error(`edits[${editIndex}].text must be a string.`);
		if (hasAnchoredSourceLine(edit.text)) throw new Error(`edits[${editIndex}].text must contain source text without line anchors.`);
		if (edit.edit_type === "replace" && typeof edit.end_anchor !== "string") {
			throw new Error(`edits[${editIndex}].end_anchor is required for replace.`);
		}
		if (edit.edit_type !== "replace" && edit.end_anchor !== undefined) {
			throw new Error(`edits[${editIndex}].end_anchor is only valid for replace.`);
		}

		const startIndex = resolveAnchor(edit.anchor, lines, anchors, editIndex, "anchor");
		const endIndex = edit.edit_type === "replace"
			? resolveAnchor(edit.end_anchor!, lines, anchors, editIndex, "end_anchor")
			: startIndex;
		if (endIndex < startIndex) throw new Error(`edits[${editIndex}] has a reversed replace range.`);
		return {
			edit,
			editIndex,
			startIndex,
			endIndex,
			spliceIndex: edit.edit_type === "replace" ? startIndex : insertionBoundary(edit, startIndex, lines),
		};
	});

	for (let leftIndex = 0; leftIndex < resolved.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < resolved.length; rightIndex++) {
			if (editsConflict(resolved[leftIndex], resolved[rightIndex])) {
				throw new Error(`edits[${resolved[leftIndex].editIndex}] and edits[${resolved[rightIndex].editIndex}] overlap; no edits were applied.`);
			}
		}
	}

	const updatedLines = applyResolvedEdits(lines, resolved);
	if (updatedLines.length > MAX_ANCHORED_FILE_LINES) throw new Error(`${file.path} would exceed the ${MAX_ANCHORED_FILE_LINES.toLocaleString()}-line edit limit.`);
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const updatedContent = updatedLines.join(newline);
	if (Buffer.byteLength(updatedContent, "utf8") > MAX_ANCHORED_FILE_BYTES) {
		throw new Error(`${file.path} would exceed the ${MAX_ANCHORED_FILE_BYTES / 1024 / 1024} MiB edit limit.`);
	}
	return {
		path: file.path,
		absolutePath,
		originalContent: content,
		updatedContent,
		updatedLines,
		editCount: resolved.length,
		preview: createPatch(file.path, content, updatedContent, "before", "after"),
	};
}

async function resolveFilePath(cwd: string, requestedPath: string): Promise<{ absolutePath: string; displayPath: string }> {
	const workspaceRoot = await fs.realpath(cwd);
	const requestedAbsolutePath = path.resolve(workspaceRoot, requestedPath);
	if (!isWithin(workspaceRoot, requestedAbsolutePath)) throw new Error(`Path is outside the Pi working directory: ${requestedPath}`);
	const absolutePath = await fs.realpath(requestedAbsolutePath);
	if (!isWithin(workspaceRoot, absolutePath)) throw new Error(`Path resolves outside the Pi working directory: ${requestedPath}`);
	return { absolutePath, displayPath: path.relative(workspaceRoot, absolutePath) || path.basename(absolutePath) };
}

async function decodeTextFile(filePath: string): Promise<string> {
	const bytes = await fs.readFile(filePath);
	if (bytes.includes(0)) throw new Error(`${filePath} is binary and cannot be edited as text.`);
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error(`${filePath} is not valid UTF-8 text and cannot be edited by this tool.`);
	}
}

async function writeAtomically(filePath: string, content: string, mode: number): Promise<void> {
	const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporaryPath, content, { flag: "wx", mode: mode & 0o777 });
		await fs.chmod(temporaryPath, mode & 0o777);
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

async function withFileQueues<T>(filePaths: string[], index: number, operation: () => Promise<T>): Promise<T> {
	if (index >= filePaths.length) return operation();
	return withFileMutationQueue(filePaths[index], () => withFileQueues(filePaths, index + 1, operation));
}

export async function editFiles(
	cwd: string,
	files: FileEditRequest[],
	confirm: (preview: string) => Promise<boolean>,
): Promise<string> {
	if (files.length === 0 || files.length > MAX_FILES) throw new Error(`Provide between 1 and ${MAX_FILES} files to edit.`);
	const resolvedFiles = await Promise.all(files.map(async (file) => ({
		file,
		...(await resolveFilePath(cwd, file.path)),
	})));
	const absolutePaths = resolvedFiles.map((file) => file.absolutePath);
	if (new Set(absolutePaths).size !== absolutePaths.length) throw new Error("Each file may appear only once in a batch.");
	const orderedLockPaths = [...absolutePaths].sort();

	return withFileQueues(orderedLockPaths, 0, async () => {
		const plans: FilePlan[] = [];
		for (const resolved of resolvedFiles) {
			const stats = await fs.stat(resolved.absolutePath);
			if (!stats.isFile()) throw new Error(`Expected a file: ${resolved.file.path}`);
			const content = await decodeTextFile(resolved.absolutePath);
			plans.push(prepareEdits(resolved.file, resolved.absolutePath, content));
		}

		const changedPlans = plans.filter((plan) => plan.originalContent !== plan.updatedContent);
		if (changedPlans.length === 0) return "No file changes were needed.";
		const preview = changedPlans.map((plan) => plan.preview).join("\n");
		if (Buffer.byteLength(preview, "utf8") > MAX_PREVIEW_BYTES) {
			throw new Error(`The edit preview exceeds ${MAX_PREVIEW_BYTES} bytes. Split this into smaller batches so the complete diff can be reviewed.`);
		}
		if (!await confirm(preview)) return "Edit cancelled; no files were changed.";

		for (const plan of changedPlans) {
			const currentContent = await decodeTextFile(plan.absolutePath);
			if (currentContent !== plan.originalContent) {
				throw new Error(`${plan.path} changed while waiting for approval. No edit was applied; reread it and retry.`);
			}
		}

		for (const plan of changedPlans) {
			const latestContent = await decodeTextFile(plan.absolutePath);
			if (latestContent !== plan.originalContent) {
				throw new Error(`${plan.path} changed during the edit batch. Earlier files may already have been written; reread all targets before retrying.`);
			}
			const stats = await fs.stat(plan.absolutePath);
			await writeAtomically(plan.absolutePath, plan.updatedContent, stats.mode);
			reconcileLineAnchors(plan.absolutePath, plan.updatedLines);
		}

		return `Applied ${changedPlans.reduce((total, plan) => total + plan.editCount, 0)} anchored edit(s) to ${changedPlans.length} file(s): ${changedPlans.map((plan) => plan.path).join(", ")}.`;
	});
}
