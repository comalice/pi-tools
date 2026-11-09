import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ingestWiki } from "../src/memory/ingest.ts";
import { expand, listSessions, openStore, replaceSession, search, stableId } from "../src/memory/store.ts";
import { parsePage, serializePage, slugify, indexableText } from "../src/wiki/format.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(directory);
  return directory;
}

const meta = { title: "SQLite WAL gotchas", slug: "sqlite-wal-gotchas", created: "2026-11-01", last_verified: "2026-11-05", tags: ["sqlite", "ops"], sources: ["pi:sess1:entry9", "doc:0017"] };

describe("wiki page format", () => {
  it("round-trips a page through serialize and parse", () => {
    const body = "## Summary\n\nWAL mode blocks readers only on checkpoint.\n\n## Sources\n\n- pi:sess1:entry9: the checkpoint discussion\n";
    const parsed = parsePage(serializePage(meta, body));
    assert.deepEqual(parsed.meta, meta);
    assert.equal(parsed.body, body);
    assert.match(indexableText(parsed), /# SQLite WAL gotchas/);
    assert.match(indexableText(parsed), /tags: sqlite, ops/);
  });

  it("rejects unknown fields, bad slugs, bad dates, and malformed sources", () => {
    const good = serializePage(meta, "body text");
    assert.throws(() => parsePage(good.replace("title:", "status:"), "p"), /unknown frontmatter field "status"/);
    assert.throws(() => parsePage(good.replace("slug: sqlite-wal-gotchas", "slug: Bad Slug"), "p"), /must match/);
    assert.throws(() => parsePage(good.replace("created: 2026-11-01", "created: yesterday"), "p"), /created must be a YYYY-MM-DD date/);
    assert.throws(() => parsePage(good.replace("- pi:sess1:entry9", "- sess1"), "p"), /sources must look like/);
    assert.throws(() => parsePage(good.replace("title: SQLite WAL gotchas\n", ""), "p"), /missing required frontmatter field "title"/);
    assert.throws(() => parsePage("no frontmatter", "p"), /missing opening frontmatter delimiter/);
  });

  it("derives slugs from titles and rejects unslugifiable titles", () => {
    assert.equal(slugify("SQLite WAL: Gotchas!"), "sqlite-wal-gotchas");
    assert.throws(() => slugify("!!!"), /Cannot derive a valid slug/);
  });
});

describe("wiki archive source", () => {
  async function wikiFixture() {
    const directory = await tempDir("memory-wiki-");
    const wiki = path.join(directory, "wiki");
    await fs.mkdir(path.join(wiki, "pages"), { recursive: true });
    await fs.mkdir(path.join(wiki, "staging"), { recursive: true });
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    return { directory, wiki, index, db };
  }

  it("indexes pages, exempts them from project scope, expands them, and reports malformed pages", async () => {
    const { wiki, db } = await wikiFixture();
    replaceSession(db, "pi", "conv1", "/project-a", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: "2026-11-03T10:00:00Z", text: "unrelated conversation about checkpointing", indexable: true },
    ]);
    await fs.writeFile(path.join(wiki, "pages", "sqlite-wal-gotchas.md"), serializePage(meta, "## Summary\n\nWAL checkpoint tuning for busy writers.\n\n## Sources\n\n- pi:sess1:entry9: checkpoint discussion\n"));
    await fs.writeFile(path.join(wiki, "pages", "broken.md"), "no frontmatter here");

    const first = ingestWiki(db, wiki);
    assert.equal(first.indexed, 1);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /broken\.md/);
    const second = ingestWiki(db, wiki);
    assert.equal(second.unchanged, 1);
    assert.equal(second.indexed, 0);

    // Project-scoped search from an unrelated project still finds the wiki page.
    const results = search(db, { query: "checkpoint tuning", project: "/project-b" });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, "wiki");
    assert.equal(results[0].session_id, "sqlite-wal-gotchas");
    assert.equal(results[0].role, "page");
    assert.equal(results[0].project, "wiki");

    // Conversation content still respects project scope.
    const conv = search(db, { query: "checkpointing", project: "/project-b" });
    assert.equal(conv.some(row => row.source === "pi"), false);

    const pageId = stableId("wiki", "sqlite-wal-gotchas", "page");
    const expanded = expand(db, pageId, { project: "/project-b", maxChars: 2000 });
    assert.ok(expanded);
    assert.match(expanded.text, /\[curated wiki page; wiki; page;/);
    assert.match(expanded.text, /WAL checkpoint tuning/);
    // Wiki pages are exempt from project scope in expand as well.
    assert.ok(expand(db, pageId, {}));

    // Removing the file removes the page on the next reconciliation.
    await fs.rm(path.join(wiki, "pages", "sqlite-wal-gotchas.md"));
    const third = ingestWiki(db, wiki);
    assert.equal(third.removed, 1);
    assert.equal(search(db, { query: "checkpoint tuning", project: "/project-b" }).length, 0);
    db.close();
  });

  it("reports a missing wiki root without failing", async () => {
    const directory = await tempDir("memory-wiki-missing-");
    const db = openStore(path.join(directory, "archive.sqlite"));
    const result = ingestWiki(db, path.join(directory, "no-such-wiki"));
    assert.equal(result.missing, true);
    db.close();
  });

  it("lists recent conversation sessions for the dream sweep and excludes wiki pages", async () => {
    const { wiki, db } = await wikiFixture();
    replaceSession(db, "pi", "recent", "/project", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: new Date().toISOString(), text: "fresh conversation", indexable: true },
    ]);
    replaceSession(db, "pi", "ancient", "/project", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: "2020-01-01T00:00:00Z", text: "old conversation", indexable: true },
    ]);
    await fs.writeFile(path.join(wiki, "pages", "sqlite-wal-gotchas.md"), serializePage(meta, "body"));
    ingestWiki(db, wiki);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sessions = listSessions(db, since);
    assert.deepEqual(sessions.map(row => row.session_id), ["recent"]);
    assert.equal(sessions[0].source, "pi");
    const everything = listSessions(db, "1970-01-01T00:00:00Z");
    assert.equal(everything.some(row => row.source === "wiki"), false);
    assert.equal(everything.some(row => row.session_id === "ancient"), true);
    db.close();
  });
});
