import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyUpdate, validateUpdate, type Dossier, type Fragment } from "../src/entity/dossier.ts";

const UNIVERSE = new Set(["a1", "b2", "c3", "d4"]);

function dossier(fragments: Fragment[]): Dossier {
  return {
    entity: "GA300-070-100",
    entity_type: "product",
    pages: [{ suffix: null, title: "GA300-070-100" }],
    fragments,
    retired: [],
    watermark: 10,
    next_fragment: 3,
    built_at: "2026-11-09T00:00:00Z",
    split_hint: null,
  };
}

const LIVE: Fragment[] = [
  { id: "f1", page: null, body: "Pin map is fixed.", citations: ["a1"] },
  { id: "f2", page: null, body: "Thermal runs exist.", citations: ["b2"] },
];

describe("dossier update validation", () => {
  it("accepts a complete keep disposition set", () => {
    const { errors } = validateUpdate(
      { dispositions: [{ id: "f1", action: "keep" }, { id: "f2", action: "keep" }] },
      dossier(LIVE),
      UNIVERSE,
    );
    assert.deepEqual(errors, []);
  });

  it("rejects silent loss: missing disposition for a live fragment", () => {
    const { errors } = validateUpdate(
      { dispositions: [{ id: "f1", action: "keep" }] },
      dossier(LIVE),
      UNIVERSE,
    );
    assert.ok(errors.some((e) => e.includes("f2") && e.includes("no disposition")));
  });

  it("rejects duplicate dispositions and unknown fragments", () => {
    const { errors } = validateUpdate(
      {
        dispositions: [
          { id: "f1", action: "keep" },
          { id: "f1", action: "retire", reason: "dup" },
          { id: "f9", action: "keep" },
          { id: "f2", action: "keep" },
        ],
      },
      dossier(LIVE),
      UNIVERSE,
    );
    assert.ok(errors.some((e) => e.includes("duplicate")));
    assert.ok(errors.some((e) => e.includes("unknown fragment f9")));
  });

  it("rejects citations outside the mention set", () => {
    const { errors } = validateUpdate(
      {
        dispositions: [
          { id: "f1", action: "amend", body: "new", citations: ["zz"] },
          { id: "f2", action: "keep" },
        ],
        new_fragments: [{ page: null, body: "fresh", citations: ["nope"] }],
      },
      dossier(LIVE),
      UNIVERSE,
    );
    assert.ok(errors.some((e) => e.includes("zz outside mention set")));
    assert.ok(errors.some((e) => e.includes("nope outside mention set")));
  });

  it("rejects new fragments referencing undeclared pages", () => {
    const { errors } = validateUpdate(
      {
        dispositions: [{ id: "f1", action: "keep" }, { id: "f2", action: "keep" }],
        new_fragments: [{ page: "thermal", body: "x", citations: ["a1"] }],
      },
      dossier(LIVE),
      UNIVERSE,
    );
    assert.ok(errors.some((e) => e.includes("undeclared page")));
  });
});

describe("dossier update application", () => {
  it("applies keep/amend/retire/merge and preserves history", () => {
    const state = dossier(LIVE);
    const next = applyUpdate(
      state,
      "GA300-070-100",
      "product",
      {
        dispositions: [
          { id: "f1", action: "amend", body: "Pin map is fixed; CS2 unresolved.", citations: ["a1", "c3"] },
          { id: "f2", action: "merge", into: "f1" },
        ],
        new_fragments: [{ page: null, body: "Smoke test passed.", citations: ["d4"] }],
      },
      99,
    );
    assert.equal(next.fragments.length, 2);
    const f1 = next.fragments.find((f) => f.id === "f1")!;
    assert.equal(f1.body, "Pin map is fixed; CS2 unresolved.");
    assert.deepEqual([...f1.citations].sort(), ["a1", "b2", "c3"], "merge unions citations");
    assert.equal(next.fragments[1].id, "f3");
    assert.equal(next.retired.length, 1);
    assert.equal(next.retired[0].reason, "merged into f1");
    assert.equal(next.watermark, 99);
    assert.equal(next.next_fragment, 4);
  });

  it("initial build from empty state", () => {
    const next = applyUpdate(null, "Zephyr", "software library", {
      new_fragments: [
        { page: null, body: "RTOS with devicetree.", citations: ["a1"] },
        { page: "drivers", body: "Sensor subsystem preferred.", citations: ["b2"] },
      ],
      pages: [
        { suffix: null, title: "Zephyr" },
        { suffix: "drivers", title: "Zephyr (drivers)" },
      ],
    }, 7);
    assert.equal(next.fragments.length, 2);
    assert.equal(next.pages.length, 2);
    assert.equal(next.watermark, 7);
  });
});
