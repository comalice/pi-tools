import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MemoryHubConfig {
  hub: string;
  token: string;
}

export const MEMORY_HUB_REQUEST_TIMEOUT_MS = 30_000;

export function memoryHubConfigPath(): string {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agent, "memory", "hub.json");
}

/** Returns null only when hub.json is absent; malformed or unsafe config is an error. */
export function loadMemoryHubConfig(filename = memoryHubConfigPath()): MemoryHubConfig | null {
  let stat;
  try { stat = lstatSync(filename); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Invalid memory hub configuration ${filename}: ${(error as Error).message}`);
  }
  if (!stat.isFile()) throw new Error(`Invalid memory hub configuration ${filename}: must be a regular file (symbolic links are not accepted)`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Invalid memory hub configuration ${filename}: must be private (mode 0600 or stricter)`);
  let contents: string;
  try { contents = readFileSync(filename, "utf8"); } catch (error) {
    throw new Error(`Invalid memory hub configuration ${filename}: ${(error as Error).message}`);
  }

  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw new Error(`Invalid memory hub configuration ${filename}: expected valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid memory hub configuration ${filename}: expected an object with hub and token strings`);
  }
  const config = value as Record<string, unknown>;
  if (typeof config.hub !== "string" || typeof config.token !== "string" || !config.token || /\s/.test(config.token)) {
    throw new Error(`Invalid memory hub configuration ${filename}: hub must be a URL and token must be a non-empty token without whitespace`);
  }

  let url: URL;
  try { url = new URL(config.hub); } catch { throw new Error(`Invalid memory hub configuration ${filename}: hub must be an absolute HTTP(S) URL`); }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid memory hub configuration ${filename}: hub must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return { hub: url.origin, token: config.token };
}

export interface MemoryHubStatus {
  ok: true;
  version: string;
  schema: number;
  sources: unknown;
  uptime: number;
  spoke: string;
}

export async function getMemoryHubStatus(config: MemoryHubConfig, signal?: AbortSignal): Promise<MemoryHubStatus> {
  const timeout = AbortSignal.timeout(MEMORY_HUB_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.hub}/status`, {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      signal: requestSignal,
    });
  } catch (error) {
    const reason = requestSignal.aborted && timeout.aborted ? `request timed out after ${MEMORY_HUB_REQUEST_TIMEOUT_MS / 1000} seconds` : (error as Error).message;
    throw new Error(`Memory hub ${config.hub} status request failed: ${reason}`);
  }
  let value: any;
  try { value = await response.json(); } catch {
    throw new Error(`Memory hub ${config.hub} returned HTTP ${response.status} with an invalid JSON status response`);
  }
  if (!response.ok) {
    const message = typeof value?.error === "string" ? value.error : response.statusText;
    throw new Error(`Memory hub ${config.hub} returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  if (!value || typeof value !== "object" || value.ok !== true || typeof value.spoke !== "string" || !value.spoke) {
    throw new Error(`Memory hub ${config.hub} returned an invalid status response`);
  }
  return value as MemoryHubStatus;
}

export async function postMemoryHub<T>(
  config: MemoryHubConfig,
  endpoint: "search" | "expand",
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(MEMORY_HUB_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.hub}/${endpoint}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(input),
      signal: requestSignal,
    });
  } catch (error) {
    const reason = requestSignal.aborted && timeout.aborted ? `request timed out after ${MEMORY_HUB_REQUEST_TIMEOUT_MS / 1000} seconds` : (error as Error).message;
    throw new Error(`Memory hub ${config.hub} request failed: ${reason}`);
  }

  let body: string;
  try { body = await response.text(); } catch (error) {
    const reason = requestSignal.aborted && timeout.aborted ? `response timed out after ${MEMORY_HUB_REQUEST_TIMEOUT_MS / 1000} seconds` : (error as Error).message;
    throw new Error(`Memory hub ${config.hub} response failed: ${reason}`);
  }
  let value: any;
  try { value = JSON.parse(body); } catch {
    throw new Error(`Memory hub ${config.hub} returned HTTP ${response.status} with an invalid JSON response`);
  }
  if (!response.ok) {
    const message = typeof value?.error === "string" ? value.error : response.statusText;
    throw new Error(`Memory hub ${config.hub} returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  if (!value || typeof value !== "object" || value.ok !== true) {
    throw new Error(`Memory hub ${config.hub} returned an invalid ${endpoint} response`);
  }
  return value as T;
}
