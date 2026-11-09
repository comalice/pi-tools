import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { marked } from "marked";
import { parsePage, type PageMeta } from "./format.ts";
import { search } from "../memory/store.ts";

// Read-only web front-end for the wiki: page index sorted by verification
// staleness, rendered pages with clickable [[links]] (missing targets shown as
// red links), staging visibility clearly marked unvetted, and full-text search
// backed by the memory archive's wiki source. Loopback-only behind a persistent
// unguessable token so the URL is stable and bookmarkable.

export interface WikiServerOptions {
  wikiDir: string;
  index?: string;
  dreamDir?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function stalenessDays(lastVerified: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(lastVerified)) / (24 * 60 * 60 * 1000)));
}

// resolveLink / resolveEntity return the href for an existing target, or null
// for a missing one (rendered as a visible red link). Raw HTML is escaped
// before rendering — pages display conversation content verbatim and must not
// inject markup — so link injection happens after escaping.
export function renderMarkdown(
  body: string,
  resolveLink: (slug: string) => string | null,
  resolveEntity: (name: string) => string | null = () => null,
): string {
  const linked = escapeHtml(body)
    .replace(/\[\[entity:([^\]|]{1,80})(?:\|([^\]]{1,160}))?\]\]/g, (_all, name, display) => {
      const href = resolveEntity(name);
      const text = display || name;
      return href ? `[${text}](${href})` : `<span class="redlink">${text} (unknown entity)</span>`;
    })
    .replace(/\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/g, (_all, slug) => {
      const href = resolveLink(slug);
      return href ? `[${slug}](${href})` : `<span class="redlink">[[${slug}]] (missing)</span>`;
    });
  return marked.parse(linked) as string;
}

interface ListedPage { meta: PageMeta; file: string; error?: string }

function listMarkdown(dir: string): ListedPage[] {
  if (!existsSync(dir)) return [];
  const pages: ListedPage[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    try {
      pages.push({ meta: parsePage(readFileSync(file, "utf8"), file).meta, file });
    } catch (error) {
      pages.push({ meta: { title: name, slug: name.replace(/\.md$/, ""), created: "", last_verified: "", tags: [], sources: [] }, file, error: (error as Error).message });
    }
  }
  return pages;
}

function loadToken(wikiDir: string): string {
  const file = path.join(wikiDir, ".admin-token");
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Wiki admin token must be a regular file");
    const token = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9-]{36}$/.test(token)) return token;
    throw new Error("Wiki admin token file is malformed; delete it to regenerate");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    const token = randomUUID();
    writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    const gitignore = path.join(wikiDir, ".gitignore");
    const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    if (!current.split("\n").includes(".admin-token")) writeFileSync(gitignore, current + ".admin-token\n");
    return token;
  }
}

const STYLE = `body{font:15px system-ui;margin:2rem auto;max-width:60rem;line-height:1.5}
nav{margin-bottom:1.5rem}nav a{margin-right:1rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
.meta{color:#555;font-size:.9em}.meta td{border:none;padding:1px 8px 1px 0}
code,pre{background:#f4f4f4}pre{padding:.75rem;overflow-x:auto}code{padding:0 .2em}
.redlink{color:#c00;font-weight:600}
.stale{color:#c00}.fresh{color:#060}
.banner{background:#fff3cd;border:1px solid #e0c46c;padding:.5rem .75rem;margin-bottom:1rem}
input[type=search]{width:24rem;padding:.3rem}
mark{background:#ff9}
.entry{margin:0 0 1.25rem}.entry .head{color:#555;font-size:.85em;margin-bottom:.15rem}
.entry pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:.5rem .75rem}
.entry:target pre{background:#fff3cd}
.entry.user pre{border-left:3px solid #6c9}.entry.assistant pre{border-left:3px solid #69c}`;

function chrome(title: string, token: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style>
<nav><a href="/${token}/">pages</a><a href="/${token}/staging">staging</a><a href="/${token}/entities">entities</a>
<form style="display:inline" action="/${token}/search"><input type="search" name="q" placeholder="search the wiki…"></form>
<span id="dream"></span></nav>
${body}`;
}

// Turns a typed source identifier into a link: conversation sources deep-link
// into the session viewer, wiki sources into pages, web sources externally.
export function sourceLink(source: string, token: string): string {
  const escaped = escapeHtml(source);
  const match = source.match(/^([a-z]+):(.+)$/);
  if (!match) return `<code>${escaped}</code>`;
  const [, kind, rest] = match;
  if (kind === "wiki" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(rest)) return `<a href="/${token}/page/${rest}"><code>${escaped}</code></a>`;
  if (kind === "web") return `<a href="${escapeHtml(rest)}" rel="noreferrer"><code>${escaped}</code></a>`;
  if (kind === "pi" || kind === "opencode" || kind === "claude") {
    const split = rest.lastIndexOf(":");
    const session = split > 0 ? rest.slice(0, split) : rest;
    const entry = split > 0 ? rest.slice(split + 1) : "";
    if (session.length > 200 || entry.length > 200) return `<code>${escaped}</code>`;
    return `<a href="/${token}/session/${kind}/${encodeURIComponent(session)}${entry ? `#${encodeURIComponent(entry)}` : ""}"><code>${escaped}</code></a>`;
  }
  return `<code>${escaped}</code>`;
}

function metaTable(meta: PageMeta, token: string): string {
  const stale = stalenessDays(meta.last_verified);
  return `<table class="meta">
<tr><td>created</td><td>${escapeHtml(meta.created)}</td><td>last verified</td><td class="${stale > 30 ? "stale" : "fresh"}">${escapeHtml(meta.last_verified)} (${stale}d ago)</td></tr>
<tr><td>tags</td><td colspan="3">${escapeHtml(meta.tags.join(", ") || "—")}</td></tr>
<tr><td>sources</td><td colspan="3">${meta.sources.map(s => sourceLink(s, token)).join("<br>") || "—"}</td></tr>
</table>`;
}

async function dreamConsoleUrl(dreamDir: string): Promise<string | null> {
  try {
    const state = JSON.parse(readFileSync(path.join(dreamDir, "state.json"), "utf8"));
    if (state.done || typeof state.token !== "string") return null;
    for (let port = 6339; port <= 6348; port++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/admin/${state.token}/state.json`, { signal: AbortSignal.timeout(400) });
        if (response.ok) return `http://127.0.0.1:${port}/admin/${state.token}/`;
      } catch { /* try next port */ }
    }
  } catch { /* no run state */ }
  return null;
}

export function createWikiServer(options: WikiServerOptions): { server: Server; token: string } {
  const wikiDir = options.wikiDir;
  const pagesDir = path.join(wikiDir, "pages");
  const stagingDir = path.join(wikiDir, "staging");
  const token = loadToken(wikiDir);
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const index = options.index ?? process.env.PI_MEMORY_INDEX ?? path.join(agent, "memory", "archive.sqlite");
  const dreamDir = options.dreamDir ?? path.join(agent, "dream");
  let archive: DatabaseSync | null = null;
  const getArchive = () => {
    if (!archive && existsSync(index)) {
      archive = new DatabaseSync(index, { readOnly: true });
      archive.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    }
    return archive;
  };
  let dreamCache: { at: number; url: string | null } = { at: 0, url: null };
  const dreamUrl = async () => {
    if (Date.now() - dreamCache.at > 60_000) dreamCache = { at: Date.now(), url: await dreamConsoleUrl(dreamDir) };
    return dreamCache.url;
  };
  const pageExists = (slug: string) => existsSync(path.join(pagesDir, `${slug}.md`));
  const entityDbPath = path.join(path.dirname(index), "entities.sqlite");
  let entityDb: DatabaseSync | null | undefined;
  const getEntityDb = () => {
    if (entityDb === undefined) {
      entityDb = existsSync(entityDbPath) ? new DatabaseSync(entityDbPath, { readOnly: true }) : null;
      entityDb?.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    }
    return entityDb;
  };
  const getRegistry = () => {
    const file = path.join(wikiDir, "entities.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as {
        entities: Record<string, { type: string; aliases: string[]; status: string }>;
      };
    } catch {
      return null;
    }
  };
  const resolveEntity = (name: string) => {
    const registry = getRegistry();
    return registry?.entities[name] ? `/${token}/entities/${encodeURIComponent(name)}` : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (html: string, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
    const notFound = () => { res.writeHead(404); res.end(); };
    if (!url.pathname.startsWith(`/${token}`)) return notFound();
    const route = url.pathname.slice(token.length + 2).replace(/\/+$/, "");

    if (route === "") {
      const pages = listMarkdown(pagesDir).sort((a, b) => a.meta.last_verified.localeCompare(b.meta.last_verified));
      const rows = pages.map(p => {
        const stale = p.meta.last_verified ? stalenessDays(p.meta.last_verified) : null;
        return `<tr><td><a href="/${token}/page/${escapeHtml(p.meta.slug)}">${escapeHtml(p.meta.title)}</a>${p.error ? ` <span class="redlink">parse error</span>` : ""}</td><td>${escapeHtml(p.meta.tags.join(", "))}</td><td class="${stale !== null && stale > 30 ? "stale" : ""}">${stale === null ? "—" : `${stale}d`}</td></tr>`;
      }).join("\n");
      const dream = await dreamUrl();
      return send(chrome("wiki", token, `
${dream ? `<p><a href="${escapeHtml(dream)}">dream runner console (active run)</a></p>` : ""}
<p>${pages.length} pages, sorted by verification staleness (most stale first).</p>
<table><tr><th>page</th><th>tags</th><th>staleness</th></tr>${rows}</table>`));
    }

    if (route === "staging") {
      const entries = listMarkdown(stagingDir);
      const rows = entries.map(p => `<tr><td><a href="/${token}/staging/${encodeURIComponent(path.basename(p.file))}">${escapeHtml(p.meta.title)}</a></td><td>${p.meta.sources.map(s => `<code>${escapeHtml(s)}</code>`).join("<br>")}</td></tr>`).join("\n");
      return send(chrome("staging — wiki", token, `
<div class="banner"><b>Unvetted.</b> Staging is raw dream-mode output awaiting librarian review; nothing here is indexed or trusted.</div>
<p>${entries.length} staging entries.</p>
<table><tr><th>entry</th><th>sources</th></tr>${rows}</table>`));
    }

    const stagingMatch = route.match(/^staging\/(.+\.md)$/);
    if (stagingMatch) {
      const name = path.basename(stagingMatch[1]);
      const file = path.join(stagingDir, name);
      if (!existsSync(file)) return notFound();
      try {
        const page = parsePage(readFileSync(file, "utf8"), file);
        return send(chrome(`${page.meta.title} — staging`, token, `
<div class="banner"><b>Unvetted staging entry.</b> Claims here are not yet verified or curated.</div>
<h1>${escapeHtml(page.meta.title)}</h1>${metaTable(page.meta, token)}${renderMarkdown(page.body, () => null)}`));
      } catch (error) {
        return send(chrome("staging error", token, `<p class="redlink">${escapeHtml((error as Error).message)}</p>`));
      }
    }

    const pageMatch = route.match(/^page\/([a-z0-9][a-z0-9-]{0,79})$/);
    if (pageMatch) {
      const file = path.join(pagesDir, `${pageMatch[1]}.md`);
      if (!existsSync(file)) return notFound();
      try {
        const page = parsePage(readFileSync(file, "utf8"), file);
        return send(chrome(page.meta.title, token, `<h1>${escapeHtml(page.meta.title)}</h1>${metaTable(page.meta, token)}${renderMarkdown(page.body, slug => (pageExists(slug) ? `/${token}/page/${slug}` : null), resolveEntity)}`));
      } catch (error) {
        return send(chrome("page error", token, `<p class="redlink">${escapeHtml((error as Error).message)}</p>`));
      }
    }

    if (route === "entities") {
      const registry = getRegistry();
      if (!registry) return send(chrome("entities — wiki", token, `<p>No <code>entities.json</code> registry in the wiki yet.</p>`));
      const db = getEntityDb();
      const counts = new Map<string, { mentions: number; docs: number }>();
      if (db) {
        for (const row of db.prepare("SELECT entity, SUM(count) AS mentions, COUNT(*) AS docs FROM mentions GROUP BY entity").all() as any[]) {
          counts.set(row.entity, { mentions: row.mentions, docs: row.docs });
        }
      }
      const rows = Object.entries(registry.entities)
        .filter(([, info]) => info.status !== "rejected")
        .sort((a, b) => (counts.get(b[0])?.mentions ?? 0) - (counts.get(a[0])?.mentions ?? 0))
        .map(([name, info]) => {
          const c = counts.get(name);
          return `<tr><td><a href="/${token}/entities/${encodeURIComponent(name)}">${escapeHtml(name)}</a></td><td>${escapeHtml(info.type)}</td><td>${escapeHtml(info.status)}</td><td>${c?.mentions ?? "—"}</td><td>${c?.docs ?? "—"}</td></tr>`;
        }).join("\n");
      return send(chrome("entities — wiki", token, `
${db ? "" : `<div class="banner">No mention index at <code>${escapeHtml(entityDbPath)}</code>; run <code>memory entity-scan</code>.</div>`}
<p>${Object.keys(registry.entities).length} entities in the registry.</p>
<table><tr><th>entity</th><th>type</th><th>status</th><th>mentions</th><th>documents</th></tr>${rows}</table>`));
    }

    const entityMatch = route.match(/^entities\/(.{1,160})$/);
    if (entityMatch) {
      const name = decodeURIComponent(entityMatch[1]);
      const registry = getRegistry();
      const info = registry?.entities[name];
      if (!info) return notFound();
      const db = getEntityDb();
      let rows = "";
      let total = 0;
      if (db) {
        const mentions = db.prepare("SELECT source, session_id, entry_id, count FROM mentions WHERE entity=? ORDER BY count DESC LIMIT 500").all(name) as any[];
        total = (db.prepare("SELECT COUNT(*) AS n FROM mentions WHERE entity=?").get(name) as any)?.n ?? 0;
        rows = mentions.map(m => {
          const href = `/${token}/session/${escapeHtml(m.source)}/${encodeURIComponent(m.session_id)}${m.entry_id ? `#${encodeURIComponent(m.entry_id)}` : ""}`;
          return `<tr><td><a href="${href}">${escapeHtml(m.source)}:${escapeHtml(m.session_id.slice(0, 18))}…</a></td><td>${m.entry_id ? `<code>${escapeHtml(m.entry_id)}</code>` : ""}</td><td>${m.count}</td></tr>`;
        }).join("\n");
      }
      return send(chrome(`${name} — entity`, token, `
<h1>${escapeHtml(name)}</h1>
<table class="meta"><tr><td>type</td><td>${escapeHtml(info.type)}</td><td>status</td><td>${escapeHtml(info.status)}</td></tr>
${info.aliases.length ? `<tr><td>aliases</td><td colspan="3">${info.aliases.map(a => `<code>${escapeHtml(a)}</code>`).join(" ")}</td></tr>` : ""}</table>
${db ? (total > 500 ? `<p class="banner">Showing first 500 of ${total} mention documents.</p>` : `<p>${total} mention document${total === 1 ? "" : "s"}.</p>`) : `<div class="banner">No mention index; run <code>memory entity-scan</code>.</div>`}
<table><tr><th>session</th><th>entry</th><th>mentions</th></tr>${rows}</table>`));
    }

    const sessionMatch = route.match(/^session\/(pi|opencode|claude)\/([^/]{1,200})$/);
    if (sessionMatch) {
      const [, source, sessionId] = sessionMatch;
      const db = getArchive();
      if (!db) return send(chrome("session — wiki", token, `<p>The memory archive is not available; run <code>memory ingest</code>.</p>`));
      const meta = db.prepare("SELECT project, title FROM sessions WHERE source=? AND session_id=?").get(source, sessionId) as any;
      if (!meta) return notFound();
      const rows = db.prepare("SELECT entry_id, role, timestamp, text FROM entries WHERE source=? AND session_id=? AND indexable=1 AND text<>'' ORDER BY rowid LIMIT 1000").all(source, sessionId) as any[];
      const total = (db.prepare("SELECT COUNT(*) AS n FROM entries WHERE source=? AND session_id=? AND indexable=1 AND text<>''").get(source, sessionId) as any)?.n ?? 0;
      const CLAMP = 8000;
      const entries = rows.map(row => {
        const text = row.text.length > CLAMP ? `${row.text.slice(0, CLAMP)}\n… [clamped, ${row.text.length - CLAMP} more characters]` : row.text;
        return `<section class="entry ${escapeHtml(row.role)}" id="${escapeHtml(row.entry_id)}"><div class="head"><b>${escapeHtml(row.role)}</b> · ${escapeHtml(row.timestamp ?? "undated")} · <code>${escapeHtml(row.entry_id)}</code></div><pre>${escapeHtml(text)}</pre></section>`;
      }).join("\n");
      return send(chrome(`session ${sessionId.slice(0, 12)} — wiki`, token, `
<h1>${escapeHtml(meta.title ?? sessionId)}</h1>
<table class="meta"><tr><td>source</td><td>${escapeHtml(source)}</td><td>project</td><td>${escapeHtml(meta.project)}</td></tr>
<tr><td>session</td><td colspan="3"><code>${escapeHtml(sessionId)}</code></td></tr></table>
${total > rows.length ? `<p class="banner">Showing first ${rows.length} of ${total} messages.</p>` : ""}
${entries || "<p>No indexed messages in this session.</p>"}`));
    }

    if (route === "search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) return send(chrome("search — wiki", token, "<p>Enter a query above.</p>"));
      const db = getArchive();
      if (!db) return send(chrome("search — wiki", token, `<p>The memory archive is not available at <code>${escapeHtml(index)}</code>; run <code>memory ingest</code>.</p>`));
      const results = search(db, { query, source: "wiki", scope: "all", limit: 20 });
      const rows = results.map(r => `<tr><td><a href="/${token}/page/${escapeHtml(r.session_id)}">${escapeHtml(r.session_id)}</a></td><td>${escapeHtml(r.excerpt)}</td></tr>`).join("\n");
      return send(chrome(`search: ${query} — wiki`, token, `
<p>${results.length} result${results.length === 1 ? "" : "s"} for <b>${escapeHtml(query)}</b> (archive lexical search, wiki source).</p>
<table><tr><th>page</th><th>excerpt</th></tr>${rows}</table>`));
    }

    return notFound();
  });
  return { server, token };
}

export function serveWiki(options: WikiServerOptions & { port: number }): void {
  const { server, token } = createWikiServer(options);
  const listen = (port: number, attempt = 0) => {
    server.once("error", (error: any) => {
      if (error?.code === "EADDRINUSE" && attempt < 9) listen(port + 1, attempt + 1);
      else throw error;
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`[wiki] front-end: http://127.0.0.1:${port}/${token}/`);
    });
  };
  listen(options.port);
}
