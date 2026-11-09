import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expand, openStore, search, status } from "../src/memory/store.ts";
import { replaceSession } from "../src/memory/store.ts";
import { runMemoryWorker } from "../src/memory/worker.ts";

let dir:string; let db:DatabaseSync;
beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),"memory-search-"));db=openStore(path.join(dir,"index.sqlite"));});
afterEach(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});
function add(session:string,project:string,id:string,text:string){replaceSession(db,"pi",session,project,[{entry_id:id,parent_id:null,role:"user",kind:"message",timestamp:null,text,indexable:true}]);}
describe("memory retrieval",()=>{
  it("safely handles punctuation and ranks multi-cue coverage above repeated single-cue hits",()=>{
    add("s1","/p","a","alpha alpha alpha alpha build deployment issue");
    add("s2","/p","b","alpha beta gamma deployment");
    add("s3","/p","c","beta alpha");
    assert.doesNotThrow(()=>search(db,{query:'" ( OR ) : * AND [ ]',project:"/p"}));
    const results=search(db,{query:"alpha",cues:["beta","gamma"],project:"/p",limit:3});
    assert.equal(results[0].session_id,"s2");
    assert.equal(results[0].score>results[2].score,true);
    assert.equal(Object.hasOwn(results[0],"text"),false);
    assert.equal(Object.hasOwn(results[0],"_rank"),false);
    assert.equal(search(db,{query:"alpha",project:"/other"}).length,0);
    assert.equal(search(db,{query:"alpha"}).length,0);
  });
  it("enforces scope on expansion and caps expansion/result sizes",()=>{
    add("s1","/p","entry", "durable historic fact "+"word ".repeat(5000));
    const result=search(db,{query:"historic",project:"/p",limit:20});assert.equal(result.length,1);
    assert.equal(result[0].excerpt.length<=480,true);
    assert.equal(expand(db,result[0].result_id,{project:"/other"}),null);
    assert.equal(expand(db,result[0].result_id,{}),null);
    const expanded=expand(db,result[0].result_id,{project:"/p",maxChars:300})!;
    assert.ok(expanded.text.length<=300);
    assert.match(expanded.text,/durable historic fact/);
    assert.match(expanded.text,/truncated/);
    assert.throws(()=>search(db,{query:"historic",project:"/p",limit:50}),/limit must be an integer/);
  });
  it("handles malformed worker JSON, structured failures, and cancellation",async()=>{
    const script=path.join(dir,"worker.mjs");
    await fs.writeFile(script,"process.stdout.write('not-json')");
    await assert.rejects(runMemoryWorker(script,"idx","search",{}),/malformed JSON/);
    await fs.writeFile(script,"process.stdout.write(JSON.stringify({ok:false,error:'synthetic worker failure'}));process.exitCode=1");
    await assert.rejects(runMemoryWorker(script,"idx","search",{}),/synthetic worker failure/);
    await fs.writeFile(script,"setTimeout(()=>process.stdout.write(JSON.stringify({ok:true})),5000)");
    const controller=new AbortController();const pending=runMemoryWorker(script,"idx","search",{},controller.signal);
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(pending,/cancelled/);
  });
  it("reports safe status counts and refuses incompatible indexes or missing index in CLI",async()=>{
    add("s1","/p","entry","private source words");
    const printed=JSON.stringify(status(db));assert.doesNotMatch(printed,/private source words/);
    const bad=path.join(dir,"bad.sqlite");const incompatible=new DatabaseSync(bad);incompatible.exec("PRAGMA user_version=77");incompatible.close();
    assert.throws(()=>openStore(bad),/Unsupported memory index schema/);
    const cli=path.resolve("src/memory/cli.ts");
    const missing=path.join(dir,"absent.sqlite");
    const missingResult=spawnSync(process.execPath,["--experimental-strip-types",cli,"status","--index",missing],{encoding:"utf8"});
    assert.notEqual(missingResult.status,0);
    assert.match(JSON.parse(missingResult.stdout).error,/Run:.*ingest/);
  });
});
