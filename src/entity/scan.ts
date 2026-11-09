import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Gazetteer, type GazetteerHit } from "./gazetteer.ts";
import { loadRegistry, surfaceForms } from "./registry.ts";

export interface EntityScanResult {
  documentsScanned: number;
  mentionsFound: number;
  entitiesSeen: number;
  registryEntities: number;
  patterns: number;
  dbPath: string;
}

const PAGE = 5000;

function defaultArchivePath(): string {
  return join(homedir(), ".pi", "agent", "memory", "archive.sqlite");
}

export function defaultEntityDbPath(): string {
  return join(homedir(), ".pi", "agent", "memory", "entities.sqlite");
}

function defaultRegistryPath(): string {
  return join(homedir(), ".pi", "agent", "wiki", "entities.json");
}

export function buildGazetteer(registryPath: string): {
  gazetteer: Gazetteer;
  entityCount: number;
} {
  const registry = loadRegistry(registryPath);
  const entries: [string, string][] = [];
  for (const [name, info] of Object.entries(registry.entities)) {
    if (info.status === "rejected") continue;
    for (const surface of surfaceForms(name, info.aliases)) {
      entries.push([name, surface]);
    }
  }
  const gazetteer = new Gazetteer(entries);
  return { gazetteer, entityCount: Object.keys(registry.entities).length };
}

interface DocumentRow {
  result_id: string;
  source: string;
  session_id: string;
  entry_id: string | null;
  text: string;
}

/**
 * Scan the archive with the gazetteer and write aggregated mentions to a
 * sidecar SQLite (rebuilt from scratch each run — derived data, disposable).
 */
export function scanEntities(options?: {
  archivePath?: string;
  registryPath?: string;
  dbPath?: string;
  limit?: number;
}): EntityScanResult {
  const archivePath = options?.archivePath ?? defaultArchivePath();
  const registryPath = options?.registryPath ?? defaultRegistryPath();
  const dbPath = options?.dbPath ?? defaultEntityDbPath();

  const { gazetteer, entityCount } = buildGazetteer(registryPath);

  const archive = new DatabaseSync(archivePath, { readOnly: true });
  archive.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  const count = (
    archive.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number }
  ).c;
  const limit = Math.min(options?.limit ?? count, count);

  // Remove stale WAL/SHM alongside the DB: another process (wiki server) may
  // hold the old inode, and mismatched wal/shm corrupts the fresh database.
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const out = new DatabaseSync(dbPath);
  out.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE mentions (
      entity TEXT NOT NULL,
      result_id TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      entry_id TEXT,
      count INTEGER NOT NULL,
      offsets TEXT NOT NULL
    );
    CREATE INDEX idx_mentions_entity ON mentions(entity);
    CREATE INDEX idx_mentions_result ON mentions(result_id);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const insert = out.prepare(
    "INSERT INTO mentions (entity, result_id, source, session_id, entry_id, count, offsets) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const page = archive.prepare(
    "SELECT result_id, source, session_id, entry_id, text FROM documents ORDER BY result_id LIMIT ? OFFSET ?",
  );

  let scanned = 0;
  let mentionRows = 0;
  let totalHits = 0;
  const entitiesSeen = new Set<string>();

  out.exec("BEGIN");
  try {
    for (let offset = 0; offset < limit; offset += PAGE) {
      const rows = page.all(PAGE, offset) as unknown as DocumentRow[];
      for (const row of rows) {
        const hits = gazetteer.find(row.text);
        if (hits.length > 0) {
          const byEntity = new Map<string, GazetteerHit[]>();
          for (const hit of hits) {
            const list = byEntity.get(hit.entity);
            if (list) list.push(hit);
            else byEntity.set(hit.entity, [hit]);
          }
          for (const [entity, entityHits] of byEntity) {
            insert.run(
              entity,
              row.result_id,
              row.source,
              row.session_id,
              row.entry_id,
              entityHits.length,
              JSON.stringify(entityHits.slice(0, 5).map((h) => h.offset)),
            );
            mentionRows++;
            entitiesSeen.add(entity);
          }
          totalHits += hits.length;
        }
        scanned++;
      }
    }
    out.exec("COMMIT");
  } catch (error) {
    out.exec("ROLLBACK");
    throw error;
  }

  out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("scanned_at", new Date().toISOString());
  out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("documents", String(scanned));
  out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("registry", registryPath);
  out.close();
  archive.close();

  return {
    documentsScanned: scanned,
    mentionsFound: mentionRows,
    entitiesSeen: entitiesSeen.size,
    registryEntities: entityCount,
    patterns: gazetteer.size,
    dbPath,
  };
}
