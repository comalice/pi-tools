import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage, serializePage, slugify, today, type PageMeta } from "./format.ts";
import { writeStaging } from "./staging.ts";
import { runSurvey } from "./survey.ts";
import { serveWiki } from "./server.ts";

const MAX_STAGING_CHARS = 64_000;

function wikiDir(options: Record<string, string>): string {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return options["--wiki-dir"] || process.env.PI_WIKI_DIR || path.join(agent, "wiki");
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | string[]> = {};
  const flags = new Set(["--staging", "--counts-only"]);
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (flags.has(arg)) { out[arg] = "true"; continue; }
      if (!argv[i + 1]) throw new Error(`Missing value for ${arg}`);
      const value = argv[++i];
      if (arg === "--entry") {
        const previous = out[arg];
        out[arg] = previous ? [...(previous as string[]), value] : [value];
      } else {
        if (out[arg]) throw new Error(`Repeated flag: ${arg}`);
        out[arg] = value;
      }
    } else if (!command) {
      command = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { command, out };
}

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assertRealDirectory(dir: string, what: string) {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${what} must be a real directory: ${dir}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
      if (data.length > MAX_STAGING_CHARS) reject(new Error(`Staging body exceeds ${MAX_STAGING_CHARS} characters`));
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function listDir(dir: string, suffix: string): any[] {
  if (!existsSync(dir)) return [];
  assertRealDirectory(dir, "Wiki directory");
  const pages: any[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(suffix)) continue;
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    try {
      const { meta } = parsePage(readFileSync(file, "utf8"), file);
      pages.push({ slug: meta.slug, title: meta.title, last_verified: meta.last_verified, tags: meta.tags, file });
    } catch (error) {
      pages.push({ file, error: (error as Error).message });
    }
  }
  return pages;
}

const PAGE_BODY = `## Summary

<one paragraph>

## Details

## Sources

- <identifier>: <what it supports>
`;

try {
  const { command, out } = parseArgs(process.argv.slice(2));
  const root = wikiDir(out as Record<string, string>);
  const value = (key: string) => out[key] as string | undefined;

  if (command === "init") {
    const pages = path.join(root, "pages");
    const staging = path.join(root, "staging");
    mkdirSync(pages, { recursive: true, mode: 0o700 });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const conventions = path.join(root, "CONVENTIONS.md");
    let wroteConventions = false;
    if (!existsSync(conventions)) {
      const template = fileURLToPath(new URL("./templates/CONVENTIONS.md", import.meta.url));
      writeFileSync(conventions, readFileSync(template, "utf8"), { mode: 0o600, flag: "wx" });
      wroteConventions = true;
    }
    let git = false;
    if (!existsSync(path.join(root, ".git"))) {
      execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
      git = true;
    }
    emit({ ok: true, root, pages, staging, conventions: wroteConventions ? "written" : "exists", gitInitialized: git });
  } else if (command === "new") {
    const title = value("--title");
    if (!title) throw new Error("new requires --title");
    const slug = value("--slug") ?? slugify(title);
    const tags = value("--tags") ? value("--tags")!.split(",").map(tag => tag.trim()).filter(Boolean) : [];
    assertRealDirectory(root, "Wiki root");
    const file = path.join(root, "pages", `${slug}.md`);
    const meta: PageMeta = { title, slug, created: today(), last_verified: today(), tags, sources: [] };
    writeFileSync(file, serializePage(meta, PAGE_BODY), { mode: 0o600, flag: "wx" });
    emit({ ok: true, path: file, slug });
  } else if (command === "stage") {
    const title = value("--title");
    const session = value("--session");
    if (!title || !session) throw new Error("stage requires --title and --session");
    const slug = value("--slug") ?? slugify(title);
    const entries = (out["--entry"] ? (Array.isArray(out["--entry"]) ? out["--entry"] : [out["--entry"]]) : []) as string[];
    const sourceKind = value("--source-kind") || "pi";
    if (!/^[a-z]+$/.test(sourceKind)) throw new Error("--source-kind must be lowercase letters");
    const tags = value("--tags") ? value("--tags")!.split(",").map(tag => tag.trim()).filter(Boolean) : [];
    const body = await readStdin();
    if (!body.trim()) throw new Error("stage requires a body on stdin");
    assertRealDirectory(root, "Wiki root");
    const staged = writeStaging({ wikiDir: root, title, tags, sourceKind, session, entries, body, slugOverride: value("--slug") ? slug : undefined });
    emit({ ok: true, path: staged.path, slug: staged.slug, sources: staged.sources });
  } else if (command === "list") {
    assertRealDirectory(root, "Wiki root");
    emit({ ok: true, entries: listDir(path.join(root, out["--staging"] ? "staging" : "pages"), ".md") });
  } else if (command === "survey") {
    assertRealDirectory(root, "Wiki root");
    const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const index = value("--index") || process.env.PI_MEMORY_INDEX || path.join(agent, "memory", "archive.sqlite");
    emit({ ok: true, survey: runSurvey(root, index) });
  } else if (command === "link-entities") {
    assertRealDirectory(root, "Wiki root");
    const pagesDir = path.join(root, "pages");
    const { buildGazetteer } = await import("../entity/scan.ts");
    const { linkEntityMentions } = await import("../entity/link.ts");
    const { gazetteer } = buildGazetteer(path.join(root, "entities.json"));
    const files = readdirSync(pagesDir).filter(name => name.endsWith(".md"));
    const results = [];
    let totalAdded = 0;
    for (const name of files) {
      const file = path.join(pagesDir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const original = readFileSync(file, "utf8");
      const { text, added } = linkEntityMentions(original, gazetteer);
      if (text !== original) {
        writeFileSync(file, text, { mode: 0o600 });
        results.push({ file: name, added });
        totalAdded += added;
      }
    }
    emit({ ok: true, pagesScanned: files.length, pagesChanged: results.length, linksAdded: totalAdded, changed: results });
  } else if (command === "link-pages") {
    const { linkPageMentions } = await import("./pagelinks.ts");
    const pagesDir = path.join(root, "pages");
    const files = readdirSync(pagesDir).filter(name => name.endsWith(".md"));
    const pages = files.map(name => {
      const parsed = parsePage(readFileSync(path.join(pagesDir, name), "utf8"), name);
      return { slug: parsed.meta.slug, title: parsed.meta.title };
    });
    const results = [];
    let totalAdded = 0;
    for (const name of files) {
      const file = path.join(pagesDir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const original = readFileSync(file, "utf8");
      const own = parsePage(original, name).meta.slug;
      const { text, added } = linkPageMentions(original, pages, own);
      if (text !== original) {
        writeFileSync(file, text, { mode: 0o600 });
        results.push({ file: name, added });
        totalAdded += added;
      }
    }
    emit({ ok: true, pagesScanned: files.length, pagesChanged: results.length, linksAdded: totalAdded, changed: results });
  } else if (command === "serve") {
    assertRealDirectory(root, "Wiki root");
    const port = Number(value("--port") ?? process.env.PI_WIKI_PORT ?? 6341);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be an integer from 1024 to 65535");
    serveWiki({ wikiDir: root, port });
  } else {
    throw new Error("Usage: wiki <init|new|stage|list|survey|link-entities|link-pages|serve> [flags]");
  }
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
