import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Gazetteer } from "../src/entity/gazetteer.ts";
import { loadRegistry, surfaceForms } from "../src/entity/registry.ts";
import { scanEntities } from "../src/entity/scan.ts";
import { openStore } from "../src/memory/store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entity-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeGazetteer(): Gazetteer {
  return new Gazetteer([
    ["GA300-070-100", "ga300-070-100"],
    ["GA300", "ga300"],
    ["MAXL-CL-4070", "maxl-cl-4070"],
    ["MAXL-CL-4070-15", "maxl-cl-4070-15"],
    ["Physical Logic", "physical logic"],
    ["Physical Logic", "physical-logic"],
    ["Zephyr", "zephyr"],
  ]);
}

describe("Gazetteer", () => {
  it("matches case-insensitively on token boundaries", () => {
    const g = makeGazetteer();
    const hits = g.find("Testing GA300-070-100 and zephyr RTOS builds.");
    assert.deepEqual(hits.map((h) => h.entity).sort(), ["GA300-070-100", "Zephyr"]);
  });

  it("rejects matches inside longer tokens", () => {
    const g = makeGazetteer();
    // 'ga300' must not match inside the full part number; 'zephyr' must not match 'zephyrous'
    const hits = g.find("ga300-070-100 arrived; zephyrous weather today");
    assert.deepEqual(hits.map((h) => h.entity), ["GA300-070-100"]);
  });

  it("specific entity wins over family prefix (hyphen is a token char)", () => {
    const g = makeGazetteer();
    const hits = g.find("MAXL-CL-4070-15 calibrated");
    assert.deepEqual(hits.map((h) => h.entity), ["MAXL-CL-4070-15"]);
  });

  it("matches separator variants declared as aliases", () => {
    const g = makeGazetteer();
    const hits = g.find("The physical-logic units passed, and Physical Logic confirmed.");
    assert.equal(hits.filter((h) => h.entity === "Physical Logic").length, 2);
  });

  it("does not match empty or report duplicates for same surface", () => {
    const g = new Gazetteer([["Zephyr", "zephyr"]]);
    assert.deepEqual(g.find("no entities here"), []);
  });
});

describe("surfaceForms", () => {
  it("generates separator variants for multi-token names", () => {
    const forms = surfaceForms("mcp server", []);
    assert.ok(forms.includes("mcp server"));
    assert.ok(forms.includes("mcp-server"));
    assert.ok(forms.includes("mcp_server"));
  });

  it("keeps aliases and drops short forms", () => {
    const forms = surfaceForms("Qdrant", ["q", "vector db"]);
    assert.ok(forms.includes("qdrant"));
    assert.ok(!forms.includes("q"));
    assert.ok(forms.includes("vector db"));
  });
});

describe("entity registry + scan", () => {
  it("rejects invalid registry files", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, entities: { X: { type: "nonsense", aliases: [], status: "auto" } } }));
    assert.throws(() => loadRegistry(bad), /schema/);
  });

  it("scans an archive fixture into a sidecar db", () => {
    const archivePath = join(dir, "archive.sqlite");
    const db = openStore(archivePath);
    db.exec(`
      INSERT INTO documents (result_id, source, session_id, project, entry_id, role, text, timestamp)
      VALUES
        ('r1', 'pi', 's1', 'proj', 'e1', 'assistant', 'GA300-070-100 passed thermal testing at Physical Logic', '2026-11-09T00:00:00Z'),
        ('r2', 'pi', 's1', 'proj', 'e2', 'user', 'unrelated text with no known names', '2026-11-09T00:00:01Z'),
        ('r3', 'pi', 's2', 'proj', 'e3', 'assistant', 'Zephyr on ESP32, and zephyr again', '2026-11-09T00:00:02Z')
    `);
    db.close();

    const registryPath = join(dir, "entities.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entities: {
          "GA300-070-100": { type: "product", aliases: [], status: "auto" },
          "Physical Logic": { type: "organization", aliases: [], status: "confirmed" },
          Zephyr: { type: "software library", aliases: [], status: "confirmed" },
          Rejected: { type: "product", aliases: [], status: "rejected" },
        },
      }),
    );

    const dbPath = join(dir, "entities.sqlite");
    const result = scanEntities({ archivePath, registryPath, dbPath });
    assert.equal(result.documentsScanned, 3);
    assert.equal(result.entitiesSeen, 3);

    const side = new DatabaseSync(dbPath, { readOnly: true });
    const rawRows = side.prepare("SELECT entity, result_id, count FROM mentions ORDER BY entity, result_id").all();
    const rows = rawRows.map((r) => ({ ...(r as object) }));
    assert.deepEqual(rows, [
      { entity: "GA300-070-100", result_id: "r1", count: 1 },
      { entity: "Physical Logic", result_id: "r1", count: 1 },
      { entity: "Zephyr", result_id: "r3", count: 2 },
    ]);
    side.close();
  });
});
