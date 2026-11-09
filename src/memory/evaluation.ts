import { lstatSync, readFileSync } from "node:fs";

export type EvaluationCase = {
  name: string;
  query: string;
  cues?: string[];
  expectedResultIds: string[];
  project?: string;
  source?: "pi" | "opencode";
  session?: string;
  scope?: "project" | "all";
};

export type EvaluationMode = "lexical" | "semantic" | "hybrid";
export type EvaluationObservation = { resultIds: string[]; elapsedMs: number; status: string };

export function readEvaluationCases(filename: string): EvaluationCase[] {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0) {
    throw new Error("Evaluation fixture must be a private regular file no larger than 128 KiB");
  }
  let data: any;
  try { data = JSON.parse(readFileSync(filename, "utf8")); }
  catch { throw new Error("Evaluation fixture is not valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["version", "cases"].includes(key)) || data.version !== 1 || !Array.isArray(data.cases) || data.cases.length < 1 || data.cases.length > 100) {
    throw new Error("Evaluation fixture must have version 1 and 1 to 100 cases, with no unknown fields");
  }
  const names = new Set<string>();
  for (const item of data.cases) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["name", "query", "cues", "expectedResultIds", "project", "source", "session", "scope"].includes(key)) || typeof item.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name) || names.has(item.name)) throw new Error("Evaluation cases must use known fields and unique lowercase names");
    names.add(item.name);
    if (typeof item.query !== "string" || item.query.length < 1 || item.query.length > 1000) throw new Error(`Invalid query in evaluation case ${item.name}`);
    if (item.cues !== undefined && (!Array.isArray(item.cues) || item.cues.length > 8 || item.cues.some((cue: unknown) => typeof cue !== "string" || cue.length > 120))) throw new Error(`Invalid cues in evaluation case ${item.name}`);
    if (!Array.isArray(item.expectedResultIds) || item.expectedResultIds.length > 20 || item.expectedResultIds.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) throw new Error(`Invalid expected result IDs in evaluation case ${item.name}`);
    if (item.project !== undefined && (typeof item.project !== "string" || item.project.length > 4096)) throw new Error(`Invalid project in evaluation case ${item.name}`);
    if (item.source !== undefined && !["pi", "opencode"].includes(item.source)) throw new Error(`Invalid source in evaluation case ${item.name}`);
    if (item.session !== undefined && (typeof item.session !== "string" || item.session.length < 1 || item.session.length > 200)) throw new Error(`Invalid session in evaluation case ${item.name}`);
    if (item.scope !== undefined && !["project", "all"].includes(item.scope)) throw new Error(`Invalid scope in evaluation case ${item.name}`);
    if ((item.scope ?? (item.project ? "project" : "all")) === "project" && !item.project) throw new Error(`Project-scoped evaluation case ${item.name} requires a project`);
  }
  return data.cases as EvaluationCase[];
}

export async function evaluateCases(
  cases: EvaluationCase[],
  search: (test: EvaluationCase, mode: EvaluationMode) => Promise<EvaluationObservation>,
  modes: EvaluationMode[] = ["lexical", "semantic", "hybrid"],
  topK = 5,
) {
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new Error("topK must be an integer from 1 to 20");
  const reports = await Promise.all(modes.map(async mode => {
    let positiveCases = 0;
    let reciprocalRankTotal = 0;
    let hitsAtK = 0;
    let negativeCases = 0;
    let negativeFalsePositives = 0;
    let fallbackCases = 0;
    let errors = 0;
    const latencies: number[] = [];
    const details: Array<{ case: string; expected: boolean; hitRank: number | null; falsePositive: boolean; status: string; elapsedMs: number | null }> = [];
    for (const test of cases) {
      const positive = test.expectedResultIds.length > 0;
      if (positive) positiveCases++; else negativeCases++;
      try {
        const result = await search(test, mode);
        if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 || !Array.isArray(result.resultIds) || typeof result.status !== "string") throw new Error("Invalid search observation");
        latencies.push(result.elapsedMs);
        if (result.status === "fallback") fallbackCases++;
        if (!positive) {
          const falsePositive = result.resultIds.length > 0;
          if (falsePositive) negativeFalsePositives++;
          details.push({ case: test.name, expected: false, hitRank: null, falsePositive, status: result.status, elapsedMs: result.elapsedMs });
          continue;
        }
        const expected = new Set(test.expectedResultIds);
        const rank = result.resultIds.findIndex(id => expected.has(id));
        if (rank >= 0) {
          hitsAtK++;
          reciprocalRankTotal += 1 / (rank + 1);
        }
        details.push({ case: test.name, expected: true, hitRank: rank >= 0 ? rank + 1 : null, falsePositive: false, status: result.status, elapsedMs: result.elapsedMs });
      } catch {
        errors++;
        details.push({ case: test.name, expected: positive, hitRank: null, falsePositive: false, status: "error", elapsedMs: null });
      }
    }
    const sortedLatencies = latencies.sort((a, b) => a - b);
    const medianLatencyMs = sortedLatencies.length === 0 ? null : sortedLatencies.length % 2
      ? sortedLatencies[(sortedLatencies.length - 1) / 2]
      : (sortedLatencies[sortedLatencies.length / 2 - 1] + sortedLatencies[sortedLatencies.length / 2]) / 2;
    return {
      mode,
      cases: cases.length,
      details,
      positiveCases,
      hitRateAtK: positiveCases ? hitsAtK / positiveCases : null,
      meanReciprocalRank: positiveCases ? reciprocalRankTotal / positiveCases : null,
      negativeCases,
      negativeFalsePositiveRate: negativeCases ? negativeFalsePositives / negativeCases : null,
      fallbackCases,
      errors,
      medianLatencyMs,
    };
  }));
  return { ok: true, cases: cases.length, topK, metrics: reports };
}
