// Wiki page format: a markdown file with a small strict YAML-lite frontmatter block.
// Strictness is deliberate: pages are primarily written by agents, and a rejected
// field with a clear error is better feedback than a silently ignored one.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const MAX_BODY_CHARS = 200_000;
const KNOWN_FIELDS = new Set(["title", "slug", "created", "last_verified", "tags", "sources"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface PageMeta {
  title: string;
  slug: string;
  created: string;
  last_verified: string;
  tags: string[];
  sources: string[];
}

export interface Page {
  meta: PageMeta;
  body: string;
}

export function slugify(title: string): string {
  const full = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length > 80) throw new Error(`Title slug would be truncated at 80 characters (${full.slice(0, 40)}…); pass an explicit --slug`);
  if (!full || !SLUG_PATTERN.test(full)) throw new Error(`Cannot derive a valid slug from title: ${title}`);
  return full;
}

function field(name: string, value: string): string {
  if (!value.trim()) throw new Error(`Page field ${name} must not be empty`);
  if (value.length > 300) throw new Error(`Page field ${name} exceeds 300 characters`);
  return value.trim();
}

export function parsePage(text: string, file = "page"): Page {
  if (text.length > MAX_BODY_CHARS + 8192) throw new Error(`${file}: page exceeds size limit`);
  if (!text.startsWith("---\n")) throw new Error(`${file}: missing opening frontmatter delimiter`);
  const close = text.indexOf("\n---\n", 4);
  if (close < 0) throw new Error(`${file}: missing closing frontmatter delimiter`);
  const block = text.slice(4, close).split("\n");
  const body = text.slice(close + 5).replace(/^\n+/, "");
  if (body.length > MAX_BODY_CHARS) throw new Error(`${file}: body exceeds ${MAX_BODY_CHARS} characters`);
  const raw: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    const item = line.match(/^- (.*)$/);
    if (item && listKey) {
      (raw[listKey] as string[]).push(field(listKey, item[1]));
      continue;
    }
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) throw new Error(`${file}: malformed frontmatter line ${i + 1}: ${line}`);
    const [, key, value] = match;
    if (!KNOWN_FIELDS.has(key)) throw new Error(`${file}: unknown frontmatter field "${key}" (known: ${[...KNOWN_FIELDS].join(", ")})`);
    if (raw[key] !== undefined) throw new Error(`${file}: repeated frontmatter field "${key}"`);
    if (value === "") {
      raw[key] = [];
      listKey = key;
    } else {
      raw[key] = value;
      listKey = null;
    }
  }
  for (const required of ["title", "slug", "created", "last_verified"]) {
    if (typeof raw[required] !== "string" || !(raw[required] as string).trim()) throw new Error(`${file}: missing required frontmatter field "${required}"`);
  }
  const meta: PageMeta = {
    title: field("title", raw.title as string),
    slug: field("slug", raw.slug as string),
    created: field("created", raw.created as string),
    last_verified: field("last_verified", raw.last_verified as string),
    tags: (Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === "string" ? (raw.tags as string).split(",") : []).map(tag => field("tags", tag)).slice(0, 12),
    sources: (Array.isArray(raw.sources) ? raw.sources : typeof raw.sources === "string" ? (raw.sources as string).split(",") : []).map(source => field("sources", source)).slice(0, 64),
  };
  if (!SLUG_PATTERN.test(meta.slug)) throw new Error(`${file}: slug "${meta.slug}" must match ${SLUG_PATTERN}`);
  if (!DATE_PATTERN.test(meta.created) || Number.isNaN(Date.parse(meta.created))) throw new Error(`${file}: created must be a YYYY-MM-DD date`);
  if (!DATE_PATTERN.test(meta.last_verified) || Number.isNaN(Date.parse(meta.last_verified))) throw new Error(`${file}: last_verified must be a YYYY-MM-DD date`);
  if (meta.sources.some(source => !/^[a-z]+:\S+/.test(source))) throw new Error(`${file}: sources must look like "<kind>:<id>", e.g. "pi:<session>:<entry>" or "doc:0017"`);
  return { meta, body };
}

export function serializePage(meta: PageMeta, body: string): string {
  const lines = [
    "---",
    `title: ${meta.title}`,
    `slug: ${meta.slug}`,
    `created: ${meta.created}`,
    `last_verified: ${meta.last_verified}`,
    meta.tags.length ? `tags: ${meta.tags.join(", ")}` : "tags:",
    ...(meta.sources.length ? ["sources:", ...meta.sources.map(source => `- ${source}`)] : ["sources:"]),
    "---",
    "",
    body.replace(/^\n+/, "").replace(/\s*$/, "\n"),
  ];
  return lines.join("\n");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Text stored in the memory archive for a page: title and tags are part of the
// retrievable text; provenance stays in the frontmatter and the conventional
// "## Sources" body section.
export function indexableText(page: Page): string {
  const tags = page.meta.tags.length ? `\ntags: ${page.meta.tags.join(", ")}` : "";
  return `# ${page.meta.title}${tags}\n\n${page.body}`.slice(0, 100_000);
}
