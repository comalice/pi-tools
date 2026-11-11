import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export function defaultHubGitRoot() {
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agent, "wiki-git");
}

function git(command: string[]) {
  const result = spawnSync("git", command, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`git ${command.join(" ")} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
}

export function ensureHubGitRepository(gitRoot = defaultHubGitRoot()) {
  mkdirSync(gitRoot, { recursive: true, mode: 0o700 });
  const stat = lstatSync(gitRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Hub Git root must be a real directory: ${gitRoot}`);
  const repo = path.join(gitRoot, "wiki.git");
  if (!existsSync(repo)) git(["init", "--bare", repo]);
  const repoStat = lstatSync(repo);
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) throw new Error(`Hub wiki repository must be a real directory: ${repo}`);
  return repo;
}

export function initializeHubGit(gitRoot: string, wikiDir: string) {
  const repo = ensureHubGitRepository(gitRoot);
  const stat = lstatSync(wikiDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Hub wiki checkout must be a real directory: ${wikiDir}`);
  const hasOrigin = spawnSync("git", ["-C", wikiDir, "remote", "get-url", "origin"], { encoding: "utf8" }).status === 0;
  git(["-C", wikiDir, "remote", hasOrigin ? "set-url" : "add", "origin", repo]);
  return { repo, wikiDir, origin: repo };
}

function badRequest(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`${message}\n`);
}

function decodeRepo(pathInfo: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(pathInfo); } catch { return null; }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return null;
  const segments = decoded.slice(1).split("/");
  if (segments[0] !== "wiki.git" || segments.some(part => !part || part === ".." || part === "." || !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  return decoded;
}

/** Run Git's supported smart-HTTP CGI backend after the hub has authenticated the request. */
export function handleGitHttp(req: IncomingMessage, res: ServerResponse, pathname: string, query: string, spoke: string, gitRoot: string) {
  const pathInfo = pathname.slice("/git".length);
  const decodedPath = decodeRepo(pathInfo);
  if (!decodedPath) return badRequest(res, 404, "Unknown Git repository");

  try { ensureHubGitRepository(gitRoot); } catch (error) {
    return badRequest(res, 500, `Could not initialize hub Git repository: ${(error as Error).message}`);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === "authorization" || value === undefined) continue;
    const cgiName = `HTTP_${name.toUpperCase().replace(/-/g, "_")}`;
    headers[cgiName] = Array.isArray(value) ? value.join(", ") : value;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: path.resolve(gitRoot),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: decodedPath,
    PATH_TRANSLATED: path.join(path.resolve(gitRoot), ...decodedPath.slice(1).split("/")),
    QUERY_STRING: query,
    REQUEST_METHOD: req.method ?? "GET",
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    CONTENT_LENGTH: req.headers["content-length"] ?? "",
    SERVER_PROTOCOL: req.httpVersion ? `HTTP/${req.httpVersion}` : "HTTP/1.1",
    SERVER_NAME: req.headers.host?.split(":")[0] ?? "localhost",
    SERVER_PORT: String(req.socket.localPort ?? "80"),
    REMOTE_ADDR: req.socket.remoteAddress ?? "",
    REMOTE_USER: spoke,
    SCRIPT_NAME: "/git",
    REQUEST_URI: req.url ?? pathname,
    ...headers,
  };
  const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let headerBuffer = Buffer.alloc(0);
  let responseStarted = false;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on("data", (chunk: Buffer) => {
    if (responseStarted) { res.write(chunk); return; }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const crlf = headerBuffer.indexOf("\r\n\r\n");
    const lf = crlf < 0 ? headerBuffer.indexOf("\n\n") : crlf;
    if (lf < 0) return;
    const separatorLength = crlf >= 0 ? 4 : 2;
    const headerText = headerBuffer.subarray(0, lf).toString("utf8");
    const body = headerBuffer.subarray(lf + separatorLength);
    const responseHeaders: Record<string, string> = {};
    let status = 200;
    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
      else responseHeaders[name] = value;
    }
    responseStarted = true;
    res.writeHead(status, responseHeaders);
    if (body.length) res.write(body);
    headerBuffer = Buffer.alloc(0);
  });
  child.once("error", error => {
    if (!responseStarted && !res.headersSent) {
      responseStarted = true;
      badRequest(res, 502, `Could not start git http-backend: ${error.message}`);
    } else res.destroy(error);
  });
  child.once("close", code => {
    if (!responseStarted) {
      responseStarted = true;
      badRequest(res, 502, `git http-backend returned no CGI response${stderr ? `: ${stderr.trim()}` : ` (exit ${code})`}`);
    } else if (!res.writableEnded) res.end();
  });
  res.once("close", () => { if (!res.writableEnded) child.kill(); });
  req.on("error", error => child.stdin.destroy(error));
  child.stdin.on("error", () => { /* backend may close stdin after rejecting a request */ });
  req.pipe(child.stdin);
}
