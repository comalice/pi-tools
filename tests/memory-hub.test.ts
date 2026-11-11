import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createMemoryHubServer } from "../src/memory/hub.ts";
import { makeHubBundle, registerHubToken } from "../src/memory/hub-tokens.ts";
import { parseHubBundle } from "../src/memory/join.ts";
import { initializeHubGit } from "../src/memory/git-http.ts";
import { openStore, replaceSession } from "../src/memory/store.ts";

const dirs: string[] = [];
const servers: any[] = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const execFileAsync = promisify(execFile);
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
  const gitRoot = path.join(directory, "wiki-git");
  const { server } = createMemoryHubServer({ index, tokenFile, gitRoot });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown, token = "secret-token") => fetch(`${base}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { directory, index, gitRoot, base, post };
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
    const added = run("hub-token", "add", "laptop", "--advertise", "http://192.0.2.12:6342");
    assert.equal(added.ok, true);
    assert.equal(added.spoke, "laptop");
    assert.equal(added.token.length, 43);
    assert.deepEqual(parseHubBundle(added.bundle), { hub: "http://192.0.2.12:6342", token: added.token });
    assert.equal(parseHubBundle(makeHubBundle("http://hub.example:6342", added.token)).hub, "http://hub.example:6342");
    const tokenFile = path.join(directory, "memory", "hub-tokens.json");
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    const listed = run("hub-token", "list");
    assert.deepEqual(listed.tokens.map((token: any) => token.spoke), ["laptop"]);
    assert.equal(JSON.stringify(listed).includes(added.token), false);
    assert.equal(run("hub-token", "revoke", "laptop").revoked, true);
    assert.deepEqual(run("hub-token", "list").tokens, []);
  });

  it("rejects absent and unknown bearer credentials, including Git smart-HTTP", async () => {
    const { base, post } = await setup();
    const noAuth = await fetch(`${base}/status`);
    assert.equal(noAuth.status, 401);
    assert.deepEqual(await noAuth.json(), { ok: false, error: "Bearer token required" });
    const noGitAuth = await fetch(`${base}/git/wiki.git/info/refs?service=git-upload-pack`);
    assert.equal(noGitAuth.status, 401);
    const traversal = await fetch(`${base}/git/wiki.git/%2e%2e/private`, { headers: { authorization: "Bearer secret-token" } });
    assert.equal(traversal.status, 404);
    const wrong = await post("/search", { query: "fixture" }, "wrong-token");
    assert.equal(wrong.status, 403);
    assert.deepEqual(await wrong.json(), { ok: false, error: "Invalid bearer token" });
    const wrongGit = await fetch(`${base}/git/wiki.git/info/refs?service=git-upload-pack`, { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(wrongGit.status, 403);
  });

  it("serves a real token-authenticated Git clone and push through git http-backend", { skip: !gitAvailable && "git is not installed" }, async () => {
    const { base, gitRoot } = await setup();
    const clone = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "memory-git-clone-")), "wiki");
    dirs.push(path.dirname(clone));
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const runGit = async (args: string[]) => (await execFileAsync("git", args, { encoding: "utf8", env, maxBuffer: 10 * 1024 * 1024 })).stdout;
    await runGit(["-c", "http.extraHeader=Authorization: Bearer secret-token", "clone", `${base}/git/wiki.git`, clone]);
    assert.equal((await fs.stat(path.join(gitRoot, "wiki.git"))).isDirectory(), true);
    await fs.writeFile(path.join(clone, "round-trip.md"), "pushed through smart HTTP\n");
    await runGit(["-C", clone, "config", "user.name", "Test Spoke"]);
    await runGit(["-C", clone, "config", "user.email", "spoke@example.invalid"]);
    await runGit(["-C", clone, "add", "round-trip.md"]);
    await runGit(["-C", clone, "commit", "-m", "round trip"]);
    await runGit(["-C", clone, "-c", "http.extraHeader=Authorization: Bearer secret-token", "push", "origin", "HEAD:refs/heads/main"]);
    const refs = await runGit(["-c", "http.extraHeader=Authorization: Bearer secret-token", "ls-remote", `${base}/git/wiki.git`]);
    assert.match(refs, /\trefs\/heads\/main\n/);
  });

  it("initializes the bare wiki repository and repoints the hub working clone", { skip: !gitAvailable && "git is not installed" }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-git-init-"));
    dirs.push(directory);
    const wiki = path.join(directory, "wiki");
    await fs.mkdir(wiki);
    execFileSync("git", ["-C", wiki, "init"], { stdio: "ignore" });
    const initialized = initializeHubGit(path.join(directory, "wiki-git"), wiki);
    assert.equal(initialized.repo, path.join(directory, "wiki-git", "wiki.git"));
    assert.equal(execFileSync("git", ["-C", wiki, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(), initialized.repo);
    assert.equal(execFileSync("git", ["--git-dir", initialized.repo, "rev-parse", "--is-bare-repository"], { encoding: "utf8" }).trim(), "true");
  });

  it("validates registered spoke tokens and refuses replacement without revocation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-register-"));
    dirs.push(directory);
    const file = path.join(directory, "tokens.json");
    const secret = randomBytes(32).toString("base64url");
    assert.throws(() => registerHubToken("laptop", "short", file), /43 canonical base64url/);
    assert.throws(() => registerHubToken(" laptop", secret, file), /spoke must contain/);
    assert.deepEqual(registerHubToken("laptop", secret, file).spoke, "laptop");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.throws(() => registerHubToken("laptop", randomBytes(32).toString("base64url"), file), /revoke it before registering/);
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

  it("accepts multi-megabyte base64 push payloads without a stack overflow", async () => {
    const { index, post } = await setup();
    // Regression: hub.ts once validated content_base64 with a regex whose per-repetition
    // recursion overflowed V8's stack at ~5 MiB of base64 (field-found, 2026-11-10). This
    // session is ~9 MiB of JSONL across many small lines (each stays under the 4 MiB line cap).
    const chunk = "push payload filler ".repeat(50); // ~1 KiB of text per message
    const lines = [JSON.stringify({ type: "session", version: 3, id: "push-big", cwd: "/spoke/project" })];
    for (let i = 0; i < 9_000; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, message: { role: "user", timestamp: "2026-02-01T12:00:00Z", content: chunk } }));
    const big = `${lines.join("\n")}\n`;
    const response = await post("/ingest", { source: "pi", filename: "push-big.jsonl", content_base64: Buffer.from(big).toString("base64") });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as any).ok, true);
    const db = openStore(index);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) n FROM entries WHERE session_id='push-big'").get() as any).n, 9_000);
    } finally { db.close(); }
  });

  it("rejects non-canonical base64 push payloads", async () => {
    const { post } = await setup();
    const response = await post("/ingest", { source: "pi", filename: "bad.jsonl", content_base64: "not!base64!at!all" });
    assert.equal(response.status, 400);
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
