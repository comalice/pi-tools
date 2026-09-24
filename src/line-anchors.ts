// Stateful line coordinates adapted from Dirac's AnchorStateManager; see NOTICE.
import { randomInt } from "node:crypto";
import { diffArrays } from "diff";

interface AnchorDocument {
	lines: string[];
	anchors: string[];
	usedAnchors: Set<string>;
}

const MAX_TRACKED_FILES = 128;
const documents = new Map<string, AnchorDocument>();

function createAnchor(usedAnchors: Set<string>): string {
	while (true) {
		let anchor = String.fromCharCode(65 + randomInt(26));
		for (let index = 0; index < 5; index++) anchor += String.fromCharCode(97 + randomInt(26));
		if (!usedAnchors.has(anchor)) return anchor;
	}
}

export function reconcileLineAnchors(filePath: string, currentLines: string[]): string[] {
	const previous = documents.get(filePath);
	if (!previous) {
		const usedAnchors = new Set<string>();
		const anchors = currentLines.map(() => {
			const anchor = createAnchor(usedAnchors);
			usedAnchors.add(anchor);
			return anchor;
		});
		store(filePath, { lines: [...currentLines], anchors, usedAnchors });
		return anchors;
	}

	const anchors: string[] = [];
	const usedAnchors = new Set(previous.usedAnchors);
	let oldIndex = 0;
	for (const change of diffArrays(previous.lines, currentLines)) {
		if (change.added) {
			for (let index = 0; index < change.count!; index++) {
				const anchor = createAnchor(usedAnchors);
				usedAnchors.add(anchor);
				anchors.push(anchor);
			}
			continue;
		}
		if (change.removed) {
			oldIndex += change.count!;
			continue;
		}
		for (let index = 0; index < change.count!; index++) anchors.push(previous.anchors[oldIndex++]);
	}

	store(filePath, { lines: [...currentLines], anchors, usedAnchors });
	return anchors;
}

export function clearLineAnchors(filePath: string): void {
	documents.delete(filePath);
}

function store(filePath: string, document: AnchorDocument): void {
	documents.delete(filePath);
	documents.set(filePath, document);
	if (documents.size > MAX_TRACKED_FILES) documents.delete(documents.keys().next().value!);
}
