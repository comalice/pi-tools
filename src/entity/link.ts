import { Gazetteer } from "./gazetteer.ts";

/**
 * Entity auto-linker for wiki pages.
 *
 * Converts the FIRST plain-text occurrence of each known entity per page
 * into [[entity:Name|original surface]] wikilinks. Mechanical, idempotent:
 *
 *  - never touches frontmatter, fenced code, inline code, headings,
 *    existing links (wikilink or markdown), or URLs;
 *  - seeds its linked-set from existing [[entity:...]] links, so re-runs
 *    only add links for entities not yet linked on the page;
 *  - preserves the original surface casing inside the link's display text.
 *
 * LLMs never write these links by hand; run `wiki link-entities` after edits.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#/;
// inline code, wikilinks, markdown links/images, bare URLs
const PROTECTED =
  /(`+[^`\n]*`+)|(\[\[[^\]\n]*\]\])|(!?\[[^\]\n]*\]\([^)\n]*\))|(https?:\/\/[^\s)\]>"]+)/g;

const EXISTING_ENTITY_LINK = /\[\[entity:([^\]|]{1,80})/g;

// Typed source citations (pi:<session>:<entry>, claude:..., wiki:...) —
// never link inside them; 'pi' here is a provenance prefix, not the entity.
const CITATION = /\b(?:pi|opencode|claude|wiki|doc|web):[0-9a-zA-Z][0-9a-zA-Z:._-]*/g;

function linkSegment(
  segment: string,
  gazetteer: Gazetteer,
  linked: Set<string>,
): { text: string; added: number } {
  const hits = gazetteer
    .find(segment)
    .sort((a, b) => a.offset - b.offset || b.surface.length - a.surface.length);
  if (hits.length === 0) return { text: segment, added: 0 };

  let cursor = 0;
  let added = 0;
  let out = "";
  for (const hit of hits) {
    if (hit.offset < cursor) continue; // overlaps an accepted hit
    if (linked.has(hit.entity)) continue; // first occurrence per page only
    const surface = segment.slice(hit.offset, hit.offset + hit.surface.length);
    out += segment.slice(cursor, hit.offset);
    out += `[[entity:${hit.entity}|${surface}]]`;
    cursor = hit.offset + hit.surface.length;
    linked.add(hit.entity);
    added++;
  }
  out += segment.slice(cursor);
  return { text: out, added };
}

function linkLine(
  line: string,
  gazetteer: Gazetteer,
  linked: Set<string>,
): { text: string; added: number } {
  PROTECTED.lastIndex = 0;
  CITATION.lastIndex = 0;
  let cursor = 0;
  let added = 0;
  let out = "";
  const spans = [...line.matchAll(PROTECTED), ...line.matchAll(CITATION)].sort(
    (a, b) => a.index! - b.index!,
  );
  for (const match of spans) {
    if (match.index! < cursor) continue; // inside an already-consumed span
    const start = match.index!;
    if (start > cursor) {
      const result = linkSegment(line.slice(cursor, start), gazetteer, linked);
      out += result.text;
      added += result.added;
    }
    out += match[0];
    cursor = start + match[0].length;
  }
  if (cursor < line.length) {
    const result = linkSegment(line.slice(cursor), gazetteer, linked);
    out += result.text;
    added += result.added;
  }
  return { text: out, added };
}

export function linkEntityMentions(
  markdown: string,
  gazetteer: Gazetteer,
): { text: string; added: number } {
  // Prune links whose target is no longer a linkable entity (rejected or
  // dropped from the registry): unwrap to the display surface.
  markdown = markdown.replace(
    /\[\[entity:([^\]|]{1,80})(?:\|([^\]\n]{1,120}))?\]\]/g,
    (whole, name: string, surface?: string) => (gazetteer.has(name) ? whole : (surface ?? name)),
  );

  const linked = new Set<string>();
  for (const match of markdown.matchAll(EXISTING_ENTITY_LINK)) {
    linked.add(match[1]);
  }

  // detach YAML frontmatter
  let prefix = "";
  let body = markdown;
  if (body.startsWith("---\n")) {
    const closeMatch = body.slice(4).match(/\n---\n/);
    if (closeMatch) {
      const cut = 4 + closeMatch.index! + closeMatch[0].length;
      prefix = body.slice(0, cut);
      body = body.slice(cut);
    }
  }

  let inFence = false;
  let added = 0;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || HEADING.test(line)) {
      out.push(line);
      continue;
    }
    const result = linkLine(line, gazetteer, linked);
    out.push(result.text);
    added += result.added;
  }
  return { text: prefix + out.join("\n"), added };
}
