import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import registerMemory from "../extensions/memory.ts";
import { createMemoryHubServer } from "../src/memory/hub.ts";
import { openStore, replaceSession } from "../src/memory/store.ts";

const directories: string[] = [];
const servers: any[] = [];
const envKeys = ["PI_CODING_AGENT_DIR", "PI_MEMORY_INDEX"] as const;
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tools() {
  const registered = new Map<string, any>();
  registerMemory({ registerTool: (tool: any) => registered.set(tool.name, tool), on: () => () => {} } as any);
  return registered;
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-remote-"));
  directories.push(directory);
  const hubDirectory = path.join(directory, "hub");
  const spokeDirectory = path.join(directory, "spoke");
  await fs.mkdir(hubDirectory);
  await fs.mkdir(path.join(spokeDirectory, "memory"), { recursive: true });
  const index = path.join(hubDirectory, "archive.sqlite");
  const db = openStore(index);
  replaceSession(db, "pi", "hub-session", "/remote/project", [
    { entry_id: "hub-entry", parent_id: null, role: "user", kind: "message", timestamp: "2026-04-02T12:00:00Z", text: "remote fixture search phrase and expansion text", indexable: true },
  ], { origin: "hub-origin" });
  replaceSession(db, "pi", "current-session", "/remote/project", [
    { entry_id: "current-entry", parent_id: null, role: "user", kind: "message", timestamp: "2026-04-02T12:01:00Z", text: "remote fixture from current session must be excluded", indexable: true },
  ]);
  db.close();
  const tokenFile = path.join(hubDirectory, "hub-tokens.json");
  await fs.writeFile(tokenFile, JSON.stringify({ "spoke-token": { spoke: "remote-spoke", created: "2026-04-02T12:00:00.000Z" } }), { mode: 0o600 });
  const { server } = createMemoryHubServer({ index, tokenFile });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PI_CODING_AGENT_DIR = spokeDirectory;
  process.env.PI_MEMORY_INDEX = path.join(directory, "must-not-open.sqlite");
  await fs.writeFile(path.join(spokeDirectory, "memory", "hub.json"), JSON.stringify({ hub, token: "spoke-token" }), { mode: 0o600 });
  return { directory, hub, spokeDirectory, index };
}

async function callSearch(registered: Map<string, any>, context = { cwd: "/remote/project", sessionManager: { getSessionId: () => "current-session" } }) {
  return registered.get("memory_search").execute("search-call", { query: "remote fixture", mode: "lexical" }, new AbortController().signal, undefined, context);
}

describe("memory extension remote mode", () => {
  it("searches and expands the real hub archive without opening a local archive", async () => {
    const { directory } = await fixture();
    const registered = tools();
    assert.deepEqual([...registered.keys()], ["memory_search", "memory_expand"]);

    const found = await callSearch(registered);
    assert.equal(found.isError, undefined);
    assert.equal(found.details.results.length, 1);
    assert.equal(found.details.results[0].origin, "hub-origin");
    assert.match(found.content[0].text, /remote fixture search phrase/);
    assert.match(found.content[0].text, /hub archive latest: 2026-04-02T12:00:00Z/);
    assert.equal(found.details.archive.latest, "2026-04-02T12:00:00Z");
    const expanded = await registered.get("memory_expand").execute("expand-call", { id: found.details.results[0].id }, new AbortController().signal, undefined, {
      cwd: "/remote/project", sessionManager: { getSessionId: () => "current-session" },
    });
    assert.match(expanded.content[0].text, /remote fixture search phrase and expansion text/);
    assert.equal(expanded.details.provenance.origin, "hub-origin");
    await assert.rejects(fs.stat(path.join(directory, "must-not-open.sqlite")), { code: "ENOENT" });
  });

  it("surfaces the hub's 403 response as a tool error instead of falling back", async () => {
    const { hub, spokeDirectory } = await fixture();
    await fs.writeFile(path.join(spokeDirectory, "memory", "hub.json"), JSON.stringify({ hub, token: "revoked-token" }), { mode: 0o600 });
    const result = await callSearch(tools());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(hub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.content[0].text, /403.*Invalid bearer token/);
  });

  it("surfaces an HTTP 401 response with its hub address", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-remote-401-"));
    directories.push(directory);
    await fs.mkdir(path.join(directory, "memory"));
    const server = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Bearer token required" })); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PI_CODING_AGENT_DIR = directory;
    await fs.writeFile(path.join(directory, "memory", "hub.json"), JSON.stringify({ hub, token: "token" }), { mode: 0o600 });

    const result = await callSearch(tools());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /401.*Bearer token required/);
    assert.match(result.content[0].text, /127\.0\.0\.1/);
  });

  it("names the hub on a network failure and does not use the local archive", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-remote-down-"));
    directories.push(directory);
    await fs.mkdir(path.join(directory, "memory"));
    const hub = "http://127.0.0.1:1";
    process.env.PI_CODING_AGENT_DIR = directory;
    process.env.PI_MEMORY_INDEX = path.join(directory, "must-not-open.sqlite");
    await fs.writeFile(path.join(directory, "memory", "hub.json"), JSON.stringify({ hub, token: "token" }), { mode: 0o600 });

    const result = await callSearch(tools());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /http:\/\/127\.0\.0\.1:1/);
    assert.match(result.content[0].text, /failed|refused|connect/i);
    await assert.rejects(fs.stat(path.join(directory, "must-not-open.sqlite")), { code: "ENOENT" });
  });

  it("rejects a hub.json that is not private instead of using local memory", async () => {
    const { spokeDirectory } = await fixture();
    await fs.chmod(path.join(spokeDirectory, "memory", "hub.json"), 0o644);
    const result = await callSearch(tools());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /hub\.json.*private.*0600/i);
    await assert.rejects(fs.stat(path.join(spokeDirectory, "must-not-open.sqlite")), { code: "ENOENT" });
  });

  it("uses the local archive unchanged when hub.json is absent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-remote-local-"));
    directories.push(directory);
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    replaceSession(db, "pi", "local-session", "/local/project", [
      { entry_id: "local-entry", parent_id: null, role: "user", kind: "message", timestamp: "2026-04-02T12:00:00Z", text: "local fallback fixture", indexable: true },
    ]);
    db.close();
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
    process.env.PI_MEMORY_INDEX = index;
    const result = await callSearch(tools(), { cwd: "/local/project", sessionManager: { getSessionId: () => "current-session" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /local fallback fixture/);
    assert.doesNotMatch(result.content[0].text, /hub archive latest/);
  });
});
