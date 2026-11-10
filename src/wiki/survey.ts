import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parsePage, type PageMeta } from "./format.ts";
import { safeSlug } from "./staging.ts";

// librarian survey: a deterministic pre-pass over the wiki staging area.
// Verifies every citation against the memory archive, clusters entries by
// shared session and title-token overlap, detects slug collisions with
// existing pages, and accounts for every entry — so the librarian agent spends
// its judgment on disposition decisions, not mechanics.

export interface SurveyEntry {
  file: string;
  slug: string;
  title: string;
  tags: string[];
  sources: string[];
  citations: { source: string; status: "ok" | "broken" | "unchecked"; origin?: string }[];
  brokenCitations: number;
  parseError?: string;
  cluster: number | null;
  suggestion: string;
}

export interface SurveyCluster {
  id: number;
  entries: string[];
  sharedTokens: string[];
  sessions: string[];
  suggestion: string;
}

export interface Survey {
  entries: SurveyEntry[];
  clusters: SurveyCluster[];
  existingPages: string[];
  tagVocabulary: Record<string, number>;
  summary: { total: number; parseErrors: number; brokenCitationEntries: number; mergeClusters: number; updateCandidates: number };
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "via", "using", "use", "how", "what", "when", "process", "pattern", "entry", "gotcha", "gotchas", "fact", "facts", "decision", "decisions", "ops"]);

function titleTokens(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(t => !STOPWORDS.has(t)));
}

function sourceSession(source: string): string | null {
  const match = source.match(/^(pi|opencode|claude):([^:]+)/);
  return match ? match[2] : null;
}

export function runSurvey(wikiDir: string, index: string): Survey {
  const stagingDir = path.join(wikiDir, "staging");
  const pagesDir = path.join(wikiDir, "pages");
  const existingPages = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter(name => name.endsWith(".md")).map(name => name.slice(0, -3)).sort()
    : [];

  let db: DatabaseSync | null = null;
  if (existsSync(index)) {
    db = new DatabaseSync(index, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  }
  const entryOrigin = db ? db.prepare("SELECT origin FROM entries WHERE source=? AND session_id=? AND entry_id=? LIMIT 1") : null;
  const sessionExists = db ? db.prepare("SELECT 1 FROM sessions WHERE source=? AND session_id=? LIMIT 1") : null;
  const sessionOrigin = db ? db.prepare("SELECT origin FROM entries WHERE source=? AND session_id=? LIMIT 1") : null;
  const pageSet = new Set(existingPages);

  function checkCitation(source: string): { status: "ok" | "broken" | "unchecked"; origin?: string } {
    const match = source.match(/^(pi|opencode|claude):([^:]+)(?::(.+))?$/);
    if (match) {
      if (!entryOrigin || !sessionExists || !sessionOrigin) return { status: "unchecked" };
      if (match[3]) {
        const entry = entryOrigin.get(match[1], match[2], match[3]) as any;
        return entry ? { status: "ok", origin: entry.origin } : { status: "broken" };
      }
      if (!sessionExists.get(match[1], match[2])) return { status: "broken" };
      const origin = (sessionOrigin.get(match[1], match[2]) as any)?.origin;
      return { status: "ok", ...(origin ? { origin } : {}) };
    }
    if (source.startsWith("wiki:")) return { status: pageSet.has(source.slice(5)) ? "ok" : "broken" };
    return { status: "unchecked" }; // doc:, web: — not verifiable here
  }

  const entries: SurveyEntry[] = [];
  const tagVocabulary: Record<string, number> = {};
  const files = existsSync(stagingDir) ? readdirSync(stagingDir).filter(name => name.endsWith(".md")).sort() : [];
  for (const name of files) {
    const file = path.join(stagingDir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    let meta: PageMeta;
    try {
      meta = parsePage(readFileSync(file, "utf8"), file).meta;
    } catch (error) {
      entries.push({ file, slug: name.slice(0, -3), title: name.slice(0, -3), tags: [], sources: [], citations: [], brokenCitations: 0, parseError: (error as Error).message, cluster: null, suggestion: "discard candidate (unparseable staging entry)" });
      continue;
    }
    for (const tag of meta.tags) tagVocabulary[tag] = (tagVocabulary[tag] ?? 0) + 1;
    const citations = meta.sources.map(source => ({ source, ...checkCitation(source) }));
    const brokenCitations = citations.filter(c => c.status === "broken").length;
    entries.push({ file, slug: meta.slug, title: meta.title, tags: meta.tags, sources: meta.sources, citations, brokenCitations, cluster: null, suggestion: "" });
  }

  // Union-find clustering: same source session, or title-token Jaccard ≥ 1/3.
  const valid = entries.filter(e => !e.parseError);
  const parent = new Map<number, number>(valid.map((_, i) => [i, i]));
  const find = (i: number): number => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i)!)!); i = parent.get(i)!; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const tokens = valid.map(e => titleTokens(e.title));
  const sessions = valid.map(e => new Set(e.sources.map(sourceSession).filter(Boolean)));
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const sharedSession = [...sessions[i]].some(s => sessions[j].has(s));
      const shared = [...tokens[i]].filter(t => tokens[j].has(t));
      const jaccard = shared.length / Math.max(1, new Set([...tokens[i], ...tokens[j]]).size);
      if (sharedSession || (shared.length > 0 && jaccard >= 1 / 3)) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < valid.length; i++) {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }
  const clusters: SurveyCluster[] = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((group, idx) => {
      const id = idx + 1;
      for (const i of group) valid[i].cluster = id;
      const sharedTokens = [...tokens[group[0]]].filter(t => group.every(i => tokens[i].has(t)));
      const sessionIds = [...new Set(group.flatMap(i => [...sessions[i]]))] as string[];
      const suggestion = group.length > 1 ? "merge candidates — one page, or a small linked set" : "review (promote or discard)";
      return { id, entries: group.map(i => valid[i].slug), sharedTokens, sessions: sessionIds, suggestion };
    });

  let mergeClusters = 0, updateCandidates = 0;
  for (const entry of valid) {
    const cluster = clusters.find(c => c.id === entry.cluster)!;
    const collides = existingPages.includes(safeSlug(entry.title));
    if (entry.brokenCitations > 0) entry.suggestion = `discard candidate (${entry.brokenCitations} citation${entry.brokenCitations === 1 ? "" : "s"} do not resolve)`;
    else if (collides) { entry.suggestion = `update existing page "${safeSlug(entry.title)}"`; updateCandidates++; }
    else if (cluster.entries.length > 1) { entry.suggestion = `merge into cluster ${cluster.id}`; }
    else entry.suggestion = "review (promote as new page, or discard)";
  }
  mergeClusters = clusters.filter(c => c.entries.length > 1).length;

  if (db) db.close();
  return {
    entries,
    clusters,
    existingPages,
    tagVocabulary,
    summary: {
      total: entries.length,
      parseErrors: entries.filter(e => e.parseError).length,
      brokenCitationEntries: entries.filter(e => e.brokenCitations > 0).length,
      mergeClusters,
      updateCandidates,
    },
  };
}
