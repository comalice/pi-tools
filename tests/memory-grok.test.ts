import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ingestGrok } from "../src/memory/ingest.ts";
import { expand, listSessions, openStore, search, stableId } from "../src/memory/store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function ts(ms: number) {
  return { $date: { $numberLong: String(ms) } };
}

function conv(id: string, title: string, responses: any[], modifyTime = "2026-11-09T19:42:14.653Z") {
  return {
    conversation: { id, title, create_time: "2026-11-09T19:40:55.622281Z", modify_time: modifyTime, temporary: false, starred: false },
    responses: responses.map((r) => ({ response: r, share_link: null })),
  };
}

function resp(id: string, parent: string | null, sender: string, message: string, ms: number, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    conversation_id: "c1",
    message,
    sender,
    create_time: ts(ms),
    parent_response_id: parent,
    model: "",
    metadata: {},
    children: [],
    path: parent ? [parent] : [],
    ...extra,
  };
}

function backend(conversations: any[]) {
  return JSON.stringify({ conversations, projects: [], tasks: [], media_posts: [] });
}

describe("grok export ingest", () => {
  it("ingests a backend file, maps senders to roles, and traverses parent chains", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-grok-"));
    dirs.push(directory);
    const root = path.join(directory, "exports");
    await fs.mkdir(root, { recursive: true });
    const db = openStore(path.join(directory, "archive.sqlite"));

    const base = Date.parse("2026-11-09T19:40:55Z");
    const file = backend([
      conv("c1", "Docling archive search", [
        resp("r1", null, "human", "how do I pipe word docs through docling", base),
        resp("r2", "r1", "assistant", "use docling pipelines then a full text index", base + 1000, { model: "grok-4", web_search_results: [{ url: "https://example.com" }] }),
        resp("r3", "r2", "human", "thanks", base + 2000),
      ]),
      conv("c2", "Second chat", [
        resp("x1", null, "human", "unrelated question", base),
        resp("x2", "x1", "ASSISTANT", "unrelated answer", base + 1000, { model: "grok-3" }),
      ]),
    ]);
    await fs.writeFile(path.join(root, "prod-grok-backend.json"), file);
    // A malformed backend-named file still surfaces a per-file error, while
    // non-backend JSONs (auth/billing) are ignored by the narrowed walk.
    await fs.writeFile(path.join(root, "prod-grok-backend-corrupt.json"), "{not json");
    await fs.writeFile(path.join(root, "prod-mc-billing.json"), "{not json either");

    const first = ingestGrok(db, root);
    assert.equal(first.indexed, 2);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /prod-grok-backend-corrupt\.json/);
    // Non-backend JSONs are skipped, not errors, and the skip is reported.
    assert.equal(first.skipped.length, 1);
    assert.match(first.skipped[0], /prod-mc-billing\.json/);

    // sender "human" -> user; everything else -> assistant
    const results = search(db, { query: "docling", project: "/anywhere", scope: "all" });
    assert.ok(results.length >= 1);
    assert.equal(results[0].source, "grok");
    assert.equal(results[0].project, "grok");
    const assistantHit = results.find((r) => r.role === "assistant");
    assert.ok(assistantHit, "expected an assistant-role result");

    // forward traversal follows the parent chain like pi/claude
    const rootId = stableId("grok", "c1", "r1");
    const forward = expand(db, rootId, { scope: "all", direction: "forward", maxChars: 3000 })!;
    assert.match(forward.text, /full text index/);
    assert.equal(forward.branch.ancestry, "entry parent chain");

    // session title is stored
    const sessions = listSessions(db, "2026-01-01T00:00:00Z");
    const row = sessions.find((r) => r.session_id === "c1");
    assert.equal(row.source, "grok");
    assert.equal(row.title, "Docling archive search");

    db.close();
  });

  it("treats re-ingest of an unchanged file as unchanged and dedupes conversation ids", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-grok-dedup-"));
    dirs.push(directory);
    const root = path.join(directory, "exports");
    await fs.mkdir(root, { recursive: true });
    const db = openStore(path.join(directory, "archive.sqlite"));
    const base = Date.parse("2026-11-09T19:40:55Z");
    const file = backend([conv("c1", "Chat", [resp("r1", null, "human", "hello", base)])]);
    await fs.writeFile(path.join(root, "prod-grok-backend.json"), file);
    const first = ingestGrok(db, root);
    assert.equal(first.indexed, 1);
    const second = ingestGrok(db, root);
    assert.equal(second.unchanged, 1);
    assert.equal(second.indexed, 0);
    db.close();
  });

  it("merges duplicate conversation ids by latest modify_time across export files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-grok-merge-"));
    dirs.push(directory);
    const root = path.join(directory, "exports");
    await fs.mkdir(root, { recursive: true });
    const db = openStore(path.join(directory, "archive.sqlite"));
    const base = Date.parse("2026-11-09T19:40:55Z");

    // Two exports of the same conversation; the older snapshot sorts first.
    const older = backend([conv("c1", "Chat", [resp("r1", null, "human", "question", base), resp("r2", "r1", "assistant", "use pinecone for vectors", base + 1000)], "2026-11-01T00:00:00Z")]);
    const newer = backend([conv("c1", "Chat", [resp("r1", null, "human", "question", base), resp("r2", "r1", "assistant", "use milvus for vectors", base + 1000), resp("r3", "r2", "human", "thanks", base + 2000)], "2026-12-01T00:00:00Z")]);
    const olderFile = path.join(root, "prod-grok-backend-2026-11.json");
    const newerFile = path.join(root, "prod-grok-backend-2026-12.json");
    await fs.writeFile(olderFile, older);
    await fs.writeFile(newerFile, newer);

    const first = ingestGrok(db, root);
    assert.equal(first.indexed, 1);
    assert.equal(first.duplicates, 1);
    // The newer snapshot wins even though its file sorts later.
    let hits = search(db, { query: "milvus", project: "/anywhere", scope: "all" });
    assert.equal(hits.length, 1);
    assert.equal(search(db, { query: "pinecone", project: "/anywhere", scope: "all" }).length, 0);

    // Re-ingest is stable.
    assert.equal(ingestGrok(db, root).unchanged, 1);

    // Removing the newer export falls back to the older snapshot rather than
    // losing the conversation.
    await fs.rm(newerFile);
    const fallback = ingestGrok(db, root);
    assert.equal(fallback.indexed, 1);
    assert.equal(fallback.removed, 0);
    hits = search(db, { query: "pinecone", project: "/anywhere", scope: "all" });
    assert.equal(hits.length, 1);
    assert.equal(search(db, { query: "milvus", project: "/anywhere", scope: "all" }).length, 0);

    // Removing all exports prunes the session.
    await fs.rm(olderFile);
    const gone = ingestGrok(db, root);
    assert.equal(gone.removed, 1);
    assert.equal(search(db, { query: "pinecone", project: "/anywhere", scope: "all" }).length, 0);
    db.close();
  });

  it("accepts a single file path as the root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-grok-file-"));
    dirs.push(directory);
    const db = openStore(path.join(directory, "archive.sqlite"));
    const base = Date.parse("2026-11-09T19:40:55Z");
    const file = path.join(directory, "prod-grok-backend.json");
    await fs.writeFile(file, backend([conv("c1", "Solo", [resp("r1", null, "human", "solo", base)])]));
    const result = ingestGrok(db, file);
    assert.equal(result.indexed, 1);
    db.close();
  });

  it("reports a missing exports root without failing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-grok-missing-"));
    dirs.push(directory);
    const db = openStore(path.join(directory, "archive.sqlite"));
    assert.equal(ingestGrok(db, path.join(directory, "nope")).missing, true);
    db.close();
  });
});
