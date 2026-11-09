import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializePage, slugify, today, type PageMeta } from "./format.ts";

// Shared staging writer: one deterministic file per (session, title, entries),
// so a retried extractor overwrites its own output instead of duplicating, while
// distinct topics from the same session never collide.
export function safeSlug(title: string): string {
  for (const cut of [title, title.slice(0, 60), title.slice(0, 40)]) {
    try { return slugify(cut); } catch { /* try a shorter cut */ }
  }
  return `x-${createHash("sha256").update(title).digest("hex").slice(0, 12)}`;
}

export function writeStaging(opts: { wikiDir: string; title: string; tags: string[]; sourceKind: string; session: string; entries: string[]; body: string; slugOverride?: string }): { path: string; slug: string; sources: string[] } {
  const slug = opts.slugOverride ?? safeSlug(opts.title);
  const fingerprint = createHash("sha256").update([opts.session, slug, ...opts.entries].join("\0")).digest("hex").slice(0, 8);
  const dir = path.join(opts.wikiDir, "staging");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${today()}-${slug}-${fingerprint}.md`);
  const sources = opts.entries.length ? opts.entries.map(entry => `${opts.sourceKind}:${opts.session}:${entry}`) : [`${opts.sourceKind}:${opts.session}`];
  const meta: PageMeta = { title: opts.title, slug, created: today(), last_verified: today(), tags: opts.tags, sources };
  writeFileSync(file, serializePage(meta, opts.body), { mode: 0o600 });
  return { path: file, slug, sources };
}
