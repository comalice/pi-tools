import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { piGenerate, type Generate } from "../dream/worker.ts";
import { loadRegistry } from "./registry.ts";
import { slugify } from "../wiki/format.ts";

/**
 * Entity dossiers: derived, agent-maintained knowledge pages per entity.
 *
 * Trust model: dossiers are DERIVED (never indexed as evidence, never
 * git-tracked, never hand-edited). Updates are watermark-triggered and
 * fragment-dispositioned: every existing fragment must be explicitly
 * kept/amended/retired/merged each run, so nothing is lost silently.
 * Citations may only reference entry IDs from the entity's own mention set
 * in the sidecar — a closed, mechanically verifiable citation universe.
 *
 * Tempo: manual for now. When scheduled: weekly, after the dream timer,
 * watermark-gated per entity (a quiet week regenerates nothing).
 */

export interface Fragment {
  id: string;
  page: string | null; // null = hub page
  body: string;
  citations: string[]; // archive entry IDs from the entity's mention set
}

export interface RetiredFragment {
  id: string;
  body: string;
  citations: string[];
  reason: string;
  retired_at: string;
}

export interface DossierPage {
  suffix: string | null;
  title: string;
}

export interface Dossier {
  entity: string;
  entity_type: string;
  pages: DossierPage[];
  fragments: Fragment[];
  retired: RetiredFragment[];
  watermark: number; // max mention result_id processed
  next_fragment: number;
  built_at: string;
  split_hint: string | null;
}

const MAX_DOCS = 40;
const MAX_DOC_CHARS = 4000;
const MAX_TOTAL_CHARS = 30_000;
const MAX_FRAGMENT_BODY = 2500;
const MAX_FRAGMENTS = 40;
const MAX_PAGES = 5;
const SUFFIX_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function dossiersDir(wikiDir: string): string {
  return join(wikiDir, "dossiers");
}

export function dossierPath(wikiDir: string, entity: string): string {
  return join(dossiersDir(wikiDir), `${slugify(entity)}.json`);
}

export function loadDossier(wikiDir: string, entity: string): Dossier | null {
  const file = dossierPath(wikiDir, entity);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Dossier;
}

interface MentionRow {
  mid: number; // mentions.rowid — monotonic with scan order, used for watermarks
  result_id: string;
  entry_id: string | null;
  count: number;
}

function mentionRows(db: DatabaseSync, entity: string): MentionRow[] {
  return db
    .prepare("SELECT rowid AS mid, result_id, entry_id, count FROM mentions WHERE entity = ? ORDER BY rowid")
    .all(entity) as unknown as MentionRow[];
}

function citationUniverse(rows: MentionRow[]): Set<string> {
  return new Set(rows.map((r) => r.entry_id).filter((e): e is string => !!e));
}

function dossierPrompt(opts: {
  entity: string;
  entityType: string;
  existing: Dossier | null;
  docs: { resultId: string; entryId: string; text: string }[];
  feedback?: string;
}): string {
  const parts: string[] = [];
  if (opts.feedback) parts.push(`NOTE: ${opts.feedback}`);
  parts.push(
    `You maintain a derived knowledge dossier about the entity "${opts.entity}" (type: ${opts.entityType}).`,
    `Fragments are short, atomic notes (facts, decisions, issues, open questions). Every fragment cites ENTRY ids from the documents shown. Never invent content; only use the documents.`,
  );
  if (opts.existing && opts.existing.fragments.length > 0) {
    parts.push(`EXISTING FRAGMENTS (you MUST emit exactly one disposition per fragment id):`);
    for (const f of opts.existing.fragments) {
      parts.push(`[${f.id}] (page: ${f.page ?? "hub"}) ${f.body}  <citations: ${f.citations.join(", ")}>`);
    }
  } else {
    parts.push(`No existing fragments — this is the initial build.`);
  }
  parts.push(`NEW DOCUMENTS:`);
  for (const d of opts.docs) {
    parts.push(`--- DOC ${d.resultId} ENTRY ${d.entryId} ---\n${d.text}`);
  }
  parts.push(`Emit ONE JSON object (no prose, no fences):
{
  "dispositions": [
    {"id": "f1", "action": "keep"}
    | {"id": "f1", "action": "amend", "body": "...", "citations": ["..."]}
    | {"id": "f1", "action": "retire", "reason": "..."}
    | {"id": "f1", "action": "merge", "into": "f2"}
  ],
  "new_fragments": [{"page": null, "body": "...", "citations": ["..."]}],
  "pages": [{"suffix": null, "title": "..."}, {"suffix": "thermal-qualification", "title": "..."}],
  "split_hint": null
}
Rules:
- Exactly one disposition per existing fragment id. "keep" preserves it verbatim; prefer keep unless the fragment is wrong, stale, or redundant. "merge" retires the fragment into another (citations union).
- "new_fragments[].page" is null (hub page) or a page suffix. Use refinement pages when the documents cover distinct facets; do not force everything onto the hub. At most 3 refinement pages.
- "pages" is optional; only emit it to declare refinement pages (max ${MAX_PAGES} total including hub). Declare each page ONCE. Suffixes: lowercase, hyphens, <= 40 chars.
- Citations: only the short (8-character) ENTRY ids from the documents above — never the long DOC ids — plus existing fragment citations for keep/merge.
- Bodies: <= 120 words each, plain text, no markdown headers.
- "split_hint": a short note ONLY if the documents suggest this name refers to two different things; otherwise null.`);
  return parts.join("\n\n");
}

interface RawUpdate {
  dispositions?: any[];
  new_fragments?: any[];
  pages?: any[];
  split_hint?: string | null;
}

export function extractJsonObject(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/gm, "").replace(/```\s*$/gm, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

export function validateUpdate(
  raw: RawUpdate,
  existing: Dossier | null,
  universe: Set<string>,
): { errors: string[] } {
  const errors: string[] = [];
  const live = existing?.fragments ?? [];
  const seen = new Set<string>();
  const dispositions = raw.dispositions ?? [];
  if (!Array.isArray(dispositions)) {
    return { errors: ["dispositions must be an array"] };
  }
  const liveIds = new Set(live.map((f) => f.id));
  for (const d of dispositions) {
    if (typeof d?.id !== "string") {
      errors.push("disposition missing id");
      continue;
    }
    if (!liveIds.has(d.id)) {
      errors.push(`disposition for unknown fragment ${d.id}`);
      continue;
    }
    if (seen.has(d.id)) {
      errors.push(`duplicate disposition for ${d.id}`);
      continue;
    }
    seen.add(d.id);
    if (!["keep", "amend", "retire", "merge"].includes(d.action)) {
      errors.push(`${d.id}: unknown action ${JSON.stringify(d.action)}`);
      continue;
    }
    if (d.action === "amend") {
      if (typeof d.body !== "string" || !d.body.trim()) errors.push(`${d.id}: amend requires a body`);
      if (!Array.isArray(d.citations) || d.citations.length === 0) errors.push(`${d.id}: amend requires citations`);
    }
    if (d.action === "retire" && (typeof d.reason !== "string" || !d.reason.trim())) {
      errors.push(`${d.id}: retire requires a reason`);
    }
    if (d.action === "merge" && (typeof d.into !== "string" || !liveIds.has(d.into) || d.into === d.id)) {
      errors.push(`${d.id}: merge requires a different live target`);
    }
    for (const c of Array.isArray(d.citations) ? d.citations : []) {
      if (typeof c !== "string" || !universe.has(c)) errors.push(`${d.id}: citation ${c} outside mention set`);
    }
  }
  for (const f of live) {
    if (!seen.has(f.id)) errors.push(`fragment ${f.id} has no disposition (silent loss rejected)`);
  }

  const declaredPages: (DossierPage | null)[] = [];
  if (raw.pages !== undefined) {
    if (!Array.isArray(raw.pages) || raw.pages.length > MAX_PAGES) {
      errors.push(`pages must be an array of at most ${MAX_PAGES}`);
    } else {
      for (const p of raw.pages) {
        if (p.suffix !== null && (typeof p.suffix !== "string" || !SUFFIX_RE.test(p.suffix))) {
          errors.push(`bad page suffix ${JSON.stringify(p.suffix)}`);
          continue;
        }
        if (typeof p.title !== "string" || !p.title.trim()) errors.push("page requires a title");
        declaredPages.push({ suffix: p.suffix ?? null, title: p.title ?? "" });
      }
    }
  }
  const suffixes = new Set<string | null>([null]); // hub is always valid
  for (const p of raw.pages !== undefined ? declaredPages : (existing?.pages ?? [])) {
    suffixes.add(p?.suffix ?? null);
  }
  if (raw.pages !== undefined) {
    const seenSuffix = new Set<string | null>();
    for (const p of declaredPages) {
      if (p && seenSuffix.has(p.suffix)) errors.push("duplicate page suffixes");
      if (p) seenSuffix.add(p.suffix);
    }
  }

  const newFragments = raw.new_fragments ?? [];
  if (!Array.isArray(newFragments)) return { errors: [...errors, "new_fragments must be an array"] };
  for (const [i, f] of newFragments.entries()) {
    const label = `new_fragments[${i}]`;
    if (typeof f?.body !== "string" || !f.body.trim()) {
      errors.push(`${label}: body required`);
      continue;
    }
    if (f.body.length > MAX_FRAGMENT_BODY) errors.push(`${label}: body exceeds ${MAX_FRAGMENT_BODY} chars`);
    if (!Array.isArray(f.citations) || f.citations.length === 0) {
      errors.push(`${label}: at least one citation required`);
      continue;
    }
    for (const c of f.citations) {
      if (typeof c !== "string" || !universe.has(c)) errors.push(`${label}: citation ${c} outside mention set`);
    }
    if (f.page !== null && f.page !== undefined && !suffixes.has(f.page)) {
      errors.push(`${label}: references undeclared page ${JSON.stringify(f.page)}`);
    }
  }
  if (live.length + newFragments.length > MAX_FRAGMENTS) {
    errors.push(`would exceed ${MAX_FRAGMENTS} live fragments`);
  }
  return { errors };
}

export function applyUpdate(existing: Dossier | null, entity: string, entityType: string, raw: RawUpdate, watermark: number): Dossier {
  const now = new Date().toISOString();
  const live = existing?.fragments ?? [];
  const retired = [...(existing?.retired ?? [])];
  let next = existing?.next_fragment ?? 1;

  const pages: DossierPage[] =
    raw.pages && raw.pages.length > 0
      ? raw.pages.map((p: any) => ({ suffix: p.suffix ?? null, title: p.title }))
      : (existing?.pages ?? [{ suffix: null, title: "" }]);
  if (!pages.some((p) => p.suffix === null)) {
    pages.unshift({ suffix: null, title: entity }); // hub always exists
  }

  const fragments: Fragment[] = [];
  const mergeTargets = new Map<string, string[]>();
  for (const d of raw.dispositions ?? []) {
    if (d.action === "merge") {
      const list = mergeTargets.get(d.into) ?? [];
      list.push(d.id);
      mergeTargets.set(d.into, list);
    }
  }
  for (const d of raw.dispositions ?? []) {
    const frag = live.find((f) => f.id === d.id)!;
    if (d.action === "keep") {
      const merged = mergeTargets.get(frag.id) ?? [];
      const mergedCites = merged.flatMap((id) => live.find((f) => f.id === id)!.citations);
      fragments.push({ ...frag, citations: [...new Set([...frag.citations, ...mergedCites])] });
    } else if (d.action === "amend") {
      const merged = mergeTargets.get(frag.id) ?? [];
      const mergedCites = merged.flatMap((id) => live.find((f) => f.id === id)!.citations);
      fragments.push({ ...frag, body: d.body, citations: [...new Set([...d.citations, ...mergedCites])] });
    } else if (d.action === "retire") {
      retired.push({ id: frag.id, body: frag.body, citations: frag.citations, reason: d.reason, retired_at: now });
    } else if (d.action === "merge") {
      retired.push({ id: frag.id, body: frag.body, citations: frag.citations, reason: `merged into ${d.into}`, retired_at: now });
    }
  }
  for (const f of raw.new_fragments ?? []) {
    fragments.push({ id: `f${next++}`, page: f.page ?? null, body: f.body, citations: f.citations });
  }
  return {
    entity,
    entity_type: entityType,
    pages,
    fragments,
    retired,
    watermark,
    next_fragment: next,
    built_at: now,
    split_hint: raw.split_hint ?? null,
  };
}

export interface DossierResult {
  entity: string;
  status: "built" | "updated" | "current" | "error";
  liveFragments: number;
  retiredTotal: number;
  newDocuments: number;
  splitHint: string | null;
  error?: string;
}

export async function updateDossier(opts: {
  entity: string;
  wikiDir: string;
  archivePath: string;
  entityDbPath: string;
  model: string;
  rebuild?: boolean;
  maxDocs?: number;
}, generate: Generate = piGenerate): Promise<DossierResult> {
  const registry = loadRegistry(join(opts.wikiDir, "entities.json"));
  const info = registry.entities[opts.entity];
  if (!info) throw new Error(`unknown entity: ${opts.entity}`);
  if (info.status === "rejected") throw new Error(`entity is rejected: ${opts.entity}`);

  const side = new DatabaseSync(opts.entityDbPath, { readOnly: true });
  const rows = mentionRows(side, opts.entity);
  side.close();
  if (rows.length === 0) throw new Error(`no mentions for entity: ${opts.entity} (run entity-scan first)`);

  const existing = opts.rebuild ? null : loadDossier(opts.wikiDir, opts.entity);
  const universe = citationUniverse(rows);
  // Models sometimes cite the DOC id (result_id) instead of the ENTRY id,
  // or truncate long ENTRY ids to a prefix. Both are recoverable in-universe.
  const resultToEntry = new Map(rows.filter((r) => r.entry_id).map((r) => [r.result_id, r.entry_id!]));
  const resolveCitation = (c: string): string => {
    if (universe.has(c)) return c;
    const docId = resultToEntry.get(c);
    if (docId) return docId;
    if (c.length >= 6) {
      const prefixed = [...universe].filter((u) => u.startsWith(c));
      if (prefixed.length === 1) return prefixed[0];
    }
    return c;
  };
  const watermark = Math.max(...rows.map((r) => r.mid));

  let candidates: MentionRow[];
  if (!existing) {
    // initial build: rank by mention density (count per document char)
    const archive = new DatabaseSync(opts.archivePath, { readOnly: true });
    const len = archive.prepare("SELECT LENGTH(text) AS n FROM documents WHERE result_id = ?");
    const scored = rows.map((r) => {
      const n = (len.get(r.result_id) as { n: number } | undefined)?.n ?? 1;
      return { row: r, density: r.count / Math.max(n, 1) };
    });
    archive.close();
    scored.sort((a, b) => b.density - a.density);
    candidates = scored.slice(0, opts.maxDocs ?? MAX_DOCS).map((s) => s.row);
  } else {
    candidates = rows.filter((r) => r.mid > existing.watermark);
    if (candidates.length === 0) {
      return { entity: opts.entity, status: "current", liveFragments: existing.fragments.length, retiredTotal: existing.retired.length, newDocuments: 0, splitHint: existing.split_hint };
    }
    if (candidates.length > (opts.maxDocs ?? MAX_DOCS)) {
      throw new Error(`${candidates.length} new mention documents exceed per-run cap (${opts.maxDocs ?? MAX_DOCS}); rerun with --max-docs`);
    }
  }

  const archive = new DatabaseSync(opts.archivePath, { readOnly: true });
  const docText = archive.prepare("SELECT text FROM documents WHERE result_id = ?");
  const docs: { resultId: string; entryId: string; text: string }[] = [];
  let total = 0;
  for (const row of candidates) {
    const text = (docText.get(row.result_id) as { text: string } | undefined)?.text ?? "";
    const clamped = text.slice(0, MAX_DOC_CHARS);
    if (total + clamped.length > MAX_TOTAL_CHARS) break;
    total += clamped.length;
    docs.push({ resultId: row.result_id, entryId: row.entry_id ?? String(row.result_id), text: clamped });
  }
  archive.close();
  if (docs.length === 0) throw new Error("no readable documents for entity mentions");

  let feedback: string | undefined;
  let raw: RawUpdate | null = null;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = dossierPrompt({ entity: opts.entity, entityType: info.type, existing, docs, feedback });
    let text: string;
    try {
      text = await generate(opts.model, prompt);
      raw = extractJsonObject(text) as RawUpdate;
    } catch (error) {
      feedback = `previous attempt failed: ${(error as Error).message}`;
      continue;
    }
    // Lenient normalization before validation:
    //  - resolve DOC-id / truncated citations, then STRIP any that remain
    //    outside the mention set (fragments must keep >= 1 valid citation);
    //  - drop exactly-duplicate page declarations (models repeat the hub);
    //  - a malformed pages field is dropped, fragments rejoin the hub.
    let stripped = 0;
    for (const d of raw.dispositions ?? []) {
      if (Array.isArray(d.citations)) {
        const kept = d.citations.map(resolveCitation).filter((c) => universe.has(c));
        stripped += d.citations.length - kept.length;
        d.citations = kept;
      }
    }
    for (const f of raw.new_fragments ?? []) {
      if (Array.isArray(f.citations)) {
        const kept = f.citations.map(resolveCitation).filter((c) => universe.has(c));
        stripped += f.citations.length - kept.length;
        f.citations = kept;
      }
    }
    // Unverifiable content is dropped, not kept: fragments whose citations
    // were all hallucinated. Amends with no surviving citation revert to
    // keep. If sloppiness exceeds 30%, the whole run is untrustworthy.
    const proposed = (raw.new_fragments ?? []).length;
    const droppedFragments = (raw.new_fragments ?? []).filter((f) => !Array.isArray(f.citations) || f.citations.length === 0).length;
    raw.new_fragments = (raw.new_fragments ?? []).filter((f) => Array.isArray(f.citations) && f.citations.length > 0);
    if (proposed > 0 && droppedFragments / proposed > 0.3) {
      errors = [`${droppedFragments}/${proposed} new fragments had no verifiable citations (model sloppiness > 30%)`];
      feedback = `previous attempt failed: ${errors[0]}. Cite only ENTRY ids shown in the documents.`;
      continue;
    }
    for (const d of raw.dispositions ?? []) {
      if (d.action === "amend" && Array.isArray(d.citations) && d.citations.length === 0) {
        d.action = "keep";
        delete d.body;
        delete d.citations;
      }
    }
    if (raw.pages !== undefined && !Array.isArray(raw.pages)) {
      delete raw.pages;
      for (const f of raw.new_fragments ?? []) f.page = null;
    }
    if (Array.isArray(raw.pages)) {
      // Dedupe by suffix: identical repeats drop silently; a suffix reused with
      // a different title keeps the first declaration (models re-declare hubs).
      const bySuffix = new Set<string | null>();
      raw.pages = raw.pages.filter((p) => {
        const suffix = p?.suffix ?? null;
        if (bySuffix.has(suffix)) return false;
        bySuffix.add(suffix);
        return true;
      });
      // Over-long page lists: trim, reassigning their fragments to the hub.
      if (raw.pages.length > MAX_PAGES) {
        const dropped = new Set(raw.pages.slice(MAX_PAGES).map((p) => p.suffix ?? null));
        raw.pages = raw.pages.slice(0, MAX_PAGES);
        for (const f of raw.new_fragments ?? []) {
          if (dropped.has(f.page ?? null)) f.page = null;
        }
      }
    }
    errors = validateUpdate(raw, existing, universe).errors;
    if (errors.length === 0) break;
    feedback = `previous attempt failed validation: ${errors.join("; ")}`;
  }
  if (!raw || errors.length > 0) {
    mkdirSync(dossiersDir(opts.wikiDir), { recursive: true });
    return { entity: opts.entity, status: "error", liveFragments: existing?.fragments.length ?? 0, retiredTotal: existing?.retired.length ?? 0, newDocuments: docs.length, splitHint: null, error: errors.join("; ") || "generation failed twice" };
  }
  // Lenient normalization before validation:
  //  - translate DOC-id citations to ENTRY ids;
  //  - drop exactly-duplicate page declarations (models repeat the hub).
  for (const d of raw.dispositions ?? []) {
    if (Array.isArray(d.citations)) d.citations = d.citations.map(resolveCitation);
  }
  for (const f of raw.new_fragments ?? []) {
    if (Array.isArray(f.citations)) f.citations = f.citations.map(resolveCitation);
  }
  if (Array.isArray(raw.pages)) {
    // Dedupe by suffix: identical repeats drop silently; a suffix reused with
    // a different title keeps the first declaration (models re-declare hubs).
    const bySuffix = new Set<string | null>();
    raw.pages = raw.pages.filter((p) => {
      const suffix = p?.suffix ?? null;
      if (bySuffix.has(suffix)) return false;
      bySuffix.add(suffix);
      return true;
    });
    // Over-long page lists: trim, reassigning their fragments to the hub.
    if (raw.pages.length > MAX_PAGES) {
      const dropped = new Set(raw.pages.slice(MAX_PAGES).map((p) => p.suffix ?? null));
      raw.pages = raw.pages.slice(0, MAX_PAGES);
      for (const f of raw.new_fragments ?? []) {
        if (dropped.has(f.page ?? null)) f.page = null;
      }
    }
  }
  const dossier = applyUpdate(existing, opts.entity, info.type, raw, watermark);
  const file = dossierPath(opts.wikiDir, opts.entity);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dossier, null, 1) + "\n", { mode: 0o600 });
  return {
    entity: opts.entity,
    status: existing ? "updated" : "built",
    liveFragments: dossier.fragments.length,
    retiredTotal: dossier.retired.length,
    newDocuments: docs.length,
    splitHint: dossier.split_hint,
  };
}
