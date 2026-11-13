// This process is the systemd service main process. It never uses a shell.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { openDb } from "./core.ts";

const [dir, id] = process.argv.slice(2);
const db = openDb(dir);
const r = db.prepare("SELECT argv,cwd,log FROM jobs WHERE id=?").get(id) as { argv: string; cwd: string; log: string } | undefined;
if (!r) throw new Error("job reservation missing");
const argv = JSON.parse(r.argv) as string[];
const log = openSync(r.log, "a", 0o600);
let finished = false;
function finish(code: number | null, signal: string | null, error: string | null) {
  if (finished) return;
  finished = true;
  db.prepare("UPDATE jobs SET state=?, exit_code=?, signal=?, error=?, finished=? WHERE id=? AND state IN ('running','launching')").run(code === 0 && !signal && !error ? "succeeded" : "failed", code, signal, error, new Date().toISOString(), id);
  closeSync(log); db.close();
  process.exitCode = code === 0 && !signal && !error ? 0 : 1;
}
try {
  const child = spawn(argv[0], argv.slice(1), { cwd: r.cwd, stdio: ["ignore", log, log], shell: false });
  child.once("error", e => finish(null, null, String(e)));
  child.once("exit", (code, signal) => finish(code, signal, null));
} catch (e) { finish(null, null, String(e)); }
