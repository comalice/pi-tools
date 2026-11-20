// This process is the systemd service main process. It never uses a shell.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { openDb, pokeControllerAsync } from "./core.ts";
import { cgroupPopulated, ownCgroup } from "./cgroup.ts";

const [dir, id] = process.argv.slice(2);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function busy(e: unknown) { return /database (?:is )?(?:locked|busy)/i.test(String(e)); }
async function retry<T>(fn: () => T): Promise<T> {
  for (;;) {
    try { return fn(); } catch (e) { if (!busy(e)) throw e; await delay(100); }
  }
}
const db = await retry(() => openDb(dir));
// The claim is irreversible even if the runner dies before spawning.
const claimed = await retry(() => db.prepare("UPDATE jobs SET execution_claimed=1 WHERE id=? AND execution_claimed=0 AND cancel_requested=0 AND state IN ('launching','running')").run(id));
if (!claimed.changes) { db.close(); process.exit(1); }
const r = db.prepare("SELECT argv,cwd,log FROM jobs WHERE id=?").get(id) as { argv: string; cwd: string; log: string } | undefined;
if (!r) throw new Error("job reservation missing");
const argv = JSON.parse(r.argv) as string[];
const log = openSync(r.log, "a", 0o600);

// Wait for the service cgroup, including nested cgroups, to contain only this
// runner. A foreground launcher can exit while its background workers live.
// Do not guess success if cgroup membership cannot be inspected.
function otherProcesses(): boolean { return cgroupPopulated(ownCgroup(), process.pid, false); }
let finished = false;
async function finish(code: number | null, signal: string | null, error: string | null) {
  if (finished) return;
  finished = true;
  for (;;) {
    try { if (!otherProcesses()) break; } catch { /* Preserve a nonterminal state until membership is readable. */ }
    await delay(100);
  }
  await retry(() => db.prepare("UPDATE jobs SET state=?, exit_code=?, signal=?, error=?, finished=? WHERE id=? AND cancel_requested=0 AND state IN ('running','launching')").run(code === 0 && !signal && !error ? "succeeded" : "failed", code, signal, error, new Date().toISOString(), id));
  closeSync(log); db.close();
  await pokeControllerAsync(dir);
  process.exitCode = code === 0 && !signal && !error ? 0 : 1;
}
try {
  const child = spawn(argv[0], argv.slice(1), { cwd: r.cwd, stdio: ["ignore", log, log], shell: false });
  child.once("error", e => { void finish(null, null, String(e)); });
  child.once("exit", (code, signal) => { void finish(code, signal, null); });
} catch (e) { await finish(null, null, String(e)); }
