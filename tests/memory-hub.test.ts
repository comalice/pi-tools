import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createMemoryHubServer } from "../src/memory/hub.ts";
import { openStore, replaceSession } from "../src/memory/store.ts";

const dirs: string[] = [];
const servers: any[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-"));
  dirs.push(directory);
  const index = path.join(directory, "archive.sqlite");
  const db = openStore(index);
  replaceSession(db, "pi", "local-session", "/project", [
    { entry_id: "entry-local", parent_id: null, role: "user", kind: "message", timestamp: "2026-01-01T00:00:00Z", text: "hub fixture search phrase", indexable: true },
  ]);
  db.close();
  const tokenFile = path.join(directory, "hub-tokens.json");
  await fs.writeFile(tokenFile, JSON.stringify({ "secret-token": { spoke: "spoke.example", created: "2026-01-01T00:00:00.000Z" } }), { mode: 0o600 });
  const { server } = createMemoryHubServer({ index, tokenFile });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown, token = "secret-token") => fetch(`${base}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { directory, index, base, post };
}

function piSession(id: string, text: string) {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/spoke/project" }),
    JSON.stringify({ type: "message", id: `${id}-entry`, parentId: null, message: { role: "user", timestamp: "2026-02-01T12:00:00Z", content: text } }),
    "",
  ].join("\n");
}

describe("memory hub service", () => {
  it("manages one-time spoke tokens locally without listing their values", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-token-cli-"));
    dirs.push(directory);
    const cli = path.resolve("src/memory/cli.ts");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: directory },
    }));
    const added = run("hub-token", "add", "laptop");
    assert.equal(added.ok, true);
    assert.equal(added.spoke, "laptop");
    assert.equal(added.token.length, 43);
    const tokenFile = path.join(directory, "memory", "hub-tokens.json");
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    const listed = run("hub-token", "list");
    assert.deepEqual(listed.tokens.map((token: any) => token.spoke), ["laptop"]);
    assert.equal(JSON.stringify(listed).includes(added.token), false);
    assert.equal(run("hub-token", "revoke", "laptop").revoked, true);
    assert.deepEqual(run("hub-token", "list").tokens, []);
  });

  it("rejects absent and unknown bearer credentials", async () => {
    const { base, post } = await setup();
    const noAuth = await fetch(`${base}/status`);
    assert.equal(noAuth.status, 401);
    assert.deepEqual(await noAuth.json(), { ok: false, error: "Bearer token required" });
    const wrong = await post("/search", { query: "fixture" }, "wrong-token");
    assert.equal(wrong.status, 403);
    assert.deepEqual(await wrong.json(), { ok: false, error: "Invalid bearer token" });
  });

  it("reports hub and archive status with the authenticated spoke identity", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/status`, { headers: { authorization: "Bearer secret-token" } });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.ok, true);
    assert.equal(result.version, "1");
    assert.equal(result.schema, 3);
    assert.ok(result.uptime >= 0);
    assert.equal(result.spoke, "spoke.example");
    assert.deepEqual(result.sources, [{ source: "pi", sessions: 1 }]);
  });

  it("searches and expands the shared archive with extension-compatible results", async () => {
    const { post } = await setup();
    const response = await post("/search", { query: "hub fixture", mode: "lexical", scope: "all" });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.ok, true);
    assert.equal(result.results[0].session_id, "local-session");
    assert.equal(result.results[0].origin.length > 0, true);
    const expanded = await post("/expand", { id: result.results[0].result_id, scope: "all" });
    const expansion = await expanded.json() as any;
    assert.equal(expansion.ok, true);
    assert.match(expansion.result.text, /hub fixture search phrase/);
  });

  it("stores pushed Pi payloads under the authenticated spoke origin and serializes ingest", async () => {
    const { directory, index, post } = await setup();
    const priorOrigin = process.env.PI_MEMORY_ORIGIN;
    process.env.PI_MEMORY_ORIGIN = "must-not-win";
    try {
      const pushes = await Promise.all(["push-one", "push-two"].map(id => post("/ingest", {
        source: "pi", filename: `${id}.jsonl`, content_base64: Buffer.from(piSession(id, `distinct ${id} searchable marker`)).toString("base64"),
      })));
      for (const response of pushes) {
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json() as any).ok, true);
      }
    } finally {
      if (priorOrigin === undefined) delete process.env.PI_MEMORY_ORIGIN;
      else process.env.PI_MEMORY_ORIGIN = priorOrigin;
    }
    const db = openStore(index);
    try {
      const rows = db.prepare("SELECT session_id,origin FROM entries WHERE session_id IN ('push-one','push-two') ORDER BY session_id").all() as any[];
      assert.deepEqual(rows.map(row => ({ session_id: row.session_id, origin: row.origin })), [
        { session_id: "push-one", origin: "spoke.example" },
        { session_id: "push-two", origin: "spoke.example" },
      ]);
      const blobs = path.join(directory, "blobs", "pi", "spoke.example");
      const files = await fs.readdir(blobs);
      assert.equal(files.length, 2);
      assert.ok(files.every(file => /^[a-f0-9]{64}--.*\.jsonl$/.test(file)));
    } finally { db.close(); }
    const search = await post("/search", { query: "push-two searchable marker", mode: "lexical", scope: "all" });
    assert.equal((await search.json() as any).results[0].session_id, "push-two");
    const cli = path.resolve("src/memory/cli.ts");
    const reconciled = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", cli, "ingest"], {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_MEMORY_INDEX: index },
    }));
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.sources[0].unchanged, 2);
  });
});
