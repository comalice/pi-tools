import { escapeHtml } from "./server.ts";

/**
 * Canonical reference linking: the ONE place that knows how to render a
 * canonical ID as a link — typed provenance sources (pi:/opencode:/claude:/
 * wiki:/doc:/web:), entity references, and bare session/entry anchors.
 *
 * Session labels prefer the durable AI-generated summary (+ dates) from
 * session-summaries.json; summaries are best-effort and may be inaccurate —
 * the session id is always available in the link title.
 */

export interface SessionInfo {
  summary: string;
  start?: string;
  end?: string;
}

export interface LinkContext {
  token: string;
  pageExists: (slug: string) => boolean;
  entityExists: (name: string) => boolean;
  sessionInfo?: (source: string, sessionId: string) => SessionInfo | null;
}

export interface CanonicalTarget {
  href: string;
  label: string;
  title: string;
}

const TYPED_SOURCE = /^(pi|opencode|claude):([^:]{1,200})(?::([^:]{1,80}))?$/;

export function canonicalTarget(ref: string, ctx: LinkContext): CanonicalTarget | null {
  const typed = ref.match(TYPED_SOURCE);
  if (typed) {
    const [, source, sessionId, entryId] = typed;
    const info = ctx.sessionInfo?.(source, sessionId);
    const dates = info?.start ? `${info.start.slice(0, 10)}${info.end && info.end.slice(0, 10) !== info.start.slice(0, 10) ? ` → ${info.end.slice(0, 10)}` : ""}` : "";
    const label = info?.summary ?? `${source}:${sessionId.slice(0, 12)}…`;
    const title = [`${source} session ${sessionId}`, dates, info ? "AI summary — may be inaccurate" : ""]
      .filter(Boolean)
      .join(" · ");
    return {
      href: `/${ctx.token}/session/${source}/${encodeURIComponent(sessionId)}${entryId ? `#${encodeURIComponent(entryId)}` : ""}`,
      label,
      title,
    };
  }
  if (ref.startsWith("wiki:")) {
    const slug = ref.slice(5);
    if (/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) && ctx.pageExists(slug)) {
      return { href: `/${ctx.token}/page/${slug}`, label: slug, title: "wiki page" };
    }
    return null;
  }
  if (ref.startsWith("web:")) {
    const url = ref.slice(4);
    if (/^https?:\/\/\S+$/.test(url)) return { href: url, label: url, title: "external source" };
    return null;
  }
  // doc: references are local documents with no web location: render as code.
  if (ref.startsWith("doc:")) return null;
  if (ref.startsWith("entity:")) {
    const name = ref.slice(7);
    if (ctx.entityExists(name)) {
      return { href: `/${ctx.token}/entities/${encodeURIComponent(name)}`, label: name, title: "entity" };
    }
    return null;
  }
  return null;
}

export function renderCanonical(ref: string, ctx: LinkContext): string {
  const target = canonicalTarget(ref, ctx);
  if (!target) return `<code>${escapeHtml(ref)}</code>`;
  return `<a href="${escapeHtml(target.href)}" title="${escapeHtml(target.title)}">${escapeHtml(target.label)}</a>`;
}
