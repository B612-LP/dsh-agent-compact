import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

const user=(seq,text,tokens=3000)=>({seq,type:'user/message',data:{role:'user',content:[{type:'text',text}]},tokens})
const assistant=(seq,blocks,tokens=100)=>({seq,type:'assistant/message',data:{message:{role:'assistant',content:blocks}},tokens})
function harness(){
 const ctx=new Context();let tool,archives=0,commits=0,attempts=0,failAt=0,archiveHook,commitHook
 let nodes=[user(10,'Opening exact requirements remain'),user(20,'Completed task A'),user(21,'Task A evidence and completion',200),
  user(30,'LIVE GAP: unfinished deployment and exact instructions',1500),user(40,'Completed task B',3100),user(41,'Task B receipt',200),
  assistant(100,[{type:'tool-call',id:'active',name:'context_compact',arguments:'{}'}])]
 let route={provider:'test',model:'fixed'}
 const session={id:'batch-fixture',surface:{nodes:nodes.map(n=>n.seq),replaceGeneration:0},eventAt:seq=>nodes.find(n=>n.seq===seq),requestHeader:()=>({config:route})}
 const refresh=()=>{session.surface.nodes=nodes.map(n=>n.seq);session.surface.replaceGeneration++}
 const meter={measure:()=>({nodes:nodes.map(n=>({seq:n.seq,tokens:n.tokens})),totalTokens:355000}),estimateMessage:m=>Math.ceil(JSON.stringify(m).length/4)+10}
 const engine={async summarize(){throw Error('official LLM must not be called')},async compactRegion(start,end,agent,signal){
  attempts++;if(attempts===failAt)throw Error('injected member failure')
  const s=await engine.summarize({start,end},agent,signal)
  const si=nodes.findIndex(n=>n.seq===start),ei=nodes.findIndex(n=>n.seq===end)
  const old=nodes.slice(si,ei+1),id='batch-compaction-'+(++commits)
  nodes.splice(si,ei-si+1,user(200+commits,s.summary.map(b=>b.text).join('\n'),50));refresh()
  await commitHook?.(commits)
  return {compactionId:id,summary:s.summary,shadowedSeqs:old.map(n=>n.seq),shadowedTokenCount:old.reduce((t,n)=>t+n.tokens,0)}
 }}
 const spill={async saveText(){archives++;await archiveHook?.(archives);return{locator:'raw-archive-'+archives,bytes:1,retrievalHint:'read raw'}}}
 const services={tools:{register:t=>{tool=t;return()=>{}}},systemPrompt:{section:()=>()=>{},context:()=>()=>{}},sessionQuery:{readSurface:async()=>({events:nodes})},tokenMeter:meter,compaction:engine,spillStore:spill}
 const offs=Object.entries(services).map(([k,v])=>ctx.provide(k,v));const stop=apply(ctx,{autoArchive:true,volumeNudgeTokens:350000,autoSafetyMarginTokens:65536,minSourceTokens:999999,minNetSavingsTokens:999999})
 const exec={agent:{session,ctx:{}},callId:'active',signal:new AbortController().signal}
 return{ctx,session,exec,engine,meter,run:async args=>{const value=await tool.execute(args,exec);assert.notEqual(snapshotJsonValue(value),undefined,'tool output must be lossless JSON');return value},get nodes(){return nodes},get archives(){return archives},get commits(){return commits},get attempts(){return attempts},set failAt(n){failAt=n},set archiveHook(f){archiveHook=f},set commitHook(f){commitHook=f},set route(v){route=v},append:n=>{nodes.push(n);refresh()},dispose:()=>{stop();offs.forEach(f=>f())}}
}
const ranges=[{startSeq:20,endSeq:21,summary:'## A\nCompleted A, exact evidence retained.'},{startSeq:40,endSeq:41,summary:'## B\nCompleted B, exact evidence retained.'}]

test('one inspect then one batch compact commits multiple 3000-token members, retains live gaps and counts call once',async()=>{
 const h=harness()
 try{
  const view=await h.run({action:'inspect'});assert.equal(view.mode,'batch');assert.ok(view.scanId);assert.ok(view.landmarks.length>=6)
  const result=await h.run({action:'compact',scanId:view.scanId,ranges})
  assert.equal(result.status,'compacted');assert.equal(result.results.length,2);assert.equal(h.commits,2);assert.equal(h.archives,2)
  assert.equal(result.estimate.committedRanges,2);assert.equal(result.estimate.sourceTokens,6500)
  assert.equal(h.nodes.find(n=>n.seq===30).data.content[0].text,'LIVE GAP: unfinished deployment and exact instructions')
  assert.equal(h.nodes[0].seq,10);assert.equal(h.nodes.at(-1).seq,100)
  assert.equal(h.nodes.filter(n=>[20,21,40,41].includes(n.seq)).length,0)
  const replay=await h.run({action:'compact',scanId:view.scanId});assert.equal(replay.status,'already_compacted');assert.equal(h.commits,2)
  const changed=await h.run({action:'compact',scanId:view.scanId,ranges:[{...ranges[0],summary:'changed'}]});assert.equal(changed.status,'needs_selection');assert.equal(h.commits,2)
 }finally{h.dispose()}
})
test('optional focused inspections do not evict the original batch scan',async()=>{
 const h=harness();try{const view=await h.run({action:'inspect'})
  for(let i=0;i<3;i++)assert.equal((await h.run({action:'inspect',query:'Completed task A'})).status,'inspect')
  assert.equal((await h.run({scanId:view.scanId,ranges})).status,'compacted');assert.equal(h.commits,2)
 }finally{h.dispose()}
})
test('ALL batch members validate before first archive or commit; overlap/current tail/missing summary fail closed',async()=>{
 for(const chosen of [[ranges[0],{...ranges[1],endSeq:100}],[ranges[0],{startSeq:21,endSeq:40,summary:'overlap'}],[ranges[0],{...ranges[1],summary:''}],[ranges[0],{...ranges[1],startSeq:999}]]){
  const h=harness();try{const view=await h.run({action:'inspect'});assert.equal((await h.run({action:'compact',scanId:view.scanId,ranges:chosen})).status,'needs_selection');assert.equal(h.archives+h.commits,0)}finally{h.dispose()}
 }
})
test('second member failure returns durable partial receipt; retry never repeats committed members',async()=>{
 const h=harness();h.failAt=2
 try{const view=await h.run({action:'inspect'});const result=await h.run({action:'compact',scanId:view.scanId,ranges})
  assert.equal(result.status,'partial');assert.deepEqual(result.results.map(r=>r.status),['compacted','failed']);assert.equal(h.commits,1)
  const retry=await h.run({scanId:view.scanId,ranges});assert.equal(retry.status,'partial');assert.equal(h.attempts,2);assert.equal(h.nodes.some(n=>n.seq===40),true)
 }finally{h.dispose()}
})
test('post-replacement host error is reconciled from durable summary and replacement evidence',async()=>{
 const h=harness();h.commitHook=async n=>{if(n===1){h.session.events=[{seq:700,type:'compaction/summary',data:{compactionId:'batch-compaction-1',shadowedRange:{start:20,end:21},shadowedSeqs:[20,21],shadowedTokenCount:3200,summary:[{type:'text',text:ranges[0].summary}]}},{seq:701,type:'user/message',sourceEventSeqs:[700,20,21],surfaceOp:{op:'replace',startSeq:20,endSeq:21},data:{}}];throw Error('end event append failed')}}
 try{const view=await h.run({action:'inspect'});const out=await h.run({scanId:view.scanId,ranges});assert.equal(out.status,'compacted');assert.equal(out.results[0].compactionId,'batch-compaction-1');assert.match(out.results[0].commitWarning,/reconciled as committed/);assert.equal(h.commits,2);assert.equal(out.results[0].archived.locator,'raw-archive-1')}finally{h.dispose()}
})
test('host error after mutation without durable proof is outcome_unknown, never claimed untouched, archive retained',async()=>{
 const h=harness();h.commitHook=async()=>{throw Error('committed then transport failed')}
 try{const view=await h.run({action:'inspect'});const out=await h.run({scanId:view.scanId,ranges});assert.equal(out.status,'outcome_unknown');assert.equal(out.results[0].status,'outcome_unknown');assert.equal(out.results[0].archived.locator,'raw-archive-1');assert.equal(out.results[1].status,'not_attempted');assert.equal(h.nodes.some(n=>n.seq===20),false);assert.equal(h.nodes.some(n=>n.seq===40),true);await h.run({scanId:view.scanId});assert.equal(h.attempts,1)}finally{h.dispose()}
})
test('append outside selected spans is allowed; content rewrite before commit is not',async()=>{
 for(const rewrite of [false,true]){
  const h=harness();try{
   const view=await h.run({action:'inspect'});h.append(user(110,'later inbox outside active call',30))
   if(rewrite)h.nodes.find(n=>n.seq===40).data.content[0].text='changed after inspect'
   const out=await h.run({scanId:view.scanId,ranges})
   assert.equal(out.status,rewrite?'needs_selection':'compacted');assert.equal(h.commits,rewrite?0:2)
  }finally{h.dispose()}
 }
})
test('rewrite of later member during earlier commit is detected without re-summarizing changed content',async()=>{
 const h=harness();h.commitHook=async n=>{if(n===1)h.nodes.find(n=>n.seq===40).data.content[0].text='outside writer changed B'}
 try{const view=await h.run({action:'inspect'});const out=await h.run({scanId:view.scanId,ranges});assert.equal(out.status,'partial');assert.deepEqual(out.results.map(r=>r.status),['compacted','stale_plan']);assert.equal(h.commits,1);assert.equal(h.archives,1)}finally{h.dispose()}
})
test('one session batch lock excludes competing mutations throughout all members',async()=>{
 const h=harness();let entered,release;const waiting=new Promise(r=>entered=r)
 h.archiveHook=async n=>{if(n===1){entered();await new Promise(r=>release=r)}}
 try{const view=await h.run({action:'inspect'});const first=h.run({scanId:view.scanId,ranges});await waiting
  assert.equal((await h.run({scanId:view.scanId,ranges})).status,'busy')
  assert.equal((await h.run({startSeq:20,endSeq:21,summary:'racing'})).status,'busy');release();assert.equal((await first).status,'compacted')
 }finally{h.dispose()}
})
test('root Code Mode prose is preserved and direct pure batch payload is cleaned only after result',async()=>{
 for(const mixed of [false,true]){
  const h=harness(),replaced=[];h.session.append=(type,data,opts)=>replaced.push({data,opts})
  if(mixed){h.exec.callId='root:ptc:1';h.exec.rootCallId='active';h.nodes.at(-1).data.message.content.unshift({type:'text',text:'Required root prose'})}
  try{const view=await h.run({action:'inspect'});const out=await h.run({scanId:view.scanId,ranges});assert.equal(out.status,'compacted')
   assert.equal(replaced.length,0);h.ctx.emit('session/event',h.session,{seq:500,type:'tool/result',data:{message:{source:{callId:h.exec.callId}}}});await new Promise(r=>queueMicrotask(r))
   assert.deepEqual(replaced.map(x=>x.opts.surfaceOp.startSeq),mixed?[]:[100,500]);assert.ok(!JSON.stringify(replaced).includes('exact evidence retained'))
  }finally{h.dispose()}
 }
})
