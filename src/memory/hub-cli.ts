import os from "node:os";
import path from "node:path";
import { serveMemoryHub } from "./hub.ts";

type Options = Record<string, string>;

function parseArgs(argv: string[]) {
  const command = argv[0] ?? "";
  const out: Options = {};
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid hub argument: ${flag}`);
    if (out[flag]) throw new Error(`Repeated flag: ${flag}`);
    out[flag] = argv[++i];
  }
  return { command, out };
}

function positivePort(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("port must be an integer from 1024 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("port must be an integer from 1024 to 65535");
  return port;
}

function emit(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }

try {
  const { command, out } = parseArgs(process.argv.slice(2));
  for (const flag of Object.keys(out)) if (!["--index", "--port", "--bind"].includes(flag)) throw new Error(`Unknown flag: ${flag}`);
  if (command !== "serve") throw new Error("Usage: pi-memory-hub serve [--index FILE] [--bind ADDRESS] [--port PORT]");
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const index = out["--index"] ?? process.env.PI_MEMORY_INDEX ?? path.join(agent, "memory", "archive.sqlite");
  const port = positivePort(out["--port"] ?? process.env.PI_HUB_PORT, 6342);
  const bind = out["--bind"] ?? process.env.PI_HUB_BIND;
  serveMemoryHub({ index, port, bind });
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
