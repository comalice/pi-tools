import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerSource, replaceFileSession, replaceSession, type Entry, transaction } from "./store.ts";
import { indexableText, parsePage } from "../wiki/format.ts";

const MAX_PI_FILE = 256 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_OPENCODE_SESSIONS = 100_000;
const hash = (s: Uint8Array) => createHash("sha256").update(s).digest("hex");
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x: any) => x && x.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("\n");
}
function safeParse(line: string, file: string, lineNo: number): any {
  try { return JSON.parse(line); } catch { throw new Error(`Malformed Pi JSON at ${file}:${lineNo}; snapshot left unchanged`); }
}
function piRecords(file: string): {header:any; entries:Entry[]; fingerprint:string; size:number} {
  const st=lstatSync(file);
  if(st.isSymbolicLink()||!st.isFile())throw new Error(`Unexpected non-regular Pi session entry: ${file}`);
  if(st.size>MAX_PI_FILE)throw new Error(`Pi session exceeds ${MAX_PI_FILE} byte limit: ${file}`);
  const bytes=readFileSync(file);const end=bytes.lastIndexOf(10)+1;const complete=bytes.subarray(0,end);
  if(!end)throw new Error(`Pi session has no complete header: ${file}`);
  const lines=complete.toString("utf8").split("\n");lines.pop();let header:any;const entries:Entry[]=[];const ids=new Set<string>();
  for(let i=0;i<lines.length;i++){
    if(Buffer.byteLength(lines[i])>MAX_LINE)throw new Error(`Oversized Pi record ${i+1} in ${file}`);
    const obj=safeParse(lines[i],file,i+1);
    if(i===0){header=obj;if(obj.type!=="session"||obj.version!==3||typeof obj.id!=="string")throw new Error(`Unsupported Pi session format in ${file}; expected v3 session header`);continue;}
    if(!obj||typeof obj.id!=="string"||typeof obj.type!=="string"||ids.has(obj.id))throw new Error(`Invalid or duplicate Pi entry ${i+1} in ${file}; snapshot left unchanged`);
    ids.add(obj.id);const msg=obj.type==="message"?obj.message:null;const role=msg?.role;
    const eligible=(role==="user"||role==="assistant")&&!obj.customType&&!obj.summary&&!obj.isSummary&&!msg?.customType&&!msg?.isCustomMessage&&!msg?.custom&&!msg?.synthetic&&!msg?.summary&&!msg?.isSummary;
    let timestamp:string|null=null;
    if(msg?.timestamp||obj.timestamp){const raw=msg?.timestamp??obj.timestamp;const date=new Date(raw);timestamp=Number.isNaN(date.valueOf())?null:date.toISOString();}
    entries.push({entry_id:obj.id,parent_id:typeof obj.parentId==="string"?obj.parentId:null,role:role??null,kind:obj.type,timestamp,text:eligible?textContent(msg.content):"",indexable:eligible,metadata:{}});
  }
  return {header,entries,fingerprint:hash(complete),size:complete.length};
}
function walk(root:string):string[]{
  const out:string[]=[];const stack=[root];
  while(stack.length){const dir=stack.pop()!;const names=readdirSync(dir);
    for(const name of names){const file=path.join(dir,name);const st=lstatSync(file);if(st.isSymbolicLink())throw new Error(`Symlink in Pi sessions tree; refusing an incomplete snapshot: ${file}`);if(st.isDirectory())stack.push(file);else if(st.isFile()&&name.endsWith(".jsonl"))out.push(file);}
  }
  return out.sort();
}
export function ingestPi(db:DatabaseSync,root:string){
  const source="pi";const normalized=path.resolve(root);
  const configured=db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if(configured&&configured.root!==normalized)throw new Error(`Source ${source} is already registered at ${configured.root}; refusing to reconcile a different path`);
  let rootStat;try{rootStat=lstatSync(root);}catch(e:any){if(e?.code==="ENOENT")return {source:"pi",missing:true,indexed:0,unchanged:0,removed:0};throw e;}
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error(`Pi sessions root must be a real directory: ${root}`);
  registerSource(db,source,normalized);
  const files=walk(root);const found=new Set<string>();let indexed=0,unchanged=0;
  for(const file of files){
    const data=piRecords(file);const prior=db.prepare("SELECT session_id,fingerprint FROM source_files WHERE source=? AND file=?").get(source,file) as any;
    found.add(file);
    if(prior?.fingerprint===data.fingerprint){unchanged++;continue;}
    const sessionId=String(data.header.id);
    const duplicate=db.prepare("SELECT file FROM source_files WHERE source=? AND session_id=? AND file<>? LIMIT 1").get(source,sessionId,file) as any;
    if(duplicate)throw new Error(`Duplicate Pi session ID ${sessionId} in multiple files; snapshot left unchanged`);
    const project=data.header.cwd?path.resolve(String(data.header.cwd)):"unknown";
    replaceFileSession(db,source,file,prior?.session_id,sessionId,project,data.entries,data.fingerprint,data.size);indexed++;
  }
  const stale=(db.prepare("SELECT file,session_id FROM source_files WHERE source=?").all(source) as any[]).filter(r=>!found.has(r.file));
  let removed=0;
  if(stale.length)transaction(db,()=>{for(const row of stale){db.prepare("DELETE FROM source_files WHERE source=? AND file=?").run(source,row.file);const still=db.prepare("SELECT 1 FROM source_files WHERE source=? AND session_id=? LIMIT 1").get(source,row.session_id);if(!still){db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source,row.session_id);db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source,row.session_id);db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source,row.session_id);removed++;}}});
  return {source,indexed,unchanged,removed};
}
const MAX_WIKI_PAGE = 512 * 1024;
const MAX_WIKI_PAGES = 10_000;
const MAX_CLAUDE_FILE = 64 * 1024 * 1024;
const MAX_CLAUDE_FILES = 50_000;

// claude.ai web exports: one JSON document per conversation, chat_messages with
// uuid/parent_message_uuid/sender/content blocks. session_id is the export uuid;
// project is the constant "claude" (exports carry no working directory).
// Duplicate conversation UUIDs across export files keep the first file (sorted
// order) and are counted, never double-ingested.
function claudeRecords(file: string): { sessionId: string; entries: Entry[]; fingerprint: string; size: number } {
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Unexpected non-regular Claude export entry: ${file}`);
  if (st.size > MAX_CLAUDE_FILE) throw new Error(`Claude export exceeds ${MAX_CLAUDE_FILE} byte limit: ${file}`);
  const bytes = readFileSync(file);
  let data: any;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Malformed Claude export JSON: ${file}`); }
  if (!data || typeof data.uuid !== "string" || !Array.isArray(data.chat_messages)) throw new Error(`Unsupported Claude export format in ${file}; expected uuid and chat_messages`);
  const entries: Entry[] = []; const ids = new Set<string>();
  for (const message of data.chat_messages) {
    if (!message || typeof message.uuid !== "string" || ids.has(message.uuid)) throw new Error(`Invalid or duplicate Claude message in ${file}; snapshot left unchanged`);
    ids.add(message.uuid);
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : null;
    const text = Array.isArray(message.content) ? message.content.filter((x: any) => x && x.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("\n") : "";
    let timestamp: string | null = null;
    if (message.created_at) { const date = new Date(message.created_at); timestamp = Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
    entries.push({ entry_id: message.uuid, parent_id: typeof message.parent_message_uuid === "string" && message.parent_message_uuid !== "00000000-0000-4000-8000-000000000000" ? message.parent_message_uuid : null, role, kind: "message", timestamp, text, indexable: Boolean(role && text.trim()), metadata: {} });
  }
  return { sessionId: data.uuid, entries, fingerprint: hash(bytes), size: bytes.length };
}

export function ingestClaude(db: DatabaseSync, root: string) {
  const source = "claude"; const normalized = path.resolve(root);
  const configured = db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if (configured && configured.root !== normalized) throw new Error(`Source ${source} is already registered at ${configured.root}; refusing to reconcile a different path`);
  let rootStat;
  try { rootStat = lstatSync(root); } catch (e: any) { if (e?.code === "ENOENT") return { source, missing: true, indexed: 0, unchanged: 0, removed: 0, duplicates: 0, errors: [] as string[] }; throw e; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Claude exports root must be a real directory: ${root}`);
  registerSource(db, source, normalized);
  // Exports arrive in two layouts: flat <name>.json files and per-conversation
  // <name>/<name>.json directories; walk both.
  const files: string[] = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw new Error(`Symlink in Claude exports tree; refusing an incomplete snapshot: ${file}`);
      if (st.isDirectory()) stack.push(file); else if (st.isFile() && name.endsWith(".json")) files.push(file);
    }
  }
  files.sort();
  if (files.length > MAX_CLAUDE_FILES) throw new Error(`Claude export count exceeded ${MAX_CLAUDE_FILES}`);
  const found = new Set<string>(); const errors: string[] = []; const seen = new Map<string, string>();
  let indexed = 0, unchanged = 0, duplicates = 0;
  for (const file of files) {
    found.add(file);
    let data;
    try { data = claudeRecords(file); } catch (error) { errors.push(`${file}: ${(error as Error).message}`); continue; }
    const priorFile = seen.get(data.sessionId);
    if (priorFile) { duplicates++; found.add(priorFile); continue; }
    seen.set(data.sessionId, file);
    const prior = db.prepare("SELECT session_id,fingerprint FROM source_files WHERE source=? AND file=?").get(source, file) as any;
    if (prior?.fingerprint === data.fingerprint) { unchanged++; continue; }
    const duplicate = db.prepare("SELECT file FROM source_files WHERE source=? AND session_id=? AND file<>? LIMIT 1").get(source, data.sessionId, file) as any;
    if (duplicate) { duplicates++; continue; }
    replaceFileSession(db, source, file, prior?.session_id, data.sessionId, "claude", data.entries, data.fingerprint, data.size);
    indexed++;
  }
  const stale = (db.prepare("SELECT file,session_id FROM source_files WHERE source=?").all(source) as any[]).filter(r => !found.has(r.file));
  let removed = 0;
  if (stale.length) transaction(db, () => { for (const row of stale) { db.prepare("DELETE FROM source_files WHERE source=? AND file=?").run(source, row.file); const still = db.prepare("SELECT 1 FROM source_files WHERE source=? AND session_id=? LIMIT 1").get(source, row.session_id); if (!still) { db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, row.session_id); db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, row.session_id); db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source, row.session_id); removed++; } } });
  return { source, indexed, unchanged, removed, duplicates, errors };
}

function walkMarkdown(root: string): string[] {
  const out: string[] = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!; const names = readdirSync(dir);
    for (const name of names) {
      const file = path.join(dir, name); const st = lstatSync(file);
      if (st.isSymbolicLink()) throw new Error(`Symlink in wiki pages tree; refusing an incomplete snapshot: ${file}`);
      if (st.isDirectory()) stack.push(file); else if (st.isFile() && name.endsWith(".md")) out.push(file);
    }
  }
  return out.sort();
}

// Wiki pages are curated knowledge, indexed as source "wiki" with one entry per page:
// session_id is the page slug, entry_id is "page", project is the constant "wiki".
// Malformed pages are skipped and reported rather than failing the whole snapshot.
export function ingestWiki(db: DatabaseSync, root: string) {
  const source = "wiki"; const normalized = path.resolve(root);
  const configured = db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if (configured && configured.root !== normalized) throw new Error(`Source ${source} is already registered at ${configured.root}; refusing to reconcile a different path`);
  let rootStat;
  try { rootStat = lstatSync(root); } catch (e: any) { if (e?.code === "ENOENT") return { source, missing: true, indexed: 0, unchanged: 0, removed: 0, errors: [] as string[] }; throw e; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Wiki root must be a real directory: ${root}`);
  const pagesDir = path.join(root, "pages");
  let pagesStat;
  try { pagesStat = lstatSync(pagesDir); } catch (e: any) { if (e?.code === "ENOENT") return { source, missing: true, indexed: 0, unchanged: 0, removed: 0, errors: [] as string[] }; throw e; }
  if (pagesStat.isSymbolicLink() || !pagesStat.isDirectory()) throw new Error(`Wiki pages must be a real directory: ${pagesDir}`);
  registerSource(db, source, normalized);
  const files = walkMarkdown(pagesDir);
  if (files.length > MAX_WIKI_PAGES) throw new Error(`Wiki page count exceeded ${MAX_WIKI_PAGES}`);
  const found = new Set<string>(); const errors: string[] = [];
  let indexed = 0, unchanged = 0;
  for (const file of files) {
    found.add(file);
    let parsed;
    try {
      const st = lstatSync(file);
      if (st.size > MAX_WIKI_PAGE) throw new Error(`wiki page exceeds ${MAX_WIKI_PAGE} byte limit`);
      const text = readFileSync(file, "utf8");
      parsed = { page: parsePage(text, file), fingerprint: hash(Buffer.from(text, "utf8")), size: Buffer.byteLength(text) };
      const base = path.basename(file, ".md");
      if (base !== parsed.page.meta.slug) throw new Error(`filename slug "${base}" does not match frontmatter slug "${parsed.page.meta.slug}"`);
    } catch (error) { errors.push(`${file}: ${(error as Error).message}`); continue; }
    const slug = parsed.page.meta.slug;
    const prior = db.prepare("SELECT session_id,fingerprint FROM source_files WHERE source=? AND file=?").get(source, file) as any;
    if (prior?.fingerprint === parsed.fingerprint) { unchanged++; continue; }
    const timestamp = Number.isNaN(Date.parse(parsed.page.meta.last_verified)) ? null : new Date(parsed.page.meta.last_verified).toISOString();
    const entries: Entry[] = [{ entry_id: "page", parent_id: null, role: "page", kind: "page", timestamp, text: indexableText(parsed.page), indexable: true, metadata: { tags: parsed.page.meta.tags, sources: parsed.page.meta.sources } }];
    replaceFileSession(db, source, file, prior?.session_id, slug, "wiki", entries, parsed.fingerprint, parsed.size, { title: parsed.page.meta.title });
    indexed++;
  }
  const stale = (db.prepare("SELECT file,session_id FROM source_files WHERE source=?").all(source) as any[]).filter(r => !found.has(r.file));
  let removed = 0;
  if (stale.length) transaction(db, () => { for (const row of stale) { db.prepare("DELETE FROM source_files WHERE source=? AND file=?").run(source, row.file); const still = db.prepare("SELECT 1 FROM source_files WHERE source=? AND session_id=? LIMIT 1").get(source, row.session_id); if (!still) { db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source, row.session_id); db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source, row.session_id); db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source, row.session_id); removed++; } } });
  return { source, indexed, unchanged, removed, errors };
}

function cols(db:DatabaseSync,table:string):Set<string>{return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(x=>x.name));}
function readOnly(filename:string){const db=new DatabaseSync(filename,{readOnly:true,timeout:5000});db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");return db;}
export function ingestOpenCode(db:DatabaseSync,filename:string){
  const source="opencode";const normalized=path.resolve(filename);
  const configured=db.prepare("SELECT root FROM source_config WHERE source=?").get(source) as any;
  if(configured&&configured.root!==normalized)throw new Error(`Source ${source} is already registered at ${configured.root}; refusing to reconcile a different path`);
  let st;try{st=lstatSync(filename);}catch(e:any){if(e?.code==="ENOENT")return {source:"opencode",missing:true,indexed:0,unchanged:0,removed:0};throw e;}
  if(st.isSymbolicLink()||!st.isFile())throw new Error("OpenCode database must be a regular file, not a symlink");
  registerSource(db,source,normalized);const src=readOnly(filename);let indexed=0;
  try{
    const tables=new Set((src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r=>r.name));
    for(const t of ["session","message","part"])if(!tables.has(t))throw new Error(`Unsupported OpenCode schema: missing ${t} table`);
    const sc=cols(src,"session"),mc=cols(src,"message"),pc=cols(src,"part");
    for(const [s,c] of [[sc,["id","project_id","parent_id","revert"]],[mc,["id","session_id","data","time_created"]],[pc,["id","message_id","session_id","data"]]] as any)for(const n of c)if(!s.has(n))throw new Error(`Unsupported OpenCode schema: missing ${n} column`);
    const seqCols=tables.has("event_sequence")?cols(src,"event_sequence"):new Set<string>();
    const seqAvailable=seqCols.has("aggregate_id")&&seqCols.has("seq");
    const directoryCol=sc.has("directory")?"directory":"NULL AS directory";
    const sessions=src.prepare(`SELECT id,project_id,parent_id,revert,${directoryCol} FROM session ORDER BY id LIMIT ?`).all(MAX_OPENCODE_SESSIONS) as any[];
    if(sessions.length===MAX_OPENCODE_SESSIONS)throw new Error("OpenCode session count exceeded configured bound");
    const live=new Set<string>();
    for(const listed of sessions){
      src.exec("BEGIN");
      try{
        const sess=src.prepare(`SELECT id,project_id,parent_id,revert,${directoryCol} FROM session WHERE id=?`).get(listed.id) as any;
        if(!sess){src.exec("COMMIT");continue;}
        live.add(sess.id);
        const messages=src.prepare("SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id LIMIT 50000").all(sess.id) as any[];
        if(messages.length===50000)throw new Error(`OpenCode session ${sess.id} exceeds per-session message limit`);
        const decoded=messages.map(m=>({message:m,data:decode(m.data,`OpenCode message ${m.id}`)}));
        const revert=decode(sess.revert,`OpenCode revert for ${sess.id}`);const boundary=revert?.messageID;const boundaryPart=revert?.partID;
        const boundaryIndex=boundary?decoded.findIndex(x=>x.message.id===boundary):-1;
        const boundaryFound=!boundary||boundaryIndex>=0;const entries:Entry[]=[];
        for(let messageIndex=0;messageIndex<decoded.length;messageIndex++){
          const {message:m,data:md}=decoded[messageIndex];
          const role=md?.role;let visible=!boundary||messageIndex<boundaryIndex;let text="";
          if(boundary&&messageIndex===boundaryIndex)visible=Boolean(boundaryPart);
          // User summary objects are ordinary metadata; only boolean true marks a derived summary.
          const eligible=(role==="user"||role==="assistant")&&visible&&md?.summary!==true&&!md?.synthetic;
          const parts=eligible?src.prepare("SELECT id,json_extract(data,'$.type') AS type,json_extract(data,'$.text') AS text,COALESCE(json_extract(data,'$.synthetic'),0) AS synthetic,COALESCE(json_extract(data,'$.ignored'),0) AS ignored,COALESCE(json_extract(data,'$.ignoredReason'),'') AS ignored_reason FROM part WHERE message_id=? ORDER BY id LIMIT 1001").all(m.id) as any[]:[];
          if(parts.length>1000)throw new Error(`OpenCode message ${m.id} exceeds per-message part limit`);
          const selected:string[]=[];let partFound=!boundaryPart||m.id!==boundary;
          for(const part of parts){
            if(m.id===boundary&&boundaryPart&&part.id===boundaryPart){partFound=true;break;}
            if(part.type==="text"&&!part.synthetic&&!part.ignored&&!part.ignored_reason&&typeof part.text==="string")selected.push(part.text);
          }
          if(m.id===boundary&&boundaryPart&&!partFound)throw new Error(`OpenCode revert part ${boundaryPart} is missing in session ${sess.id}; snapshot left unchanged`);
          text=selected.join("\n");
          const when=md?.time?.created??m.time_created;const date=new Date(when);const timestamp=Number.isNaN(date.valueOf())?null:date.toISOString();
          entries.push({entry_id:m.id,parent_id:null,role:role??null,kind:"message",timestamp,text:eligible?text:"",indexable:eligible,metadata:{visible,sessionParent:sess.parent_id??null,assistantParent:md?.parentID??null}});
        }
        if(boundary&&!boundaryFound)throw new Error(`OpenCode revert target ${boundary} is missing in session ${sess.id}; snapshot left unchanged`);
        const project=sess.directory?path.resolve(String(sess.directory)):"unknown";
        const seq=seqAvailable?src.prepare("SELECT seq FROM event_sequence WHERE aggregate_id=?").get(sess.id) as any:null;
        const fingerprint=hash(Buffer.from(JSON.stringify([sess,entries.map(e=>[e.entry_id,e.parent_id,e.role,e.text,e.indexable,e.timestamp,e.metadata]),seq?.seq??null])));
        const prior=db.prepare("SELECT fingerprint FROM source_files WHERE source=? AND file=?").get(source,sess.id) as any;
        if(prior?.fingerprint!==fingerprint){replaceSession(db,source,sess.id,project,entries,{parentSession:sess.parent_id??undefined,revertMessage:boundary,sourceFile:{key:sess.id,fingerprint,size:entries.length}});indexed++;}
        src.exec("COMMIT");
      }catch(e){try{src.exec("ROLLBACK");}catch{}throw e;}
    }
    const old=db.prepare("SELECT file FROM source_files WHERE source=?").all(source) as any[];let removed=0;
    for(const row of old)if(!live.has(row.file))transaction(db,()=>{db.prepare("DELETE FROM source_files WHERE source=? AND file=?").run(source,row.file);db.prepare("DELETE FROM documents WHERE source=? AND session_id=?").run(source,row.file);db.prepare("DELETE FROM entries WHERE source=? AND session_id=?").run(source,row.file);db.prepare("DELETE FROM sessions WHERE source=? AND session_id=?").run(source,row.file);removed++;});
    return {source,indexed,unchanged:sessions.length-indexed,removed,eventSequenceAvailable:seqAvailable,reconciliation:"bounded per-session full reconciliation; event log not read"};
  }finally{src.close();}
}
function decode(value:any,label="OpenCode JSON"):any{if(value==null)return null;try{return typeof value==="string"?JSON.parse(value):value;}catch{throw new Error(`Malformed ${label}; snapshot left unchanged`);}}
