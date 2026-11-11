import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../src/memory/store.ts";

test("entity-scan --index writes the sidecar beside the given index, not the default path", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-entity-scan-cli-"));
  const customDir = path.join(agentDir, "custom-memory");
  mkdirSync(customDir, { recursive: true });
  const indexPath = path.join(customDir, "archive.sqlite");

  const db = openStore(indexPath);
  db.exec(`
    INSERT INTO documents (result_id, source, session_id, project, entry_id, role, text, timestamp)
    VALUES ('r1', 'pi', 's1', 'proj', 'e1', 'assistant', 'Zephyr appears here', '2026-01-01T00:00:00Z')
  `);
  db.close();

  const wikiDir = path.join(agentDir, "wiki");
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(
    path.join(wikiDir, "entities.json"),
    JSON.stringify({
      version: 1,
      entities: { Zephyr: { type: "software library", aliases: [], status: "confirmed" } },
    }),
  );

  const out = JSON.parse(
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", path.resolve("src/memory/cli.ts"), "entity-scan", "--index", indexPath, "--wiki-dir", wikiDir],
      { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
    ),
  );
  assert.equal(out.ok, true);

  assert.ok(existsSync(path.join(customDir, "entities.sqlite")), "sidecar should sit beside the overridden index");
  assert.ok(
    !existsSync(path.join(agentDir, "memory", "entities.sqlite")),
    "sidecar must not fall back to the default location",
  );
});
