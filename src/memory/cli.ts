import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expand, listSessions, openStore, status, SCHEMA_VERSION } from "./store.ts";
import { ingestClaude, ingestGrok, ingestOpenCode, ingestPi, ingestWiki } from "./ingest.ts";
import { backfillImports, forgetImport, importFiles } from "./blobs.ts";
import { pushSessions } from "./push.ts";
import { hubOrigin, memoryEnroll, memoryJoin, memoryJoinStatus, parseHubBundle, validateHubUrl } from "./join.ts";
import { addHubToken, listHubTokens, makeHubBundle, registerHubToken, revokeHubToken } from "./hub-tokens.ts";
import { defaultHubGitRoot, initializeHubGit } from "./git-http.ts";
import { buildVectorIndex, refreshVectorIndex, searchMemory, vectorStatus } from "./semantic.ts";
import { embedTexts, health, serviceUrls } from "./vector-client.ts";
import { evaluateCases, readEvaluationCases } from "./evaluation.ts";

type Options = Record<string, string | string[]>;

function parseArgs(argv: string[]) {
  const out: Options = {};
  const flags = new Set(["--all", "--no-replies", "--rebuild", "--backfill", "--force", "--no-push", "--status", "--token-stdin"]);
  let command = "";
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (flags.has(arg)) {
        if (out[arg]) throw new Error(`Repeated flag: ${arg}`);
        out[arg] = "true";
        continue;
      }
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      const value = argv[++i];
      if (arg === "--cue") {
        const previous = out[arg];
        out[arg] = previous ? [...(Array.isArray(previous) ? previous : [previous]), value] : [value];
      } else {
        if (out[arg]) throw new Error(`Repeated flag: ${arg}`);
        out[arg] = value;
      }
    } else if (!command) {
      command = arg;
    } else {
      args.push(arg);
    }
  }
  return { command, out, args };
}

function value(out: Options, key: string): string | undefined {
  const item = out[key];
  return Array.isArray(item) ? item[0] : item;
}

function defaults(options: Options) {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return {
    index: value(options, "--index") || process.env.PI_MEMORY_INDEX || path.join(agent, "memory", "archive.sqlite"),
    pi: value(options, "--pi-sessions") || path.join(agent, "sessions"),
    opencode: value(options, "--opencode-db") || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    wiki: value(options, "--wiki-dir") || process.env.PI_WIKI_DIR || path.join(agent, "wiki"),
    claude: value(options, "--claude-exports") || process.env.PI_CLAUDE_EXPORTS || path.join(agent, "claude-exports"),
    grok: value(options, "--grok-exports") || process.env.PI_GROK_EXPORTS || path.join(agent, "grok-exports"),
  };
}

function only(options: Options, allowed: string[]) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`Unknown flag: ${key}`);
  }
}

function positiveInt(value: string | undefined, name: string, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdinToken() {
  process.stdin.setEncoding("utf8");
  let token = "";
  for await (const chunk of process.stdin) {
    if (token.length + chunk.length > 256) throw new Error("Token from stdin exceeds 256 characters");
    token += chunk;
  }
  if (!token || /\s/.test(token)) throw new Error("Token from stdin must be non-empty and contain no whitespace");
  return token;
}

function openReadIndex(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  const schema = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (schema !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Unsupported memory index schema ${schema}; expected ${SCHEMA_VERSION}`);
  }
  return db;
}

function canonicalPath(filename: string) {
  try { return realpathSync(filename); } catch { return path.resolve(filename); }
}

function safeIndexLocation(index: string, piSessions: string, opencode: string) {
  const resolved = canonicalPath(index);
  const piRoot = canonicalPath(piSessions);
  const opencodePath = canonicalPath(opencode);
  if (resolved === opencodePath) throw new Error("Memory index path must not equal the OpenCode source database");
  if (resolved === piRoot || resolved.startsWith(piRoot + path.sep)) throw new Error("Memory index must not be stored inside the Pi sessions source tree");
}

const operation = new AbortController();
process.once("SIGINT", () => operation.abort(new Error("Memory operation cancelled")));
process.once("SIGTERM", () => operation.abort(new Error("Memory operation cancelled")));

try {
  const { command, out, args } = parseArgs(process.argv.slice(2));
  const paths = defaults(out);
  if (!command) throw new Error("Usage: memory <ingest|import|forget|push|join|enroll|hub-token|hub-git-init|status|sessions|search|expand|vector-build|vector-refresh|vector-status|entity-scan|entity-dossier|session-summaries|benchmark|evaluate> [flags]");
  if (command !== "import" && command !== "hub-token" && command !== "join" && command !== "enroll" && args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const blobDirectory = path.join(path.dirname(paths.index), "blobs");

  if (command === "join") {
    only(out, ["--status", "--port", "--token", "--token-stdin", "--force", "--no-push"]);
    if (out["--status"]) {
      if (args.length || value(out, "--port") || value(out, "--token") || out["--token-stdin"] || out["--force"] || out["--no-push"]) throw new Error("Usage: memory join --status");
      const result = await memoryJoinStatus();
      emit(result);
      if (!result.ok) process.exitCode = 1;
    } else {
      if (args.length !== 1) throw new Error("Usage: memory join <hub-host|bundle> [--port 6342] (--token <spoke-token>|--token-stdin) [--force] [--no-push]");
      const bundle = args[0].startsWith("pih1.") ? parseHubBundle(args[0]) : undefined;
      let hub: string;
      let token: string;
      if (bundle) {
        if (value(out, "--port") !== undefined || value(out, "--token") !== undefined || out["--token-stdin"]) throw new Error("A pih1 bundle already contains its hub address and token; do not pass --port or token flags");
        hub = bundle.hub;
        token = bundle.token;
      } else {
        const { hub: origin } = hubOrigin(args[0], positiveInt(value(out, "--port"), "port", 6342, 1, 65535));
        const tokenArg = value(out, "--token");
        const tokenFromStdin = Boolean(out["--token-stdin"]);
        if (Boolean(tokenArg) === tokenFromStdin) throw new Error("memory join requires exactly one of --token <spoke-token> or --token-stdin");
        hub = origin;
        token = tokenFromStdin ? await readStdinToken() : tokenArg!;
      }
      emit(await memoryJoin({ hub, token, force: Boolean(out["--force"]), noPush: Boolean(out["--no-push"]) }));
    }
  } else if (command === "enroll") {
    only(out, ["--port", "--spoke", "--no-push"]);
    if (args.length !== 1) throw new Error("Usage: memory enroll <hub-host> [--port 6342] [--spoke <name>] [--no-push]");
    const { hub } = hubOrigin(args[0], positiveInt(value(out, "--port"), "port", 6342, 1, 65535));
    const enroll = await memoryEnroll({
      hub,
      spoke: value(out, "--spoke"),
      noPush: Boolean(out["--no-push"]),
      signal: operation.signal,
      onRegisterCommand: command => process.stdout.write(`On the hub, run exactly:\n${command}\n`),
    });
    emit(enroll);
  } else if (command === "push") {
    only(out, []);
    const push = await pushSessions({ agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), sessionsDir: paths.pi });
    emit({ ok: push.failed === 0, push });
    if (push.failed) process.exitCode = 1;
  } else if (command === "hub-token") {
    only(out, ["--advertise"]);
    const [action, spoke, secret, extra] = args;
    if (action === "add" && spoke && !secret && !extra) {
      const bind = process.env.PI_HUB_BIND || "127.0.0.1";
      const bindHost = bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
      const advertisedInput = value(out, "--advertise") ?? `http://${bindHost}:${positiveInt(process.env.PI_HUB_PORT, "PI_HUB_PORT", 6342, 1, 65535)}`;
      const advertised = validateHubUrl(advertisedInput);
      const minted = addHubToken(spoke);
      const host = new URL(advertised).hostname.replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "::1" || host.startsWith("127.")) process.stderr.write("Warning: bundle is only useful on the hub itself (advertised address is loopback).\n");
      emit({ ok: true, ...minted, bundle: makeHubBundle(advertised, minted.token) });
    } else if (action === "register" && spoke && secret && !extra && !value(out, "--advertise")) {
      emit({ ok: true, ...registerHubToken(spoke, secret) });
    } else if (action === "list" && args.length === 1 && !value(out, "--advertise")) {
      emit({ ok: true, tokens: listHubTokens() });
    } else if (action === "revoke" && spoke && !secret && !extra && !value(out, "--advertise")) {
      emit({ ok: true, ...revokeHubToken(spoke) });
    } else {
      throw new Error("Usage: memory hub-token <add SPOKE [--advertise http://host:port]|register SPOKE SECRET|list|revoke SPOKE>");
    }
  } else if (command === "hub-git-init") {
    only(out, []);
    if (args.length) throw new Error("Usage: memory hub-git-init");
    emit({ ok: true, ...initializeHubGit(defaultHubGitRoot(), paths.wiki) });
  } else if (command === "ingest") {
    only(out, ["--index", "--pi-sessions", "--opencode-db", "--wiki-dir", "--claude-exports", "--grok-exports"]);
    safeIndexLocation(paths.index, paths.pi, paths.opencode);
    const db = openStore(paths.index);
    try {
      const piRoot = (db.prepare("SELECT root FROM source_config WHERE source='pi'").get() as any)?.root ?? paths.pi;
      const claudeRoot = (db.prepare("SELECT root FROM source_config WHERE source='claude'").get() as any)?.root ?? paths.claude;
      const grokRoot = (db.prepare("SELECT root FROM source_config WHERE source='grok'").get() as any)?.root ?? paths.grok;
      const sources = [ingestPi(db, piRoot), ingestOpenCode(db, paths.opencode), ingestClaude(db, claudeRoot), ingestGrok(db, grokRoot), ingestWiki(db, paths.wiki)];
      emit({ ok: true, sources, status: status(db) });
    } finally {
      db.close();
    }
  } else if (command === "import") {
    only(out, ["--index", "--source", "--backfill"]);
    safeIndexLocation(paths.index, paths.pi, paths.opencode);
    if (out["--backfill"]) {
      if (value(out, "--source") || args.length) throw new Error("memory import --backfill does not accept --source or file arguments");
      const db = openStore(paths.index);
      try { emit({ ok: true, backfill: backfillImports(db, blobDirectory) }); } finally { db.close(); }
    } else {
      const source = value(out, "--source");
      if (source !== "pi" && source !== "claude" && source !== "grok") throw new Error("memory import requires --source pi|claude|grok");
      if (!args.length) throw new Error("memory import requires one or more file or directory paths");
      const db = openStore(paths.index);
      try { emit({ ok: true, ...importFiles(db, source, args, blobDirectory), status: status(db) }); } finally { db.close(); }
    }
  } else if (command === "forget") {
    only(out, ["--index", "--source", "--session", "--file"]);
    safeIndexLocation(paths.index, paths.pi, paths.opencode);
    const source = value(out, "--source");
    if (!source) throw new Error("memory forget requires --source pi|claude|grok");
    if (!value(out, "--session") && !value(out, "--file")) throw new Error("memory forget requires --session ID or --file PATH");
    if (value(out, "--session") && value(out, "--file")) throw new Error("Specify exactly one of --session or --file");
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}`);
    const db = openStore(paths.index);
    try { emit({ ok: true, ...forgetImport(db, { source, session: value(out, "--session"), file: value(out, "--file") }, blobDirectory) }); } finally { db.close(); }
  } else if (command === "sessions") {
    only(out, ["--index", "--since", "--limit"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run: node --experimental-strip-types src/memory/cli.ts ingest`);
    const raw = value(out, "--since") ?? "7d";
    const days = raw.match(/^(\d+)d$/);
    const since = days ? new Date(Date.now() - Number(days[1]) * 24 * 60 * 60 * 1000) : new Date(raw);
    if (Number.isNaN(since.valueOf())) throw new Error("--since must be an ISO date or a day count like 7d");
    const limit = positiveInt(value(out, "--limit"), "limit", 500, 1, 5000);
    const db = openReadIndex(paths.index);
    try {
      emit({ ok: true, since: since.toISOString(), sessions: listSessions(db, since.toISOString(), limit) });
    } finally {
      db.close();
    }
  } else if (command === "status") {
    only(out, ["--index"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run: node --experimental-strip-types src/memory/cli.ts ingest`);
    const db = openReadIndex(paths.index);
    try {
      emit({ ok: true, status: status(db), semantic: await vectorStatus(paths.index, operation.signal) });
    } finally {
      db.close();
    }
  } else if (command === "search") {
    only(out, ["--index", "--query", "--cue", "--limit", "--project", "--source", "--session", "--exclude-session", "--all", "--mode", "--cosine-floor"]);
    if (!out["--all"] && !out["--project"]) throw new Error("Search requires --project, or explicitly pass --all");
    const query = value(out, "--query") ?? "";
    const cues = out["--cue"] ? (Array.isArray(out["--cue"]) ? out["--cue"] : [out["--cue"]]) : [];
    if (cues.length > 8 || cues.some(cue => cue.length > 120)) throw new Error("At most 8 cues, each no longer than 120 characters");
    const limit = positiveInt(value(out, "--limit"), "limit", 8, 1, 20);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run: node --experimental-strip-types src/memory/cli.ts ingest`);
    const mode = value(out, "--mode") as "auto" | "lexical" | "hybrid" | "semantic" | undefined;
    if (mode && !["auto", "lexical", "hybrid", "semantic"].includes(mode)) throw new Error("mode must be lexical, hybrid, semantic, or auto");
    const floorValue = value(out, "--cosine-floor");
    const cosineFloor = floorValue === undefined ? undefined : Number(floorValue);
    if (cosineFloor !== undefined && (!Number.isFinite(cosineFloor) || cosineFloor < -1 || cosineFloor > 1)) throw new Error("cosine-floor must be a finite number between -1 and 1");
    const db = openReadIndex(paths.index);
    try {
      const excludedSession = value(out, "--exclude-session");
      const result = await searchMemory(db, paths.index, {
        query,
        cues,
        limit,
        project: value(out, "--project"),
        source: value(out, "--source"),
        session: value(out, "--session"),
        currentSession: excludedSession,
        scope: out["--all"] ? "all" : "project",
        mode,
        cosineFloor,
      }, operation.signal);
      const freshness = (excludedSession
        ? db.prepare("SELECT MAX(timestamp) AS latest FROM documents WHERE session_id<>?").get(excludedSession)
        : db.prepare("SELECT MAX(timestamp) AS latest FROM documents").get()) as any;
      emit({ ok: true, ...result, archive: { latest: freshness?.latest ?? null } });
    } finally {
      db.close();
    }
  } else if (command === "expand") {
    only(out, ["--index", "--id", "--max-chars", "--project", "--source", "--all", "--offset", "--direction", "--branch-id", "--no-replies"]);
    if (!out["--all"] && !out["--project"]) throw new Error("Expand requires --project, or explicitly pass --all");
    const maxChars = positiveInt(value(out, "--max-chars"), "max-chars", 3000, 200, 8000);
    const offset = positiveInt(value(out, "--offset"), "offset", 0, 0, 100_000_000);
    const direction = value(out, "--direction") as "backward" | "forward" | "both" | undefined;
    if (direction && !["backward", "forward", "both"].includes(direction)) throw new Error("direction must be backward, forward, or both");
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run: node --experimental-strip-types src/memory/cli.ts ingest`);
    const db = openReadIndex(paths.index);
    try {
      const result = expand(db, value(out, "--id") || "", {
        project: value(out, "--project"),
        scope: out["--all"] ? "all" : "project",
        maxChars,
        source: value(out, "--source"),
        offset,
        direction,
        branchId: value(out, "--branch-id"),
        includeReplies: !out["--no-replies"],
      });
      if (!result) throw new Error("Memory result not found or outside selected project/source scope");
      emit({ ok: true, result });
    } finally {
      db.close();
    }
  } else if (command === "vector-build") {
    only(out, ["--index"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    safeIndexLocation(paths.index, paths.pi, paths.opencode);
    const check = openReadIndex(paths.index);
    check.close();
    emit({ ok: true, build: await buildVectorIndex(paths.index, operation.signal) });
  } else if (command === "vector-refresh") {
    only(out, ["--index", "--max-age-hours"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    const hours = positiveInt(value(out, "--max-age-hours") ?? process.env.PI_MEMORY_VECTOR_REFRESH_HOURS, "max-age-hours", 24, 1, 24 * 30);
    emit({ ok: true, refresh: await refreshVectorIndex(paths.index, { maxAgeMs: hours * 60 * 60 * 1000 }, operation.signal) });
  } else if (command === "vector-status") {
    only(out, ["--index"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    emit({ ok: true, semantic: await vectorStatus(paths.index, operation.signal) });
  } else if (command === "evaluate") {
    only(out, ["--index", "--cases", "--top-k", "--cosine-floor", "--exclude-session"]);
    const fixture = value(out, "--cases");
    if (!fixture) throw new Error("Evaluation requires --cases PRIVATE_JSON_FILE");
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run: node --experimental-strip-types src/memory/cli.ts ingest`);
    const topK = positiveInt(value(out, "--top-k"), "top-k", 5, 1, 20);
    const floorValue = value(out, "--cosine-floor");
    const cosineFloor = floorValue === undefined ? undefined : Number(floorValue);
    if (cosineFloor !== undefined && (!Number.isFinite(cosineFloor) || cosineFloor < -1 || cosineFloor > 1)) throw new Error("cosine-floor must be a finite number between -1 and 1");
    const cases = readEvaluationCases(fixture);
    const db = openReadIndex(paths.index);
    try {
      const report = await evaluateCases(cases, async (test, mode) => {
        const result = await searchMemory(db, paths.index, {
          query: test.query,
          cues: test.cues,
          limit: topK,
          project: test.project,
          source: test.source,
          session: test.session,
          currentSession: value(out, "--exclude-session"),
          scope: test.scope ?? (test.project ? "project" : "all"),
          mode,
          cosineFloor,
        }, operation.signal);
        return { resultIds: result.results.map(row => row.result_id), elapsedMs: result.retrieval.elapsedMs, status: result.retrieval.status };
      }, undefined, topK);
      emit(report);
    } finally {
      db.close();
    }
  } else if (command === "entity-scan") {
    only(out, ["--index", "--wiki-dir", "--limit"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    const limit = value(out, "--limit") === undefined ? undefined : positiveInt(value(out, "--limit"), "limit", 10000, 1, 1_000_000);
    const { scanEntities } = await import("../entity/scan.ts");
    emit({ ok: true, scan: scanEntities({ archivePath: paths.index, registryPath: path.join(paths.wiki, "entities.json"), limit }) });
  } else if (command === "entity-dossier") {
    only(out, ["--index", "--wiki-dir", "--entity", "--top", "--model", "--max-docs", "--rebuild"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    const entityDb = path.join(path.dirname(paths.index), "entities.sqlite");
    if (!existsSync(entityDb)) throw new Error("No entity mention index; run entity-scan first");
    if (!value(out, "--entity") && !value(out, "--top")) throw new Error("entity-dossier requires --entity NAME or --top N");
    // nemotron-3-super hangs on dossier prompts (reasoning explosion on the
    // disposition schema); gpt-oss-120b handles them reliably and quickly.
    const model = value(out, "--model") ?? process.env.PI_DOSSIER_MODEL ?? "gladiator/gpt-oss-120b";
    const maxDocs = value(out, "--max-docs") === undefined ? undefined : positiveInt(value(out, "--max-docs"), "max-docs", 40, 1, 200);
    const { updateDossier } = await import("../entity/dossier.ts");
    const rebuild = out["--rebuild"] === "true";
    let entities: string[];
    if (value(out, "--entity")) {
      entities = [value(out, "--entity")!];
    } else {
      const top = positiveInt(value(out, "--top"), "top", 10, 1, 100);
      const { DatabaseSync } = await import("node:sqlite");
      const side = new DatabaseSync(entityDb, { readOnly: true });
      entities = (side.prepare("SELECT entity FROM mentions GROUP BY entity ORDER BY COUNT(*) DESC LIMIT ?").all(top) as unknown as { entity: string }[]).map((r) => r.entity);
      side.close();
    }
    const results = [];
    for (const entity of entities) {
      try {
        results.push(await updateDossier({ entity, wikiDir: paths.wiki, archivePath: paths.index, entityDbPath: entityDb, model, maxDocs, rebuild }));
      } catch (error) {
        results.push({ entity, status: "error", error: (error as Error).message });
      }
    }
    emit({ ok: true, results });
  } else if (command === "session-summaries") {
    only(out, ["--index", "--wiki-dir", "--limit", "--model", "--rebuild"]);
    if (!existsSync(paths.index)) throw new Error(`Memory index not found at ${paths.index}. Run ingest first`);
    const limit = value(out, "--limit") === undefined ? undefined : positiveInt(value(out, "--limit"), "limit", 50, 1, 5000);
    const model = value(out, "--model") ?? process.env.PI_SUMMARY_MODEL ?? "gladiator/gpt-oss-120b";
    const { summarizeSessions } = await import("./summaries.ts");
    // Target sessions: everything cited by wiki pages plus everything in the
    // entity mention sidecar — the sessions canonical links can point at.
    const wanted = new Set<string>();
    const pagesDir = path.join(paths.wiki, "pages");
    if (existsSync(pagesDir)) {
      const { readdirSync, readFileSync } = await import("node:fs");
      for (const name of readdirSync(pagesDir)) {
        if (!name.endsWith(".md")) continue;
        for (const m of readFileSync(path.join(pagesDir, name), "utf8").matchAll(/^- (pi|opencode|claude):([^:\s]+)/gm)) {
          wanted.add(`${m[1]}:${m[2]}`);
        }
      }
    }
    const entityDb = path.join(path.dirname(paths.index), "entities.sqlite");
    if (existsSync(entityDb)) {
      const { DatabaseSync } = await import("node:sqlite");
      const side = new DatabaseSync(entityDb, { readOnly: true });
      for (const row of side.prepare("SELECT DISTINCT source, session_id FROM mentions").all() as unknown as { source: string; session_id: string }[]) {
        wanted.add(`${row.source}:${row.session_id}`);
      }
      side.close();
    }
    const sessions = [...wanted].map((key) => {
      const split = key.indexOf(":");
      return { source: key.slice(0, split), session_id: key.slice(split + 1) };
    });
    const storePath = path.join(path.dirname(paths.index), "session-summaries.json");
    emit({ ok: true, candidateSessions: sessions.length, result: await summarizeSessions({ archivePath: paths.index, storePath, sessions, model, rebuild: out["--rebuild"] === "true", limit }) });
  } else if (command === "benchmark") {
    only(out, []);
    const endpoints = serviceUrls();
    const started = Date.now();
    const model = await health(endpoints.embedder, operation.signal);
    const healthMs = Date.now() - started;
    const synthetic = Array.from({ length: 8 }, (_, i) => (`Synthetic benchmark passage ${i}: ` + "local embedding throughput sample ".repeat(50)).slice(0, 1400));
    const rounds = 3;
    const passageStarted = Date.now();
    for (let round = 0; round < rounds; round++) await embedTexts(endpoints.embedder, synthetic, "passage", operation.signal);
    const passageMs = Date.now() - passageStarted;
    const queryStarted = Date.now();
    for (let round = 0; round < rounds; round++) await embedTexts(endpoints.embedder, synthetic.slice(0, 4), "query", operation.signal);
    const queryMs = Date.now() - queryStarted;
    emit({
      ok: true,
      model: { model: model.model, revision: model.revision, dimension: model.dimension },
      healthMs,
      rounds,
      passageTextsPerSecond: synthetic.length * rounds / (passageMs / 1000),
      queryTextsPerSecond: 4 * rounds / (queryMs / 1000),
      passageMs,
      queryMs,
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
