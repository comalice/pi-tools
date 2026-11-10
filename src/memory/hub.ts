import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { importPayload } from "./blobs.ts";
import { readHubTokens, defaultHubTokenFile } from "./hub-tokens.ts";
import { searchMemory } from "./semantic.ts";
import { expand, openStore, SCHEMA_VERSION, status } from "./store.ts";
import { resolveBindAddress } from "../shared/bind.ts";

export const MEMORY_HUB_VERSION = "1";
const MAX_PI_FILE = 256 * 1024 * 1024;
const MAX_HTTP_BODY = Math.ceil(MAX_PI_FILE * 4 / 3) + 1024 * 1024;

export interface MemoryHubOptions {
  index?: string;
  tokenFile?: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value)}\n`);
}

function bearer(req: IncomingMessage, tokenFile: string) {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer ([^\s]+)$/) : null;
  if (!match) throw new HttpError(401, "Bearer token required");
  let tokens;
  try { tokens = readHubTokens(tokenFile); } catch (error) { throw new HttpError(503, `Hub token store unavailable: ${(error as Error).message}`); }
  const identity = tokens[match[1]];
  if (!identity) throw new HttpError(403, "Invalid bearer token");
  return identity.spoke;
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_HTTP_BODY) { tooLarge = true; chunks.length = 0; continue; }
    if (!tooLarge) chunks.push(bytes);
  }
  if (tooLarge) throw new HttpError(413, "Request body exceeds the 342 MiB limit");
  let value: any;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Request body must be a JSON object");
  return value;
}

function scope(value: unknown, project: unknown) {
  if (value !== undefined && value !== "project" && value !== "all") throw new HttpError(400, "scope must be project or all");
  if (project !== undefined && (typeof project !== "string" || project.length > 4096)) throw new HttpError(400, "project must be a string of at most 4096 characters");
  return { scope: value as "project" | "all" | undefined, project: project as string | undefined };
}

function requestIndex(options: MemoryHubOptions) {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(options.index ?? process.env.PI_MEMORY_INDEX ?? path.join(agent, "memory", "archive.sqlite"));
}

export function createMemoryHubServer(options: MemoryHubOptions = {}): { server: Server } {
  const index = requestIndex(options);
  // Startup uses the normal writable opener so schema-N-1 migration runs before
  // the service's exact-version read-only connection is created.
  const writer = openStore(index);
  const reader = new DatabaseSync(index, { readOnly: true, timeout: 5000 });
  reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  const tokenFile = options.tokenFile ?? defaultHubTokenFile();
  const started = Date.now();
  let ingestQueue: Promise<void> = Promise.resolve();
  const serializeIngest = <T>(operation: () => T | Promise<T>) => {
    const result = ingestQueue.then(operation);
    ingestQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const spoke = bearer(req, tokenFile);
      if (req.method === "GET" && url.pathname === "/status") {
        const archive = status(reader);
        return send(res, 200, {
          ok: true,
          version: MEMORY_HUB_VERSION,
          schema: SCHEMA_VERSION,
          sources: archive.sources,
          uptime: Math.floor((Date.now() - started) / 1000),
          spoke,
        });
      }
      if (req.method === "POST" && url.pathname === "/search") {
        const input = await readJson(req);
        const fields = scope(input.scope, input.project);
        const mode = input.mode;
        if (mode !== undefined && !["auto", "lexical", "hybrid", "semantic"].includes(mode)) throw new HttpError(400, "mode must be lexical, hybrid, semantic, or auto");
        if (input.currentSession !== undefined && (typeof input.currentSession !== "string" || input.currentSession.length < 1 || input.currentSession.length > 200)) throw new HttpError(400, "currentSession must contain 1 to 200 characters");
        if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10)) throw new HttpError(400, "limit must be an integer from 1 to 10");
        const retrievalScope = fields.scope ?? (fields.project === undefined ? "all" : "project");
        let result;
        try {
          result = await searchMemory(reader, index, {
            query: input.query,
            cues: input.cues,
            limit: input.limit,
            mode,
            cosineFloor: input.cosineFloor,
            source: input.source,
            session: input.session,
            currentSession: input.currentSession,
            project: fields.project,
            scope: retrievalScope,
          });
        } catch (error) { throw new HttpError(400, (error as Error).message); }
        const latest = input.currentSession
          ? reader.prepare("SELECT MAX(timestamp) AS latest FROM documents WHERE session_id<>?").get(input.currentSession)
          : reader.prepare("SELECT MAX(timestamp) AS latest FROM documents").get();
        return send(res, 200, { ok: true, ...result, archive: { latest: (latest as any)?.latest ?? null } });
      }
      if (req.method === "POST" && url.pathname === "/expand") {
        const input = await readJson(req);
        const fields = scope(input.scope, input.project);
        const retrievalScope = fields.scope ?? (fields.project === undefined ? "all" : "project");
        if (input.includeReplies !== undefined && typeof input.includeReplies !== "boolean") throw new HttpError(400, "includeReplies must be a boolean");
        let result;
        try {
          result = expand(reader, input.id ?? "", {
            project: fields.project,
            scope: retrievalScope,
            source: input.source,
            maxChars: input.maxChars,
            offset: input.offset,
            direction: input.direction,
            branchId: input.branchId,
            includeReplies: input.includeReplies,
          });
        } catch (error) { throw new HttpError(400, (error as Error).message); }
        if (!result) throw new HttpError(404, "Memory result not found or outside selected project/source scope");
        return send(res, 200, { ok: true, result });
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        const result = await serializeIngest(async () => {
          const input = await readJson(req);
          if (input.source !== "pi") throw new HttpError(400, "Hub ingest currently supports source pi only");
          if (typeof input.filename !== "string" || input.filename.length > 255 || !input.filename.toLowerCase().endsWith(".jsonl")) throw new HttpError(400, "filename must be a .jsonl file name of at most 255 characters");
          if (typeof input.content_base64 !== "string" || !input.content_base64.length || input.content_base64.length > MAX_HTTP_BODY) throw new HttpError(400, "content_base64 must contain a Pi session payload");
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content_base64)) throw new HttpError(400, "content_base64 must be canonical standard base64");
          const bytes = Buffer.from(input.content_base64, "base64");
          if (!bytes.length || bytes.length > MAX_PI_FILE || bytes.toString("base64") !== input.content_base64) throw new HttpError(400, "Decoded Pi session must contain 1 to 268435456 bytes of canonical base64");
          return importPayload(writer, "pi", input.filename, bytes, path.join(path.dirname(index), "blobs"), { origin: spoke, replaceFilename: true });
        });
        return send(res, 200, { ok: true, source: result.source, copied: result.copied, ingest: result.ingest });
      }
      return send(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.once("close", () => { reader.close(); writer.close(); });
  return { server };
}

export function serveMemoryHub(options: MemoryHubOptions & { port: number; bind?: string }): void {
  const bind = resolveBindAddress(options.bind);
  const { server } = createMemoryHubServer(options);
  server.listen(options.port, bind, () => {
    const host = bind.includes(":") ? `[${bind}]` : bind;
    console.log(`[memory-hub] listening on http://${host}:${options.port}`);
  });
}
