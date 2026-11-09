import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

function validProvenance(value: any) {
  return value && ["pi", "opencode", "claude", "wiki"].includes(value.source) && typeof value.sessionId === "string" && value.sessionId.length <= 200 && typeof value.project === "string" && value.project.length <= 4096 && typeof value.entryId === "string" && value.entryId.length <= 200 && typeof value.resultId === "string" && value.resultId.length <= 64;
}

export async function runMemoryWorker<T = any>(
  script: string,
  index: string,
  command: string,
  options: Record<string, string | string[]>,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  if (signal?.aborted) throw new Error("Memory request cancelled");
  const argv = ["--experimental-strip-types", script, command, "--index", index];
  for (const [key, raw] of Object.entries(options)) {
    if (key === "--all" || key === "--no-replies") {
      argv.push(key);
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) argv.push(key, value);
  }

  try {
    const result = await execute(process.execPath, argv, {
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
      encoding: "utf8",
      signal,
    });
    let parsed: any;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Memory worker returned malformed JSON"); }
    if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") throw new Error("Memory worker returned an invalid response");
    if (!parsed.ok) throw new Error(typeof parsed.error === "string" ? parsed.error : "Memory worker failed");

    if (command === "search") {
      if (!Array.isArray(parsed.results) || parsed.results.length > 20) throw new Error("Memory worker returned invalid search results");
      for (const row of parsed.results) {
        if (!row || !["pi", "opencode", "claude", "wiki"].includes(row.source) || !["user", "assistant", "page"].includes(row.role) ||
            !["result_id", "session_id", "entry_id", "project", "excerpt"].every(key => typeof row[key] === "string") ||
            row.result_id.length > 64 || row.session_id.length > 200 || row.entry_id.length > 200 || row.project.length > 4096 ||
            row.excerpt.length > 480 || Object.hasOwn(row, "text") || !Number.isFinite(row.score) ||
            !Number.isSafeInteger(row.snippet_start) || !Number.isSafeInteger(row.snippet_end) || row.snippet_start < 0 ||
            row.snippet_end < row.snippet_start || row.snippet_end - row.snippet_start !== row.excerpt.length ||
            !Number.isSafeInteger(row.text_length) || row.text_length > 100_000 || row.snippet_end > row.text_length ||
            !validProvenance(row.provenance) || row.provenance.source !== row.source || row.provenance.sessionId !== row.session_id ||
            row.provenance.project !== row.project || row.provenance.entryId !== row.entry_id || row.provenance.resultId !== row.result_id) {
          throw new Error("Memory worker returned an invalid or oversized search result");
        }
      }
      if (!parsed.retrieval || !["lexical", "hybrid", "semantic"].includes(parsed.retrieval.mode) ||
          !["ok", "fallback"].includes(parsed.retrieval.status) || !Number.isFinite(parsed.retrieval.elapsedMs) ||
          parsed.retrieval.warning !== undefined && (typeof parsed.retrieval.warning !== "string" || parsed.retrieval.warning.length > 1000)) {
        throw new Error("Memory worker returned invalid retrieval diagnostics");
      }
      if (parsed.archive !== undefined && (!parsed.archive || typeof parsed.archive !== "object" ||
          (parsed.archive.latest !== null && typeof parsed.archive.latest !== "string"))) {
        throw new Error("Memory worker returned invalid archive metadata");
      }
    } else if (command === "expand") {
      const result = parsed.result;
      if (!result || !["pi", "opencode", "claude", "wiki"].includes(result.source) || typeof result.text !== "string" || result.text.length > 8000 ||
          typeof result.sessionId !== "string" || result.sessionId.length > 200 || typeof result.entryId !== "string" || result.entryId.length > 200 ||
          typeof result.project !== "string" || result.project.length > 4096 || !result.branch || typeof result.branch !== "object" ||
          !validProvenance(result.provenance) || result.provenance.source !== result.source || result.provenance.sessionId !== result.sessionId ||
          result.provenance.project !== result.project || result.provenance.entryId !== result.entryId || result.provenance.resultId !== result.id ||
          !Number.isSafeInteger(result.offset) || result.offset < 0 || result.nextOffset !== null && !Number.isSafeInteger(result.nextOffset) ||
          typeof result.truncated !== "boolean" || typeof result.repliesTruncated !== "boolean" ||
          result.nextResultId !== null && (typeof result.nextResultId !== "string" || result.nextResultId.length > 64) ||
          !Array.isArray(result.branchChoices) || result.branchChoices.length > 16 ||
          !Number.isSafeInteger(result.branchChoiceCount) || result.branchChoiceCount < result.branchChoices.length) {
        throw new Error("Memory worker returned an invalid or oversized expansion");
      }
      for (const choice of result.branchChoices) {
        if (!choice || typeof choice.entryId !== "string" || choice.entryId.length > 200 || typeof choice.indexable !== "boolean" ||
            choice.role !== null && !["user", "assistant"].includes(choice.role)) throw new Error("Memory worker returned invalid branch choices");
      }
    } else if (command === "status") {
      if (!parsed.status || typeof parsed.status !== "object") throw new Error("Memory worker returned invalid status");
    } else if (command === "vector-refresh") {
      if (!parsed.refresh || typeof parsed.refresh !== "object" || typeof parsed.refresh.refreshed !== "boolean") throw new Error("Memory worker returned an invalid vector refresh result");
    }
    return parsed as T;
  } catch (error: any) {
    if (error?.name === "AbortError" || signal?.aborted) throw new Error("Memory request cancelled");
    if (error?.code === "ETIMEDOUT") throw new Error("Memory worker timed out");
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Memory worker output exceeded its limit");
    if (error instanceof Error && ["Memory worker returned malformed JSON", "Memory worker failed"].includes(error.message)) throw error;
    if (error?.stdout) {
      try {
        const parsed = JSON.parse(String(error.stdout));
        if (parsed?.error) throw new Error(parsed.error);
      } catch (parseError: any) {
        if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") throw parseError;
      }
    }
    if (error?.stderr) throw new Error(String(error.stderr).slice(0, 1000));
    throw error;
  }
}
