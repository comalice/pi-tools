import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

export type HubToken = { spoke: string; created: string };
export type HubTokens = Record<string, HubToken>;

export function defaultHubTokenFile() {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agent, "memory", "hub-tokens.json");
}

export function validateSpokeName(spoke: string) {
  if (typeof spoke !== "string" || !spoke.trim() || spoke.length > 255 || spoke.trim() !== spoke) throw new Error("spoke must contain 1 to 255 non-whitespace characters with no surrounding whitespace");
}

function inspectFile(file: string) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Hub token store must be a regular file, not a symlink");
    if (stat.size > 1024 * 1024) throw new Error("Hub token store exceeds 1 MiB");
    return stat;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function readHubTokens(file = defaultHubTokenFile()): HubTokens {
  const stat = inspectFile(file);
  if (!stat) return {};
  if ((stat.mode & 0o077) !== 0) throw new Error("Hub token store must have mode 0600");
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Hub token store is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hub token store must be an object mapping tokens to spokes");
  const tokens: HubTokens = Object.create(null);
  const spokes = new Set<string>();
  for (const [token, value] of Object.entries(parsed)) {
    if (!token || token.length > 256 || !value || typeof value !== "object" || Array.isArray(value) || typeof (value as any).spoke !== "string" || typeof (value as any).created !== "string" || Number.isNaN(Date.parse((value as any).created))) throw new Error("Hub token store contains an invalid token entry");
    validateSpokeName((value as any).spoke);
    if (spokes.has((value as any).spoke)) throw new Error("Hub token store contains duplicate spoke identities");
    spokes.add((value as any).spoke);
    tokens[token] = { spoke: (value as any).spoke, created: (value as any).created };
  }
  return tokens;
}

function writeHubTokens(tokens: HubTokens, file = defaultHubTokenFile()) {
  const directory = path.dirname(file);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Hub token directory must be a real directory");
  const existing = inspectFile(file);
  if (existing && (existing.mode & 0o077) !== 0) chmodSync(file, 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* absent */ }
    throw error;
  }
}

export function addHubToken(spoke: string, file = defaultHubTokenFile()) {
  validateSpokeName(spoke);
  const tokens = readHubTokens(file);
  if (Object.values(tokens).some(item => item.spoke === spoke)) throw new Error(`A token already exists for spoke ${spoke}; revoke it before adding another`);
  const token = randomBytes(32).toString("base64url");
  const created = new Date().toISOString();
  tokens[token] = { spoke, created };
  writeHubTokens(tokens, file);
  return { token, spoke, created };
}

export function registerHubToken(spoke: string, token: string, file = defaultHubTokenFile()) {
  validateSpokeName(spoke);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32 || Buffer.from(token, "base64url").toString("base64url") !== token) {
    throw new Error("secret must be exactly 43 canonical base64url characters (32 bytes)");
  }
  const tokens = readHubTokens(file);
  if (Object.values(tokens).some(item => item.spoke === spoke)) throw new Error(`A token already exists for spoke ${spoke}; revoke it before registering another`);
  if (tokens[token]) throw new Error("This secret is already registered");
  const created = new Date().toISOString();
  tokens[token] = { spoke, created };
  writeHubTokens(tokens, file);
  return { spoke, created };
}

export function makeHubBundle(hub: string, token: string) {
  return `pih1.${Buffer.from(JSON.stringify({ hub })).toString("base64url")}.${token}`;
}

export function listHubTokens(file = defaultHubTokenFile()) {
  return Object.values(readHubTokens(file)).map(({ spoke, created }) => ({ spoke, created })).sort((a, b) => a.spoke.localeCompare(b.spoke));
}

export function revokeHubToken(spoke: string, file = defaultHubTokenFile()) {
  validateSpokeName(spoke);
  const tokens = readHubTokens(file);
  const token = Object.keys(tokens).find(key => tokens[key].spoke === spoke);
  if (!token) return { spoke, revoked: false };
  delete tokens[token];
  writeHubTokens(tokens, file);
  return { spoke, revoked: true };
}
