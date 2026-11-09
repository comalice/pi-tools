import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateCases, readEvaluationCases, type EvaluationCase } from "../src/memory/evaluation.ts";

let directory: string | undefined;
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); directory = undefined; });

describe("memory retrieval evaluation", () => {
  it("reports aggregate ranking and negative-query metrics without case data", async () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const cases: EvaluationCase[] = [
      { name: "first", query: "private query one", expectedResultIds: [first] },
      { name: "second", query: "private query two", expectedResultIds: [second] },
      { name: "negative", query: "private absent query", expectedResultIds: [] },
    ];
    const report = await evaluateCases(cases, async (test) => ({
      resultIds: test.name === "first" ? ["c".repeat(32), first] : test.name === "negative" ? [] : [],
      elapsedMs: test.name === "first" ? 10 : test.name === "second" ? 20 : 30,
      status: "ok",
    }), ["lexical"]);
    assert.deepEqual(report.metrics[0].details, [
      { case: "first", expected: true, hitRank: 2, falsePositive: false, status: "ok", elapsedMs: 10 },
      { case: "second", expected: true, hitRank: null, falsePositive: false, status: "ok", elapsedMs: 20 },
      { case: "negative", expected: false, hitRank: null, falsePositive: false, status: "ok", elapsedMs: 30 },
    ]);
    assert.deepEqual({ ...report.metrics[0], details: undefined }, {
      mode: "lexical",
      cases: 3,
      details: undefined,
      positiveCases: 2,
      hitRateAtK: 0.5,
      meanReciprocalRank: 0.25,
      negativeCases: 1,
      negativeFalsePositiveRate: 0,
      fallbackCases: 0,
      errors: 0,
      medianLatencyMs: 20,
    });
    const output = JSON.stringify(report);
    assert.doesNotMatch(output, /private query|private absent|a{32}|b{32}/);
  });

  it("accepts only bounded owner-private fixtures with valid IDs and scopes", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-"));
    const fixture = path.join(directory, "cases.json");
    const data = { version: 1, cases: [{ name: "one", query: "safe test query", expectedResultIds: ["d".repeat(32)], scope: "all" }] };
    await fs.writeFile(fixture, JSON.stringify(data), { mode: 0o600 });
    assert.equal(readEvaluationCases(fixture)[0].name, "one");
    await fs.chmod(fixture, 0o640);
    assert.throws(() => readEvaluationCases(fixture), /private regular file/);
    await fs.chmod(fixture, 0o600);
    await fs.writeFile(fixture, JSON.stringify({ ...data, cases: [{ ...data.cases[0], expectedResultIds: ["not-an-id"] }] }), { mode: 0o600 });
    assert.throws(() => readEvaluationCases(fixture), /expected result IDs/);
    await fs.writeFile(fixture, JSON.stringify({ ...data, cases: [{ ...data.cases[0], excerpt: "source text" }] }), { mode: 0o600 });
    assert.throws(() => readEvaluationCases(fixture), /known fields/);
    const link = path.join(directory, "link.json");
    await fs.symlink(fixture, link);
    assert.throws(() => readEvaluationCases(link), /private regular file/);
  });
});
