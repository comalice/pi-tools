import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSurvey } from "../src/wiki/survey.ts";
import { serializePage } from "../src/wiki/format.ts";
import { openStore, replaceSession } from "../src/memory/store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("librarian survey", () => {
  it("verifies citations, clusters same-session and title-overlap entries, and detects page collisions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-survey-"));
    dirs.push(directory);
    const wiki = path.join(directory, "wiki");
    await fs.mkdir(path.join(wiki, "staging"), { recursive: true });
    await fs.mkdir(path.join(wiki, "pages"), { recursive: true });
    const index = path.join(directory, "archive.sqlite");
    const db = openStore(index);
    replaceSession(db, "pi", "sess-real", "/p", [
      { entry_id: "e1", parent_id: null, role: "user", kind: "message", timestamp: null, text: "wal checkpoint tuning discussion", indexable: true },
    ], { origin: "survey-spoke" });
    db.close();

    const staging = (name: string, slug: string, title: string, sources: string[]) =>
      fs.writeFile(path.join(wiki, "staging", name), serializePage(
        { title, slug, created: "2026-01-01", last_verified: "2026-01-01", tags: ["wal"], sources }, "body"));
    // Same-session pair (should cluster) with one good and one broken citation:
    await staging("a.md", "wal-checkpoint-tuning", "WAL checkpoint tuning", ["pi:sess-real:e1"]);
    await staging("b.md", "wal-checkpoint-gotchas", "WAL checkpoint gotchas", ["pi:sess-real:missing-entry"]);
    // Title-overlap pair from different sessions (should cluster):
    await staging("c.md", "spi-voltage-limits", "SPI voltage limits", ["claude:other-session:e9"]);
    await staging("d.md", "spi-voltage-frequency", "SPI voltage frequency", ["web:https://example.com"]);
    // Collision candidate (no citations, so the collision surfaces):
    await staging("e.md", "spi-voltage-limits-copy", "SPI voltage limits", []);
    await fs.writeFile(path.join(wiki, "pages", "spi-voltage-limits.md"), serializePage(
      { title: "SPI voltage limits", slug: "spi-voltage-limits", created: "2026-01-01", last_verified: "2026-01-01", tags: [], sources: [] }, "existing"));
    // Unparseable entry:
    await fs.writeFile(path.join(wiki, "staging", "broken.md"), "no frontmatter");

    const survey = runSurvey(wiki, index);
    const bySlug = Object.fromEntries(survey.entries.map(e => [e.slug, e]));

    assert.equal(bySlug["wal-checkpoint-tuning"].citations[0].status, "ok");
    assert.equal(bySlug["wal-checkpoint-tuning"].citations[0].origin, "survey-spoke");
    assert.equal(bySlug["wal-checkpoint-tuning"].citations[0].project, "/p");
    assert.equal(bySlug["wal-checkpoint-gotchas"].citations[0].status, "broken");
    assert.match(bySlug["wal-checkpoint-gotchas"].suggestion, /discard candidate/);
    assert.equal(bySlug["spi-voltage-frequency"].citations[0].status, "unchecked");
    assert.match(bySlug["broken"].suggestion, /unparseable/);
    // Broken citations take priority over a page collision:
    assert.match(bySlug["spi-voltage-limits"].suggestion, /discard candidate/);

    const walCluster = bySlug["wal-checkpoint-tuning"].cluster;
    assert.equal(bySlug["wal-checkpoint-gotchas"].cluster, walCluster, "same session clusters");
    const spiCluster = bySlug["spi-voltage-limits"].cluster;
    assert.equal(bySlug["spi-voltage-frequency"].cluster, spiCluster, "title overlap clusters");
    assert.notEqual(walCluster, spiCluster);

    assert.deepEqual(survey.existingPages, ["spi-voltage-limits"]);
    const collision = survey.entries.find(e => e.file.endsWith("/e.md"))!;
    assert.match(collision.suggestion, /update existing page "spi-voltage-limits"/);
    assert.equal(survey.summary.total, 6);
    assert.equal(survey.summary.parseErrors, 1);
    assert.equal(survey.summary.brokenCitationEntries, 2);
    assert.equal(survey.summary.mergeClusters, 2);
    assert.equal(survey.summary.updateCandidates, 1);
  });
});
