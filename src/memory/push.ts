import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_PI_FILE = 256 * 1024 * 1024;

type Fingerprint = { size: number; mtimeMs: number; sha256: string };
type PushState = { version: 1; files: Record<string, Fingerprint>; lastRun: string | null };
type PushOptions = { agentDir?: string; sessionsDir?: string };

function configFor(agentDir: string) {
  const filename = path.join(agentDir, "memory", "hub.json");
  if (!existsSync(filename)) throw new Error(`Hub configuration not found at ${filename}; run memory join first`);
  const st = lstatSync(filename);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Hub configuration must be a regular file: ${filename}`);
  let config: any;
  try { config = JSON.parse(readFileSync(filename, "utf8")); } catch (error) {
    throw new Error(`Invalid hub configuration at ${filename}: ${(error as Error).message}`);
  }
  if (!config || typeof config !== "object" || typeof config.hub !== "string" || typeof config.token !== "string" || !config.token.trim()) {
    throw new Error(`Invalid hub configuration at ${filename}; expected {"hub":"http://<host>:<port>","token":"..."}`);
  }
  let hub: URL;
  try { hub = new URL(config.hub); } catch { throw new Error(`Invalid hub URL in ${filename}`); }
  if (!(["http:", "https:"].includes(hub.protocol)) || hub.username || hub.password || hub.search || hub.hash || (hub.pathname !== "/" && hub.pathname !== "")) {
    throw new Error(`Hub URL in ${filename} must be an http(s) origin without credentials, path, query, or fragment`);
  }
  if (/\s/.test(config.token)) throw new Error(`Invalid bearer token in ${filename}`);
  return { endpoint: `${hub.origin}/ingest`, token: config.token };
}

function emptyState(): PushState {
  return { version: 1, files: {}, lastRun: null };
}

function loadState(filename: string): PushState {
  if (!existsSync(filename)) return emptyState();
  const st = lstatSync(filename);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Push state must be a regular file: ${filename}`);
  let state: any;
  try { state = JSON.parse(readFileSync(filename, "utf8")); } catch (error) {
    throw new Error(`Invalid push state at ${filename}: ${(error as Error).message}`);
  }
  if (!state || state.version !== 1 || !state.files || typeof state.files !== "object" || Array.isArray(state.files) || !(state.lastRun === null || typeof state.lastRun === "string")) {
    throw new Error(`Invalid push state at ${filename}`);
  }
  for (const [name, fingerprint] of Object.entries(state.files)) {
    const item = fingerprint as any;
    if (typeof name !== "string" || !item || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.mtimeMs !== "number" || !Number.isFinite(item.mtimeMs) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`Invalid file fingerprint in push state at ${filename}`);
    }
  }
  return state as PushState;
}

function saveState(filename: string, state: PushState) {
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

function sessionFiles(root: string) {
  const files: string[] = [];
  const failures: { file: string; error: string }[] = [];
  const visit = (filename: string) => {
    let st;
    try { st = lstatSync(filename); } catch (error: any) {
      failures.push({ file: filename, error: error?.message ?? String(error) });
      return;
    }
    if (st.isSymbolicLink()) {
      failures.push({ file: filename, error: "symlinks are not pushed" });
      return;
    }
    if (st.isDirectory()) {
      let names: string[];
      try { names = readdirSync(filename).sort(); } catch (error: any) {
        failures.push({ file: filename, error: error?.message ?? String(error) });
        return;
      }
      for (const name of names) visit(path.join(filename, name));
    } else if (st.isFile() && filename.toLowerCase().endsWith(".jsonl")) {
      files.push(filename);
    }
  };
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Pi sessions root must be a real directory: ${root}`);
  visit(root);
  return { files, failures };
}

function fingerprint(file: string, bytes: Buffer): Fingerprint {
  return {
    size: bytes.length,
    mtimeMs: statSync(file).mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function relativeName(root: string, filename: string) {
  return path.relative(root, filename).split(path.sep).join("/");
}

function uploadFilename(relativePath: string, filename: string) {
  const basename = path.basename(filename);
  const extension = path.extname(basename);
  const pathKey = createHash("sha256").update(relativePath).digest("hex").slice(0, 32);
  const prefix = `${pathKey}--`;
  const stem = path.basename(basename, extension).slice(0, 255 - prefix.length - extension.length) || "session";
  return `${prefix}${stem}${extension}`;
}

export async function pushSessions(options: PushOptions = {}) {
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".pi", "agent");
  const sessionsDir = options.sessionsDir ?? path.join(agentDir, "sessions");
  const memoryDir = path.join(agentDir, "memory");
  const stateFile = path.join(memoryDir, "push-state.json");
  const { endpoint, token } = configFor(agentDir);
  const state = loadState(stateFile);
  const { files, failures: walkFailures } = sessionFiles(sessionsDir);
  const failures = [...walkFailures];
  let sent = 0;
  let unchanged = 0;

  const reportFailure = (file: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ file, error: message });
    process.stderr.write(`[memory push] ${file}: ${message}\n`);
  };
  for (const failure of walkFailures) process.stderr.write(`[memory push] ${failure.file}: ${failure.error}\n`);
  for (const file of files) {
    const name = relativeName(sessionsDir, file);
    try {
      const before = statSync(file);
      if (before.size > MAX_PI_FILE) throw new Error("Pi session exceeds the hub's 256 MiB file limit");
      const bytes = readFileSync(file);
      const after = statSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error("Session changed while it was being read; retry on the next push");
      if (bytes.length === 0) throw new Error("Empty session files cannot be ingested by the hub");
      const current = fingerprint(file, bytes);
      const previous = state.files[name];
      if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.sha256 === current.sha256) {
        unchanged++;
        continue;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5 * 60 * 1000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ source: "pi", filename: uploadFilename(name, file), content_base64: bytes.toString("base64") }),
      });
      const text = await response.text();
      let result: any;
      try { result = JSON.parse(text); } catch { throw new Error(`Hub returned HTTP ${response.status} with invalid JSON`); }
      if (!response.ok || result?.ok !== true) throw new Error(`Hub returned HTTP ${response.status}: ${result?.error ?? "ingest failed"}`);
      state.files[name] = current;
      try { saveState(stateFile, state); } catch (error) {
        if (previous) state.files[name] = previous;
        else delete state.files[name];
        throw new Error(`uploaded, but could not save push watermark: ${(error as Error).message}`);
      }
      sent++;
    } catch (error) {
      reportFailure(name, error);
    }
  }

  if (!failures.length) {
    const previousLastRun = state.lastRun;
    state.lastRun = new Date().toISOString();
    try { saveState(stateFile, state); } catch (error) {
      state.lastRun = previousLastRun;
      reportFailure("push-state.json", error);
    }
  }
  return { sent, unchanged, failed: failures.length, failures, lastRun: state.lastRun };
}
