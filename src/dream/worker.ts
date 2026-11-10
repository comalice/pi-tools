import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { writeStaging } from "../wiki/staging.ts";

// Dream extraction harness: a deterministic state machine around single-turn
// model calls. The model never touches tools — it receives one transcript
// chunk and must return a JSON array of extractions. Code validates the output
// (entry IDs must exist in the chunk, kinds are enumerated, counts and lengths
// are bounded), retries once with the error fed back, and persists validated
// extractions itself. Design lineage: maelstrom-code's state-machine and
// context-budget ideas (hard truncation, budgeted chunks), minimally adapted.

const CHUNK_CHARS = 12_000;
const MAX_CHUNKS = 40;
const MAX_PER_CHUNK = 5;
const MAX_PER_SESSION = 8;
const GENERATE_TIMEOUT_MS = 8 * 60 * 1000;
const KINDS = ["decision", "fact", "process", "gotcha", "ops-pattern"] as const;

export interface Message { id: string; role: string; text: string }
export interface Chunk { ids: Set<string>; transcript: string; truncated: boolean }
export interface Extraction { title: string; kind: string; tags: string[]; entry_ids: string[]; body: string }

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((x: any) => x && x.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("\n");
}

export function digestPi(file: string): Message[] {
  const bytes = readFileSync(file);
  const end = bytes.lastIndexOf(10) + 1;
  const messages: Message[] = [];
  for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "message" || typeof obj.id !== "string") continue;
    const role = obj.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (obj.customType || obj.summary || obj.isSummary || obj.message?.customType || obj.message?.synthetic) continue;
    const text = textFromContent(obj.message?.content);
    if (text.trim()) messages.push({ id: obj.id, role, text });
  }
  return messages;
}


/** Assemble an OpenCode session from its SQLite store, mirroring the archive
 * ingest eligibility: user/assistant messages before the revert boundary,
 * excluding summaries/synthetic; text parts only, not synthetic/ignored. */
export function digestOpenCode(dbFile: string, sessionId: string): Message[] {
  const src = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 });
  try {
    src.exec("PRAGMA query_only=ON;");
    const sess = src.prepare("SELECT id,revert FROM session WHERE id=?").get(sessionId) as any;
    if (!sess) throw new Error(`OpenCode session not found: ${sessionId}`);
    const revert = sess.revert ? JSON.parse(sess.revert) : null;
    const boundary = revert?.messageID;
    const boundaryPart = revert?.partID;
    const rows = src.prepare("SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id LIMIT 50000").all(sessionId) as any[];
    if (rows.length === 50000) throw new Error(`OpenCode session ${sessionId} exceeds per-session message limit`);
    const decoded = rows.map((m) => ({ m, data: JSON.parse(m.data) }));
    const boundaryIndex = boundary ? decoded.findIndex((x) => x.m.id === boundary) : -1;
    const partStmt = src.prepare("SELECT id,json_extract(data,'$.type') AS type,json_extract(data,'$.text') AS text,COALESCE(json_extract(data,'$.synthetic'),0) AS synthetic,COALESCE(json_extract(data,'$.ignored'),0) AS ignored,COALESCE(json_extract(data,'$.ignoredReason'),'') AS ignored_reason FROM part WHERE message_id=? ORDER BY id LIMIT 1001");
    const out: Message[] = [];
    for (let i = 0; i < decoded.length; i++) {
      const { m, data } = decoded[i];
      const role = data?.role;
      const visible = !boundary || i < boundaryIndex || (i === boundaryIndex && Boolean(boundaryPart));
      const eligible = (role === "user" || role === "assistant") && visible && data?.summary !== true && !data?.synthetic;
      if (!eligible) continue;
      const parts = partStmt.all(m.id) as any[];
      if (parts.length > 1000) throw new Error(`OpenCode message ${m.id} exceeds per-message part limit`);
      const text = parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && !p.ignored_reason && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text.trim()) out.push({ id: m.id, role, text });
    }
    return out;
  } finally {
    src.close();
  }
}

export function digestClaude(file: string): Message[] {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || !Array.isArray(data.chat_messages)) throw new Error(`Unsupported Claude export: ${file}`);
  const messages: Message[] = [];
  for (const m of data.chat_messages) {
    const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : null;
    if (!role || typeof m.uuid !== "string") continue;
    const text = textFromContent(m.content);
    if (text.trim()) messages.push({ id: m.uuid, role, text });
  }
  return messages;
}

export function chunkMessages(messages: Message[]): Chunk[] {
  const chunks: Chunk[] = [];
  let ids = new Set<string>();
  let transcript = "";
  let truncated = false;
  const flush = () => {
    if (!transcript) return;
    chunks.push({ ids, transcript, truncated });
    ids = new Set<string>();
    transcript = "";
    truncated = false;
  };
  for (const message of messages) {
    let piece = `[e:${message.id}] ${message.role}:\n${message.text}\n\n`;
    let pieceTruncated = false;
    if (piece.length > CHUNK_CHARS) {
      piece = `[e:${message.id}] ${message.role}:\n${message.text.slice(0, CHUNK_CHARS)}\n[… single message hard-truncated from ${message.text.length} characters]\n\n`;
      pieceTruncated = true;
    }
    if (transcript && transcript.length + piece.length > CHUNK_CHARS) flush();
    ids.add(message.id);
    transcript += piece;
    if (pieceTruncated) truncated = true; // marks the chunk the truncated message lands in
    if (chunks.length >= MAX_CHUNKS) break;
  }
  if (chunks.length < MAX_CHUNKS) flush();
  return chunks;
}

export function extractJsonArray(text: string): any[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("response contains no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not a JSON array");
  return parsed;
}

export function validateExtractions(raw: any[], chunkIds: Set<string>): { items: Extraction[]; errors: string[] } {
  const errors: string[] = [];
  const items: Extraction[] = [];
  if (raw.length > MAX_PER_CHUNK) errors.push(`at most ${MAX_PER_CHUNK} extractions per chunk; got ${raw.length}`);
  for (const [i, item] of raw.slice(0, MAX_PER_CHUNK).entries()) {
    const label = `item ${i + 1} (${typeof item?.title === "string" ? item.title.slice(0, 40) : "untitled"})`;
    if (!item || typeof item !== "object") { errors.push(`${label}: not an object`); continue; }
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 200) { errors.push(`${label}: title must be a string of 1-200 characters`); continue; }
    if (!(KINDS as readonly string[]).includes(item.kind)) { errors.push(`${label}: kind must be one of ${KINDS.join("|")}`); continue; }
    if (typeof item.body !== "string" || !item.body.trim() || item.body.length > 2000) { errors.push(`${label}: body must be a string of 1-2000 characters`); continue; }
    const tags = Array.isArray(item.tags) ? item.tags.slice(0, 6) : [];
    if (tags.some((t: any) => typeof t !== "string" || !t.trim() || t.length > 40)) { errors.push(`${label}: tags must be strings of 1-40 characters`); continue; }
    if (!Array.isArray(item.entry_ids) || item.entry_ids.length < 1 || item.entry_ids.length > 5) { errors.push(`${label}: entry_ids must contain 1-5 IDs`); continue; }
    const invented = item.entry_ids.filter((id: any) => typeof id !== "string" || !chunkIds.has(id));
    if (invented.length) { errors.push(`${label}: entry_ids not present in this chunk: ${invented.join(", ").slice(0, 120)} — copy IDs verbatim from [e:...] markers`); continue; }
    items.push({ title: item.title.trim(), kind: item.kind, tags, entry_ids: item.entry_ids, body: item.body.trim() });
  }
  return { items, errors };
}

export function extractionPrompt(meta: { source: string; session: string; project: string }, chunk: Chunk, chunkIndex: number, chunkCount: number, feedback?: string): string {
  return `You are an extraction engine. Read the transcript chunk and output ONLY a JSON array — no prose, no markdown fences — of at most ${MAX_PER_CHUNK} objects with exactly these fields:
[{"title": "short topic title", "kind": "decision|fact|process|gotcha|ops-pattern", "tags": ["topic"], "entry_ids": ["id"], "body": "dense markdown, at most 2000 characters"}]

Rules:
- Extract only durable knowledge: decisions (with rationale), facts (checkable statements), processes (repeatable procedures), gotchas (failure modes and fixes), ops-patterns (repetitive, failure-prone, or expensive operations, with occurrence counts).
- Fewer is better; most chunks yield 0-2 extractions. Output [] when nothing qualifies.
- Every claim must be supported by the entry_ids you cite. Copy entry IDs VERBATIM from the [e:...] markers; an ID you invent is a validation failure.
- Redact secrets on sight.
${feedback ? `\nYour previous output was rejected. Fix these errors and output the corrected JSON array only:\n${feedback}\n` : ""}
Session: ${meta.source} ${meta.session} (${meta.project}), chunk ${chunkIndex + 1}/${chunkCount}.
Transcript:
${chunk.transcript}`;
}

export type Generate = (model: string, prompt: string) => Promise<string>;

export const piGenerate: Generate = (model, prompt) => new Promise((resolve, reject) => {
  // npm-run prepends node_modules/.bin to PATH, where a stale bundled pi may
  // shadow the real one; strip those entries so the agent pi always wins.
  const env = { ...process.env };
  env.PATH = (env.PATH ?? "").split(":").filter((p) => !p.includes("node_modules/.bin")).join(":");
  const bin = process.env.PI_AGENT_BIN ?? "pi";
  const child = spawn(bin, ["--print", "--no-session", "--no-skills", "--no-extensions", "--no-mcp", "--no-tools", "--model", model, prompt], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
  const killer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("generation timed out")); }, GENERATE_TIMEOUT_MS);
  child.on("error", error => { clearTimeout(killer); reject(error); });
  child.on("close", code => {
    clearTimeout(killer);
    if (code === 0) resolve(stdout);
    else reject(new Error(`pi exited ${code}: ${stderr.trim().slice(-300)}`));
  });
});

export interface WorkerResult { staged: number; titles: string[]; chunks: number; chunkFailures: string[]; truncatedMessages: boolean }

export async function runWorker(opts: { file: string; source: string; session: string; project: string; model: string; wikiDir?: string }, generate: Generate = piGenerate): Promise<WorkerResult> {
  const messages = opts.source === "claude" ? digestClaude(opts.file) : opts.source === "opencode" ? digestOpenCode(opts.file, opts.session) : digestPi(opts.file);
  if (!messages.length) return { staged: 0, titles: [], chunks: 0, chunkFailures: [], truncatedMessages: false };
  const chunks = chunkMessages(messages);
  const wikiDir = opts.wikiDir ?? process.env.PI_WIKI_DIR ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "wiki");
  const stagedTitles = new Set<string>();
  const titles: string[] = [];
  const chunkFailures: string[] = [];
  const hardTruncated = chunks.some(chunk => chunk.truncated);

  for (const [index, chunk] of chunks.entries()) {
    if (titles.length >= MAX_PER_SESSION) break;
    let feedback: string | undefined;
    let items: Extraction[] = [];
    let failed = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = extractJsonArray(await generate(opts.model, extractionPrompt({ source: opts.source, session: opts.session, project: opts.project }, chunk, index, chunks.length, feedback)));
        const validated = validateExtractions(raw, chunk.ids);
        if (!validated.errors.length || attempt === 1) {
          items = validated.items;
          failed = validated.errors.length ? `chunk ${index + 1}: kept ${validated.items.length} valid of ${raw.length}; rejected: ${validated.errors.join("; ").slice(0, 300)}` : "";
          break;
        }
        feedback = validated.errors.join("\n");
      } catch (error) {
        if (attempt === 1) failed = `chunk ${index + 1}: ${(error as Error).message.slice(0, 300)}`;
        else feedback = `Unparseable response: ${(error as Error).message}. Output ONLY the JSON array.`;
      }
    }
    if (failed) chunkFailures.push(failed);
    for (const item of items) {
      if (titles.length >= MAX_PER_SESSION) break;
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (stagedTitles.has(key)) continue;
      stagedTitles.add(key);
      writeStaging({ wikiDir, title: item.title, tags: [...new Set([item.kind, ...item.tags])], sourceKind: opts.source, session: opts.session, entries: item.entry_ids, body: item.body });
      titles.push(item.title);
    }
  }
  return { staged: titles.length, titles, chunks: chunks.length, chunkFailures, truncatedMessages: hardTruncated };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
  try {
    for (const required of ["--file", "--source", "--session", "--project", "--model"]) {
      if (!args[required]) throw new Error(`missing ${required}`);
    }
    const result = await runWorker({ file: args["--file"], source: args["--source"], session: args["--session"], project: args["--project"], model: args["--model"], wikiDir: args["--wiki-dir"] });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    if (result.staged === 0 && result.chunkFailures.length === result.chunks && result.chunks > 0) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`);
    process.exitCode = 1;
  }
}
