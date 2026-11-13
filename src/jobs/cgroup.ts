import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const mount = "/sys/fs/cgroup";
export function ownCgroup(): string {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(s => s.startsWith("0::"));
  if (!line) throw new Error("cgroup v2 membership unavailable");
  return line.slice(3);
}

// A missing cgroup is empty. Inspection failures other than removal must not be
// treated as evidence of completion. Nested cgroups can disappear while read.
export function cgroupPopulated(group: string, exceptPid?: number, missingIsEmpty = true): boolean {
  if (!group.startsWith("/") || group.split("/").includes("..")) throw new Error("invalid cgroup path");
  const root = path.join(mount, group);
  if (exceptPid === undefined) {
    try {
      const events = readFileSync(path.join(root, "cgroup.events"), "utf8");
      const populated = /^populated ([01])$/m.exec(events);
      if (!populated) throw new Error("cgroup populated state unavailable");
      return populated[1] === "1";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && missingIsEmpty) return false;
      throw e;
    }
  }
  function scan(dir: string): boolean {
    try {
      const pids = readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
      if (pids.some(pid => pid !== exceptPid)) return true;
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && scan(path.join(dir, entry.name))) return true;
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && (dir !== root || missingIsEmpty)) return false;
      throw e;
    }
  }
  return scan(root);
}
