import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import registerMemory from "../extensions/memory.ts";
import { expand, openStore, replaceSession, search, stableId, type Db, type Entry } from "../src/memory/store.ts";

let directory: string;
let database: Db;
let filename: string;

function entry(id: string, text: string, parent: string | null = null): Entry {
  return { entry_id: id, parent_id: parent, role: "user", kind: "message", timestamp: null, text, indexable: true };
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "memory-integration-"));
  filename = path.join(directory, "archive.sqlite");
  database = openStore(filename);
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("memory integration regressions", () => {
  it("creates private database, WAL and shared-memory files before storing content", () => {
    replaceSession(database, "pi", "session", "/project", [entry("u", "synthetic private content")]);
    for (const suffix of ["", "-wal", "-shm"]) {
      assert.equal(statSync(filename + suffix).mode & 0o077, 0);
    }
  });

  it("keeps the selected memory when an older ancestor exhausts the budget", () => {
    replaceSession(database, "pi", "session", "/project", [
      entry("old", "long old context ".repeat(1000)),
      entry("target", "selected memory must survive", "old"),
      entry("sibling", "unrelated sibling must not appear", "old"),
    ]);
    const result = expand(database, stableId("pi", "session", "target"), { project: "/project", maxChars: 300 });
    assert.ok(result);
    assert.match(result.text, /selected memory must survive/);
    assert.doesNotMatch(result.text, /unrelated sibling/);
    assert.ok(result.text.length <= 300);
  });

  it("scores cues beyond the first 32 words and deduplicates reordered cue terms", () => {
    const filler = Array.from({ length: 80 }, (_, i) => `filler${i}`).join(" ");
    replaceSession(database, "pi", "session", "/project", [entry("late", `${filler} alpha beta gamma`)]);
    const single = search(database, { query: "gamma", cues: ["alpha beta"], project: "/project" });
    const repeated = search(database, { query: "gamma", cues: ["alpha beta", "beta alpha"], project: "/project" });
    assert.equal(single[0].score, 11);
    assert.equal(repeated[0].score, single[0].score);
    assert.equal(Object.hasOwn(single[0], "text"), false);
  });

  it("expands a bounded chronological OpenCode window rather than reply ancestry", () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`message-${i}`, `synthetic passage ${i}`));
    replaceSession(database, "opencode", "session", "/project", entries);
    const result = expand(database, stableId("opencode", "session", "message-80"), { project: "/project", maxChars: 8000 });
    assert.ok(result);
    assert.equal(result.branch.ancestry, "chronological within-session window");
    assert.match(result.text, /synthetic passage 80/);
    assert.doesNotMatch(result.text, /synthetic passage (56|81|99)\b/);
  });

  it("executes registered Pi tools through the real worker without a model call", async () => {
    replaceSession(database, "pi", "previous-session", "/project", [entry("u", "synthetic alpha beta decision")], { origin: "integration-spoke" });
    const previousIndex = process.env.PI_MEMORY_INDEX;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_MEMORY_INDEX = filename;
    // Hermetic: the temp agent dir has no memory/hub.json, so the extension
    // exercises the local worker even on hosts with a hub configured.
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      const tools = new Map<string, any>();
      registerMemory({ registerTool: (tool: any) => tools.set(tool.name, tool), on: () => () => {} } as any);
      assert.deepEqual([...tools.keys()], ["memory_search", "memory_expand"]);
      const context = { cwd: "/project", sessionManager: { getSessionId: () => "current-session" } };
      const controller = new AbortController();
      const found = await tools.get("memory_search").execute("call-search", { query: "alpha", cues: ["beta"] }, controller.signal, undefined, context);
      assert.equal(found.details.results.length, 1);
      assert.equal(found.details.results[0].origin, "integration-spoke");
      assert.match(found.content[0].text, /origin integration-spoke/);
      assert.equal(found.details.origin, "durable-memory");
      assert.equal(found.details.indexable, false);
      const expanded = await tools.get("memory_expand").execute("call-expand", { id: found.details.results[0].id }, controller.signal, undefined, context);
      assert.match(expanded.content[0].text, /synthetic alpha beta decision/);
      assert.match(expanded.content[0].text, /origin integration-spoke/);
      assert.equal(expanded.details.provenance.origin, "integration-spoke");
      const otherContext = { ...context, cwd: "/other-project" };
      await assert.rejects(tools.get("memory_expand").execute("out-of-scope", { id: found.details.results[0].id }, controller.signal, undefined, otherContext), /outside selected/);
    } finally {
      if (previousIndex === undefined) delete process.env.PI_MEMORY_INDEX;
      else process.env.PI_MEMORY_INDEX = previousIndex;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
