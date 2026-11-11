import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { ensureWikiClone, memoryJoin, memoryJoinStatus, updateSshConfig, writeHubConfig, type CommandRunner } from "../src/memory/join.ts";
import { createMemoryHubServer } from "../src/memory/hub.ts";

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

function runJoinStatus(agentDir: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("src/memory/cli.ts"), "join", "--status"], {
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

async function runJoinWithTokenStdin(agentDir: string, homeDir: string, binDir: string, host: string, port: number, token: string) {
  await fs.mkdir(binDir, { recursive: true });
  const fakeGit = path.join(binDir, "git");
  await fs.writeFile(fakeGit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types", path.resolve("src/memory/cli.ts"),
      "join", host, "--port", String(port), "--token-stdin", "--no-push",
    ], {
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: agentDir,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(token);
  });
}

describe("memory join setup helpers", () => {
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

  it("updates only the managed SSH block and preserves foreign content", async () => {
    const directory = await temporary();
    const config = path.join(directory, ".ssh", "config");
    await fs.mkdir(path.dirname(config), { mode: 0o700 });
    const unrelated = "Host other\n  HostName other.example\n  User somebody\n";
    await fs.writeFile(config, unrelated);
    updateSshConfig(config, "hub-one.example");
    const first = await fs.readFile(config, "utf8");
    assert.match(first, /HostName hub-one\.example/);
    assert.ok(first.endsWith(unrelated));
    updateSshConfig(config, "hub-two.example");
    const second = await fs.readFile(config, "utf8");
    assert.match(second, /HostName hub-two\.example/);
    assert.doesNotMatch(second, /hub-one\.example/);
    assert.equal(second.match(/Host memory-hub/g)?.length, 1);
    assert.ok(second.endsWith(unrelated));
    assert.throws(() => updateSshConfig(config, "bad\nhost"), /Invalid hub host/);
  });

  it("clones absent wiki, fast-forwards matching origin, and refuses a different origin", async () => {
    const directory = await temporary();
    const wiki = path.join(directory, "wiki");
    const calls: string[][] = [];
    const cloneRunner: CommandRunner = (_command, args) => { calls.push(args); return result(); };
    assert.deepEqual(ensureWikiClone(wiki, cloneRunner), { action: "cloned", directory: wiki });
    assert.deepEqual(calls[0], ["clone", "wikigit@memory-hub:wiki.git", wiki]);

    await fs.mkdir(wiki);
    const currentRunner: CommandRunner = (_command, args) => {
      calls.push(args);
      if (args[0] === "remote") return result(0, "wikigit@memory-hub:wiki.git\n");
      return result();
    };
    assert.deepEqual(ensureWikiClone(wiki, currentRunner), { action: "updated", directory: wiki });
    assert.deepEqual(calls.slice(-4).map(args => args.slice(0, 2)), [["rev-parse", "--is-inside-work-tree"], ["remote", "get-url"], ["fetch", "origin"], ["pull", "--ff-only"]]);

    const wrongRunner: CommandRunner = (_command, args) => args[0] === "remote" ? result(0, "git@old-hub:wiki.git\n") : result();
    assert.throws(() => ensureWikiClone(wiki, wrongRunner), /different origin.*hub migration/);
  });

  it("reports actionable HITL key enrollment on SSH authentication failure", async () => {
    const directory = await temporary();
    const wiki = path.join(directory, "wiki");
    const runner: CommandRunner = () => result(128, "", "git@memory-hub: Permission denied (publickey).");
    assert.throws(() => ensureWikiClone(wiki, runner, path.join(directory, ".ssh")), /ssh-keygen.*\/home\/wikigit\/\.ssh\/authorized_keys.*one line per spoke/s);
  });

  it("verifies and reports identity from a real hub status endpoint", async () => {
    const directory = await temporary();
    const index = path.join(directory, "archive.sqlite");
    const tokenFile = path.join(directory, "tokens.json");
    await fs.writeFile(tokenFile, JSON.stringify({ secret: { spoke: "laptop.example", created: "2026-01-01T00:00:00Z" } }), { mode: 0o600 });
    const { server } = createMemoryHubServer({ index, tokenFile });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const agentDir = path.join(directory, "agent");
    const sshHome = path.join(directory, "home");
    const runner: CommandRunner = (command, args) => {
      if (command === "git" && args[0] === "clone") return result(0);
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    };
    const joined = await memoryJoin({ host: "127.0.0.1", port, token: "secret", agentDir, homeDir: sshHome, noPush: true, runner });
    assert.equal(joined.spoke, "laptop.example");
    assert.equal(joined.pushTimer.status, "skipped (--no-push)");
    assert.equal(JSON.parse(await fs.readFile(path.join(agentDir, "memory", "hub.json"), "utf8")).hub, `http://127.0.0.1:${port}`);

    const status = await memoryJoinStatus(path.join(agentDir, "memory", "hub.json"));
    assert.equal(status.reachable, true);
    assert.equal(status.spoke, "laptop.example");
    const cliStatus = await runJoinStatus(agentDir);
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.equal(JSON.parse(cliStatus.stdout).spoke, "laptop.example");

    const stdinAgent = path.join(directory, "stdin-agent");
    const stdinHome = path.join(directory, "stdin-home");
    const fakeBin = path.join(directory, "fake-bin");
    const stdinJoin = await runJoinWithTokenStdin(stdinAgent, stdinHome, fakeBin, "127.0.0.1", port, "secret");
    assert.equal(stdinJoin.status, 0, stdinJoin.stderr);
    assert.doesNotMatch(stdinJoin.stdout + stdinJoin.stderr, /secret/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stdinAgent, "memory", "hub.json"), "utf8")), {
      hub: `http://127.0.0.1:${port}`,
      token: "secret",
    });
    assert.equal((await fs.stat(path.join(stdinAgent, "memory", "hub.json"))).mode & 0o777, 0o600);
    const invalidStdin = await runJoinWithTokenStdin(path.join(directory, "invalid-agent"), path.join(directory, "invalid-home"), fakeBin, "127.0.0.1", port, "bad token");
    assert.notEqual(invalidStdin.status, 0);
    assert.match(invalidStdin.stdout, /must be non-empty and contain no whitespace/);

    await fs.writeFile(path.join(agentDir, "memory", "hub.json"), JSON.stringify({ hub: `http://127.0.0.1:${port}`, token: "rejected" }), { mode: 0o600 });
    const rejected = await memoryJoinStatus(path.join(agentDir, "memory", "hub.json"));
    assert.equal(rejected.reachable, false);
    assert.match(rejected.error!, /403.*Invalid bearer token/);
  });
});
