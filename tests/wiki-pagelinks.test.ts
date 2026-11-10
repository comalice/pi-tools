import test from "node:test";
import assert from "node:assert/strict";
import { linkPageMentions, pageLinkTargets, buildPageMatchers } from "../src/wiki/pagelinks.ts";

const PAGES = [
  { slug: "mang-b10-boot-sequence", title: "MANG_B10 boot sequence" },
  { slug: "ghidra-mcp-operations", title: "Ghidra MCP operations" },
  { slug: "kalman-filter-design-principles", title: "Kalman filter design principles" },
];

test("links a prose title mention once, first occurrence only", () => {
  const md = "See the MANG_B10 boot sequence for details. The MANG_B10 boot sequence covers VTOR.";
  const { text, added } = linkPageMentions(md, PAGES, "other-page");
  assert.equal(added, 1);
  assert.equal(text, "See the [[page:mang-b10-boot-sequence|MANG_B10 boot sequence]] for details. The MANG_B10 boot sequence covers VTOR.");
});

test("links slug mentions with spaces or hyphens", () => {
  const md = "As the ghidra mcp operations page explains.";
  const { text, added } = linkPageMentions(md, PAGES, "other-page");
  assert.equal(added, 1);
  assert.match(text, /\[\[page:ghidra-mcp-operations\|ghidra mcp operations\]\]/);
});

test("never self-links", () => {
  const md = "This page describes the MANG_B10 boot sequence itself.";
  const { added } = linkPageMentions(md, PAGES, "mang-b10-boot-sequence");
  assert.equal(added, 0);
});

test("existing wikilinks seed the linked set (idempotent)", () => {
  const md = "Intro mentions MANG_B10 boot sequence.\n\n## See also\n\n- [[page:mang-b10-boot-sequence|MANG_B10 boot sequence]]\n";
  const { text, added } = linkPageMentions(md, PAGES, "other-page");
  assert.equal(added, 0);
  assert.equal(text, md);
});

test("protected zones: frontmatter, fences, headings, citations", () => {
  const md = [
    "---",
    "title: MANG_B10 boot sequence notes",
    "---",
    "",
    "# MANG_B10 boot sequence",
    "",
    "`MANG_B10 boot sequence` in code.",
    "",
    "```",
    "MANG_B10 boot sequence in fence",
    "```",
    "",
    "Cite pi:01234567-89ab-7def-8123-456789abcdef:abcd1234 here.",
  ].join("\n");
  const { added } = linkPageMentions(md, PAGES, "other-page");
  assert.equal(added, 0);
});

test("does not link inside a longer word", () => {
  const matchers = buildPageMatchers([{ slug: "x", title: "boot-sequence-x" }]);
  void matchers;
  const md = "preMANG_B10 boot sequencepost should not link.";
  const { added } = linkPageMentions(md, PAGES, "other-page");
  assert.equal(added, 0);
});

test("pageLinkTargets extracts unique targets", () => {
  const md = "- [[page:a|A]] and [[page:b]] and [[page:a|A again]]";
  assert.deepEqual(pageLinkTargets(md), ["a", "b"]);
});

test("short titles are skipped", () => {
  const md = "A mention of VTOR here.";
  const { added } = linkPageMentions(md, [{ slug: "vtor", title: "VTOR" }], "other");
  assert.equal(added, 0);
});
