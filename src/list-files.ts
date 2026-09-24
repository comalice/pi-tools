// Adapted from Dirac's list_files behavior; see NOTICE for attribution and changes.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_FILES = 200;
const IGNORED_NAMES = new Set([
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"dist",
	"out",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"Pods",
]);
const IGNORED_PATHS = ["target/dependency", "build/dependencies"];

export interface ListedFile {
	path: string;
	mtime: number;
	isDirectory: boolean;
	lineCount?: number;
}

export interface ListFilesResult {
	files: ListedFile[];
	didHitLimit: boolean;
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRestrictedPath(absolutePath: string): boolean {
	const root = path.parse(absolutePath).root;
	return absolutePath === root || absolutePath === path.resolve(os.homedir());
}

function shouldIgnore(name: string, relativePath: string, allowHidden: boolean): boolean {
	if (!allowHidden && name.startsWith(".")) return true;
	if (IGNORED_NAMES.has(name) || name.endsWith(".log")) return true;
	if (IGNORED_PATHS.some((ignoredPath) => relativePath === ignoredPath || relativePath.startsWith(`${ignoredPath}${path.sep}`))) return true;
	return false;
}

async function countLines(filePath: string): Promise<number | undefined> {
	const content = await fs.readFile(filePath);
	if (content.includes(0)) return undefined;
	let lineCount = 1;
	for (const byte of content) {
		if (byte === 10) lineCount++;
	}
	return lineCount;
}

export async function listFiles(cwd: string, requestedPath: string, recursive = false): Promise<ListFilesResult> {
	const workspaceRoot = await fs.realpath(cwd);
	const requestedAbsolutePath = path.resolve(workspaceRoot, requestedPath);
	if (!isWithin(workspaceRoot, requestedAbsolutePath)) {
		throw new Error(`Path is outside the Pi working directory: ${requestedPath}`);
	}

	let absolutePath: string;
	try {
		absolutePath = await fs.realpath(requestedAbsolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], didHitLimit: false };
		throw error;
	}
	if (!isWithin(workspaceRoot, absolutePath)) {
		throw new Error(`Path resolves outside the Pi working directory: ${requestedPath}`);
	}
	if (isRestrictedPath(absolutePath)) return { files: [], didHitLimit: false };

	const rootStat = await fs.stat(absolutePath);
	if (!rootStat.isDirectory()) {
		return {
			files: [{ path: path.basename(requestedAbsolutePath), mtime: rootStat.mtimeMs, isDirectory: false, lineCount: await countLines(absolutePath) }],
			didHitLimit: false,
		};
	}

	const allowHidden = path.basename(absolutePath).startsWith(".");
	const files: ListedFile[] = [];
	const queue = [{ absolutePath, relativePath: "" }];
	for (let index = 0; index < queue.length && files.length < MAX_FILES; index++) {
		const current = queue[index];
		const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
		const sortedEntries = await Promise.all(
			entries
				.filter((entry) => !entry.isSymbolicLink() && !shouldIgnore(entry.name, path.join(current.relativePath, entry.name), allowHidden))
				.map(async (entry) => {
					const absoluteEntryPath = path.join(current.absolutePath, entry.name);
					const stats = await fs.stat(absoluteEntryPath);
					return { entry, absoluteEntryPath, mtime: stats.mtimeMs, isDirectory: stats.isDirectory() };
				}),
		);
		sortedEntries.sort((a, b) => b.mtime - a.mtime || a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: "base" }));

		for (const { entry, absoluteEntryPath, mtime, isDirectory } of sortedEntries) {
			if (files.length >= MAX_FILES) break;
			const relativePath = path.join(current.relativePath, entry.name);
			const listedFile: ListedFile = { path: relativePath, mtime, isDirectory };
			if (!isDirectory) listedFile.lineCount = await countLines(absoluteEntryPath);
			files.push(listedFile);
			if (recursive && isDirectory) queue.push({ absolutePath: absoluteEntryPath, relativePath });
		}
	}

	return { files, didHitLimit: files.length >= MAX_FILES };
}
