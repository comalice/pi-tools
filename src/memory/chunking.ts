import { createHash } from "node:crypto";

export const CHUNKING_REVISION = "chars-1400-overlap-200-v1";
export interface MemoryChunk {
  start: number;
  end: number;
  text: string;
  contentHash: string;
  chunkHash: string;
}

function safeBoundary(text: string, offset: number): number {
  if (offset > 0 && offset < text.length) {
    const previous = text.charCodeAt(offset - 1);
    const current = text.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return offset - 1;
  }
  return offset;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkText(text: string, size = 1400, overlap = 200): MemoryChunk[] {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("chunk size and overlap are invalid");
  }
  const fullHash = contentHash(text);
  const chunks: MemoryChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = safeBoundary(text, Math.min(text.length, start + size));
    if (end <= start) end = Math.min(text.length, start + size + 1);
    const value = text.slice(start, end);
    chunks.push({ start, end, text: value, contentHash: fullHash, chunkHash: contentHash(`${start}\0${end}\0${value}`) });
    if (end === text.length) break;
    const candidate = safeBoundary(text, Math.max(start + 1, end - overlap));
    start = candidate > start ? candidate : end;
  }
  return chunks;
}
