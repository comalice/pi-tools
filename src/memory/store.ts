import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

export const SCHEMA_VERSION = 3;
export type Db = DatabaseSync;

export function openStore(path: string): Db {
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
  let file;
  try { file = lstatSync(path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("Memory index must be a regular file, not a symlink");
  if (!file) closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version !== 0 && version !== 2 && version !== SCHEMA_VERSION) throw new Error(`Unsupported memory index schema ${version}; expected ${SCHEMA_VERSION}`);
    if (!version && Number(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n ?? 0) > 0) throw new Error("Unversioned non-empty SQLite file is not a memory index; refusing to modify it");
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    if (!version) transaction(db, () => db.exec(`CREATE TABLE source_files(source TEXT NOT NULL, file TEXT NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, size INTEGER NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY(source,file));
      CREATE TABLE source_config(source TEXT PRIMARY KEY, root TEXT NOT NULL);
      CREATE TABLE sessions(source TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL, title TEXT, parent_session TEXT, revert_message TEXT, PRIMARY KEY(source,session_id));
      CREATE TABLE entries(source TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, role TEXT, kind TEXT NOT NULL, timestamp TEXT, text TEXT NOT NULL DEFAULT '', indexable INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT '${hostname().replace(/'/g, "''")}', PRIMARY KEY(source,session_id,entry_id));
      CREATE INDEX entry_session_parent ON entries(source,session_id,parent_id);
      CREATE TABLE documents(result_id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL, entry_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT);
      CREATE VIRTUAL TABLE documents_fts USING fts5(text, content='documents', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
      CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN INSERT INTO documents_fts(documents_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO documents_fts(rowid,text) VALUES(new.rowid,new.text); END;
      PRAGMA user_version=${SCHEMA_VERSION};`));
    else if (version === 2) transaction(db, () => db.exec(`ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT '${hostname().replace(/'/g, "''")}'; PRAGMA user_version=${SCHEMA_VERSION};`));
    return db;
  } catch (error) { db.close(); throw error; }
}
export const SOURCES = ["pi", "opencode", "claude", "grok", "wiki"] as const;
export function stableId(...parts: string[]): string { return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32); }
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function registerSource(db: Db, source: string, root: string) {
  const prior = db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if (prior && prior.root !== root) throw new Error(`Source ${source} is already registered at ${prior.root}; refusing to reconcile a different path`);
  db.prepare("INSERT OR IGNORE INTO source_config(source,root) VALUES(?,?)").run(source, root);
}
export interface Entry { entry_id: string; parent_id: string | null; role: string | null; kind: string; timestamp: string | null; text: string; indexable: boolean; metadata?: unknown; }
function resolveOrigin(origin?: string) {
  const value = origin ?? process.env.PI_MEMORY_ORIGIN ?? hostname();
  if (typeof value !== "string" || !value.trim() || value.length > 255) throw new Error("origin must contain 1 to 255 characters");
  return value;
}
export function replaceSession(db: Db, source: string, sessionId: string, project: string, entries: Entry[], opts: {title?: string; parentSession?: string; revertMessage?: string; sourceFile?: {key:string; fingerprint:string; size:number}; origin?: string} = {}) {
  transaction(db, () => {
    db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, sessionId);
    db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, sessionId);
    db.prepare("INSERT INTO sessions(source,session_id,project,title,parent_session,revert_message) VALUES(?,?,?,?,?,?) ON CONFLICT(source,session_id) DO UPDATE SET project=excluded.project,title=excluded.title,parent_session=excluded.parent_session,revert_message=excluded.revert_message").run(source, sessionId, project, opts.title ?? null, opts.parentSession ?? null, opts.revertMessage ?? null);
    const origin = resolveOrigin(opts.origin);
    const insert = db.prepare("INSERT INTO entries(source,session_id,entry_id,parent_id,role,kind,timestamp,text,indexable,metadata,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const doc = db.prepare("INSERT INTO documents(result_id,source,session_id,project,entry_id,role,text,timestamp) VALUES(?,?,?,?,?,?,?,?)");
    for (const e of entries) {
      const text = e.indexable ? e.text.slice(0, 100_000) : "";
      insert.run(source, sessionId, e.entry_id, e.parent_id, e.role, e.kind, e.timestamp, text, e.indexable ? 1 : 0, JSON.stringify(e.metadata ?? {}), origin);
      if (text.trim()) doc.run(stableId(source, sessionId, e.entry_id), source, sessionId, project, e.entry_id, e.role ?? "unknown", text, e.timestamp);
    }
    if (opts.sourceFile) db.prepare("INSERT INTO source_files(source,file,session_id,fingerprint,size,indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source,file) DO UPDATE SET session_id=excluded.session_id,fingerprint=excluded.fingerprint,size=excluded.size,indexed_at=excluded.indexed_at").run(source, opts.sourceFile.key, sessionId, opts.sourceFile.fingerprint, opts.sourceFile.size, new Date().toISOString());
  });
}
export function replaceFileSession(db: Db, source: string, file: string, oldSession: string | undefined, sessionId: string, project: string, entries: Entry[], fingerprint: string, size: number, opts: {title?: string; origin?: string} = {}) {
  transaction(db, () => {
    if (oldSession && oldSession !== sessionId) {
      db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, oldSession);
      db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, oldSession);
      db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source, oldSession);
    }
    db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, sessionId);
    db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, sessionId);
    db.prepare("INSERT INTO sessions(source,session_id,project,title) VALUES(?,?,?,?) ON CONFLICT(source,session_id) DO UPDATE SET project=excluded.project,title=excluded.title").run(source, sessionId, project, opts.title ?? null);
    const origin = resolveOrigin(opts.origin);
    const put = db.prepare("INSERT INTO entries(source,session_id,entry_id,parent_id,role,kind,timestamp,text,indexable,metadata,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const doc = db.prepare("INSERT INTO documents(result_id,source,session_id,project,entry_id,role,text,timestamp) VALUES(?,?,?,?,?,?,?,?)");
    for (const entry of entries) {
      const text = entry.indexable ? entry.text.slice(0, 100_000) : "";
      put.run(source, sessionId, entry.entry_id, entry.parent_id, entry.role, entry.kind, entry.timestamp, text, entry.indexable ? 1 : 0, JSON.stringify(entry.metadata ?? {}), origin);
      if (text.trim()) doc.run(stableId(source, sessionId, entry.entry_id), source, sessionId, project, entry.entry_id, entry.role ?? "unknown", text, entry.timestamp);
    }
    db.prepare("INSERT INTO source_files(source,file,session_id,fingerprint,size,indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source,file) DO UPDATE SET session_id=excluded.session_id,fingerprint=excluded.fingerprint,size=excluded.size,indexed_at=excluded.indexed_at").run(source, file, sessionId, fingerprint, size, new Date().toISOString());
  });
}
export function status(db: Db) { return { schema: SCHEMA_VERSION, sources: db.prepare("SELECT source,COUNT(*) sessions FROM sessions GROUP BY source ORDER BY source").all(), entries: db.prepare("SELECT COUNT(*) count FROM entries").get()?.count ?? 0, indexed: db.prepare("SELECT COUNT(*) count FROM documents").get()?.count ?? 0 }; }

// Conversation sessions with indexed activity at or after sinceIso, most recent first.
// Used by dream mode to sweep a time window; wiki pages are deliberately excluded.
export function listSessions(db: Db, sinceIso: string, limit = 500) {
  const rows = db.prepare(`SELECT s.source, s.session_id, s.project, s.title, MIN(e.timestamp) AS first, MAX(e.timestamp) AS last, MIN(e.origin) AS origin, COUNT(*) AS messages
    FROM sessions s JOIN entries e ON e.source=s.source AND e.session_id=s.session_id
    WHERE s.source <> 'wiki' AND e.indexable=1 AND e.timestamp IS NOT NULL
    GROUP BY s.source, s.session_id
    HAVING MAX(e.timestamp) >= ?
    ORDER BY last DESC LIMIT ?`).all(sinceIso, limit) as any[];
  const fileFor = db.prepare("SELECT file FROM source_files WHERE source=? AND session_id=? LIMIT 1");
  return rows.map(row => ({ source: row.source, session_id: row.session_id, project: row.project, title: row.title ?? null, first: row.first, last: row.last, origin: row.origin, messages: row.messages, file: (fileFor.get(row.source, row.session_id) as any)?.file ?? null }));
}
function queryTerms(s: string): string[] { return [...new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))].slice(0, 32); }
function documentTerms(text: string) { return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []); }
export function search(db: Db, input: {query: string; cues?: string[]; limit?: number; project?: string; source?: string; session?: string; currentSession?: string; scope?: "project"|"all"}) {
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer from 1 to 20");
  if ((input.cues?.length ?? 0) > 8 || (input.cues ?? []).some(c => typeof c !== "string" || c.length > 120)) throw new Error("cues must contain at most 8 strings of at most 120 characters");
  if (typeof input.query !== "string" || input.query.length > 1000) throw new Error("query must be a string of at most 1000 characters");
  if (input.source && !(SOURCES as readonly string[]).includes(input.source)) throw new Error(`source must be ${SOURCES.join(", ")}`);
  const query = queryTerms(input.query);
  const cueTerms = [...new Set((input.cues ?? []).map(c => queryTerms(c).sort().join(" ")).filter(Boolean))];
  if (!query.length && !cueTerms.length) return [];
  const filters: string[] = []; const filterArgs: any[] = [];
  // Wiki pages are curated cross-project knowledge: project scope never excludes them.
  if (input.scope !== "all") { if (!input.project) return []; filters.push("(d.project=? OR d.source='wiki')"); filterArgs.push(input.project); }
  if (input.source) { filters.push("d.source=?"); filterArgs.push(input.source); }
  if (input.session) { filters.push("d.session_id=?"); filterArgs.push(input.session); }
  if (input.currentSession) { filters.push("d.session_id<>?"); filterArgs.push(input.currentSession); }
  const base = `SELECT d.result_id,d.source,d.session_id,d.project,d.entry_id,d.role,d.text,d.timestamp,e.origin,bm25(documents_fts) rank FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid JOIN entries e ON e.source=d.source AND e.session_id=d.session_id AND e.entry_id=d.entry_id WHERE documents_fts MATCH ? ${filters.length ? "AND "+filters.join(" AND "):""} ORDER BY rank LIMIT 120`;
  const statement = db.prepare(base);
  const candidateMap = new Map<string, any>();
  const addCandidates = (terms: string[], join: "OR"|"AND") => {
    if (!terms.length) return;
    const match = terms.map(t => `"${t}"`).join(` ${join} `);
    for (const row of statement.all(match, ...filterArgs) as any[]) candidateMap.set(row.result_id, row);
  };
  addCandidates(query, "OR");
  for (const cue of cueTerms) addCandidates(queryTerms(cue), "AND");
  const candidates = [...candidateMap.values()];
  return candidates.map(r => {
    const terms = [...new Set([...query, ...cueTerms.flatMap(c => queryTerms(c))])];
    const textTerms = documentTerms(r.text);
    const coverage = cueTerms.reduce((n, cue) => n + (queryTerms(cue).every(term => textTerms.has(term)) ? 1 : 0), 0);
    const queryHits = query.filter(term => textTerms.has(term)).length;
    let match = -1;
    for (const term of terms) {
      const at = r.text.toLowerCase().indexOf(term);
      if (at >= 0 && (match < 0 || at < match)) match = at;
    }
    let start = Math.max(0, Math.min(Math.max(0, r.text.length - 480), (match < 0 ? 0 : match - 180)));
    if (start > 0 && start < r.text.length && /[\uD800-\uDBFF]/.test(r.text[start - 1]) && /[\uDC00-\uDFFF]/.test(r.text[start])) start--;
    let end = Math.min(r.text.length, start + 480);
    if (end < r.text.length && end > start && /[\uD800-\uDBFF]/.test(r.text[end - 1])) end--;
    return { result_id:r.result_id, source:r.source, session_id:r.session_id, project:r.project, entry_id:r.entry_id, role:r.role, timestamp:r.timestamp, origin:r.origin, score:coverage*10+Math.min(10,queryHits), excerpt:r.text.slice(start,end), snippet_start:start, snippet_end:end, text_length:r.text.length, provenance:{source:r.source,sessionId:r.session_id,project:r.project,entryId:r.entry_id,resultId:r.result_id,origin:r.origin}, _rank:Number(r.rank) };
  }).sort((a,b)=>b.score-a.score||a._rank-b._rank).slice(0,limit).map(({_rank,...r})=>r);
}

export function expand(db: Db, id: string, opts: { project?: string; scope?: "project" | "all"; maxChars?: number; source?: string; offset?: number; direction?: "backward" | "forward" | "both"; branchId?: string; includeReplies?: boolean }) {
  const budget = opts.maxChars ?? 3000;
  if (!Number.isInteger(budget) || budget < 200 || budget > 8000) throw new Error("maxChars must be an integer from 200 to 8000");
  const offset = opts.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  if (opts.direction && !["backward", "forward", "both"].includes(opts.direction)) throw new Error("direction must be backward, forward, or both");
  if (typeof id !== "string" || id.length < 1 || id.length > 64) throw new Error("id must be a string of 1 to 64 characters");
  if (opts.source && !(SOURCES as readonly string[]).includes(opts.source)) throw new Error(`source must be ${SOURCES.join(", ")}`);
  if (opts.branchId !== undefined && (typeof opts.branchId !== "string" || opts.branchId.length < 1 || opts.branchId.length > 200)) throw new Error("branchId must contain 1 to 200 characters");

  const doc = db.prepare("SELECT * FROM documents WHERE result_id=?").get(id) as any;
  if (!doc || (opts.source && doc.source !== opts.source) || (opts.scope !== "all" && doc.source !== "wiki" && (!opts.project || doc.project !== opts.project))) return null;
  const session = db.prepare("SELECT parent_session FROM sessions WHERE source=? AND session_id=?").get(doc.source, doc.session_id) as any;
  const getEntry = (entryId: string) => db.prepare("SELECT entry_id,parent_id,role,kind,timestamp,text,indexable,origin FROM entries WHERE source=? AND session_id=? AND entry_id=?").get(doc.source, doc.session_id, entryId) as any;
  const target = getEntry(doc.entry_id);
  if (!target || offset > target.text.length) return null;
  const pageOffset = offset > 0 && offset < target.text.length && /[\uD800-\uDBFF]/.test(target.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(target.text[offset]) ? offset - 1 : offset;

  const evidenceKind = doc.source === "wiki" ? "curated wiki page" : "historical evidence";
  const label = (entry: any) => `[${evidenceKind}; ${doc.source}; origin ${entry.origin}; ${entry.role}; ${entry.timestamp ?? "undated"}; session ${String(doc.session_id).slice(0, 36)}; entry ${String(entry.entry_id).slice(0, 36)}]\n`;
  const metadataRows = db.prepare("SELECT entry_id,parent_id FROM entries WHERE source=? AND session_id=?").all(doc.source, doc.session_id) as any[];
  const children = new Map<string, string[]>();
  const parentById = new Map<string, string | null>();
  for (const row of metadataRows) {
    parentById.set(row.entry_id, row.parent_id);
    if (!row.parent_id) continue;
    const siblings = children.get(row.parent_id) ?? [];
    siblings.push(row.entry_id);
    children.set(row.parent_id, siblings);
  }

  let branchPath = new Set<string>();
  if (opts.branchId) {
    if (opts.branchId === doc.entry_id) return null;
    let current: string | null = opts.branchId;
    const seen = new Set<string>();
    let steps = 0;
    while (current && current !== doc.entry_id && steps < 1000 && !seen.has(current)) {
      seen.add(current);
      branchPath.add(current);
      current = parentById.get(current) ?? null;
      steps++;
    }
    if (current !== doc.entry_id) return null;
  }

  const choicesFor = (parent: string) => (children.get(parent) ?? []).slice(0, 16).map(entryId => {
    const entry = getEntry(entryId);
    return { entryId, indexable: Boolean(entry?.indexable), role: entry?.role ?? null };
  });
  let branchChoices: any[] = [];
  let branchChoiceCount = 0;
  let replies: any[] = [];
  let traversalTruncated = false;
  if ((opts.direction === "forward" || opts.direction === "both") && (doc.source === "pi" || doc.source === "claude" || doc.source === "grok")) {
    let current = doc.entry_id;
    const seen = new Set<string>([current]);
    let visited = 0;
    let stoppedAtFork = false;
    while (visited < 100) {
      const descendants = children.get(current) ?? [];
      if (descendants.length === 0) break;
      if (descendants.length > 1) {
        const selected = opts.branchId ? descendants.find(child => branchPath.has(child)) : undefined;
        if (!selected) {
          stoppedAtFork = true;
          branchChoiceCount = descendants.length;
          branchChoices = choicesFor(current);
          break;
        }
        current = selected;
      } else {
        current = descendants[0];
      }
      if (seen.has(current)) break;
      seen.add(current);
      visited++;
      const entry = getEntry(current);
      if (entry?.indexable && entry.text.trim()) replies.push(entry);
      stoppedAtFork = false;
    }
    if (visited >= 100 && !stoppedAtFork && (children.get(current)?.length ?? 0) > 0) traversalTruncated = true;
  } else if ((opts.direction === "forward" || opts.direction === "both") && doc.source === "opencode") {
    const after = db.prepare(`SELECT entry_id,role,kind,timestamp,text,indexable,origin FROM entries
      WHERE source=? AND session_id=? AND rowid>(SELECT rowid FROM entries WHERE source=? AND session_id=? AND entry_id=?)
      ORDER BY rowid LIMIT 24`).all(doc.source, doc.session_id, doc.source, doc.session_id, doc.entry_id) as any[];
    replies = after.filter(entry => entry.indexable && entry.text.trim());
    traversalTruncated = after.length === 24;
  }

  const marker = "…[truncated]";
  const targetLabel = label(target);
  const availableForTarget = Math.max(1, budget - targetLabel.length);
  const targetHasMore = target.text.length - pageOffset > availableForTarget;
  const targetBudget = targetHasMore ? Math.max(1, availableForTarget - marker.length) : availableForTarget;
  let targetEnd = Math.min(target.text.length, pageOffset + targetBudget);
  if (targetEnd < target.text.length && targetEnd > pageOffset && /[\uD800-\uDBFF]/.test(target.text[targetEnd - 1]) && /[\uDC00-\uDFFF]/.test(target.text[targetEnd])) targetEnd--;
  if (!targetHasMore && targetEnd < target.text.length) {
    targetEnd = Math.min(target.text.length, pageOffset + Math.max(1, availableForTarget - marker.length));
    if (targetEnd < target.text.length && targetEnd > pageOffset && /[\uD800-\uDBFF]/.test(target.text[targetEnd - 1]) && /[\uDC00-\uDFFF]/.test(target.text[targetEnd])) targetEnd--;
  }
  if (targetEnd <= pageOffset) targetEnd = Math.min(target.text.length, pageOffset + targetBudget + 1);
  const targetText = target.text.slice(pageOffset, targetEnd);
  let text = targetLabel + targetText;
  let remaining = budget - text.length;
  let nextOffset: number | null = null;
  if (pageOffset + targetText.length < target.text.length) {
    nextOffset = pageOffset + targetText.length;
    text += marker;
    remaining -= marker.length;
  }

  if (opts.direction !== "forward") {
    let ancestors: any[] = [];
    if (doc.source === "opencode") {
      const targetRow = db.prepare("SELECT rowid FROM entries WHERE source=? AND session_id=? AND entry_id=?").get(doc.source, doc.session_id, doc.entry_id) as any;
      if (targetRow) {
        ancestors = (db.prepare(`SELECT entry_id,role,kind,timestamp,text,indexable,origin FROM entries
          WHERE source=? AND session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 23`).all(doc.source, doc.session_id, targetRow.rowid) as any[]).filter(entry => entry.indexable && entry.text);
      }
    } else {
      let current = target.parent_id;
      const seen = new Set<string>([target.entry_id]);
      let visited = 0;
      while (current && !seen.has(current) && visited < 100) {
        seen.add(current);
        visited++;
        const entry = getEntry(current);
        if (!entry) break;
        if (entry.indexable && entry.text) ancestors.push(entry);
        current = entry.parent_id;
      }
    }
    for (const entry of ancestors) {
      const fragment = `${label(entry)}${entry.text}\n\n`;
      if (fragment.length > remaining) break;
      text = fragment + text;
      remaining -= fragment.length;
    }
  }

  let repliesTruncated = false;
  let nextResultId: string | null = null;
  if (nextOffset === null && opts.includeReplies !== false) {
    for (const entry of replies) {
      const fragment = `\n\n${label(entry)}${entry.text}`;
      if (fragment.length > remaining) {
        repliesTruncated = true;
        nextResultId = stableId(doc.source, doc.session_id, entry.entry_id);
        break;
      }
      text += fragment;
      remaining -= fragment.length;
    }
  }

  const provenance = { source: doc.source, sessionId: doc.session_id, project: doc.project, entryId: doc.entry_id, resultId: id, origin: target.origin };
  return {
    id,
    source: doc.source,
    origin: target.origin,
    sessionId: doc.session_id,
    project: doc.project,
    entryId: doc.entry_id,
    provenance,
    offset: pageOffset,
    nextOffset,
    nextResultId,
    truncated: nextOffset !== null,
    repliesTruncated,
    traversalTruncated,
    branchChoices,
    branchChoiceCount,
    branchChoicesTruncated: branchChoiceCount > branchChoices.length,
    branch: {
      ancestry: doc.source === "opencode" ? "chronological within-session window" : "entry parent chain",
      siblingsIncluded: doc.source === "opencode" ? "unknown" : false,
      activeLeaf: "not inferred; forward traversal follows a unique child chain",
      sessionParent: session?.parent_session ?? null,
      sessionParentIsForkLineage: false,
      forkLineage: doc.source === "opencode" ? "unknown" : "not applicable",
    },
    text: text.slice(0, budget),
  };
}
