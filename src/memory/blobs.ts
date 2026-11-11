import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ingestClaude, ingestGrok, ingestPi } from "./ingest.ts";
import { registerSource, transaction } from "./store.ts";

export type ImportSource = "pi" | "claude" | "grok";
const IMPORT_SOURCES: readonly ImportSource[] = ["pi", "claude", "grok"];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function validSource(source: string): asserts source is ImportSource {
  if (!(IMPORT_SOURCES as readonly string[]).includes(source)) throw new Error("Import source must be pi, claude, or grok");
}

function originValue() {
  const origin = process.env.PI_MEMORY_ORIGIN ?? os.hostname();
  if (!origin.trim() || origin.length > 255) throw new Error("origin must contain 1 to 255 characters");
  return origin;
}

function originDirectory(origin: string) {
  // Keep ordinary hostnames legible; encode everything else without collisions
  // or path separators (including '.' and '..').
  return /^[A-Za-z0-9.-]+$/.test(origin) && origin !== "." && origin !== ".."
    ? origin
    : `origin-${Buffer.from(origin, "utf8").toString("hex")}`;
}

function safeFilename(filename: string) {
  const extension = path.extname(filename).replace(/[^A-Za-z0-9.]/g, "_");
  const stem = path.basename(filename, path.extname(filename)).replace(/[^A-Za-z0-9_-]/g, "_").replace(/^\.+|\.+$/g, "") || "payload";
  return `${stem}${extension}`;
}

function ensurePrivateDirectory(directory: string) {
  if (existsSync(directory)) {
    const st = lstatSync(directory);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Blob directory must be a real directory: ${directory}`);
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const st = lstatSync(directory);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Blob directory must be a real directory: ${directory}`);
}

function walkPayloads(inputs: string[]): string[] {
  const files: string[] = [];
  const visit = (entry: string) => {
    let st;
    try { st = lstatSync(entry); } catch (error: any) { if (error?.code === "ENOENT") throw new Error(`Import path does not exist: ${entry}`); throw error; }
    if (st.isSymbolicLink()) throw new Error(`Symlink in import input; refusing to copy: ${entry}`);
    if (st.isFile()) { files.push(path.resolve(entry)); return; }
    if (!st.isDirectory()) throw new Error(`Import input must be a regular file or directory: ${entry}`);
    for (const name of readdirSync(entry).sort()) visit(path.join(entry, name));
  };
  for (const input of inputs) visit(path.resolve(input));
  return [...new Set(files)].sort();
}

function filesUnder(root: string): string[] {
  const st = lstatSync(root);
  if (st.isSymbolicLink()) throw new Error(`Symlink source root is not allowed: ${root}`);
  if (st.isFile()) return [path.resolve(root)];
  if (!st.isDirectory()) throw new Error(`Registered import root must be a regular file or directory: ${root}`);
  return walkPayloads([root]);
}

function findBlob(sourceRoot: string, origin: string, digest: string): string | undefined {
  const directory = path.join(sourceRoot, originDirectory(origin));
  if (!existsSync(directory)) return undefined;
  const st = lstatSync(directory);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unexpected blob origin directory: ${directory}`);
  const matches = readdirSync(directory).filter(name => name.startsWith(`${digest}--`)).map(name => path.join(directory, name)).filter(file => {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Unexpected blob entry: ${file}`);
    return sha256(readFileSync(file)) === digest;
  });
  if (matches.length > 1) throw new Error(`Multiple blobs found for content hash ${digest} at ${directory}`);
  return matches[0];
}

function putBlob(sourceRoot: string, origin: string, bytes: Buffer, originalName: string) {
  const originDir = path.join(sourceRoot, originDirectory(origin));
  ensurePrivateDirectory(sourceRoot);
  ensurePrivateDirectory(originDir);
  const digest = sha256(bytes);
  const existing = findBlob(sourceRoot, origin, digest);
  if (existing) return { file: existing, copied: false, digest };
  const destination = path.join(originDir, `${digest}--${safeFilename(originalName)}`);
  let fd: number;
  try { fd = openSync(destination, "wx", 0o600); } catch (error: any) {
    if (error?.code === "EEXIST") {
      if (sha256(readFileSync(destination)) === digest) return { file: destination, copied: false, digest };
    }
    throw error;
  }
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  return { file: destination, copied: true, digest };
}

function ingestSource(db: DatabaseSync, source: ImportSource, root: string, opts: { origin?: string } = {}) {
  if (source === "pi") return ingestPi(db, root, opts);
  if (source === "claude") return ingestClaude(db, root, opts);
  return ingestGrok(db, root, opts);
}

function importRoot(db: DatabaseSync, source: ImportSource, blobDirectory: string) {
  const sourceRoot = path.join(path.resolve(blobDirectory), source);
  const configured = db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if (configured && path.resolve(configured.root) !== sourceRoot) throw new Error(`Source ${source} is registered at ${configured.root}; run memory import --backfill before adding blobs`);
  return { sourceRoot, configured };
}

interface StoredPayload { file: string; filename: string; copied: boolean }

// Replace prior blob versions of the same imported filenames (per origin dir), run one ingest with
// them moved aside, then drop them. On failure the stored blobs are removed and the previous
// versions restored, so a failed import never duplicates a session across two live blobs.
function withReplacedVersions<T>(sourceRoot: string, origin: string, stored: StoredPayload[], ingest: () => T): T {
  const originDir = path.join(sourceRoot, originDirectory(origin));
  const previousByFile = stored.map(item => {
    const suffix = `--${safeFilename(item.filename)}`;
    const previous = existsSync(originDir)
      ? readdirSync(originDir).filter(name => name.endsWith(suffix)).map(name => path.join(originDir, name)).filter(file => file !== item.file && !stored.some(other => other.file === file))
      : [];
    return { item, previous };
  });
  const dropStored = () => { for (const { item } of previousByFile) if (item.copied) try { unlinkSync(item.file); } catch { /* already absent */ } };
  if (!previousByFile.some(entry => entry.previous.length)) {
    try { return ingest(); } catch (error) { dropStored(); throw error; }
  }
  for (const { previous } of previousByFile) for (const file of previous) {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Unexpected blob entry: ${file}`);
  }
  const backup = path.join(path.dirname(sourceRoot), `.push-replaced-${randomUUID()}`);
  mkdirSync(backup, { mode: 0o700 });
  const moved: { from: string; to: string }[] = [];
  try {
    for (const { previous } of previousByFile) for (const file of previous) {
      const to = path.join(backup, `${randomUUID()}--${path.basename(file)}`);
      renameSync(file, to);
      moved.push({ from: file, to });
    }
    const result = ingest();
    try { rmSync(backup, { recursive: true, force: true }); } catch { /* backup is outside the scanned blob root */ }
    return result;
  } catch (error) {
    dropStored();
    let restoreFailed = false;
    for (const { from, to } of moved) {
      try { renameSync(to, from); } catch { restoreFailed = true; }
    }
    if (!restoreFailed) try { rmSync(backup, { recursive: true, force: true }); } catch { /* retain failed recovery data */ }
    throw error;
  }
}

// The whole-root ingest stamps every re-ingested file with the process-default origin; re-point
// exactly the sessions this call imported at their true origin so pushed/imported provenance is
// precise and unchanged co-tenant blobs are never re-tagged.
function markImportedOrigin(db: DatabaseSync, source: ImportSource, origin: string, files: string[]) {
  const mark = db.prepare("UPDATE entries SET origin=? WHERE source=? AND session_id=(SELECT session_id FROM source_files WHERE source=? AND file=?)");
  for (const file of files) mark.run(origin, source, source, file);
}

export function importPayload(db: DatabaseSync, source: ImportSource, filename: string, bytes: Uint8Array, blobDirectory: string, opts: { origin?: string; replaceFilename?: boolean } = {}) {
  validSource(source);
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) throw new Error("Import filename must contain 1 to 255 characters");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("Import payload must not be empty");
  const { sourceRoot, configured } = importRoot(db, source, blobDirectory);
  const origin = opts.origin ?? originValue();
  if (!origin.trim() || origin.length > 255) throw new Error("origin must contain 1 to 255 characters");
  const stored = putBlob(sourceRoot, origin, Buffer.from(bytes), filename);
  const runIngest = () => {
    if (configured) db.prepare("UPDATE source_config SET root=? WHERE source=?").run(sourceRoot, source);
    else registerSource(db, source, sourceRoot);
    const result = ingestSource(db, source, sourceRoot);
    markImportedOrigin(db, source, origin, [stored.file]);
    return result;
  };
  const ingest = source === "pi" && opts.replaceFilename
    ? withReplacedVersions(sourceRoot, origin, [{ file: stored.file, filename, copied: stored.copied }], runIngest)
    : runIngest();
  return { source, copied: stored.copied ? 1 : 0, files: [stored.file], ingest };
}

export function importFiles(db: DatabaseSync, source: ImportSource, inputs: string[], blobDirectory: string, opts: { origin?: string } = {}) {
  validSource(source);
  if (!inputs.length) throw new Error("memory import requires at least one file or directory");
  const { sourceRoot, configured } = importRoot(db, source, blobDirectory);
  const origin = opts.origin ?? originValue();
  const files = walkPayloads(inputs);
  if (!files.length) throw new Error("Import input contains no regular files");
  const stored: StoredPayload[] = [];
  let copied = 0;
  for (const file of files) {
    const result = putBlob(sourceRoot, origin, readFileSync(file), path.basename(file));
    stored.push({ file: result.file, filename: path.basename(file), copied: result.copied });
    if (result.copied) copied++;
  }
  const runIngest = () => {
    if (configured) db.prepare("UPDATE source_config SET root=? WHERE source=?").run(sourceRoot, source);
    else registerSource(db, source, sourceRoot);
    const result = ingestSource(db, source, sourceRoot);
    markImportedOrigin(db, source, origin, stored.map(item => item.file));
    return result;
  };
  // Pi sessions are append-mostly: re-importing a grown file must replace its previous blob, not
  // accumulate a duplicate session (field-found 2026-11-10: duplicate blobs poisoned every ingest).
  const ingest = source === "pi" ? withReplacedVersions(sourceRoot, origin, stored, runIngest) : runIngest();
  return { source, copied, files: stored.map(item => item.file), ingest };
}

function physicalFile(source: ImportSource, file: string) {
  if (source === "grok") {
    const separator = file.lastIndexOf("#");
    if (separator > 0) return file.slice(0, separator);
  }
  return file;
}

function rowOrigins(db: DatabaseSync, source: ImportSource, session: string, fallback: string) {
  const rows = db.prepare("SELECT DISTINCT origin FROM entries WHERE source=? AND session_id=?").all(source, session) as any[];
  const values = [...new Set(rows.map(row => String(row.origin)))];
  if (values.length > 1) throw new Error(`Cannot backfill ${source} session ${session}: entries have multiple origins`);
  return values[0] ?? fallback;
}

export function backfillImports(db: DatabaseSync, blobDirectory: string) {
  const blobs = path.resolve(blobDirectory);
  const sources: Record<string, { copied: number; files: number }> = {};
  const roots = db.prepare("SELECT source,root FROM source_config WHERE source IN ('pi','claude','grok') ORDER BY source").all() as any[];
  const updates: { source: ImportSource; newFile: string; session: string; fingerprint: string; size: number; indexedAt: string }[] = [];
  const newRoots: { source: ImportSource; root: string }[] = [];
  const fallbackOrigin = originValue();
  for (const registration of roots) {
    const source = registration.source as ImportSource;
    validSource(source);
    const oldRoot = path.resolve(registration.root);
    const sourceRoot = path.join(blobs, source);
    const payloads = filesUnder(oldRoot);
    if (payloads.length > 50_000) throw new Error(`${source} export count exceeded 50000 during backfill`);
    const sourceRows = db.prepare("SELECT file,session_id,fingerprint,size,indexed_at FROM source_files WHERE source=?").all(source) as any[];
    const pathOrigins = new Map<string, Set<string>>();
    for (const row of sourceRows) {
      const physical = path.resolve(physicalFile(source, row.file));
      const origins = pathOrigins.get(physical) ?? new Set<string>();
      origins.add(rowOrigins(db, source, row.session_id, fallbackOrigin));
      pathOrigins.set(physical, origins);
    }
    let copied = 0;
    const mapping = new Map<string, Map<string, string>>();
    for (const file of payloads) {
      const origins = pathOrigins.get(file) ?? new Set([fallbackOrigin]);
      const bytes = readFileSync(file);
      for (const origin of origins) {
        const result = putBlob(sourceRoot, origin, bytes, path.basename(file));
        if (result.copied) copied++;
        const byOrigin = mapping.get(file) ?? new Map<string, string>();
        byOrigin.set(origin, result.file);
        mapping.set(file, byOrigin);
      }
    }
    for (const row of sourceRows) {
      const file = path.resolve(physicalFile(source, row.file));
      if (!existsSync(file)) throw new Error(`Cannot backfill ${source} manifest file ${row.file}: source file is missing`);
      const origin = rowOrigins(db, source, row.session_id, fallbackOrigin);
      const bytes = readFileSync(file);
      const digest = sha256(bytes);
      const candidates = (mapping.get(file)?.get(origin) ? [mapping.get(file)!.get(origin)!] : []).filter(blob => sha256(readFileSync(blob)) === digest);
      if (candidates.length !== 1) throw new Error(`Cannot backfill ${source} manifest file ${row.file}: content hash ${digest} maps to ${candidates.length} blobs`);
      updates.push({ source, newFile: source === "grok" ? `${candidates[0]}#${row.session_id}` : candidates[0], session: row.session_id, fingerprint: row.fingerprint, size: row.size, indexedAt: row.indexed_at });
    }
    sources[source] = { copied, files: payloads.length };
    newRoots.push({ source, root: sourceRoot });
  }
  transaction(db, () => {
    for (const source of new Set(updates.map(row => row.source))) db.prepare("DELETE FROM source_files WHERE source=?").run(source);
    const insert = db.prepare("INSERT INTO source_files(source,file,session_id,fingerprint,size,indexed_at) VALUES(?,?,?,?,?,?)");
    for (const row of updates) insert.run(row.source, row.newFile, row.session, row.fingerprint, row.size, row.indexedAt);
    const updateRoot = db.prepare("UPDATE source_config SET root=? WHERE source=?");
    for (const row of newRoots) updateRoot.run(row.root, row.source);
  });
  return { sources };
}

export function forgetImport(db: DatabaseSync, input: { source: string; session?: string; file?: string }, blobDirectory: string) {
  validSource(input.source);
  if (Boolean(input.session) === Boolean(input.file)) throw new Error("Specify exactly one of --session or --file");
  const source = input.source;
  const sourceRoot = path.resolve(blobDirectory, source);
  const configured = db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if (!configured || path.resolve(configured.root) !== sourceRoot) throw new Error(`Source ${source} is not registered in import mode; refusing to forget from a watch source`);
  const rows = db.prepare("SELECT file,session_id FROM source_files WHERE source=?").all(source) as any[];
  let selected: any[];
  if (input.session) selected = rows.filter(row => row.session_id === input.session);
  else {
    const requested = path.resolve(input.file!);
    selected = rows.filter(row => row.file === input.file || physicalFile(source, row.file) === requested);
    if (!selected.length && (requested === sourceRoot || !requested.startsWith(sourceRoot + path.sep))) throw new Error("--file must identify a manifest file inside this source's blob directory");
  }
  if (!selected.length) return { source, removed: 0, files: 0 };
  const toDelete = new Set(selected.map(row => row.file));
  const physicals = new Set(selected.map(row => physicalFile(source, row.file)));
  let realSourceRoot: string | undefined;
  try {
    const rootStat = lstatSync(sourceRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Unexpected blob source directory: ${sourceRoot}`);
    realSourceRoot = realpathSync(sourceRoot);
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  for (const file of physicals) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(sourceRoot + path.sep)) throw new Error(`Refusing to delete file outside blob store: ${file}`);
    if (!realSourceRoot) continue;
    const parent = path.dirname(resolved);
    if (path.dirname(parent) !== sourceRoot) throw new Error(`Unexpected blob path depth: ${file}`);
    let parentStat;
    try { parentStat = lstatSync(parent); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || !realpathSync(parent).startsWith(realSourceRoot + path.sep)) throw new Error(`Unexpected blob origin directory: ${parent}`);
    let fileStat;
    try { fileStat = lstatSync(resolved); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || !realpathSync(resolved).startsWith(realSourceRoot + path.sep)) throw new Error(`Refusing to delete unexpected blob entry: ${resolved}`);
  }
  transaction(db, () => {
    const remove = db.prepare("DELETE FROM source_files WHERE source=? AND file=?");
    for (const row of selected) remove.run(source, row.file);
    for (const session of new Set(selected.map(row => row.session_id))) {
      const still = db.prepare("SELECT 1 FROM source_files WHERE source=? AND session_id=? LIMIT 1").get(source, session);
      if (!still) {
        db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, session);
        db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, session);
        db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source, session);
      }
    }
  });
  let files = 0;
  for (const file of physicals) {
    const remaining = (db.prepare("SELECT file FROM source_files WHERE source=?").all(source) as any[]).some(row => physicalFile(source, row.file) === file);
    if (remaining) continue;
    const resolved = path.resolve(file);
    let st;
    try { st = lstatSync(resolved); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Refusing to delete unexpected blob entry: ${resolved}`);
    unlinkSync(resolved);
    files++;
  }
  return { source, removed: toDelete.size, files };
}
