import { readFileSync } from "node:fs";

export const ENTITY_TYPES = [
  "product",
  "person",
  "organization",
  "place",
  "software library",
  "hardware component",
  "programming language",
  "protocol or standard",
  "part number",
  "technology",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type EntityStatus = "auto" | "confirmed" | "rejected";

export interface EntityInfo {
  type: EntityType;
  aliases: string[];
  status: EntityStatus;
}

export interface EntityRegistry {
  version: 1;
  notes?: string;
  entities: Record<string, EntityInfo>;
}

function fail(path: string, detail: string): never {
  throw new Error(`entity registry ${path} violates schema: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRegistry(raw: string, path: string): EntityRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(path, `invalid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) fail(path, "top level must be an object");
  if (parsed.version !== 1) fail(path, "version must be 1");
  if (parsed.notes !== undefined && typeof parsed.notes !== "string") fail(path, "notes must be a string");
  if (!isRecord(parsed.entities)) fail(path, "entities must be an object");
  if (Object.keys(parsed.entities).length > 100_000) fail(path, "too many entities");

  const entities: Record<string, EntityInfo> = {};
  for (const [name, info] of Object.entries(parsed.entities)) {
    if (name.length < 1 || name.length > 80) fail(path, `entity name out of bounds: ${name.slice(0, 40)}`);
    if (!isRecord(info)) fail(path, `entity ${name}: info must be an object`);
    if (!ENTITY_TYPES.includes(info.type as EntityType)) {
      fail(path, `entity ${name}: unknown type ${JSON.stringify(info.type)}`);
    }
    if (info.status !== "auto" && info.status !== "confirmed" && info.status !== "rejected") {
      fail(path, `entity ${name}: status must be auto|confirmed|rejected`);
    }
    if (!Array.isArray(info.aliases) || info.aliases.length > 64) {
      fail(path, `entity ${name}: aliases must be an array of at most 64`);
    }
    const aliases: string[] = [];
    for (const alias of info.aliases) {
      if (typeof alias !== "string" || alias.length < 1 || alias.length > 80) {
        fail(path, `entity ${name}: alias out of bounds`);
      }
      aliases.push(alias);
    }
    entities[name] = { type: info.type as EntityType, aliases, status: info.status };
  }
  return { version: 1, notes: parsed.notes as string | undefined, entities };
}

export function loadRegistry(path: string): EntityRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`failed to read entity registry at ${path}: ${(error as Error).message}`);
  }
  return parseRegistry(raw, path);
}

/**
 * All matchable surface forms for an entity: canonical name, declared
 * aliases, and auto-generated separator variants (-/_/space interchangeable)
 * for multi-token names. Returns lowercase forms (matcher is case-insensitive).
 */
export function surfaceForms(name: string, aliases: string[]): string[] {
  const forms = new Set<string>();
  const bases = [name, ...aliases];
  for (const base of bases) {
    forms.add(base.toLowerCase());
    if (/[-_ ]/.test(base)) {
      const tokens = base.split(/[-_ ]+/).filter(Boolean);
      if (tokens.length > 1) {
        forms.add(tokens.join("-").toLowerCase());
        forms.add(tokens.join("_").toLowerCase());
        forms.add(tokens.join(" ").toLowerCase());
      }
    }
  }
  return [...forms].filter((f) => f.length >= 2);
}
