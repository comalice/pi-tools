import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piGenerate, type Generate } from "../dream/worker.ts";

/**
 * Durable AI-generated session summaries for canonical session links.
 *
 * Summaries are best-effort (may be inaccurate) and durable: existing entries
 * are never regenerated unless rebuild is requested. Stored outside the
 * archive — derived presentation data, not evidence.
 */

export interface SessionSummary {
  summary: string;
  start?: string;
  end?: string;
  generated_at: string;
}

export type SummaryStore = Record<string, SessionSummary>;

export function loadSummaries(path: string): SummaryStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SummaryStore;
  } catch {
    return {};
  }
}

export function saveSummaries(path: string, store: SummaryStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 1) + "\n", { mode: 0o600 });
}

const ENTRY_CAP = 2500;
const CONTEXT_ENTRIES = 3;
const TAIL_ENTRIES = 2;

function summaryPrompt(source: string, sessionId: string, head: string[], tail: string[]): string {
  return `You are labeling an archived AI conversation session for a link index.

Source: ${source}, session: ${sessionId}

${head.map((t, i) => `--- message ${i + 1} ---\n${t}`).join("\n\n")}
${tail.length ? `\n--- final messages ---\n${tail.join("\n\n")}` : ""}

In AT MOST 15 words, what did this session work on? Be specific: name the system, component, or task. Output ONLY the summary phrase — no preamble, no trailing period.`;
}

export async function summarizeSessions(opts: {
  archivePath: string;
  storePath: string;
  sessions: { source: string; session_id: string }[];
  model: string;
  rebuild?: boolean;
  limit?: number;
}, generate: Generate = piGenerate): Promise<{ summarized: number; skipped: number; failed: { session: string; error: string }[] }> {
  const store = loadSummaries(opts.storePath);
  const db = new DatabaseSync(opts.archivePath, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  const head = db.prepare(
    "SELECT text, timestamp FROM entries WHERE source=? AND session_id=? AND indexable=1 AND text<>'' ORDER BY rowid LIMIT ?",
  );
  const tail = db.prepare(
    "SELECT text, timestamp FROM entries WHERE source=? AND session_id=? AND indexable=1 AND text<>'' ORDER BY rowid DESC LIMIT ?",
  );

  let summarized = 0;
  let skipped = 0;
  const failed: { session: string; error: string }[] = [];
  for (const { source, session_id } of opts.sessions) {
    const key = `${source}:${session_id}`;
    if (store[key] && !opts.rebuild) {
      skipped++;
      continue;
    }
    if (opts.limit !== undefined && summarized >= opts.limit) break;
    try {
      const headRows = head.all(source, session_id, CONTEXT_ENTRIES) as unknown as { text: string; timestamp?: string }[];
      const tailRows = tail.all(source, session_id, TAIL_ENTRIES) as unknown as { text: string; timestamp?: string }[];
      if (headRows.length === 0) {
        skipped++;
        continue;
      }
      const prompt = summaryPrompt(
        source,
        session_id,
        headRows.map((r) => r.text.slice(0, ENTRY_CAP)),
        tailRows.map((r) => r.text.slice(0, ENTRY_CAP)),
      );
      const text = (await generate(opts.model, prompt)).trim().split("\n")[0].replace(/\.$/, "").slice(0, 120);
      if (text.length < 3) throw new Error("empty summary");
      const times = [...headRows, ...tailRows].map((r) => r.timestamp).filter((t): t is string => !!t).sort();
      store[key] = {
        summary: text,
        start: times[0],
        end: times[times.length - 1],
        generated_at: new Date().toISOString(),
      };
      summarized++;
      if (summarized % 10 === 0) saveSummaries(opts.storePath, store); // checkpoint
    } catch (error) {
      failed.push({ session: key, error: (error as Error).message });
    }
  }
  db.close();
  saveSummaries(opts.storePath, store);
  return { summarized, skipped, failed };
}
