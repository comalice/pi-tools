import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { chunkText, contentHash } from "../src/memory/chunking.ts";
import { expand, openStore, replaceSession, search, stableId } from "../src/memory/store.ts";
import { buildVectorIndex, readSemanticConfig, refreshVectorIndex, searchMemory, vectorStatus } from "../src/memory/semantic.ts";
import { embedTexts, localHttpUrl, requestJson } from "../src/memory/vector-client.ts";

const servers: any[] = [];
const dirs: string[] = [];
const revisionA = "a".repeat(64);
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function mockServer(handler: (request: any, response: any) => void) {
  const server = createServer(handler);
  servers.push(server);
  return new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}
function json(response: any, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function body(request: any) {
  let value = "";
  for await (const part of request) value += part;
  return JSON.parse(value);
}

describe("semantic memory primitives", () => {
  it("chunks full content with deterministic overlapping UTF-16-safe offsets and content hashes", () => {
    const text = `a`.repeat(1399) + "😀" + "b".repeat(1800);
    const chunks = chunkText(text);
    assert.equal(chunks[0].start, 0);
    assert.equal(chunks[0].end, 1399);
    assert.equal(chunks[1].start, 1199);
    assert.equal(chunks.map(chunk => chunk.text).join("").includes("😀"), true);
    for (const chunk of chunks) {
      assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
      assert.equal(chunk.contentHash, contentHash(text));
      assert.ok(!(chunk.end < text.length && /[\uD800-\uDBFF]/.test(text[chunk.end - 1])));
    }
    assert.notEqual(contentHash(text), contentHash(`${text}!`));
    assert.equal(chunks[1].start < chunks[0].end, true);
    let coveredUntil = 0;
    for (const chunk of chunks) {
      assert.ok(chunk.start <= coveredUntil);
      coveredUntil = Math.max(coveredUntil, chunk.end);
    }
    assert.equal(coveredUntil, text.length);
    const tiny = chunkText("a😀", 2, 1);
    assert.deepEqual(tiny.map(chunk => [chunk.start, chunk.end]), [[0, 1], [1, 3]]);
    assert.equal(tiny.map(chunk => chunk.text).join(""), "a😀");
  });

  it("enforces loopback URLs and rejects redirects", async () => {
    assert.throws(() => localHttpUrl("https://127.0.0.1:6333", "endpoint"), /loopback HTTP/);
    assert.throws(() => localHttpUrl("http://example.com", "endpoint"), /loopback HTTP/);
    await assert.rejects(requestJson("http://example.com"), /loopback HTTP/);
    const base = await mockServer((request, response) => {
      if (request.url === "/redirect") { response.writeHead(302, { location: "http://127.0.0.1/elsewhere" }); response.end(); return; }
      json(response, { model: "fake", revision: "r", dimension: 383, vectors: [Array(383).fill(0)] });
    });
    await assert.rejects(requestJson(`${base}/redirect`), /fetch failed|redirect/i);
    await assert.rejects(embedTexts(base, ["synthetic"], "query"), /identity or vector count/);
  });

  it("builds a private versioned collection and keeps the prior active sidecar on failed rebuild", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-vector-build-"));
    dirs.push(directory);
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    replaceSession(db, "pi", "s1", "/project", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: null, text: "synthetic vector passage ".repeat(80), indexable: true },
    ]);
    db.close();
    let pointCount = 0;
    let failCount = false;
    let hasTextPayload = false;
    const embedder = await mockServer(async (request, response) => {
      if (request.url === "/health") return json(response, { status: "ok", model: "synthetic-model", revision: revisionA, dimension: 384, max_tokens: 512, service_version: 1 });
      if (request.url === "/embed") {
        const input = await body(request);
        return json(response, { model: "synthetic-model", revision: revisionA, dimension: 384, vectors: input.texts.map(() => Array(384).fill(0.01)) });
      }
      json(response, {}, 404);
    });
    const qdrant = await mockServer(async (request, response) => {
      if (request.method === "PUT" && request.url?.startsWith("/collections/") && !request.url.includes("/points")) return json(response, { result: true });
      if (request.method === "PUT" && request.url?.includes("/points?")) {
        const input = await body(request);
        pointCount += input.points.length;
        hasTextPayload ||= input.points.some((point: any) => Object.hasOwn(point.payload, "text"));
        return json(response, { result: true });
      }
      if (request.url?.endsWith("/points/count")) return json(response, failCount ? { result: { count: pointCount + 1 } } : { result: { count: pointCount } });
      if (request.method === "DELETE") return json(response, { result: true });
      json(response, {}, 404);
    });
    const oldEmbedder = process.env.PI_MEMORY_EMBEDDER_URL;
    const oldQdrant = process.env.PI_MEMORY_QDRANT_URL;
    process.env.PI_MEMORY_EMBEDDER_URL = embedder;
    process.env.PI_MEMORY_QDRANT_URL = qdrant;
    try {
      const built = await buildVectorIndex(index);
      const active = JSON.parse(await fs.readFile(`${index}.semantic.json`, "utf8"));
      assert.equal(active.collection, built.collection);
      assert.equal(active.chunkCount, pointCount);
      assert.equal((await fs.stat(`${index}.semantic.json`)).mode & 0o077, 0);
      assert.equal(hasTextPayload, false);
      pointCount = 0;
      failCount = true;
      await assert.rejects(buildVectorIndex(index), /count verification/);
      const stillActive = JSON.parse(await fs.readFile(`${index}.semantic.json`, "utf8"));
      assert.equal(stillActive.collection, active.collection);
    } finally {
      if (oldEmbedder === undefined) delete process.env.PI_MEMORY_EMBEDDER_URL; else process.env.PI_MEMORY_EMBEDDER_URL = oldEmbedder;
      if (oldQdrant === undefined) delete process.env.PI_MEMORY_QDRANT_URL; else process.env.PI_MEMORY_QDRANT_URL = oldQdrant;
    }
  });

  it("refreshes the vector index only when configured, stale, and reachable, then removes the superseded generation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-vector-refresh-"));
    dirs.push(directory);
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    replaceSession(db, "pi", "s1", "/project", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: null, text: "synthetic refresh passage", indexable: true },
    ]);
    db.close();

    assert.deepEqual(await refreshVectorIndex(index), { refreshed: false, reason: "not_configured" });

    const revision = "b".repeat(64);
    let healthFails = false;
    const embedder = await mockServer(async (request, response) => {
      if (request.url === "/health") {
        if (healthFails) return json(response, { error: "synthetic down" }, 503);
        return json(response, { status: "ok", model: "synthetic-model", revision, dimension: 384, max_tokens: 512, service_version: 1 });
      }
      if (request.url === "/embed") {
        const input = await body(request);
        return json(response, { model: "synthetic-model", revision, dimension: 384, vectors: input.texts.map(() => Array(384).fill(0.01)) });
      }
      json(response, {}, 404);
    });
    let pointCount = 0;
    const deleted: string[] = [];
    const qdrant = await mockServer(async (request, response) => {
      if (request.method === "GET" && request.url?.includes("gmissing")) return json(response, { error: "synthetic missing" }, 404);
      if (request.method === "GET" && request.url?.startsWith("/collections/")) return json(response, { result: { config: { params: { vectors: { size: 384, distance: "Cosine" } } } } });
      if (request.method === "PUT" && request.url?.startsWith("/collections/") && !request.url.includes("/points")) return json(response, { result: true });
      if (request.method === "PUT" && request.url?.includes("/points?")) {
        const input = await body(request);
        pointCount += input.points.length;
        return json(response, { result: true });
      }
      if (request.url?.endsWith("/points/count")) return json(response, { result: { count: pointCount } });
      if (request.method === "DELETE") { deleted.push(request.url!); return json(response, { result: true }); }
      json(response, {}, 404);
    });

    const oldEmbedder = process.env.PI_MEMORY_EMBEDDER_URL;
    const oldQdrant = process.env.PI_MEMORY_QDRANT_URL;
    process.env.PI_MEMORY_EMBEDDER_URL = embedder;
    process.env.PI_MEMORY_QDRANT_URL = qdrant;
    try {
    const namespace = createHash("sha256").update(index).digest("hex").slice(0, 16);
    const previousCollection = `memory_${namespace}_gold123_12345678`;
    const sidecar = { version: 1, archive: index, collection: previousCollection, namespace, endpoints: { embedder, qdrant }, model: { model: "synthetic-model", revision, dimension: 384, max_tokens: 512 }, chunkingRevision: "chars-1400-overlap-200-v1", documentCount: 1, chunkCount: 1, builtAt: new Date().toISOString() };
    const writeSidecar = async (overrides: any) => fs.writeFile(`${index}.semantic.json`, JSON.stringify({ ...sidecar, ...overrides }), { mode: 0o600 });

    healthFails = true;
    await writeSidecar({});
    const unavailable = await refreshVectorIndex(index);
    assert.equal(unavailable.refreshed, false);
    if (!unavailable.refreshed) assert.equal(unavailable.reason, "unavailable");
    healthFails = false;

    await writeSidecar({});
    assert.deepEqual(await refreshVectorIndex(index), { refreshed: false, reason: "current" });

    await writeSidecar({ documentCount: 0, chunkCount: 0 });
    assert.deepEqual(await refreshVectorIndex(index), { refreshed: false, reason: "recent" });

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeSidecar({ documentCount: 0, chunkCount: 0, builtAt: old });
    const refreshed = await refreshVectorIndex(index);
    assert.equal(refreshed.refreshed, true);
    if (refreshed.refreshed) {
      assert.equal(refreshed.removedCollection, previousCollection);
      assert.equal(refreshed.build.documentCount, 1);
      assert.equal(refreshed.build.chunkCount, pointCount);
    }
    assert.deepEqual(deleted, [`/collections/${previousCollection}`]);
    const active = JSON.parse(await fs.readFile(`${index}.semantic.json`, "utf8"));
    assert.notEqual(active.collection, previousCollection);
    assert.equal(active.documentCount, 1);

    pointCount = 0;
    await writeSidecar({ collection: `memory_${namespace}_gmissing_12345678`, builtAt: new Date().toISOString() });
    const missing = await refreshVectorIndex(index);
    assert.equal(missing.refreshed, true);
    } finally {
      if (oldEmbedder === undefined) delete process.env.PI_MEMORY_EMBEDDER_URL; else process.env.PI_MEMORY_EMBEDDER_URL = oldEmbedder;
      if (oldQdrant === undefined) delete process.env.PI_MEMORY_QDRANT_URL; else process.env.PI_MEMORY_QDRANT_URL = oldQdrant;
    }
  });

  it("handles stale vector hits, chunk deduplication, query filtering, and lexical fallback", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-vector-search-"));
    dirs.push(directory);
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    replaceSession(db, "pi", "s1", "/project", [{ entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: null, text: "synthetic durable alpha fact", indexable: true }]);
    replaceSession(db, "pi", "s2", "/other", [{ entry_id: "e2", parent_id: null, role: "user", kind: "message", timestamp: null, text: "synthetic durable beta fact", indexable: true }]);
    const vectorText = "vector-only semantic passage without lexical match";
    replaceSession(db, "pi", "s3", "/project", [{ entry_id: "e3", parent_id: null, role: "assistant", kind: "message", timestamp: null, text: vectorText, indexable: true }]);
    const e1 = stableId("pi", "s1", "e1");
    const e3 = stableId("pi", "s3", "e3");
    let lastEmbeddedTexts: string[] = [];
    const embedder = await mockServer(async (request, response) => {
      if (request.url === "/health") return json(response, { status: "ok", model: "fake", revision: revisionA, dimension: 384, max_tokens: 512 });
      if (request.url === "/embed") {
        const input = await body(request);
        lastEmbeddedTexts = input.texts;
        return json(response, { model: "fake", revision: revisionA, dimension: 384, vectors: input.texts.map(() => Array(384).fill(0.1)) });
      }
      json(response, {}, 404);
    });
    let failQueries = false;
    let vectorScore = 0.85;
    const qdrant = await mockServer(async (request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/collections/")) return json(response, { result: { config: { params: { vectors: { size: 384, distance: "Cosine" } } } } });
      if (request.url?.endsWith("/points/count")) return json(response, { result: { count: 2 } });
      if (request.url?.endsWith("/points/query")) {
        if (failQueries) return json(response, { error: "synthetic unavailable" }, 503);
        const input = await body(request);
        assert.ok(input.filter.must.some((clause: any) => clause.should?.some((inner: any) => inner.key === "project" && inner.match.value === "/project") && clause.should.some((inner: any) => inner.key === "source" && inner.match.value === "wiki")));
        assert.ok(input.filter.must_not.some((clause: any) => clause.key === "session" && clause.match.value === "current-session"));
        return json(response, { result: { points: [
          { id: "1", score: 0.9, payload: { result_id: e1, source: "pi", session: "s1", project: "/project", start: 0, end: 28, content_hash: "stale", model_revision: revisionA, chunking_revision: "chars-1400-overlap-200-v1" } },
          { id: "2", score: 0.8, payload: { result_id: e1, source: "pi", session: "s1", project: "/project", start: 0, end: 28, content_hash: "stale", model_revision: revisionA, chunking_revision: "chars-1400-overlap-200-v1" } },
          { id: "3", score: vectorScore, payload: { result_id: e3, source: "pi", session: "s3", project: "/project", start: 0, end: vectorText.length, content_hash: contentHash(vectorText), model_revision: revisionA, chunking_revision: "chars-1400-overlap-200-v1" } },
          { id: "4", score: vectorScore - 0.01, payload: { result_id: e3, source: "pi", session: "s3", project: "/project", start: 0, end: vectorText.length, content_hash: contentHash(vectorText), model_revision: revisionA, chunking_revision: "chars-1400-overlap-200-v1" } },
        ] } });
      }
      json(response, {}, 404);
    });
    const oldEmbedder = process.env.PI_MEMORY_EMBEDDER_URL;
    const oldQdrant = process.env.PI_MEMORY_QDRANT_URL;
    process.env.PI_MEMORY_EMBEDDER_URL = embedder;
    process.env.PI_MEMORY_QDRANT_URL = qdrant;
    try {
      const namespace = createHash("sha256").update(index).digest("hex").slice(0, 16);
      await fs.writeFile(`${index}.semantic.json`, JSON.stringify({ version: 1, archive: index, collection: `memory_${namespace}_gabc123_12345678`, namespace, endpoints: { embedder, qdrant }, model: { model: "fake", revision: revisionA, dimension: 384, max_tokens: 512 }, chunkingRevision: "chars-1400-overlap-200-v1", documentCount: 2, chunkCount: 2, builtAt: new Date().toISOString() }), { mode: 0o600 });
      assert.doesNotThrow(() => readSemanticConfig(index));
      const ready = await vectorStatus(index);
      assert.equal(ready.status, "ready");
      assert.equal(ready.ready, true);
      const rawConfig = JSON.parse(await fs.readFile(`${index}.semantic.json`, "utf8"));
      rawConfig.endpoints.qdrant = "http://example.com";
      await fs.writeFile(`${index}.semantic.json`, JSON.stringify(rawConfig), { mode: 0o600 });
      assert.throws(() => readSemanticConfig(index), /loopback HTTP/);
      rawConfig.endpoints.qdrant = qdrant;
      await fs.writeFile(`${index}.semantic.json`, JSON.stringify(rawConfig), { mode: 0o600 });
      await assert.rejects(searchMemory(db, index, { query: "alpha", project: "/project", currentSession: "current-session", mode: "semantic", limit: 50 }), /limit must be an integer/);
      const result = await searchMemory(db, index, { query: "alpha", cues: ["durable alpha", "fact", "fact"], project: "/project", currentSession: "current-session", mode: "hybrid" });
      assert.ok(lastEmbeddedTexts.includes("alpha\ndurable alpha\nfact"));
      assert.equal(lastEmbeddedTexts.filter(text => text === "fact").length, 1);
      assert.equal(result.results.length, 2);
      assert.equal(result.results[0].result_id, e3);
      assert.equal(Object.hasOwn(result.results[0], "text"), false);
      assert.equal(result.results[0].snippet_start, 0);
      assert.equal(result.results[0].snippet_end, vectorText.length);
      assert.equal(result.results[0].provenance.resultId, e3);
      assert.equal(result.results.some(row => row.result_id === e1), true);
      assert.equal(result.retrieval.mode, "hybrid");
      assert.equal(result.retrieval.status, "ok");
      const semantic = await searchMemory(db, index, { query: "alpha", project: "/project", currentSession: "current-session", mode: "semantic" });
      assert.equal(semantic.results.length, 1);
      assert.equal(semantic.results[0].result_id, e3);
      assert.equal(Object.hasOwn(semantic.results[0], "text"), false);
      failQueries = true;
      const fallback = await searchMemory(db, index, { query: "alpha", project: "/project", currentSession: "current-session", mode: "hybrid" });
      assert.equal(fallback.results.length, 1);
      assert.equal(fallback.retrieval.mode, "lexical");
      assert.equal(fallback.retrieval.status, "fallback");
      await assert.rejects(searchMemory(db, index, { query: "alpha", project: "/project", currentSession: "current-session", mode: "semantic" }), /HTTP 503/);
      const automatic = await searchMemory(db, index, { query: "alpha", project: "/project", currentSession: "current-session", mode: "auto" });
      assert.equal(automatic.results.length, 1);
      failQueries = false;
      vectorScore = 0.74;
      const absent = await searchMemory(db, index, { query: "zzqvxjp7180f93", project: "/project", currentSession: "current-session", mode: "hybrid" });
      assert.equal(absent.results.length, 0);
      const relaxed = await searchMemory(db, index, { query: "zzqvxjp7180f93", project: "/project", currentSession: "current-session", mode: "semantic", cosineFloor: 0.7 });
      assert.equal(relaxed.results.length, 1);
    } finally {
      db.close();
      if (oldEmbedder === undefined) delete process.env.PI_MEMORY_EMBEDDER_URL; else process.env.PI_MEMORY_EMBEDDER_URL = oldEmbedder;
      if (oldQdrant === undefined) delete process.env.PI_MEMORY_QDRANT_URL; else process.env.PI_MEMORY_QDRANT_URL = oldQdrant;
    }
  });

  it("centers snippets, paginates target text and offers only valid Pi descendants at forks", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-expand-"));
    dirs.push(directory);
    const db = openStore(path.join(directory, "archive.sqlite"));
    replaceSession(db, "pi", "s", "/project", [
      { entry_id: "target", parent_id: null, role: "user", kind: "message", timestamp: null, text: "x".repeat(600) + "😀 pivotal needle " + "y".repeat(2000), indexable: true },
      { entry_id: "metadata", parent_id: "target", role: null, kind: "custom", timestamp: null, text: "", indexable: false },
      { entry_id: "left", parent_id: "metadata", role: "assistant", kind: "message", timestamp: null, text: "left answer", indexable: true },
      { entry_id: "right", parent_id: "metadata", role: "assistant", kind: "message", timestamp: null, text: "right answer", indexable: true },
    ]);
    const resultId = stableId("pi", "s", "target");
    const results = search(db, { query: "pivotal needle", project: "/project" });
    assert.equal(results[0].snippet_start <= 600, true);
    assert.equal(results[0].snippet_end - results[0].snippet_start, results[0].excerpt.length);
    assert.match(results[0].excerpt, /pivotal needle/);
    const page = expand(db, resultId, { project: "/project", maxChars: 300, offset: 601 })!;
    const targetPart = page.text.slice(page.text.indexOf("\n") + 1).replace(/…\[truncated\]$/, "");
    assert.equal(page.offset, 600);
    assert.match(targetPart, /^😀/);
    assert.equal(page.nextOffset, page.offset + targetPart.length);
    assert.ok(page.nextOffset !== null);
    const targetSource = "x".repeat(600) + "😀 pivotal needle " + "y".repeat(2000);
    assert.ok(!(page.nextOffset < targetSource.length && /[\uD800-\uDBFF]/.test(targetSource[page.nextOffset - 1]) && /[\uDC00-\uDFFF]/.test(targetSource[page.nextOffset])));
    assert.match(page.text, /truncated/);
    const forward = expand(db, resultId, { project: "/project", direction: "forward" })!;
    assert.deepEqual(forward.branchChoices.map((choice: any) => choice.entryId), ["left", "right"]);
    assert.equal(forward.text.includes("left answer"), false);
    const selected = expand(db, resultId, { project: "/project", direction: "forward", branchId: "left" })!;
    assert.match(selected.text, /left answer/);
    assert.equal(expand(db, resultId, { project: "/elsewhere", direction: "forward", branchId: "left" }), null);
    assert.equal(expand(db, resultId, { project: "/project", direction: "forward", branchId: "outsider" }), null);

    replaceSession(db, "pi", "context", "/project", [
      { entry_id: "old", parent_id: null, role: "user", kind: "message", timestamp: null, text: "older context that should not displace a nearer reply ".repeat(20), indexable: true },
      { entry_id: "near", parent_id: "old", role: "assistant", kind: "message", timestamp: null, text: "nearest useful context", indexable: true },
      { entry_id: "focus", parent_id: "near", role: "user", kind: "message", timestamp: null, text: "focused target", indexable: true },
      { entry_id: "reply", parent_id: "focus", role: "assistant", kind: "message", timestamp: null, text: "following reply ".repeat(100), indexable: true },
    ]);
    const focusId = stableId("pi", "context", "focus");
    const contextual = expand(db, focusId, { project: "/project", maxChars: 300 })!;
    assert.match(contextual.text, /nearest useful context/);
    assert.doesNotMatch(contextual.text, /older context/);
    assert.ok(contextual.text.indexOf("nearest useful context") < contextual.text.indexOf("focused target"));
    const replyPage = expand(db, focusId, { project: "/project", maxChars: 200, direction: "forward" })!;
    assert.equal(replyPage.repliesTruncated, true);
    assert.equal(replyPage.nextResultId, stableId("pi", "context", "reply"));
    assert.ok(expand(db, replyPage.nextResultId!, { project: "/project" }));
    db.close();
  });
});
