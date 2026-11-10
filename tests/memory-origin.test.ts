import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expand, openStore, search, SCHEMA_VERSION } from "../src/memory/store.ts";
import { ingestPi } from "../src/memory/ingest.ts";

let directory: string;
let database: DatabaseSync;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-origin-"));
  database = openStore(path.join(directory, "archive.sqlite"));
});

afterEach(async () => {
  database.close();
  await fs.rm(directory, { recursive: true, force: true });
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("memory entry origin", () => {
  it("migrates a v2 archive in place and defaults existing entries to this host", async () => {
    const filename = path.join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE entries(source TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, role TEXT, kind TEXT NOT NULL, timestamp TEXT, text TEXT NOT NULL DEFAULT '', indexable INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(source,session_id,entry_id)); INSERT INTO entries(source,session_id,entry_id,kind,indexable) VALUES('pi','old-session','old-entry','message',1); PRAGMA user_version=2;`);
    legacy.close();

    const migrated = openStore(filename);
    try {
      assert.equal(SCHEMA_VERSION, 3);
      assert.equal((migrated.prepare("PRAGMA user_version").get() as any).user_version, 3);
      assert.equal((migrated.prepare("SELECT origin FROM entries WHERE entry_id='old-entry'").get() as any).origin, os.hostname());
    } finally {
      migrated.close();
    }
  });

  it("captures an ingest origin and returns it through search and expansion", async () => {
    const root = path.join(directory, "sessions");
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "session.jsonl"), [
      line({ type: "session", version: 3, id: "session", cwd: "/work/project" }),
      line({ type: "message", id: "entry", parentId: null, message: { role: "user", content: "origin evidence phrase" } }),
    ].join(""));

    ingestPi(database, root, { origin: "spoke.example" });
    assert.equal((database.prepare("SELECT origin FROM entries WHERE entry_id='entry'").get() as any).origin, "spoke.example");
    const result = search(database, { query: "origin evidence", project: "/work/project" })[0];
    assert.equal(result.origin, "spoke.example");
    assert.equal(result.provenance.origin, "spoke.example");
    const expanded = expand(database, result.result_id, { project: "/work/project" })!;
    assert.equal(expanded.origin, "spoke.example");
    assert.equal(expanded.provenance.origin, "spoke.example");
  });

  it("uses PI_MEMORY_ORIGIN when no explicit ingest origin is supplied", async () => {
    const root = path.join(directory, "sessions");
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "session.jsonl"), [
      line({ type: "session", version: 3, id: "env-session", cwd: "/work/project" }),
      line({ type: "message", id: "env-entry", parentId: null, message: { role: "user", content: "environment origin phrase" } }),
    ].join(""));
    const previous = process.env.PI_MEMORY_ORIGIN;
    process.env.PI_MEMORY_ORIGIN = "hub.example";
    try {
      ingestPi(database, root);
    } finally {
      if (previous === undefined) delete process.env.PI_MEMORY_ORIGIN;
      else process.env.PI_MEMORY_ORIGIN = previous;
    }
    assert.equal((database.prepare("SELECT origin FROM entries WHERE entry_id='env-entry'").get() as any).origin, "hub.example");
  });
});
