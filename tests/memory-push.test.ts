import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createMemoryHubServer } from "../src/memory/hub.ts";

const dirs: string[] = [];
const servers: any[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function runCli(agentDir: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("src/memory/cli.ts"), "push"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

function piSession(id: string, text: string) {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/spoke/project" }),
    JSON.stringify({ type: "message", id: `${id}-entry`, parentId: null, message: { role: "user", timestamp: "2026-02-01T12:00:00Z", content: text } }),
    "",
  ].join("\n");
}

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-push-"));
  dirs.push(directory);
  const agentDir = path.join(directory, "agent");
  const sessionsDir = path.join(agentDir, "sessions");
  await fs.mkdir(path.join(agentDir, "memory"), { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  return { directory, agentDir, sessionsDir };
}

describe("memory push", () => {
  it("requires memory join configuration with an actionable diagnostic", async () => {
    const { directory } = await setup();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", path.resolve("src/memory/cli.ts"), "push"], {
      encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "agent") },
    });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /run memory join first/i);
  });

  it("pushes recursively to a real hub, stores the spoke identity, and is incremental/idempotent", async () => {
    const { directory, agentDir, sessionsDir } = await setup();
    const nested = path.join(sessionsDir, "2026", "02");
    await fs.mkdir(nested, { recursive: true });
    const source = path.join(nested, "session.jsonl");
    const otherNested = path.join(sessionsDir, "2026", "03");
    await fs.mkdir(otherNested, { recursive: true });
    await fs.writeFile(source, piSession("pushed-session", "first pushed marker"));
    await fs.writeFile(path.join(otherNested, "session.jsonl"), piSession("other-session", "separate basename marker"));

    const index = path.join(directory, "hub.sqlite");
    const tokenFile = path.join(directory, "tokens.json");
    await fs.writeFile(tokenFile, JSON.stringify({ token: { spoke: "spoke.test", created: "2026-01-01T00:00:00.000Z" } }), { mode: 0o600 });
    const { server } = createMemoryHubServer({ index, tokenFile });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fs.writeFile(path.join(agentDir, "memory", "hub.json"), JSON.stringify({ hub, token: "token" }), { mode: 0o600 });

    const firstRun = await runCli(agentDir);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const first = JSON.parse(firstRun.stdout);
    assert.equal(first.ok, true);
    assert.equal(first.push.sent, 2);
    assert.equal((await fs.stat(path.join(agentDir, "memory", "push-state.json"))).mode & 0o777, 0o600);

    const secondRun = await runCli(agentDir);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const second = JSON.parse(secondRun.stdout);
    assert.equal(second.push.sent, 0);
    assert.equal(second.push.unchanged, 2);

    const priorTimes = await fs.stat(source);
    await fs.writeFile(source, piSession("pushed-session", "other pushed marker"));
    await fs.utimes(source, priorTimes.atime, priorTimes.mtime);
    const thirdRun = await runCli(agentDir);
    assert.equal(thirdRun.status, 0, thirdRun.stderr);
    const third = JSON.parse(thirdRun.stdout);
    assert.equal(third.push.sent, 1);
    assert.equal(third.push.unchanged, 1);

    const blobs = path.join(directory, "blobs", "pi", "spoke.test");
    assert.equal((await fs.readdir(blobs)).length, 2);
    const search = await fetch(`${hub}/search`, {
      method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ query: "other pushed marker", mode: "lexical", scope: "all" }),
    });
    assert.equal((await search.json() as any).results[0].session_id, "pushed-session");
  });

  it("does not advance failed file fingerprints, but continues and records successful files", async () => {
    const { agentDir, sessionsDir } = await setup();
    const good = path.join(sessionsDir, "good.jsonl");
    const bad = path.join(sessionsDir, "bad.jsonl");
    await fs.writeFile(good, piSession("good", "good marker"));
    await fs.writeFile(bad, piSession("bad", "bad marker"));
    await fs.writeFile(path.join(agentDir, "memory", "hub.json"), JSON.stringify({ hub: "http://127.0.0.1:1", token: "token" }));
    const server = await import("node:http").then(({ createServer }) => createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain request */ }
      serverRequests++;
      res.writeHead(serverRequests === 1 ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(serverRequests === 1 ? { ok: false, error: "injected failure" } : { ok: true }));
    }));
    let serverRequests = 0;
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    await fs.writeFile(path.join(agentDir, "memory", "hub.json"), JSON.stringify({ hub: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "token" }));

    const run = await runCli(agentDir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /bad.jsonl: Hub returned HTTP 500/);
    const result = JSON.parse(run.stdout);
    assert.equal(result.push.sent, 1);
    assert.equal(result.push.failed, 1);
    const state = JSON.parse(await fs.readFile(path.join(agentDir, "memory", "push-state.json"), "utf8"));
    assert.equal(Object.hasOwn(state.files, "good.jsonl"), true);
    assert.equal(Object.hasOwn(state.files, "bad.jsonl"), false);
    assert.equal(state.lastRun, null);
  });
});
