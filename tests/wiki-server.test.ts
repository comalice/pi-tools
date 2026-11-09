import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createWikiServer, renderMarkdown, sourceLink, stalenessDays } from "../src/wiki/server.ts";
import { serializePage } from "../src/wiki/format.ts";
import { ingestWiki } from "../src/memory/ingest.ts";
import { openStore, replaceSession } from "../src/memory/store.ts";

const dirs: string[] = [];
const servers: any[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function page(slug: string, title: string, verified: string, body: string, sources: string[] = ["pi:s:e"]) {
  return serializePage({ title, slug, created: "2026-01-01", last_verified: verified, tags: ["test"], sources }, body);
}

describe("wiki front-end", () => {
  it("renders markdown with wiki-link resolution and escapes raw HTML", () => {
    const html = renderMarkdown("See [[real-page]] and [[ghost-page]]. <script>alert(1)</script>", slug => (slug === "real-page" ? "/t/page/real-page" : null));
    assert.match(html, /<a href="\/t\/page\/real-page">real-page<\/a>/);
    assert.match(html, /class="redlink"/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes("<script>"), false);
    assert.equal(stalenessDays("2020-01-01", Date.parse("2020-01-11T00:00:00Z")), 10);
  });

  it("linkifies typed source identifiers", () => {
    assert.match(sourceLink("pi:sess-1:entry-2", "T"), /href="\/T\/session\/pi\/sess-1#entry-2"/);
    assert.match(sourceLink("claude:sess-9", "T"), /href="\/T\/session\/claude\/sess-9"/);
    assert.match(sourceLink("wiki:some-page", "T"), /href="\/T\/page\/some-page"/);
    assert.match(sourceLink("web:https://example.com/x", "T"), /href="https:\/\/example.com\/x"/);
    assert.match(sourceLink("doc:0017", "T"), /<code>doc:0017<\/code>/);
  });

  it("serves index, pages, staging, and search behind the persistent token", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-serve-"));
    dirs.push(directory);
    const wiki = path.join(directory, "wiki");
    await fs.mkdir(path.join(wiki, "pages"), { recursive: true });
    await fs.mkdir(path.join(wiki, "staging"), { recursive: true });
    await fs.writeFile(path.join(wiki, "pages", "old-page.md"), page("old-page", "Old page", "2020-01-01", "Content about wal checkpoints. See [[new-page]]."));
    await fs.writeFile(path.join(wiki, "pages", "new-page.md"), page("new-page", "New page", "2026-11-08", "Fresh content linking to [[old-page]] and [[missing-page]]."));
    await fs.writeFile(path.join(wiki, "staging", "2026-11-08-raw-12345678.md"), page("raw", "Raw extraction", "2026-11-08", "unvetted body"));
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    ingestWiki(db, wiki);
    replaceSession(db, "pi", "sess-abc", "/project", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: "2026-11-01T10:00:00Z", text: "how do checkpoints work", indexable: true },
      { entry_id: "e2", parent_id: "e1", role: "assistant", kind: "message", timestamp: "2026-11-01T10:01:00Z", text: "spread them with max_wal_size", indexable: true },
      { entry_id: "e3", parent_id: "e2", role: null, kind: "custom", timestamp: null, text: "", indexable: false },
    ]);
    db.close();

    const { server, token } = createWikiServer({ wikiDir: wiki, index, dreamDir: path.join(directory, "no-dream") });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

    assert.equal((await get("/")).status, 404);
    assert.equal((await get(`/wrong-token/page/new-page`)).status, 404);

    const home = await get(`/${token}/`);
    assert.equal(home.status, 200);
    assert.ok(home.text.indexOf("Old page") < home.text.indexOf("New page"), "most stale page sorts first");
    assert.match(home.text, /sorted by verification staleness/);

    const rendered = await get(`/${token}/page/new-page`);
    assert.equal(rendered.status, 200);
    assert.match(rendered.text, /href="\/[a-f0-9-]+\/page\/old-page"/);
    assert.match(rendered.text, /class="redlink"/);
    assert.equal((await get(`/${token}/page/nope`)).status, 404);

    const staging = await get(`/${token}/staging`);
    assert.equal(staging.status, 200);
    assert.match(staging.text, /Unvetted/);
    const stagedPage = await get(`/${token}/staging/2026-11-08-raw-12345678.md`);
    assert.match(stagedPage.text, /not yet verified/);

    const results = await get(`/${token}/search?q=wal+checkpoints`);
    assert.equal(results.status, 200);
    assert.match(results.text, /old-page/);
    assert.match(results.text, /1 result/);

    // The session viewer renders archived messages and the page's sources link into it.
    const sessionView = await get(`/${token}/session/pi/sess-abc`);
    assert.equal(sessionView.status, 200);
    assert.match(sessionView.text, /how do checkpoints work/);
    assert.match(sessionView.text, /spread them with max_wal_size/);
    assert.match(sessionView.text, /id="e2"/);
    assert.equal((await get(`/${token}/session/pi/nope`)).status, 404);
    const oldPage = await get(`/${token}/page/old-page`);
    assert.match(oldPage.text, /href="\/[a-f0-9-]+\/session\/pi\/s#e"/);

    // The token persisted to the wiki root and is gitignored.
    assert.match(await fs.readFile(path.join(wiki, ".admin-token"), "utf8"), new RegExp(token));
    assert.match(await fs.readFile(path.join(wiki, ".gitignore"), "utf8"), /\.admin-token/);
  });
});
