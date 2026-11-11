import { copyFileSync, existsSync, lstatSync, mkdirSync, chmodSync, renameSync, unlinkSync, writeFileSync, linkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { getMemoryHubStatus, loadMemoryHubConfig, type MemoryHubConfig, type MemoryHubStatus } from "./remote.ts";
import { validateSpokeName } from "./hub-tokens.ts";

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

export function validateHubUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("hub address must be an absolute HTTP(S) origin"); }
  if (!(url.protocol === "http:" || url.protocol === "https:") || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("hub address must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export function parseHubBundle(bundle: string): MemoryHubConfig {
  const match = /^pih1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(bundle);
  if (!match || Buffer.from(match[2], "base64url").length !== 32 || Buffer.from(match[2], "base64url").toString("base64url") !== match[2]) throw new Error("Invalid pih1 enrollment bundle");
  let payload: any;
  try {
    const decoded = Buffer.from(match[1], "base64url");
    if (decoded.toString("base64url") !== match[1]) throw new Error();
    payload = JSON.parse(decoded.toString("utf8"));
  } catch { throw new Error("Invalid pih1 enrollment bundle payload"); }
  if (!payload || typeof payload !== "object" || typeof payload.hub !== "string") throw new Error("Invalid pih1 enrollment bundle payload: expected hub URL");
  return { hub: validateHubUrl(payload.hub), token: match[2] };
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
    if (existing) {
      const backup = nextBackupName(filename);
      copyFileSync(filename, backup);
      chmodSync(backup, 0o600);
      renameSync(temporary, filename);
      chmodSync(filename, 0o600);
      return { filename, backup };
    }
    linkSync(temporary, filename);
    unlinkSync(temporary);
    chmodSync(filename, 0o600);
    return { filename, backup: undefined };
  } finally {
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
  }
}

function commandOk(runner: CommandRunner, command: string, args: string[], cwd?: string): CommandResult {
  const result = runner(command, args, cwd);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result;
}

function privateGitConfig(wikiDir: string) {
  const gitDir = path.join(wikiDir, ".git");
  const gitStat = lstatSync(gitDir);
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) throw new Error(`Wiki Git metadata must be a real directory: ${gitDir}`);
  const config = path.join(gitDir, "config");
  const configStat = lstatSync(config);
  if (configStat.isSymbolicLink() || !configStat.isFile()) throw new Error(`Wiki Git config must be a regular file: ${config}`);
  return config;
}

export function ensureWikiClone(wikiDir: string, hub: string, token: string, runner: CommandRunner = runCommand) {
  const origin = `${validateHubUrl(hub)}/git/wiki.git`;
  let exists = false;
  try { lstatSync(wikiDir); exists = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    const cloned = runner("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "clone", origin, wikiDir]);
    if (cloned.status !== 0) {
      const message = `${cloned.stderr}\n${cloned.stdout}`;
      throw new Error(`Could not clone wiki from ${origin}: ${message.trim() || `git exited ${cloned.status}`}`);
    }
    chmodSync(wikiDir, 0o700);
  } else {
    const stat = lstatSync(wikiDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Wiki path exists but is not a real directory: ${wikiDir}`);
    commandOk(runner, "git", ["rev-parse", "--is-inside-work-tree"], wikiDir);
    const currentOrigin = commandOk(runner, "git", ["remote", "get-url", "origin"], wikiDir).stdout.trim();
    if (currentOrigin !== origin) throw new Error(`Wiki repository at ${wikiDir} has a different origin (${currentOrigin || "none"}); refusing to replace it. This may be a hub migration or a mistake; inspect it manually.`);
  }

  const config = privateGitConfig(wikiDir);
  commandOk(runner, "git", ["config", "http.extraHeader", `Authorization: Bearer ${token}`], wikiDir);
  chmodSync(wikiDir, 0o700);
  chmodSync(config, 0o600);
  if (exists) {
    commandOk(runner, "git", ["fetch", "origin"], wikiDir);
    commandOk(runner, "git", ["pull", "--ff-only"], wikiDir);
  }
  return { action: exists ? "updated" : "cloned", directory: wikiDir, origin };
}

export interface JoinOptions {
  hub: string;
  token: string;
  force?: boolean;
  noPush?: boolean;
  agentDir?: string;
  homeDir?: string;
  repoDir?: string;
  runner?: CommandRunner;
}

async function completeJoin(options: JoinOptions, remoteStatus: MemoryHubStatus) {
  const hub = validateHubUrl(options.hub);
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(options.homeDir ?? os.homedir(), ".pi", "agent");
  const runner = options.runner ?? runCommand;
  const config = { hub, token: options.token };
  try {
    const configResult = writeHubConfig(config, path.join(agentDir, "memory", "hub.json"), options.force ?? false);
    const wiki = ensureWikiClone(path.join(agentDir, "wiki"), hub, options.token, runner);
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
      wiki,
      pushTimer,
      summary: "Memory tools now use the hub. Sessions push every 15 minutes when the timer is installed. Verify hub reachability and your spoke identity with pi-memory join --status; run pi-memory push to test session upload.",
    };
  } catch (error) {
    throw new Error(`Hub ${hub} authenticated this spoke as "${remoteStatus.spoke}", but onboarding did not finish: ${(error as Error).message}`);
  }
}

export async function memoryJoin(options: JoinOptions) {
  if (!options.token || /\s/.test(options.token)) throw new Error("--token must be a non-empty token without whitespace");
  const hub = validateHubUrl(options.hub);
  const remoteStatus = await getMemoryHubStatus({ hub, token: options.token });
  return completeJoin({ ...options, hub }, remoteStatus);
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Enrollment cancelled"));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Enrollment cancelled")); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function memoryEnroll(options: {
  hub: string;
  spoke?: string;
  noPush?: boolean;
  agentDir?: string;
  homeDir?: string;
  repoDir?: string;
  runner?: CommandRunner;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  secret?: string;
  onRegisterCommand?: (command: string) => void;
}) {
  const hub = validateHubUrl(options.hub);
  const spoke = options.spoke ?? os.hostname();
  validateSpokeName(spoke);
  const token = options.secret ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32 || Buffer.from(token, "base64url").toString("base64url") !== token) throw new Error("Enrollment secret must be 32 bytes encoded as canonical base64url");
  const safeSpoke = /^[A-Za-z0-9._-]+$/.test(spoke) ? spoke : `'${spoke.replace(/'/g, "'\\''")}'`;
  options.onRegisterCommand?.(`pi-memory hub-token register ${safeSpoke} '${token}'`);

  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  const interval = options.pollIntervalMs ?? 5000;
  let remoteStatus: MemoryHubStatus | undefined;
  let lastError = "hub has not accepted the token yet";
  while (!remoteStatus && Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Enrollment cancelled");
    try {
      const accepted = await getMemoryHubStatus({ hub, token }, options.signal);
      if (accepted.spoke !== spoke) throw new Error(`Registered token identifies spoke "${accepted.spoke}", expected "${spoke}"`);
      remoteStatus = accepted;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      lastError = (error as Error).message;
      if (lastError.startsWith("Registered token identifies spoke ")) throw error;
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(interval, remaining), options.signal);
    }
  }
  if (!remoteStatus) throw new Error(`Enrollment timed out after ${Math.round((options.timeoutMs ?? 15 * 60 * 1000) / 1000)} seconds waiting for hub-token registration (${lastError}). No hub.json was written.`);
  return completeJoin({ ...options, hub, token }, remoteStatus);
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
