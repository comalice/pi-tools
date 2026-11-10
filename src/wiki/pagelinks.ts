/**
 * Mechanical page-to-page wikilinking.
 *
 * Links prose mentions of other pages' titles or slugs as
 * [[page:slug|surface]] wikilinks. Same philosophy as the entity linker:
 * zone-aware (frontmatter, fences, headings, existing links, URLs, and
 * citation prefixes are protected), first occurrence per target per page,
 * no self-links. Dangling links are NOT pruned — the server renders them
 * red as a discovery queue for the librarian.
 */

export const PAGE_LINK = /\[\[page:([a-z0-9][a-z0-9-]{0,79})(?:\|([^\]\n]{1,160}))?\]\]/g;

// inline code, any wikilink, markdown links/images, bare URLs
const PROTECTED =
  /(`+[^`\n]*`+)|(\[\[[^\]\n]*\]\])|(!?\[[^\]\n]*\]\([^)\n]*\))|(https?:\/\/[^\s)\]>"]+)/g;

// Typed source citations — never link inside them.
const CITATION = /\b(?:pi|opencode|claude|wiki|doc|web):[0-9a-zA-Z][0-9a-zA-Z:._-]*/g;

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const MIN_TITLE_CHARS = 8;

export interface LinkablePage {
  slug: string;
  title: string;
}

interface Matcher {
  slug: string;
  pattern: RegExp;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build matchers for page titles and slugs, longest first. */
export function buildPageMatchers(pages: LinkablePage[]): Matcher[] {
  const matchers: Matcher[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const surface of [page.title, page.slug]) {
      const key = surface.toLowerCase();
      if (key.length < MIN_TITLE_CHARS || seen.has(key)) continue;
      seen.add(key);
      // Slugs contain hyphens; prose may use spaces instead. Allow both.
      const flexible = escapeRegex(surface).replace(/[-\s]+/g, "[-\\s]+");
      matchers.push({ slug: page.slug, pattern: new RegExp(`\\b(${flexible})\\b`, "i") });
    }
  }
  return matchers.sort((a, b) => (b.pattern.source.length - a.pattern.source.length));
}

/** Extract outgoing page-link targets from markdown. */
export function pageLinkTargets(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(PAGE_LINK)].map((m) => m[1]))];
}

function linkSegment(
  segment: string,
  matchers: Matcher[],
  linked: Set<string>,
  ownSlug: string,
): { text: string; added: number } {
  let added = 0;
  for (const matcher of matchers) {
    if (matcher.slug === ownSlug || linked.has(matcher.slug)) continue;
    const replaced = segment.replace(matcher.pattern, (whole, surface: string, offset: number) => {
      if (added && linked.has(matcher.slug)) return whole;
      // Don't link a mention that is part of a longer word.
      const before = segment[offset - 1];
      const after = segment[offset + whole.length];
      if ((before && /[\w-]/.test(before)) || (after && /[\w-]/.test(after))) return whole;
      linked.add(matcher.slug);
      added++;
      return `[[page:${matcher.slug}|${surface}]]`;
    });
    segment = replaced;
  }
  return { text: segment, added };
}

function linkLine(
  line: string,
  matchers: Matcher[],
  linked: Set<string>,
  ownSlug: string,
): { text: string; added: number } {
  let out = "";
  let cursor = 0;
  let added = 0;
  const protect = new RegExp(`${PROTECTED.source}|${CITATION.source}`, "g");
  for (const match of line.matchAll(protect)) {
    const start = match.index!;
    if (start > cursor) {
      const result = linkSegment(line.slice(cursor, start), matchers, linked, ownSlug);
      out += result.text;
      added += result.added;
    }
    out += match[0];
    cursor = start + match[0].length;
  }
  if (cursor < line.length) {
    const result = linkSegment(line.slice(cursor), matchers, linked, ownSlug);
    out += result.text;
    added += result.added;
  }
  return { text: out, added };
}

export function linkPageMentions(
  markdown: string,
  pages: LinkablePage[],
  ownSlug: string,
): { text: string; added: number } {
  const matchers = buildPageMatchers(pages);
  const linked = new Set<string>(pageLinkTargets(markdown));

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
    const result = linkLine(line, matchers, linked, ownSlug);
    out.push(result.text);
    added += result.added;
  }
  return { text: prefix + out.join("\n"), added };
}
