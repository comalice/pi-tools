/**
 * Gazetteer: dictionary matcher for known entities (Aho-Corasick).
 *
 * Case-insensitive. A match is only accepted on token boundaries: the
 * characters flanking the match must not be token characters, where token
 * characters are [a-z0-9-_]. Treating '-' and '_' as token characters means
 * "maxl-cl-4070" does NOT match inside "maxl-cl-4070-15" — the specific
 * entity wins; family rollup is a query-time concern, not a matching one.
 */

export interface GazetteerHit {
  /** Canonical entity name (as registered). */
  entity: string;
  /** Byte/char offset of the match start in the searched text. */
  offset: number;
  /** Matched surface form (lowercased). */
  surface: string;
}

interface Node {
  next: Map<string, number>;
  fail: number;
  /** pattern indexes ending at this node */
  out: number[];
}

const TOKEN_CHAR = /[a-z0-9\-_]/;

function isTokenChar(ch: string | undefined): boolean {
  return ch !== undefined && TOKEN_CHAR.test(ch);
}

export class Gazetteer {
  private nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  /** pattern index -> { entity, surface } */
  private patterns: { entity: string; surface: string }[] = [];
  private entitySet = new Set<string>();

  /** entries: [canonicalName, surfaceForm][] — surfaces must be lowercase. */
  constructor(entries: [string, string][]) {
    for (const [entity, surface] of entries) {
      this.addPattern(entity, surface);
    }
    this.buildFailures();
  }

  /** True when the canonical entity name is in this gazetteer. */
  has(entity: string): boolean {
    return this.entitySet.has(entity);
  }

  private addPattern(entity: string, surface: string): void {
    let cur = 0;
    for (const ch of surface) {
      const node = this.nodes[cur];
      let nxt = node.next.get(ch);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, out: [] });
        node.next.set(ch, nxt);
      }
      cur = nxt;
    }
    this.nodes[cur].out.push(this.patterns.length);
    this.patterns.push({ entity, surface });
    this.entitySet.add(entity);
  }

  private buildFailures(): void {
    const queue: number[] = [];
    const root = this.nodes[0];
    for (const [, child] of root.next) {
      this.nodes[child].fail = 0;
      queue.push(child);
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const [ch, nxt] of this.nodes[cur].next) {
        queue.push(nxt);
        let f = this.nodes[cur].fail;
        while (f !== 0 && !this.nodes[f].next.has(ch)) {
          f = this.nodes[f].fail;
        }
        const candidate = this.nodes[f].next.get(ch);
        this.nodes[nxt].fail = candidate !== undefined && candidate !== nxt ? candidate : 0;
        // inherit outputs from failure target (suffix patterns)
        this.nodes[nxt].out.push(...this.nodes[this.nodes[nxt].fail].out);
      }
    }
  }

  /** Find all boundary-respecting entity mentions in text (any case). */
  find(text: string): GazetteerHit[] {
    const lower = text.toLowerCase();
    const hits: GazetteerHit[] = [];
    let cur = 0;
    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];
      while (cur !== 0 && !this.nodes[cur].next.has(ch)) {
        cur = this.nodes[cur].fail;
      }
      cur = this.nodes[cur].next.get(ch) ?? 0;
      for (const p of this.nodes[cur].out) {
        const { entity, surface } = this.patterns[p];
        const start = i - surface.length + 1;
        const end = i + 1;
        if (isTokenChar(lower[start - 1]) || isTokenChar(lower[end])) {
          continue;
        }
        hits.push({ entity, offset: start, surface });
      }
    }
    return hits;
  }

  get size(): number {
    return this.patterns.length;
  }
}

/** Convenience: does this text mention this entity? (For query-time checks.) */
export function mentionsEntity(gazetteer: Gazetteer, text: string, entity: string): boolean {
  return gazetteer.find(text).some((h) => h.entity === entity);
}
