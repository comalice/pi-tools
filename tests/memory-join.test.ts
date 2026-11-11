import assert from "node:assert/strict";
import { existsSync, promises as fs, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { ensureWikiClone, memoryEnroll, memoryJoinStatus, parseHubBundle, writeHubConfig, type CommandRunner } from "../src/memory/join.ts";
import { makeHubBundle } from "../src/memory/hub-tokens.ts";

const dirs: string[] = [];
const servers: any[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-join-"));
  dirs.push(directory);
  return directory;
}

function result(status = 0, stdout = "", stderr = "") { return { status, stdout, stderr }; }

function fakeGitRunner(): CommandRunner {
  return (command, args) => {
    if (command !== "git") throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    if (args.includes("clone")) {
      const wiki = args.at(-1)!;
      mkdirSync(path.join(wiki, ".git"), { recursive: true });
      writeFileSync(path.join(wiki, ".git", "config"), "[core]\n");
    }
    return result();
  };
}

function startStubHub(token: string, spoke: string) {
  let accepted = false;
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== `Bearer ${token}` || !accepted) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not registered" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, spoke, version: "1", schema: 3, sources: [], uptime: 0 }));
  });
  servers.push(server);
  return new Promise<{ hub: string; accept: () => void; requests: () => number }>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ hub: `http://127.0.0.1:${port}`, accept: () => { accepted = true; }, requests: () => requests });
    });
  });
}

async function runJoinCli(agentDir: string, homeDir: string, binDir: string, joinArgs: string[], tokenStdin?: string) {
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "git"), "#!/bin/sh\nfor last do :; done\ncase \"$*\" in *clone*) mkdir -p \"$last/.git\"; printf '[core]\\n' > \"$last/.git/config\";; esac\nexit 0\n", { mode: 0o755 });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("src/memory/cli.ts"), "join", ...joinArgs], {
      env: { ...process.env, HOME: homeDir, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: agentDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(tokenStdin);
  });
}

describe("memory join setup", () => {
  it("writes a private hub config, refuses overwrite, and force backs up the prior config", async () => {
    const directory = await temporary();
    const filename = path.join(directory, "agent", "memory", "hub.json");
    const first = writeHubConfig({ hub: "http://hub-one:6342", token: "one" }, filename);
    assert.equal(first.backup, undefined);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
    assert.throws(() => writeHubConfig({ hub: "http://hub-two:6342", token: "two" }, filename), /already exists.*--force/);
    const updated = writeHubConfig({ hub: "http://hub-two:6342", token: "two" }, filename, true);
    assert.ok(updated.backup);
    assert.deepEqual(JSON.parse(await fs.readFile(updated.backup!, "utf8")), { hub: "http://hub-one:6342", token: "one" });
    assert.equal((await fs.stat(updated.backup!)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { hub: "http://hub-two:6342", token: "two" });
  });

  it("clones over HTTP with a persisted bearer header and updates only a matching origin", async () => {
    const directory = await temporary();
    const wiki = path.join(directory, "wiki");
    const calls: { args: string[]; cwd?: string }[] = [];
    const runner: CommandRunner = (command, args, cwd) => {
      calls.push({ args, cwd });
      if (args.includes("clone")) {
        mkdirSync(path.join(wiki, ".git"), { recursive: true });
        writeFileSync(path.join(wiki, ".git", "config"), "[core]\n");
      }
      if (args[0] === "remote") return result(0, "http://hub.example:6342/git/wiki.git\n");
      return result();
    };
    const cloned = ensureWikiClone(wiki, "http://hub.example:6342", "secret-token", runner);
    assert.equal(cloned.action, "cloned");
    assert.deepEqual(calls[0].args, ["-c", "http.extraHeader=Authorization: Bearer secret-token", "clone", "http://hub.example:6342/git/wiki.git", wiki]);
    assert.ok(calls.some(call => call.args[0] === "config" && call.args[1] === "http.extraHeader"));
    assert.equal((await fs.stat(path.join(wiki, ".git", "config"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(wiki)).mode & 0o777, 0o700);

    calls.length = 0;
    const existingRunner: CommandRunner = (_command, args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "remote") return result(0, "http://hub.example:6342/git/wiki.git\n");
      return result();
    };
    assert.equal(ensureWikiClone(wiki, "http://hub.example:6342", "secret-token", existingRunner).action, "updated");
    assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [
      ["rev-parse", "--is-inside-work-tree"], ["remote", "get-url"], ["config", "http.extraHeader"], ["fetch", "origin"], ["pull", "--ff-only"],
    ]);
    assert.throws(() => ensureWikiClone(wiki, "http://another-hub:6342", "secret-token", existingRunner), /different origin.*hub migration/);
  });

  it("enrolls only after the hub registers the generated secret", async () => {
    const directory = await temporary();
    const token = randomBytes(32).toString("base64url");
    const stub = await startStubHub(token, "laptop.example");
    let commandCount = 0;
    const setup = memoryEnroll({
      hub: stub.hub,
      spoke: "laptop.example",
      secret: token,
      pollIntervalMs: 5,
      timeoutMs: 1500,
      agentDir: path.join(directory, "agent"),
      noPush: true,
      runner: fakeGitRunner(),
      onRegisterCommand: command => {
        commandCount++;
        assert.equal(command, `pi-memory hub-token register laptop.example '${token}'`);
        assert.equal(existsSync(path.join(directory, "agent", "memory", "hub.json")), false);
        setTimeout(stub.accept, 30);
      },
    });
    const joined = await setup;
    assert.equal(commandCount, 1);
    assert.ok(stub.requests() >= 2);
    assert.equal(joined.spoke, "laptop.example");
    const filename = path.join(directory, "agent", "memory", "hub.json");
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { hub: stub.hub, token });
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal(joined.pushTimer.status, "skipped (--no-push)");
  });

  it("times out without writing pending hub configuration", async () => {
    const directory = await temporary();
    const token = randomBytes(32).toString("base64url");
    const stub = await startStubHub(token, "pending-spoke");
    await assert.rejects(memoryEnroll({
      hub: stub.hub,
      spoke: "pending-spoke",
      secret: token,
      pollIntervalMs: 5,
      timeoutMs: 20,
      agentDir: path.join(directory, "agent"),
      onRegisterCommand: () => undefined,
    }), /timed out.*No hub\.json was written/);
    assert.equal(existsSync(path.join(directory, "agent", "memory", "hub.json")), false);
  });

  it("parses and uses a pih1 bundle via the join CLI without exposing its token", async () => {
    const directory = await temporary();
    const token = randomBytes(32).toString("base64url");
    const stub = await startStubHub(token, "bundle-spoke");
    stub.accept();
    const bundle = makeHubBundle(stub.hub, token);
    assert.deepEqual(parseHubBundle(bundle), { hub: stub.hub, token });
    assert.throws(() => parseHubBundle("pih1.not-base64.token"), /Invalid pih1/);
    const result = await runJoinCli(path.join(directory, "agent"), path.join(directory, "home"), path.join(directory, "bin"), [bundle, "--no-push"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "agent", "memory", "hub.json"), "utf8")).token, token);

    const stdinToken = randomBytes(32).toString("base64url");
    const stdinStub = await startStubHub(stdinToken, "stdin-spoke");
    stdinStub.accept();
    const stdinAgent = path.join(directory, "stdin-agent");
    const stdinJoin = await runJoinCli(stdinAgent, path.join(directory, "home"), path.join(directory, "bin-stdin"), [new URL(stdinStub.hub).hostname, "--port", new URL(stdinStub.hub).port, "--token-stdin", "--no-push"], stdinToken);
    assert.equal(stdinJoin.status, 0, stdinJoin.stdout + stdinJoin.stderr);
    assert.doesNotMatch(stdinJoin.stdout + stdinJoin.stderr, new RegExp(stdinToken));
    assert.equal(JSON.parse(await fs.readFile(path.join(stdinAgent, "memory", "hub.json"), "utf8")).token, stdinToken);
  });

  it("reports authenticated status from a configured hub", async () => {
    const directory = await temporary();
    const stub = await startStubHub("status-token", "status-spoke");
    stub.accept();
    const filename = path.join(directory, "agent", "memory", "hub.json");
    writeHubConfig({ hub: stub.hub, token: "status-token" }, filename);
    const status = await memoryJoinStatus(filename);
    assert.equal(status.reachable, true);
    assert.equal(status.spoke, "status-spoke");
  });
});
