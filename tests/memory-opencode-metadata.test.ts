import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { ingestOpenCode } from "../src/memory/ingest.ts";
import { openStore, search } from "../src/memory/store.ts";

it("imports OpenCode user summary metadata while excluding generated assistant summaries", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-user-summary-"));
  const sourcePath = path.join(directory, "source.sqlite");
  const source = new DatabaseSync(sourcePath);
  const archive = openStore(path.join(directory, "archive.sqlite"));
  try {
    source.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, revert TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
      INSERT INTO session VALUES ('s', 'project', NULL, '/project', NULL);
    `);
    const insertMessage = source.prepare("INSERT INTO message VALUES (?, 's', ?, ?)");
    const insertPart = source.prepare("INSERT INTO part VALUES (?, ?, 's', ?)");
    insertMessage.run("user", JSON.stringify({ role: "user", summary: { title: "Session title", body: "Summary metadata", diffs: [] } }), 1);
    insertPart.run("p1", "user", JSON.stringify({ type: "text", text: "original user question about maelstrom" }));
    insertMessage.run("assistant", JSON.stringify({ role: "assistant", summary: true }), 2);
    insertPart.run("p2", "assistant", JSON.stringify({ type: "text", text: "generated compaction synthesis" }));
    ingestOpenCode(archive, sourcePath);
    const users = search(archive, { query: "maelstrom", project: "/project" });
    assert.equal(users.length, 1);
    assert.equal(users[0].role, "user");
    assert.equal(search(archive, { query: "compaction", project: "/project" }).length, 0);
    assert.equal(ingestOpenCode(archive, sourcePath).unchanged, 1);
  } finally {
    source.close();
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
