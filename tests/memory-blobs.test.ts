import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { ingestClaude, ingestGrok, ingestPi } from "../src/memory/ingest.ts";
import { backfillImports, forgetImport, importFiles } from "../src/memory/blobs.ts";
import { openStore, search } from "../src/memory/store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function piSession(root: string, projectDir: string, id: string, text: string) {
  const directory = path.join(root, projectDir);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  return fs.mkdir(directory, { recursive: true }).then(() => fs.writeFile(
    path.join(directory, `${id}.jsonl`),
    line({ type: "session", version: 3, id, cwd: "/work/project" }) +
    line({ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text }] } }),
  ));
}

function claudeExport(id: string, text: string) {
  return JSON.stringify({ uuid: id, chat_messages: [{ uuid: `${id}-message`, parent_message_uuid: null, sender: "human", content: [{ type: "text", text }] }] });
}

describe("memory export blobs", () => {
  it("imports idempotently and ingests from the registered blob root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-import-"));
    dirs.push(directory);
    const input = path.join(directory, "my conversation.json");
    await fs.writeFile(input, claudeExport("chat-1", "blob import keeps this conversation"));
    const db = openStore(path.join(directory, "archive.sqlite"));
    try {
      const blobRoot = path.join(directory, "blobs");
      const first = importFiles(db, "claude", [input], blobRoot);
      assert.equal(first.copied, 1);
      assert.equal(first.ingest.indexed, 1);
      assert.match(first.files[0], /[a-f0-9]{64}--my_conversation\.json$/);
      const second = importFiles(db, "claude", [input], blobRoot);
      assert.equal(second.copied, 0);
      assert.equal(second.ingest.unchanged, 1);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM source_files WHERE source='claude'").get() as any).n, 1);
      const alias = path.join(directory, "different-name.json");
      await fs.writeFile(alias, await fs.readFile(input));
      const sameContent = importFiles(db, "claude", [alias], blobRoot);
      assert.equal(sameContent.copied, 0);
      assert.equal(sameContent.files[0], first.files[0]);
      assert.equal(search(db, { query: "blob import conversation", scope: "all" }).length, 1);
      await fs.rm(first.files[0]);
      assert.equal(ingestClaude(db, path.join(blobRoot, "claude")).removed, 0);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM sessions WHERE source='claude'").get() as any).n, 1);
    } finally { db.close(); }
  });

  it("exposes import and forget through the CLI", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-cli-"));
    dirs.push(directory);
    const input = path.join(directory, "cli.json");
    await fs.writeFile(input, claudeExport("cli-chat", "CLI import and forget test"));
    const cli = path.resolve("src/memory/cli.ts");
    const index = path.join(directory, "archive.sqlite");
    const imported = spawnSync(process.execPath, ["--experimental-strip-types", cli, "import", "--source", "claude", input, "--index", index], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    assert.equal(JSON.parse(imported.stdout).ingest.indexed, 1);
    const forgotten = spawnSync(process.execPath, ["--experimental-strip-types", cli, "forget", "--source", "claude", "--session", "cli-chat", "--index", index], { encoding: "utf8" });
    assert.equal(forgotten.status, 0, forgotten.stdout + forgotten.stderr);
    assert.equal(JSON.parse(forgotten.stdout).removed, 1);
  });

  it("backfills a legacy source root and the next ingest is a perfect no-op", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-backfill-"));
    dirs.push(directory);
    const sourceRoot = path.join(directory, "legacy-claude");
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, "legacy.json"), claudeExport("legacy-chat", "backfill preserves archive rows"));
    const db = openStore(path.join(directory, "archive.sqlite"));
    try {
      assert.equal(ingestClaude(db, sourceRoot).indexed, 1);
      const blobRoot = path.join(directory, "blobs");
      const result = backfillImports(db, blobRoot);
      assert.equal(result.sources.claude.copied, 1);
      assert.equal((db.prepare("SELECT root FROM source_config WHERE source='claude'").get() as any).root, path.join(blobRoot, "claude"));
      const stored = db.prepare("SELECT file FROM source_files WHERE source='claude'").get() as any;
      assert.ok(stored.file.startsWith(path.join(blobRoot, "claude") + path.sep));
      const next = ingestClaude(db, path.join(blobRoot, "claude"));
      assert.equal(next.indexed, 0);
      assert.equal(next.unchanged, 1);
      assert.equal(next.removed, 0);
    } finally { db.close(); }
  });

  it("backfills a legacy Pi watch root so hub pushes can import through blobs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-pi-"));
    dirs.push(directory);
    const sourceRoot = path.join(directory, "sessions");
    await piSession(sourceRoot, "--home-spoke--", "pi-backfill-chat", "pi backfill durable phrase");
    const db = openStore(path.join(directory, "archive.sqlite"));
    try {
      assert.equal(ingestPi(db, sourceRoot).indexed, 1);
      const blobRoot = path.join(directory, "blobs");
      const result = backfillImports(db, blobRoot);
      assert.equal(result.sources.pi.copied, 1);
      assert.equal((db.prepare("SELECT root FROM source_config WHERE source='pi'").get() as any).root, path.join(blobRoot, "pi"));
      const stored = db.prepare("SELECT file FROM source_files WHERE source='pi'").get() as any;
      assert.ok(stored.file.startsWith(path.join(blobRoot, "pi") + path.sep));
      const next = ingestPi(db, path.join(blobRoot, "pi"));
      assert.equal(next.indexed, 0);
      assert.equal(next.unchanged, 1);
      assert.equal(next.removed, 0);
      assert.equal(search(db, { query: "pi backfill durable", scope: "all" }).length, 1);
    } finally { db.close(); }
  });

  it("backfills Grok manifest keys to content-addressed blobs without pruning", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-grok-"));
    dirs.push(directory);
    const sourceRoot = path.join(directory, "legacy-grok");
    await fs.mkdir(sourceRoot);
    const legacyFile = path.join(sourceRoot, "prod-grok-backend.json");
    await fs.writeFile(legacyFile, JSON.stringify({ conversations: [{ conversation: { id: "grok-chat", title: "Grok", modify_time: "2026-01-01T00:00:00Z" }, responses: [{ response: { _id: "response-1", message: "grok backfill durable phrase", sender: "human", parent_response_id: null } }] }] }));
    const db = openStore(path.join(directory, "archive.sqlite"));
    try {
      assert.equal(ingestGrok(db, sourceRoot).indexed, 1);
      const blobRoot = path.join(directory, "blobs");
      backfillImports(db, blobRoot);
      const mapped = db.prepare("SELECT file FROM source_files WHERE source='grok'").get() as any;
      assert.match(mapped.file, /[a-f0-9]{64}--prod-grok-backend\.json#grok-chat$/);
      const next = ingestGrok(db, path.join(blobRoot, "grok"));
      assert.equal(next.indexed, 0);
      assert.equal(next.unchanged, 1);
      assert.equal(next.removed, 0);
    } finally { db.close(); }
  });

  it("forgets an imported session and cascades its archive rows and unreferenced blob", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-blobs-forget-"));
    dirs.push(directory);
    const input = path.join(directory, "forget-me.json");
    await fs.writeFile(input, claudeExport("forget-chat", "forget this imported conversation"));
    const db = openStore(path.join(directory, "archive.sqlite"));
    try {
      const imported = importFiles(db, "claude", [input], path.join(directory, "blobs"));
      const blob = imported.files[0];
      assert.equal(forgetImport(db, { source: "claude", session: "forget-chat" }, path.join(directory, "blobs")).removed, 1);
      assert.equal(await fs.stat(blob).then(() => true, () => false), false);
      for (const table of ["source_files", "documents", "entries", "sessions"]) {
        assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE source='claude'`).get() as any).n, 0, table);
      }
      assert.equal(search(db, { query: "forget imported conversation", scope: "all" }).length, 0);
    } finally { db.close(); }
  });
});
