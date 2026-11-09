import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expand, openStore, search } from "../src/memory/store.ts";
import { ingestOpenCode, ingestPi } from "../src/memory/ingest.ts";

let dir:string; let db:DatabaseSync; let index:string;
beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),"memory-test-"));index=path.join(dir,"index.sqlite");db=openStore(index);});
afterEach(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});
const line=(o:unknown)=>JSON.stringify(o)+"\n";
async function session(root:string, name:string, entries:any[], extra:any={}) {
  await fs.mkdir(path.join(root,"project"),{recursive:true});
  const file=path.join(root,"project",name+".jsonl");
  const header={type:"session",version:3,id:name,cwd:"/work/project",...extra};
  await fs.writeFile(file,line(header)+entries.map(line).join(""));return file;
}

describe("Pi memory import",()=>{
  it("keeps branches and excluded metadata, expands only the selected parent chain",async()=>{
    const root=path.join(dir,"sessions");
    const file=await session(root,"branch",[
      {type:"message",id:"root",parentId:null,message:{role:"user",content:[{type:"text",text:"choose the blue widget"}]}},
      {type:"message",id:"thinking",parentId:"root",message:{role:"assistant",content:[{type:"thinking",thinking:"private reasoning"}]}},
      {type:"message",id:"left",parentId:"thinking",message:{role:"assistant",content:[{type:"text",text:"left branch decision"}]}},
      {type:"message",id:"right",parentId:"thinking",message:{role:"assistant",content:[{type:"text",text:"right branch answer"}]}},
      {type:"message",id:"tool",parentId:"right",message:{role:"toolResult",content:[{type:"text",text:"secret tool output"}]}},
      {type:"custom_message",id:"custom",parentId:"right",customType:"memory",message:{role:"assistant",content:[{type:"text",text:"recall artifact"}]}},
      {type:"message",id:"summary",parentId:"right",message:{role:"assistant",summary:true,content:[{type:"text",text:"derived summary"}]}}
    ]);
    assert.deepEqual(ingestPi(db,root).indexed,1);
    const results=search(db,{query:"right answer",project:"/work/project"}); assert.equal(results.length,1);
    const expanded=expand(db,results[0].result_id,{project:"/work/project"})!;
    assert.match(expanded.text,/right branch answer/);assert.doesNotMatch(expanded.text,/left branch decision|private reasoning|secret tool output|recall artifact|derived summary/);
    assert.equal(search(db,{query:"derived summary",project:"/work/project"}).length,0);
    assert.equal(expanded.branch.siblingsIncluded,false);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM entries WHERE source='pi'").get() as any).n,7);
  });
  it("ignores incomplete tails, rejects malformed updates without deleting valid snapshot, and detects rewrites/deletions",async()=>{
    const root=path.join(dir,"sessions");
    const file=await session(root,"s1",[{type:"message",id:"u",parentId:null,message:{role:"user",content:"alpha beta"}}]);
    await fs.appendFile(file,"{\"type\":\"message\",\"id\":\"partial\"");
    assert.equal(ingestPi(db,root).indexed,1);
    assert.match((search(db,{query:"alpha",project:"/work/project"})[0] as any).excerpt,/alpha/);
    const valid=await fs.readFile(file,"utf8");
    await fs.writeFile(file,valid.slice(0,valid.lastIndexOf("{\"type\":"))+"not-json\n");
    assert.throws(()=>ingestPi(db,root),/Malformed Pi JSON/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM documents").get() as any).n,1);
    // Same-size change is detected through full content fingerprint.
    await fs.writeFile(file,valid.replace("alpha","omega"));
    assert.equal(ingestPi(db,root).indexed,1);
    assert.equal(search(db,{query:"omega",project:"/work/project"}).length,1);
    await fs.rm(file); assert.equal(ingestPi(db,root).removed,1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM documents").get() as any).n,0);
  });
  it("fails diagnostically on unsupported version",async()=>{
    const root=path.join(dir,"sessions");const f=path.join(root,"bad.jsonl");await fs.mkdir(root);
    await fs.writeFile(f,line({type:"session",version:2,id:"bad"}));
    assert.throws(()=>ingestPi(db,root),/Unsupported Pi session format/);
  });
  it("reconciles a reheadered file atomically and refuses changed source roots",async()=>{
    const root=path.join(dir,"sessions");const file=await session(root,"old-id",[{type:"message",id:"entry",parentId:null,message:{role:"user",content:"reheadered session phrase"}}]);
    ingestPi(db,root);
    const rewritten=line({type:"session",version:3,id:"new-id",cwd:"/work/project"})+line({type:"message",id:"entry",parentId:null,message:{role:"user",content:"reheadered session phrase"}});
    await fs.writeFile(file,rewritten);
    assert.equal(ingestPi(db,root).indexed,1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM sessions WHERE source='pi'").get() as any).n,1);
    assert.equal((db.prepare("SELECT session_id FROM source_files WHERE source='pi'").get() as any).session_id,"new-id");
    await assert.rejects(async()=>ingestPi(db,path.join(dir,"other-sessions")),/already registered/);
  });
  it("does not follow or prune through symlinks after a failed source walk",async()=>{
    const root=path.join(dir,"sessions");const file=await session(root,"safe",[{type:"message",id:"entry",parentId:null,message:{role:"user",content:"still preserved snapshot"}}]);
    ingestPi(db,root);await fs.rename(file,file+".saved");await fs.symlink(file+".saved",file);
    assert.throws(()=>ingestPi(db,root),/Symlink in Pi sessions tree/);
    assert.equal(search(db,{query:"preserved",project:"/work/project"}).length,1);
  });
});

describe("OpenCode memory import",()=>{
  function fixture(file:string){
    const source=new DatabaseSync(file);
    source.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,directory TEXT,revert TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
      CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT,time_created INTEGER);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER);`);
    source.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("ses_a","proj","ses_parent","/work/project",JSON.stringify({messageID:"msg_u2"}));
    source.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("ses_parent","proj",null,"/other/project",null);
    const msg=source.prepare("INSERT INTO message VALUES(?,?,?,?,?)");
    msg.run("msg_u1","ses_a",JSON.stringify({role:"user",parentID:null,time:{created:100}}),100,100);
    msg.run("msg_a1","ses_a",JSON.stringify({role:"assistant",parentID:"msg_u1",time:{created:200}}),200,200);
    msg.run("msg_u2","ses_a",JSON.stringify({role:"user",parentID:"msg_a1",time:{created:300}}),300,300);
    msg.run("msg_hidden","ses_a",JSON.stringify({role:"assistant",parentID:"msg_u2",time:{created:400}}),400,400);
    const part=source.prepare("INSERT INTO part VALUES(?,?,?,?,?)");
    part.run("prt_1","msg_u1","ses_a",JSON.stringify({type:"text",text:"first visible subject"}),100);
    part.run("prt_2","msg_a1","ses_a",JSON.stringify({type:"reasoning",text:"private reasoning"}),200);
    part.run("prt_3","msg_a1","ses_a",JSON.stringify({type:"text",text:"assistant visible choice"}),200);
    part.run("prt_4","msg_hidden","ses_a",JSON.stringify({type:"text",text:"hidden after revert"}),400);
    part.run("prt_5","msg_u2","ses_a",JSON.stringify({type:"tool",output:"tool secret"}),300);
    source.prepare("INSERT INTO event_sequence VALUES(?,?)").run("ses_a",3);return source;
  }
  it("indexes text parts, preserves parent semantics, honors revert and reconciles updates/removals",async()=>{
    const file=path.join(dir,"oc.sqlite");let src=fixture(file);src.close();
    const original = await fs.readFile(file);
    const one=ingestOpenCode(db,file);assert.equal(one.indexed,2);
    assert.deepEqual(await fs.readFile(file), original);
    const found=search(db,{query:"assistant choice",scope:"all"});assert.equal(found.length,1);
    assert.equal(search(db,{query:"hidden after revert",scope:"all"}).length,0);
    assert.equal(search(db,{query:"private reasoning",scope:"all"}).length,0);
    const ex=expand(db,found[0].result_id,{scope:"all"})!;assert.match(ex.branch.sessionParent!,/ses_parent/);assert.doesNotMatch(ex.text,/other project/);
    src=new DatabaseSync(file);src.prepare("UPDATE part SET data=? WHERE id='prt_3'").run(JSON.stringify({type:"text",text:"updated chosen subject"}));src.close();
    assert.equal(ingestOpenCode(db,file).indexed,1);assert.equal(search(db,{query:"updated chosen",scope:"all"}).length,1);
    src=new DatabaseSync(file);src.prepare("DELETE FROM session WHERE id='ses_a'").run();src.close();
    assert.equal(ingestOpenCode(db,file).removed,1);assert.equal(search(db,{query:"updated chosen",scope:"all"}).length,0);
  });
  it("uses conservative message and part revert boundaries and diagnoses missing targets",async()=>{
    const file=path.join(dir,"oc-revert.sqlite");const src=fixture(file);
    src.prepare("UPDATE session SET revert=? WHERE id='ses_a'").run(JSON.stringify({messageID:"msg_u2",partID:"prt_7"}));
    const part=src.prepare("INSERT INTO part VALUES(?,?,?,?,?)");
    // OpenCode orders parts by ID, not insertion order.
    part.run("prt_8","msg_u2","ses_a",JSON.stringify({type:"text",text:"later part excluded"}),303);
    part.run("prt_6","msg_u2","ses_a",JSON.stringify({type:"text",text:"part before boundary stays"}),301);
    part.run("prt_7","msg_u2","ses_a",JSON.stringify({type:"text",text:"boundary text excluded"}),302);
    src.close();
    ingestOpenCode(db,file);
    assert.equal(search(db,{query:"part before boundary",scope:"all"}).length,1);
    assert.equal(search(db,{query:"excluded",scope:"all"}).length,0);
    assert.equal(search(db,{query:"later",scope:"all"}).length,0);
    const src2=new DatabaseSync(file);src2.prepare("UPDATE session SET revert=? WHERE id='ses_a'").run(JSON.stringify({messageID:"missing-message"}));src2.close();
    assert.throws(()=>ingestOpenCode(db,file),/revert target .* is missing/);
    assert.equal(search(db,{query:"part before boundary",scope:"all"}).length,1);
  });
  it("refuses unsupported source schemas and missing archive remains diagnosable",()=>{
    const bad=path.join(dir,"bad.sqlite");const x=new DatabaseSync(bad);x.exec("CREATE TABLE unrelated(x)");x.close();
    assert.throws(()=>ingestOpenCode(db,bad),/Unsupported OpenCode schema/);
  });
});
