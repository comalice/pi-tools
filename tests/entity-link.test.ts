import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Gazetteer } from "../src/entity/gazetteer.ts";
import { linkEntityMentions } from "../src/entity/link.ts";
import { renderMarkdown } from "../src/wiki/server.ts";

function gazetteer(): Gazetteer {
  return new Gazetteer([
    ["GA300-070-100", "ga300-070-100"],
    ["Physical Logic", "physical logic"],
    ["Physical Logic", "physical-logic"],
    ["Zephyr", "zephyr"],
    ["Git", "git"],
  ]);
}

const FRONT = "---\ntitle: T\nslug: t\ncreated: 2026-01-01\nlast_verified: 2026-01-01\ntags: x\nsources:\n- pi:s:e\n---\n\n";

describe("entity linker", () => {
  it("links the first occurrence only and preserves surface casing", () => {
    const input = FRONT + "We tested ga300-070-100 twice; GA300-070-100 held up. Zephyr and zephyr again.";
    const { text, added } = linkEntityMentions(input, gazetteer());
    assert.equal(added, 2);
    assert.ok(text.includes("[[entity:GA300-070-100|ga300-070-100]]"), "preserves lowercase surface");
    assert.ok(text.includes("GA300-070-100 held up"), "second occurrence untouched");
    assert.ok(text.includes("[[entity:Zephyr|Zephyr]]"));
  });

  it("never touches frontmatter, code, headings, or existing links", () => {
    const input =
      FRONT +
      "# Zephyr setup\n" +
      "Inline `zephyr` code, fenced:\n" +
      "```\nzephyr build\n```\n" +
      "A [[zephyr-spi-sensor-driver]] page and [Zephyr docs](https://docs.zephyrproject.org) exist.\n" +
      "Bare https://zephyr.example.com link.\n" +
      "But plain zephyr here links.";
    const { text, added } = linkEntityMentions(input, gazetteer());
    assert.equal(added, 1, "only the plain-text occurrence");
    assert.ok(text.includes("[[entity:Zephyr|zephyr]] here links"));
    assert.ok(!text.includes("# [[entity:"), "heading untouched");
    assert.ok(!text.includes("`[[entity:"), "inline code untouched");
  });

  it("is idempotent across re-runs", () => {
    const input = FRONT + "Physical Logic shipped units; physical logic again.";
    const once = linkEntityMentions(input, gazetteer());
    assert.equal(once.added, 1);
    const twice = linkEntityMentions(once.text, gazetteer());
    assert.equal(twice.added, 0);
    assert.equal(twice.text, once.text);
  });

  it("links alias surfaces to the canonical entity", () => {
    const input = FRONT + "The physical-logic vendor confirmed.";
    const { text, added } = linkEntityMentions(input, gazetteer());
    assert.equal(added, 1);
    assert.ok(text.includes("[[entity:Physical Logic|physical-logic]]"));
  });
});

describe("entity link rendering", () => {
  it("renders entity links with display text and page links unchanged", () => {
    const body = "See [[entity:GA300-070-100|ga300-070-100]] and [[esp32-s3-sensor-firmware]].";
    const html = renderMarkdown(
      body,
      (slug) => `/t/page/${slug}`,
      (name) => `/t/entities/${encodeURIComponent(name)}`,
    );
    assert.ok(html.includes('<a href="/t/entities/GA300-070-100">ga300-070-100</a>'));
    assert.ok(html.includes('<a href="/t/page/esp32-s3-sensor-firmware">esp32-s3-sensor-firmware</a>'));
  });

  it("marks unknown entities as red links", () => {
    const html = renderMarkdown("Mentions [[entity:Nobody|nobody]] here.", () => null, () => null);
    assert.ok(html.includes("unknown entity"));
  });
});
