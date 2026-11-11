import { copyFileSync, existsSync, lstatSync, mkdirSync, chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync, linkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { getMemoryHubStatus, loadMemoryHubConfig, type MemoryHubConfig } from "./remote.ts";

const SSH_BEGIN = "# BEGIN pi-memory managed memory-hub";
const SSH_END = "# END pi-memory managed memory-hub";

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], cwd?: string) => CommandResult;

export const runCommand: CommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? `${result.stderr ?? ""}${result.stderr ? "\n" : ""}${result.error.message}` : (result.stderr ?? ""),
  };
};

export function validateHubHost(input: string): string {
  const host = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (isIP(host) === 6) return host;
  if (isIP(host) === 4) return host;
  if (host.length > 253 || !host || !/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..") || host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new Error(`Invalid hub host ${JSON.stringify(input)}; provide a hostname or IP address without a scheme or port`);
  }
  return host;
}

export function hubOrigin(hostInput: string, port = 6342): { host: string; hub: string } {
  const host = validateHubHost(hostInput);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  return { host, hub: `http://${urlHost}:${port}` };
}

function ensurePrivateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a real directory: ${directory}`);
}

function nextBackupName(filename: string) {
  const base = `${filename}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let candidate = base;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function writeHubConfig(config: MemoryHubConfig, filename: string, force = false) {
  const directory = path.dirname(filename);
  ensurePrivateDirectory(directory);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try { existing = lstatSync(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`Refusing to replace non-regular hub configuration: ${filename}`);
  if (existing && !force) throw new Error(`Hub configuration already exists at ${filename}; pass --force to back it up and replace it`);

  const temporary = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    let backup: string | undefined;
    if (existing) {
      backup = nextBackupName(filename);
      copyFileSync(filename, backup);
      chmodSync(backup, 0o600);
      renameSync(temporary, filename);
    } else {
      // link is atomic and fails rather than clobbering a file created concurrently.
      linkSync(temporary, filename);
      unlinkSync(temporary);
    }
    chmodSync(filename, 0o600);
    return { filename, backup };
  } finally {
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
  }
}

function managedSshBlock(host: string) {
  return `${SSH_BEGIN}\nHost memory-hub\n  HostName ${host}\n  User git\n  IdentitiesOnly yes\n${SSH_END}`;
}

export function updateSshConfig(filename: string, hostInput: string) {
  const host = validateHubHost(hostInput);
  const directory = path.dirname(filename);
  ensurePrivateDirectory(directory);
  let original = "";
  let mode = 0o600;
  try {
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`SSH config must be a regular file: ${filename}`);
    mode = stat.mode & 0o777;
    original = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const starts = [...original.matchAll(new RegExp(SSH_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  const ends = [...original.matchAll(new RegExp(SSH_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && starts[0].index! >= ends[0].index!)) {
    throw new Error(`SSH config has malformed or duplicate pi-memory markers: ${filename}`);
  }

  const block = managedSshBlock(host);
  let updated: string;
  if (starts.length === 1) {
    const start = starts[0].index!;
    const end = ends[0].index! + SSH_END.length;
    updated = `${original.slice(0, start)}${block}${original.slice(end)}`;
  } else {
    if (/^\s*Host\s+(?:[^\n]*\s)?memory-hub(?:\s|$)/im.test(original)) {
      throw new Error(`SSH config already defines Host memory-hub outside the managed block; resolve that entry manually before joining`);
    }
    updated = `${block}\n${original}`;
  }

  const temporary = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, filename);
    chmodSync(filename, mode);
  } finally {
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
  }
  return filename;
}

function commandOk(runner: CommandRunner, command: string, args: string[], cwd?: string): CommandResult {
  const result = runner(command, args, cwd);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result;
}

function authFailure(message: string, sshDir: string) {
  const key = ["id_ed25519.pub", "id_rsa.pub"].map(name => path.join(sshDir, name)).find(filename => existsSync(filename));
  const pubkey = key ? `Public key to enroll: ${key}.` : `No default public key was found. Generate one first with: ssh-keygen -t ed25519 -C "$(hostname)".`;
  return new Error(`SSH authentication to the hub wiki failed. ${pubkey} The operator must append that public key as one line to /home/wikigit/.ssh/authorized_keys on the hub (one line per spoke, comment = spoke hostname). Do this manually; this command will not use sudo. Git said: ${message.trim()}`);
}

export function ensureWikiClone(wikiDir: string, runner: CommandRunner = runCommand, sshDir = path.join(os.homedir(), ".ssh")) {
  const remote = "wikigit@memory-hub:wiki.git";
  let exists = false;
  try { lstatSync(wikiDir); exists = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    const cloned = runner("git", ["clone", remote, wikiDir]);
    if (cloned.status !== 0) {
      const message = `${cloned.stderr}\n${cloned.stdout}`;
      if (/permission denied|publickey|authentication failed/i.test(message)) throw authFailure(message, sshDir);
      throw new Error(`Could not clone wiki from ${remote}: ${message.trim() || `git exited ${cloned.status}`}`);
    }
    return { action: "cloned", directory: wikiDir };
  }

  const stat = lstatSync(wikiDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki path exists but is not a real directory: ${wikiDir}`);
  commandOk(runner, "git", ["rev-parse", "--is-inside-work-tree"], wikiDir);
  const origin = commandOk(runner, "git", ["remote", "get-url", "origin"], wikiDir).stdout.trim();
  if (origin !== remote) throw new Error(`Wiki repository at ${wikiDir} has a different origin (${origin || "none"}); refusing to replace it. This may be a hub migration or a mistake; inspect it manually.`);
  commandOk(runner, "git", ["fetch", "origin"], wikiDir);
  commandOk(runner, "git", ["pull", "--ff-only"], wikiDir);
  return { action: "updated", directory: wikiDir };
}

export async function memoryJoin(options: {
  host: string;
  port?: number;
  token: string;
  force?: boolean;
  noPush?: boolean;
  agentDir?: string;
  homeDir?: string;
  repoDir?: string;
  runner?: CommandRunner;
}) {
  if (!options.token || /\s/.test(options.token)) throw new Error("--token must be a non-empty token without whitespace");
  const { host, hub } = hubOrigin(options.host, options.port ?? 6342);
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(options.homeDir ?? os.homedir(), ".pi", "agent");
  const sshDir = path.join(options.homeDir ?? os.homedir(), ".ssh");
  const runner = options.runner ?? runCommand;
  const config = { hub, token: options.token };
  const remoteStatus = await getMemoryHubStatus(config);
  try {
    const configResult = writeHubConfig(config, path.join(agentDir, "memory", "hub.json"), options.force ?? false);
    const sshConfig = updateSshConfig(path.join(sshDir, "config"), host);
    const wiki = ensureWikiClone(path.join(agentDir, "wiki"), runner, sshDir);

    let pushTimer: { installed: boolean; status: string };
    if (options.noPush) {
      pushTimer = { installed: false, status: "skipped (--no-push)" };
    } else {
      const make = commandOk(runner, "make", ["install-spoke"], options.repoDir ?? process.cwd());
      const timer = runner("systemctl", ["--user", "is-enabled", "pi-memory-push.timer"]);
      pushTimer = { installed: true, status: timer.status === 0 ? timer.stdout.trim() : (make.stdout.trim() || "installed; systemctl status unavailable").split("\n").at(-1)! };
    }
    return {
      ok: true,
      hub,
      spoke: remoteStatus.spoke,
      hubConfig: configResult,
      sshConfig,
      wiki,
      pushTimer,
      summary: "Memory tools now use the hub. Sessions push every 15 minutes when the timer is installed. Verify hub reachability and your spoke identity with pi-memory join --status; run pi-memory push to test session upload.",
    };
  } catch (error) {
    throw new Error(`Hub ${hub} authenticated this spoke as "${remoteStatus.spoke}", but onboarding did not finish: ${(error as Error).message}`);
  }
}

export async function memoryJoinStatus(filename?: string) {
  const config = loadMemoryHubConfig(filename);
  if (!config) return { ok: false, configured: false, reachable: false, error: "No hub.json is configured; run pi-memory join <hub-host> --token <spoke-token>" };
  try {
    const status = await getMemoryHubStatus(config);
    return { ok: true, configured: true, reachable: true, hub: config.hub, spoke: status.spoke, status };
  } catch (error) {
    return { ok: false, configured: true, reachable: false, hub: config.hub, error: (error as Error).message };
  }
}
