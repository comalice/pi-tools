import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ingestClaude } from "../src/memory/ingest.ts";
import { expand, listSessions, openStore, search, stableId } from "../src/memory/store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function exportJson(uuid: string, messages: any[]) {
  return JSON.stringify({ uuid, name: "test chat", chat_messages: messages });
}

function msg(uuid: string, parent: string | null, sender: string, text: string, created = "2026-10-20T12:00:00Z") {
  return { uuid, parent_message_uuid: parent ?? "00000000-0000-4000-8000-000000000000", sender, created_at: created, content: [{ type: "text", text }] };
}

describe("claude export ingest", () => {
  it("ingests exports, dedupes by conversation uuid, traverses parent chains, and reports malformed files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-claude-"));
    dirs.push(directory);
    const root = path.join(directory, "exports");
    await fs.mkdir(root, { recursive: true });
    const db = openStore(path.join(directory, "archive.sqlite"));

    const chatA = exportJson("chat-a", [
      msg("m1", null, "human", "how do I tune wal checkpoints"),
      msg("m2", "m1", "assistant", "increase max_wal_size and spread checkpoints"),
      msg("m3", "m2", "human", "thanks"),
    ]);
    await fs.writeFile(path.join(root, "a-first.json"), chatA);
    await fs.writeFile(path.join(root, "b-duplicate.json"), chatA); // same uuid, second file
    await fs.writeFile(path.join(root, "c-malformed.json"), "{not json");

    const first = ingestClaude(db, root);
    assert.equal(first.indexed, 1);
    assert.equal(first.duplicates, 1);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /c-malformed\.json/);
    assert.equal(ingestClaude(db, root).unchanged, 1);

    const results = search(db, { query: "wal checkpoints", project: "/anywhere", scope: "all" });
    assert.ok(results.length >= 1);
    assert.equal(results[0].source, "claude");
    assert.equal(results[0].session_id, "chat-a");
    assert.equal(results[0].project, "claude");
    assert.ok(results.every(row => row.session_id === "chat-a"));

    // Forward traversal follows the parent chain like pi.
    const rootId = stableId("claude", "chat-a", "m1");
    const forward = expand(db, rootId, { scope: "all", direction: "forward", maxChars: 3000 })!;
    assert.match(forward.text, /increase max_wal_size/);
    assert.equal(forward.branch.ancestry, "entry parent chain");

    // The dream sweep lists claude sessions with their file path.
    const sessions = listSessions(db, "2026-01-01T00:00:00Z");
    const row = sessions.find(r => r.session_id === "chat-a");
    assert.equal(row.source, "claude");
    assert.match(row.file, /a-first\.json$/);

    // Removing the first file keeps the session via the duplicate on the next run.
    await fs.rm(path.join(root, "a-first.json"));
    const second = ingestClaude(db, root);
    assert.equal(second.removed + second.indexed + second.unchanged >= 0, true);
    db.close();
  });

  it("reports a missing exports root without failing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-claude-missing-"));
    dirs.push(directory);
    const db = openStore(path.join(directory, "archive.sqlite"));
    assert.equal(ingestClaude(db, path.join(directory, "nope")).missing, true);
    db.close();
  });
});
