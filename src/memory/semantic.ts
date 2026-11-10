import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkText, CHUNKING_REVISION, contentHash } from "./chunking.ts";
import { search as lexicalSearch } from "./store.ts";
import { embedTexts, health, localHttpUrl, requestJson, serviceUrls, type ModelIdentity } from "./vector-client.ts";

const CONFIG_VERSION = 1;
const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 200;
const RRF_K = 60;
type Config = { version: number; archive: string; endpoints: { qdrant: string; embedder: string }; model: ModelIdentity; collection: string; namespace: string; chunkingRevision: string; documentCount: number; chunkCount: number; builtAt: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sidecar = (index: string) => `${resolve(index)}.semantic.json`;

export function readSemanticConfig(index: string): Config | null {
  let stat;
  try { stat = lstatSync(sidecar(index)); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("Semantic index sidecar must be a private regular file no larger than 64 KiB");
  const canonicalArchive = realpathSync(index);
  let raw: string;
  try { raw = readFileSync(sidecar(index), "utf8"); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
  let config: any;
  try { config = JSON.parse(raw); } catch { throw new Error("Semantic index sidecar is invalid JSON; run vector-build"); }
  const namespace = hash(canonicalArchive).slice(0, 16);
  const collectionPattern = new RegExp(`^memory_${namespace}_g[a-z0-9]+_[a-f0-9]{8}$`);
  if (config.version !== CONFIG_VERSION || config.archive !== canonicalArchive || config.namespace !== namespace || typeof config.collection !== "string" || !collectionPattern.test(config.collection) || config.chunkingRevision !== CHUNKING_REVISION || !config.model || typeof config.model.model !== "string" || config.model.model.length === 0 || typeof config.model.revision !== "string" || !/^[a-f0-9]{64}$/i.test(config.model.revision) || config.model.dimension !== 384 || config.model.max_tokens !== 512 || !Number.isSafeInteger(config.documentCount) || config.documentCount < 0 || !Number.isSafeInteger(config.chunkCount) || config.chunkCount < 0 || typeof config.builtAt !== "string" || Number.isNaN(Date.parse(config.builtAt))) throw new Error("Semantic index sidecar does not match this archive or supported format");
  localHttpUrl(config.endpoints?.qdrant, "Qdrant URL");
  localHttpUrl(config.endpoints?.embedder, "Embedder URL");
  return config as Config;
}

function pointId(value: string) { const bytes = Buffer.from(hash(value).slice(0, 32), "hex"); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; }

export async function buildVectorIndex(index: string, signal?: AbortSignal) {
  const endpoints = serviceUrls();
  const model = await health(endpoints.embedder, signal);
  const archive = realpathSync(index);
  const namespace = hash(archive).slice(0, 16);
  const collection = `memory_${namespace}_g${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  let created = false;
  const qdrant = endpoints.qdrant;
  const db = new DatabaseSync(archive, { readOnly: true, timeout: 5000 });
  let chunksWritten = 0;
  let documentCount = 0;
  let temporary: string | null = null;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const createdResponse = await requestJson<any>(`${qdrant}/collections/${collection}`, { method: "PUT", body: JSON.stringify({ vectors: { size: 384, distance: "Cosine" } }), signal });
    created = true;
    if (createdResponse?.result !== true) throw new Error("Qdrant did not confirm collection creation");
    const insertBatch = async (batch: any[]) => {
      if (!batch.length) return;
      const embedded = await embedTexts(endpoints.embedder, batch.map(item => item.chunk.text), "passage", signal);
      if (embedded.identity.model !== model.model || embedded.identity.revision !== model.revision) throw new Error("Embedder model identity changed during vector build");
      const points = batch.map((item, i) => ({
        id: pointId(`${item.result_id}:${item.chunk.start}:${item.chunk.end}:${item.chunk.contentHash}:${CHUNKING_REVISION}`),
        vector: embedded.vectors[i],
        payload: { source: item.source, session: item.session_id, project: item.project, result_id: item.result_id, start: item.chunk.start, end: item.chunk.end, content_hash: item.chunk.contentHash, model_revision: model.revision, chunking_revision: CHUNKING_REVISION },
      }));
      const response = await requestJson<any>(`${qdrant}/collections/${collection}/points?wait=true`, { method: "PUT", body: JSON.stringify({ points }), signal });
      if (response?.result !== true && (!response?.result || typeof response.result !== "object")) throw new Error("Qdrant did not acknowledge the point batch");
      chunksWritten += points.length;
    };
    const rows = db.prepare("SELECT result_id,source,session_id,project,text FROM documents ORDER BY result_id").iterate();
    let batch: any[] = [];
    for (const row of rows as any) {
      documentCount++;
      for (const chunk of chunkText(row.text, CHUNK_SIZE, CHUNK_OVERLAP)) {
        batch.push({ ...row, chunk });
        if (batch.length === 32) { await insertBatch(batch); batch = []; }
      }
    }
    await insertBatch(batch);
    const counted = await requestJson<any>(`${qdrant}/collections/${collection}/points/count`, { method: "POST", body: JSON.stringify({ exact: true }), signal });
    const count = counted?.result?.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count !== chunksWritten) throw new Error("Qdrant count verification failed; active vector index was not changed");
    const config: Config = { version: CONFIG_VERSION, archive, endpoints, model, collection, namespace, chunkingRevision: CHUNKING_REVISION, documentCount, chunkCount: chunksWritten, builtAt: new Date().toISOString() };
    temporary = `${sidecar(index)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    db.exec("COMMIT");
    renameSync(temporary, sidecar(index));
    return { collection, documentCount, chunkCount: chunksWritten, model: { model: model.model, revision: model.revision, dimension: model.dimension }, builtAt: config.builtAt };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (temporary) { try { unlinkSync(temporary); } catch {} }
    if (created) { try { await requestJson(`${qdrant}/collections/${collection}`, { method: "DELETE", signal }); } catch {} }
    throw error;
  } finally { db.close(); }
}

export async function vectorStatus(index: string, signal?: AbortSignal) {
  const config = readSemanticConfig(index);
  if (!config) return { configured: false, ready: false, status: "not_configured" };
  const manifest = { configured: true, collection: config.collection, model: config.model, documentCount: config.documentCount, chunkCount: config.chunkCount, builtAt: config.builtAt };
  try {
    const model = await health(config.endpoints.embedder, signal);
    const collection = await requestJson<any>(`${config.endpoints.qdrant}/collections/${config.collection}`, { signal });
    const count = await requestJson<any>(`${config.endpoints.qdrant}/collections/${config.collection}/points/count`, { method: "POST", body: JSON.stringify({ exact: true }), signal });
    const vectors = collection?.result?.config?.params?.vectors;
    const actualCount = count?.result?.count;
    const validCount = typeof actualCount === "number" && Number.isSafeInteger(actualCount);
    const matches = model.model === config.model.model && model.revision === config.model.revision && model.dimension === config.model.dimension && vectors?.size === 384 && vectors?.distance === "Cosine" && validCount && actualCount === config.chunkCount;
    return { ...manifest, ready: matches, status: matches ? "ready" : "mismatch", actualChunkCount: validCount ? actualCount : null, activeModel: { model: model.model, revision: model.revision, dimension: model.dimension } };
  } catch (error) {
    return { ...manifest, ready: false, status: "unavailable", warning: `Saved vector index cannot currently be verified: ${(error as Error).message}` };
  }
}

export const VECTOR_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type VectorRefresh =
  | { refreshed: true; build: Awaited<ReturnType<typeof buildVectorIndex>>; removedCollection: string | null }
  | { refreshed: false; reason: "not_configured" | "unavailable" | "current" | "recent"; warning?: string };

// Conditionally rebuilds the vector index: only once a semantic sidecar exists (semantic
// indexing stays opt-in via an explicit first vector-build), only when services answer, and
// only when the archive document set changed since the sidecar was built and the sidecar is
// older than maxAgeMs. A changed embedder identity or a missing/broken collection forces a
// rebuild regardless of age. After a successful build the superseded generation recorded in
// the previous sidecar is deleted best-effort so repeated refreshes do not accumulate
// collections; unknown collections are never touched.
export async function refreshVectorIndex(index: string, options: { maxAgeMs?: number } = {}, signal?: AbortSignal): Promise<VectorRefresh> {
  const maxAgeMs = options.maxAgeMs ?? VECTOR_REFRESH_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("maxAgeMs must be a positive number");
  const config = readSemanticConfig(index);
  if (!config) return { refreshed: false, reason: "not_configured" };
  let model: ModelIdentity;
  try { model = await health(config.endpoints.embedder, signal); }
  catch (error) { return { refreshed: false, reason: "unavailable", warning: `Embedder unavailable: ${(error as Error).message}` }; }
  let collectionReady = true;
  try {
    const collection = await requestJson<any>(`${config.endpoints.qdrant}/collections/${config.collection}`, { signal });
    const vectors = collection?.result?.config?.params?.vectors;
    collectionReady = vectors?.size === 384 && vectors?.distance === "Cosine";
  } catch { collectionReady = false; }
  const db = new DatabaseSync(config.archive, { readOnly: true, timeout: 5000 });
  let documentCount = 0;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    documentCount = Number((db.prepare("SELECT COUNT(*) AS count FROM documents").get() as any)?.count ?? 0);
  } finally { db.close(); }
  const modelChanged = model.model !== config.model.model || model.revision !== config.model.revision || model.dimension !== config.model.dimension;
  const countChanged = documentCount !== config.documentCount;
  const aged = Date.now() - Date.parse(config.builtAt) >= maxAgeMs;
  if (!modelChanged && collectionReady && (!countChanged || !aged)) {
    return { refreshed: false, reason: countChanged ? "recent" : "current" };
  }
  const previous = config.collection;
  const build = await buildVectorIndex(index, signal);
  let removedCollection: string | null = null;
  if (previous !== build.collection) {
    try {
      const removed = await requestJson<any>(`${config.endpoints.qdrant}/collections/${previous}`, { method: "DELETE", signal });
      if (removed?.result === true) removedCollection = previous;
    } catch { /* Orphaned generation left for manual cleanup. */ }
  }
  return { refreshed: true, build, removedCollection };
}

type SearchInput = { query: string; cues?: string[]; limit?: number; project?: string; source?: string; session?: string; currentSession?: string; scope?: "project"|"all"; mode?: "lexical"|"hybrid"|"semantic"|"auto"; cosineFloor?: number };

const PAGE_LINK_RE = /\[\[page:([a-z0-9][a-z0-9-]{0,79})(?:\|[^\]\n]{0,160})?\]\]/g;

/** Surface wiki page links (outgoing + backlinks) on wiki results so agents can traverse the graph. */
function enrichWikiLinks(db: DatabaseSync, results: any[]): any[] {
  if (!results.some((r) => r.source === "wiki")) return results;
  const textStmt = db.prepare("SELECT text FROM documents WHERE result_id=?");
  const backlinkStmt = db.prepare("SELECT session_id FROM documents WHERE source='wiki' AND session_id<>? AND instr(text, ?) > 0 LIMIT 20");
  for (const r of results) {
    if (r.source !== "wiki") continue;
    const text = String((textStmt.get(r.result_id) as any)?.text ?? "");
    r.page_links = [...new Set([...text.matchAll(PAGE_LINK_RE)].map((m) => m[1]))];
    r.linked_from = (backlinkStmt.all(r.session_id, `[[page:${r.session_id}`) as any[]).map((row) => row.session_id);
  }
  return results;
}

export async function searchMemory(db: DatabaseSync, index: string, input: SearchInput, signal?: AbortSignal) {
  const mode = input.mode ?? "auto";
  const limit = input.limit ?? 8;
  if (!["lexical", "hybrid", "semantic", "auto"].includes(mode)) throw new Error("mode must be lexical, hybrid, semantic, or auto");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer from 1 to 20");
  if (typeof input.query !== "string" || input.query.length > 1000) throw new Error("query must be a string of at most 1000 characters");
  if (input.cues !== undefined && (!Array.isArray(input.cues) || input.cues.length > 8 || input.cues.some(cue => typeof cue !== "string" || cue.length > 120))) throw new Error("cues must contain at most 8 strings of at most 120 characters");
  if (input.source !== undefined && (typeof input.source !== "string" || !["pi", "opencode", "claude", "grok", "wiki"].includes(input.source))) throw new Error("source must be pi, opencode, claude, grok, or wiki");
  if (input.session !== undefined && (typeof input.session !== "string" || input.session.length < 1 || input.session.length > 200) || input.currentSession !== undefined && (typeof input.currentSession !== "string" || input.currentSession.length < 1 || input.currentSession.length > 200)) throw new Error("session IDs must contain 1 to 200 characters");
  if (input.project !== undefined && (typeof input.project !== "string" || input.project.length > 4096)) throw new Error("project must be a string of at most 4096 characters");
  if (input.scope !== undefined && !["project", "all"].includes(input.scope)) throw new Error("scope must be project or all");
  if (input.cosineFloor !== undefined && (!Number.isFinite(input.cosineFloor) || input.cosineFloor < -1 || input.cosineFloor > 1)) throw new Error("cosineFloor must be between -1 and 1");
  const lexicalInput = { ...input, limit: 20 };
  const lexical = () => lexicalSearch(db, lexicalInput);
  if (mode === "lexical") { const started = Date.now(); const results = enrichWikiLinks(db, lexical().slice(0, limit)); return { results, retrieval: { mode: "lexical", status: "ok", elapsedMs: Date.now() - started } }; }
  const started = Date.now();
  let config: Config | null;
  try { config = readSemanticConfig(index); }
  catch (error) { if (mode === "semantic") throw error; return { results: enrichWikiLinks(db, lexical().slice(0, limit)), retrieval: { mode: "lexical", status: "fallback", warning: String((error as Error).message), elapsedMs: Date.now() - started } }; }
  if (!config) {
    if (mode === "semantic") throw new Error("Semantic index is not configured; run vector-build");
    return { results: enrichWikiLinks(db, lexical().slice(0, limit)), retrieval: { mode: "lexical", status: mode === "hybrid" ? "fallback" : "ok", ...(mode === "hybrid" ? { warning: "Semantic index is not configured; run vector-build" } : {}), elapsedMs: Date.now() - started } };
  }
  try {
    const canonical = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.sort().join(" ") ?? value.trim().toLowerCase();
    const cueMap = new Map<string, string>();
    for (const cue of input.cues ?? []) { const value = cue.trim(); if (value) cueMap.set(canonical(value), value); }
    const cues = [...cueMap.values()].slice(0, 8);
    const textMap = new Map<string, string>();
    const combinedTopic = [input.query, ...cues].map(text => text.trim()).filter(Boolean).join("\n");
    const embeddingInputs = [input.query, ...(cues.length ? [combinedTopic] : []), ...cues];
    for (const value of embeddingInputs.map(text => text.trim()).filter(Boolean)) textMap.set(canonical(value), value);
    const texts = [...textMap.values()].slice(0, 10);
    if (!texts.length) return { results: [], retrieval: { mode: mode === "semantic" ? "semantic" : "hybrid", status: "ok", elapsedMs: Date.now() - started, candidates: 0 } };
    const embedded = await embedTexts(config.endpoints.embedder, texts, "query", signal);
    if (embedded.identity.model !== config.model.model || embedded.identity.revision !== config.model.revision) throw new Error("Embedder model revision differs from the built vector index");
    const where: any[] = [{ key: "model_revision", match: { value: config.model.revision } }, { key: "chunking_revision", match: { value: CHUNKING_REVISION } }];
    // Wiki pages are curated cross-project knowledge: project scope never excludes them.
    if (input.scope !== "all") { if (!input.project) return { results: [], retrieval: { mode: "hybrid", status: "ok", elapsedMs: Date.now() - started, candidates: 0 } }; where.push({ should: [{ key: "project", match: { value: input.project } }, { key: "source", match: { value: "wiki" } }] }); }
    if (input.source) where.push({ key: "source", match: { value: input.source } });
    if (input.session) where.push({ key: "session", match: { value: input.session } });
    const mustNot = input.currentSession ? [{ key: "session", match: { value: input.currentSession } }] : [];
    const vectorMap = new Map<string, { payload: any; rrfScore: number; similarity: number }>();
    const vectorResponses = await Promise.all(embedded.vectors.map(vector => requestJson<any>(`${config.endpoints.qdrant}/collections/${config.collection}/points/query`, { method: "POST", body: JSON.stringify({ query: vector, filter: { must: where, must_not: mustNot }, limit: 40, with_payload: true, with_vector: false }), signal })));
    vectorResponses.forEach(response => {
      const points = response?.result?.points;
      if (!Array.isArray(points)) throw new Error("Qdrant returned an invalid query response");
      const seenParents = new Set<string>();
      let uniqueRank = 0;
      for (const point of points) {
        const p = point?.payload;
        if (!p || typeof p.result_id !== "string" || p.result_id.length > 64 || !["pi", "opencode", "claude", "grok", "wiki"].includes(p.source) || typeof p.session !== "string" || p.session.length > 200 || typeof p.project !== "string" || p.project.length > 4096 || typeof p.content_hash !== "string" || !Number.isFinite(point.score) || point.score < -1 || point.score > 1) continue;
        const key = p.result_id;
        if (seenParents.has(key)) continue;
        seenParents.add(key);
        uniqueRank++;
        const contribution = 1 / (RRF_K + uniqueRank);
        const prior = vectorMap.get(key);
        if (!prior) vectorMap.set(key, { payload: p, rrfScore: contribution, similarity: point.score });
        else {
          prior.rrfScore += contribution;
          if (point.score > prior.similarity) { prior.payload = p; prior.similarity = point.score; }
        }
      }
    });
    const lexicalRows = mode === "semantic" ? [] : lexical();
    const lexById = new Map(lexicalRows.map((row, i) => [row.result_id, { row, rank: i + 1 }]));
    const fused = new Map<string, { row: any; score: number; excerpt: string; vectorStart?: number; vectorEnd?: number }>();
    if (mode !== "semantic") {
      for (const [key, value] of lexById) fused.set(key, { row: value.row, score: 1 / (RRF_K + value.rank), excerpt: value.row.excerpt });
    }
    const floor = input.cosineFloor ?? 0.75;
    const verify = db.prepare("SELECT d.result_id,d.source,d.session_id,d.project,d.entry_id,d.role,d.timestamp,d.text,e.origin FROM documents d JOIN entries e ON e.source=d.source AND e.session_id=d.session_id AND e.entry_id=d.entry_id WHERE d.result_id=?");
    for (const [key, value] of vectorMap) {
      if (value.similarity < floor) continue;
      const row = verify.get(key) as any;
      if (!row || row.source !== value.payload.source || row.session_id !== value.payload.session || row.project !== value.payload.project || input.source && row.source !== input.source || input.session && row.session_id !== input.session || input.currentSession && row.source !== "wiki" && row.session_id === input.currentSession || input.scope !== "all" && row.source !== "wiki" && row.project !== input.project) continue;
      const hashNow = contentHash(row.text);
      if (hashNow !== value.payload.content_hash || value.payload.model_revision !== config.model.revision || value.payload.chunking_revision !== CHUNKING_REVISION) continue;
      const start = Number(value.payload.start); const end = Number(value.payload.end);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > row.text.length) continue;
      const existing = fused.get(key);
      const vectorRankScore = value.rrfScore;
      let excerptEnd = Math.min(end, start + 480);
      if (excerptEnd < end && excerptEnd > start && /[\uD800-\uDBFF]/.test(row.text[excerptEnd - 1])) excerptEnd--;
      const chunkExcerpt = row.text.slice(start, excerptEnd);
      if (existing) { existing.score += vectorRankScore; existing.excerpt = chunkExcerpt; existing.vectorStart = start; existing.vectorEnd = excerptEnd; existing.row.text = row.text; }
      else fused.set(key, { row, score: vectorRankScore, excerpt: chunkExcerpt, vectorStart: start, vectorEnd: excerptEnd });
    }
    const distinctCues = [...new Set((input.cues ?? []).map(cue => cue.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.sort().join(" ") ?? ""))].filter(Boolean);
    const readText = db.prepare("SELECT text FROM documents WHERE result_id=?");
    const results = [...fused.values()].map(value => {
      const text = String(value.row.text ?? (readText.get(value.row.result_id) as any)?.text ?? "");
      const textTerms = new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
      const cueCoverage = distinctCues.reduce((count, cue) => count + (cue.split(" ").every(term => textTerms.has(term)) ? 1 : 0), 0);
      return {
        result_id: value.row.result_id,
        source: value.row.source,
        session_id: value.row.session_id,
        project: value.row.project,
        entry_id: value.row.entry_id,
        role: value.row.role,
        timestamp: value.row.timestamp,
        excerpt: value.excerpt,
        snippet_start: value.vectorStart ?? value.row.snippet_start,
        snippet_end: value.vectorEnd ?? value.row.snippet_end,
        text_length: value.row.text_length ?? text.length,
        score: value.score + cueCoverage * 0.01,
        cueCoverage,
        origin: value.row.origin,
        provenance: { source: value.row.source, sessionId: value.row.session_id, project: value.row.project, entryId: value.row.entry_id, resultId: value.row.result_id, origin: value.row.origin },
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    return { results: enrichWikiLinks(db, results), retrieval: { mode: mode === "semantic" ? "semantic" : "hybrid", status: "ok", elapsedMs: Date.now() - started, candidates: vectorMap.size, lexicalCandidates: lexicalRows.length, cosineFloor: floor } };
  } catch (error) {
    if (mode === "semantic") throw error;
    return { results: enrichWikiLinks(db, lexical().slice(0, limit)), retrieval: { mode: "lexical", status: "fallback", warning: `Semantic retrieval unavailable: ${(error as Error).message}`, elapsedMs: Date.now() - started } };
  }
}
