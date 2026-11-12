import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { chunkMessages, digestClaude, digestGrok, digestPi, extractJsonArray, extractionPrompt, runWorker, validateExtractions } from "../src/dream/worker.ts";
import { parsePage } from "../src/wiki/format.ts";
import { DatabaseSync } from "node:sqlite";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function tempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dream-worker-"));
  dirs.push(directory);
  return directory;
}

function piLine(id: string, role: string, text: string, extra: any = {}) {
  return JSON.stringify({ type: "message", id, ...extra, message: { role, content: [{ type: "text", text }] } });
}

describe("dream worker harness", () => {
  it("digests pi JSONL and claude exports into role-tagged messages", async () => {
    const directory = await tempDir();
    const pi = path.join(directory, "s.jsonl");
    await fs.writeFile(pi, [
      JSON.stringify({ type: "session", version: 3, id: "s" }),
      piLine("m1", "user", "hello there"),
      piLine("m2", "assistant", "general kenobi"),
      piLine("m3", "assistant", "hidden", { customType: "x" }),
      JSON.stringify({ type: "custom", id: "c1" }),
      piLine("m4", "user", "trailing incomplete") .slice(0, 20),
    ].join("\n"));
    const messages = digestPi(pi);
    assert.deepEqual(messages.map(m => [m.id, m.role, m.text]), [["m1", "user", "hello there"], ["m2", "assistant", "general kenobi"]]);

    const claude = path.join(directory, "c.json");
    await fs.writeFile(claude, JSON.stringify({ uuid: "c", chat_messages: [
      { uuid: "u1", sender: "human", content: [{ type: "text", text: "q" }] },
      { uuid: "u2", sender: "assistant", content: [{ type: "text", text: "a" }] },
      { uuid: "u3", sender: "system", content: [{ type: "text", text: "skip" }] },
    ] }));
    assert.deepEqual(digestClaude(claude).map(m => m.id), ["u1", "u2"]);
  });

  it("digests only the requested Grok conversation in child-chain order", async () => {
    const directory = await tempDir();
    const file = path.join(directory, "prod-grok-backend.json");
    const timestamp = { $date: { $numberLong: "1760000000000" } };
    const response = (id: string, sender: string, message: string, parent: string | null, children: string[] = []) => ({
      _id: id, sender, message, parent_response_id: parent, children, create_time: timestamp,
    });
    await fs.writeFile(file, JSON.stringify({ conversations: [
      { conversation: { id: "other" }, responses: [{ response: response("other-id", "human", "wrong chat", null) }] },
      { conversation: { id: "wanted" }, responses: [
        { response: response("answer", "grok-model", "the answer", "question") },
        { response: response("empty", "human", "  ", "answer") },
        { response: response("question", "human", "the question", null, ["answer", "empty"]) },
        { response: response("unknown-role", "", "must be skipped", "empty") },
      ] },
    ] }));

    const messages = digestGrok(`${file}#wanted`, "wanted");
    assert.deepEqual(messages, [
      { id: "question", role: "user", text: "the question", timestamp: "2025-10-09T08:53:20.000Z" },
      { id: "answer", role: "assistant", text: "the answer", timestamp: "2025-10-09T08:53:20.000Z" },
    ]);

    let prompt = "";
    const result = await runWorker({ file: `${file}#wanted`, source: "grok", session: "wanted", project: "grok", model: "fake" }, async (_model, value) => {
      prompt = value;
      return "[]";
    });
    assert.equal(result.chunks, 1);
    assert.match(prompt, /\[e:question\]/);
    assert.match(prompt, /\[e:answer\]/);
    assert.match(prompt, /2025-10-09T08:53:20\.000Z/);
    assert.doesNotMatch(prompt, /wrong chat|unknown-role/);
    assert.throws(() => digestGrok(file, "missing"), /Grok conversation not found: missing/);

    const malformed = path.join(directory, "malformed.json");
    await fs.writeFile(malformed, "not json");
    assert.throws(() => digestGrok(malformed, "wanted"), /Malformed Grok export JSON/);
  });

  it("chunks at message boundaries and hard-truncates oversized messages", () => {
    const big = "x".repeat(20_000);
    const messages = [
      { id: "a", role: "user", text: "a".repeat(11_900) },
      { id: "b", role: "assistant", text: "b".repeat(500) },
      { id: "c", role: "user", text: big },
    ];
    const chunks = chunkMessages(messages);
    assert.equal(chunks.length, 3);
    assert.ok(chunks[0].ids.has("a") && !chunks[0].ids.has("b"), "b spills past the 12k boundary");
    assert.ok(chunks[1].ids.has("b"));
    assert.ok(chunks[2].ids.has("c"));
    assert.equal(chunks[2].truncated, true);
    assert.match(chunks[2].transcript, /hard-truncated/);
  });

  it("salvages JSON arrays from prose and fences, and rejects non-arrays", () => {
    assert.deepEqual(extractJsonArray('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(extractJsonArray('Sure! Here you go:\n```json\n[{"a":1}]\n```\nDone.'), [{ a: 1 }]);
    assert.throws(() => extractJsonArray("no array here"), /no JSON array/);
  });

  it("validates kinds, counts, lengths, and verbatim entry IDs", () => {
    const ids = new Set(["e1", "e2"]);
    const ok = validateExtractions([{ title: "t", kind: "fact", tags: ["x"], entry_ids: ["e1"], body: "b" }], ids);
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.items.length, 1);
    const bad = validateExtractions([
      { title: "good", kind: "fact", tags: [], entry_ids: ["e1"], body: "b" },
      { title: "invented", kind: "fact", tags: [], entry_ids: ["extract-001"], body: "b" },
      { title: "badkind", kind: "idea", tags: [], entry_ids: ["e2"], body: "b" },
    ], ids);
    assert.equal(bad.items.length, 1);
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors[0], /not present in this chunk/);
  });

  it("prompt steers the extractor away from expiring observations", () => {
    const prompt = extractionPrompt(
      { source: "pi", session: "s1", project: "/p" },
      { transcript: "[e:m1] user: hi", ids: new Set(["m1"]), truncated: false },
      0,
      1,
    );
    assert.match(prompt, /Do NOT extract expiring observations/);
    assert.match(prompt, /absence-of-feature/);
    assert.match(prompt, /verification results/);
    assert.match(prompt, /three months/, "states the durability test");
    assert.match(prompt, /Output \[\] when nothing qualifies/);
  });

  it("runs the state machine end to end with retries, dedupe, and staging", async () => {
    const directory = await tempDir();
    const pi = path.join(directory, "s.jsonl");
    const lines = [JSON.stringify({ type: "session", version: 3, id: "s" })];
    for (let i = 0; i < 8; i++) lines.push(piLine(`m${i}`, i % 2 ? "assistant" : "user", `message ${i} ` + "content ".repeat(400)));
    await fs.writeFile(pi, lines.join("\n") + "\n");
    const wikiDir = path.join(directory, "wiki");

    let calls = 0;
    const stagedIdsByCall: string[][] = [];
    const generate = async (_model: string, prompt: string) => {
      calls++;
      if (calls === 1) return "I refuse to output JSON";
      const ids = [...prompt.matchAll(/\[e:(m\d)\]/g)].map(m => m[1]);
      stagedIdsByCall.push(ids);
      return `Here is the JSON:\n\`\`\`json\n[{"title":"Checkpoint tuning process","kind":"process","tags":["wal"],"entry_ids":["${ids[0]}"],"body":"How checkpoints were tuned."},{"title":"invented id item","kind":"fact","tags":[],"entry_ids":["nope"],"body":"reject me"}]\n\`\`\``;
    };
    const result = await runWorker({ file: pi, source: "pi", session: "s1", project: "/p", model: "fake", wikiDir }, generate);
    assert.ok(calls >= 3, "first call retried after unparseable response");
    assert.ok(result.staged >= 1);
    assert.equal(result.titles.filter(t => t === "Checkpoint tuning process").length, 1, "duplicate titles deduped");
    assert.ok(result.chunkFailures.some(f => f.includes("rejected")), "invalid items reported as chunk warnings");

    const staged = await fs.readdir(path.join(wikiDir, "staging"));
    assert.equal(staged.length, result.staged);
    const page = parsePage(await fs.readFile(path.join(wikiDir, "staging", staged[0]), "utf8"));
    assert.deepEqual(page.meta.sources, ["pi:s1:m0"]);
    assert.ok(page.meta.tags.includes("process"));
  });

  it("pins the pi spawn args: print mode, no session/skills/extensions/tools, and no --no-mcp", () => {
    const args = piSpawnArgs("gladiator/nemotron-3-super", "the prompt");
    for (const flag of ["--print", "--no-session", "--no-skills", "--no-extensions", "--no-tools"]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.equal(args[args.indexOf("--model") + 1], "gladiator/nemotron-3-super");
    assert.equal(args[args.length - 1], "the prompt");
    assert.ok(!args.includes("--no-mcp"), "the pi CLI rejects --no-mcp as an unknown option");
  });

  it("threads origin into the extraction prompt only when provided", async () => {
    const directory = await tempDir();
    const pi = path.join(directory, "s.jsonl");
    await fs.writeFile(pi, [JSON.stringify({ type: "session", version: 3, id: "s" }), piLine("m1", "user", "hello there")].join("\n") + "\n");
    const wikiDir = path.join(directory, "wiki");
    const prompts: string[] = [];
    const generate = async (_model: string, prompt: string) => { prompts.push(prompt); return "[]"; };
    await runWorker({ file: pi, source: "pi", session: "s1", project: "/p", origin: "workbox", model: "fake", wikiDir }, generate);
    assert.match(prompts[0], /Session: pi s1 \(\/p\), origin workbox, chunk 1\/1\./);
    await runWorker({ file: pi, source: "pi", session: "s1", project: "/p", model: "fake", wikiDir }, generate);
    assert.match(prompts[1], /Session: pi s1 \(\/p\), chunk 1\/1\./);
  });
});


it("digestOpenCode assembles eligible text from the SQLite store", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-oc-"));
  dirs.push(dir);
  const dbFile = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, revert TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
  db.prepare("INSERT INTO session VALUES ('ses_1', NULL)").run();
  const msg = (id, role, extra) =>
    db.prepare("INSERT INTO message VALUES (?, 'ses_1', ?, '2026-01-01T00:00:00Z')").run(id, JSON.stringify({ role, ...(extra ?? {}) }));
  msg("msg_a", "user");
  msg("msg_b", "assistant");
  msg("msg_c", "tool");
  msg("msg_d", "user", { summary: true });
  const part = (id, mid, type, text, flags) =>
    db.prepare("INSERT INTO part VALUES (?, ?, 'ses_1', ?)").run(id, mid, JSON.stringify({ type, text, ...(flags ?? {}) }));
  part("p1", "msg_a", "text", "hello");
  part("p2", "msg_a", "text", "world");
  part("p3", "msg_b", "text", "answer");
  part("p4", "msg_b", "text", "secret", { synthetic: true });
  part("p5", "msg_b", "tool-call", null);
  db.close();
  const { digestOpenCode } = await import("../src/dream/worker.ts");
  const out = digestOpenCode(dbFile, "ses_1");
  assert.deepEqual(out, [
    { id: "msg_a", role: "user", text: "hello\nworld" },
    { id: "msg_b", role: "assistant", text: "answer" },
  ]);
});
