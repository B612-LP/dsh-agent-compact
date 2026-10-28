import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

const u=(seq,text,tokens=10000)=>({seq,type:'user/message',data:{content:[{type:'text',text}]},tokens})
const a=(seq,blocks,tokens=100)=>({seq,type:'assistant/message',data:{message:{content:blocks}},tokens})
function harness(size=20000, archival=false) {
 const ctx=new Context();let tool, archives=0, commits=0, summarySeen
 let nodes=[u(1,'finished task begins',size),a(2,[{type:'text',text:'finished task complete'}],500),
  a(3,[{type:'tool-call',name:'context_compact',id:'active',arguments:'{}'}])]
 let route={provider:'test',model:'fixed'}
 const session={id:'isolated-execute',surface:{nodes:nodes.map(n=>n.seq),replaceGeneration:0},
  eventAt:seq=>nodes.find(n=>n.seq===seq),requestHeader:()=>({config:route})}
 const agent={session,ctx:{}}
 const meter={measure:()=>({nodes:nodes.map(n=>({seq:n.seq,tokens:n.tokens})),totalTokens:350000}),
  estimateMessage:msg=>Math.ceil(JSON.stringify(msg).length/4)+12}
 const engine={summarize:async()=>{throw Error('must not call official LLM')},compactRegion:async(start,end,owner)=>{
  summarySeen=await engine.summarize({},owner);commits++
  return {compactionId:'test-id',shadowedSeqs:[start,end],shadowedTokenCount:size+500}
 }}
 const spill={saveText:async()=>{archives++;return {locator:'safe-test-locator',bytes:10,retrievalHint:'read archive'}}}
 const services={tools:{register:value=>{tool=value;return ()=>{}}},
  systemPrompt:{section:()=>()=>{},context:()=>()=>{}},
  sessionQuery:{readSurface:async()=>({events:nodes})},tokenMeter:meter,compaction:engine,spillStore:spill}
 const offs=Object.entries(services).map(([key,value])=>ctx.provide(key,value))
 const stop=apply(ctx,{autoArchive:archival,volumeNudgeTokens:300000,autoSafetyMarginTokens:65536,minSourceTokens:4096,minNetSavingsTokens:2048})
 const exec={agent,callId:'active',signal:new AbortController().signal}
 const run=args=>tool.execute(args,exec)
 return {run,ctx,session,agent,meter,engine,spill,exec,tool,get nodes(){return nodes},
  get archives(){return archives},get commits(){return commits},get summarySeen(){return summarySeen},
  replace:v=>{nodes=v;session.surface.nodes=v.map(n=>n.seq);session.surface.replaceGeneration++},
  route:v=>{route=v},dispose:()=>{stop();offs.forEach(f=>f())}}
}

test('direct observed sequence compact skips a prepare round trip without bypassing validation',async()=>{
 const h=harness(20000,true)
 try {
  const done=await h.run({action:'compact',startSeq:1,endSeq:2,summary:'Complete task, exact corrections and evidence retained.'})
  assert.equal(done.status,'compacted');assert.equal(h.commits,1)
  assert.equal((await h.run({action:'compact',startSeq:1,endSeq:3,summary:'must not compact active call'})).status,'needs_selection')
 }finally{h.dispose()}
})
test('successful receipt-only replay needs no summary; full pure retries are cleaned without losing mixed prose',async()=>{
 for(const mixed of [false,true]) {
  const h=harness(20000,true),replacements=[]
  h.session.append=(type,data,options)=>replacements.push({type,data,options})
  try {
   const p=await h.run({action:'prepare',startSeq:1,endSeq:2})
   assert.equal((await h.run({planId:p.planId,summary:'original facts'})).status,'compacted')
   const replay=a(4,[...(mixed?[{type:'text',text:'Required root prose'}]:[]),
    {type:'tool-call',name:'context_compact',id:'retry',arguments:'original facts '.repeat(1000)}])
   h.replace([...h.nodes,replay]);h.exec.callId='retry'
   assert.equal((await h.run({planId:p.planId})).status,'already_compacted')
   h.ctx.emit('session/event',h.session,{seq:5,type:'tool/result',data:{message:{source:{callId:'retry'}}}})
   await new Promise(resolve=>queueMicrotask(resolve))
   assert.deepEqual(replacements.map(r=>r.options.surfaceOp.startSeq),mixed?[]:[4,5])
   assert.ok(!JSON.stringify(replacements).includes('original facts'))
   assert.equal(h.commits,1);assert.equal(h.archives,1)
  }finally{h.dispose()}
 }
})
test('partial or mixed direct sequence selectors never fall back to compressing the opening',async()=>{
 const h=harness(20000,true)
 try {
  for(const selection of [{startSeq:2,endAnchor:'finished task complete'},{startSeq:2},{endSeq:2},
    {planId:'unknown',startSeq:1,endSeq:2},{startSeq:1,endSeq:2,startAnchor:'finished task begins'}]) {
   assert.equal((await h.run({...selection,summary:'all facts'})).status,'needs_selection')
  }
  assert.equal(h.archives+h.commits,0)
 }finally{h.dispose()}
})
test('prepare reserves submitted summary growth: observed 4965-token budget no longer promises 1352 tokens',async()=>{
 const h=harness(4465,true)
 try {
  const p=await h.run({action:'prepare',startSeq:1,endSeq:2})
  assert.equal(p.status,'ready');assert.ok(p.estimate.maxCheckpointTokens<1120)
  const summary='Retained facts. '.repeat(4)
  const framed=h.meter.estimateMessage({role:'user',content:[{type:'text',text:summary}]})+100
  assert.ok(framed<=p.estimate.maxCheckpointTokens)
  h.nodes[2].tokens=framed+100
  const done=await h.run({planId:p.planId,summary})
  assert.equal(done.status,'compacted');assert.equal(h.commits,1)
 }finally{h.dispose()}
})
test('committed host-generated checkpoint size is reported separately from submitted estimate',async()=>{
 const h=harness(20000,true)
 h.engine.compactRegion=async()=>({compactionId:'official',summary:[{type:'text',text:'official detailed checkpoint '.repeat(100)}]})
 try {
  const done=await h.run({startSeq:1,endSeq:2,summary:'complete submitted facts'})
  assert.equal(done.status,'compacted');assert.ok(done.estimate.actualCheckpointTokens>done.estimate.checkpointTokens)
  assert.ok(done.estimate.actualEstimatedNetSavings<done.estimate.estimatedNetSavings)
 }finally{h.dispose()}
})

test('tiny 472-token screenshot case has no archive and no engine call, even with a short summary',async()=>{
 const h=harness(400,true);h.nodes[1].tokens=72
 try {
  const result=await h.run({startAnchor:'finished task begins',endAnchor:'finished task complete',summary:'# Done'})
  assert.equal(result.status,'skipped');assert.equal(result.ok,false)
  assert.equal(h.archives,0);assert.equal(h.commits,0)
  assert.equal(h.engine._externalSummary,undefined)
 }finally{h.dispose()}
})
test('inspect -> prepare without duplicated summary -> compact returns committed status and framed estimate',async()=>{
 const h=harness(20000,true)
 try {
  const view=await h.run({action:'inspect'});assert.deepEqual(view.groups.flatMap(g=>g.candidates.map(n=>n.seq)),[1,2])
  const p=await h.run({action:'prepare',startSeq:1,endSeq:2});assert.equal(p.status,'ready');assert.equal(h.archives,0)
  const result=await h.run({action:'compact',planId:p.planId,summary:'## Finished\nPreserve exact user correction, path, evidence and next steps.'})
  assert.equal(result.status,'compacted');assert.equal(h.commits,1);assert.equal(h.archives,1)
  assert.equal(h.summarySeen.provider,'agent');assert.equal(result.estimate.useful,true)
  assert.equal((await h.run({planId:p.planId,summary:'old'})).status,'already_compacted');assert.equal(h.commits,1);assert.equal(h.archives,1)
 }finally{h.dispose()}
})
test('legacy bad anchor is non-mutating and offers current boundary IDs instead of a red engine error',async()=>{
 const h=harness()
 try{const out=await h.run({startAnchor:'invented',endAnchor:'finished task complete',summary:'full summary'})
  assert.equal(out.status,'needs_selection');assert.equal(out.groups[0].candidates[0].seq,1);assert.equal(h.commits,0)
 }finally{h.dispose()}
})
test('current tool-call prose cannot be the end; preserves nearby required text',async()=>{
 const h=harness()
 h.nodes[2].data.message.content.unshift({type:'text',text:'Both systems all tests passed'})
 try{const out=await h.run({startAnchor:'finished task begins',endAnchor:'Both systems all tests passed',summary:'retain details'})
  assert.equal(out.status,'needs_selection');assert.equal(h.commits,0)
  assert.match(h.nodes[2].data.message.content[0].text,/all tests passed/)
 }finally{h.dispose()}
})
test('prepared content change or route change skips before archive/summary installation',async()=>{
 for(const mutation of [h=>{h.nodes[0].data.content[0].text='changed'},h=>h.route({provider:'test',model:'other'})]){
  const h=harness(20000,true)
  try{const p=await h.run({action:'prepare',startSeq:1,endSeq:2});mutation(h)
   assert.equal((await h.run({planId:p.planId,summary:'details'})).status,'stale_plan')
   assert.equal(h.archives+h.commits,0)
  }finally{h.dispose()}
 }
})
test('archive await revalidates; an intervening rewrite leaves history unmodified and no summary ticket',async()=>{
 const h=harness(20000,true)
 h.spill.saveText=async()=>{h.nodes[0].data.content[0].text='rewritten during archive';return {locator:'test',bytes:1,retrievalHint:'test'}}
 try{const out=await h.run({startAnchor:'finished task begins',endAnchor:'finished task complete',summary:'full checkpoint'})
  assert.equal(out.status,'stale_plan');assert.equal(h.commits,0);assert.equal(h.engine._externalSummary,undefined)
 }finally{h.dispose()}
})
test('same session parallel mutation is rejected; no second archive or engine entry',async()=>{
 const h=harness(20000,true);let release,entered
 const waiting=new Promise(r=>entered=r)
 h.spill.saveText=async()=>{entered();await new Promise(r=>release=r);return {locator:'safe',bytes:1,retrievalHint:'safe'}}
 try{
  const args={startAnchor:'finished task begins',endAnchor:'finished task complete',summary:'full retained checkpoint'}
  const first=h.run(args);await waiting
  assert.equal((await h.run(args)).status,'busy');release();assert.equal((await first).status,'compacted');assert.equal(h.commits,1)
 }finally{h.dispose()}
})
test('full checkpoint plus submitted-call cost cannot create fake net benefit',async()=>{
 const h=harness(4500,true);h.nodes[2].tokens=3000
 try{const out=await h.run({startAnchor:'finished task begins',endAnchor:'finished task complete',summary:'all required detail'})
  assert.equal(out.status,'skipped');assert.equal(h.archives+h.commits,0)
 }finally{h.dispose()}
})
test('cancellation after archive does not install a ticket; lock is released',async()=>{
 const h=harness(20000,true),controller=new AbortController();h.exec.signal=controller.signal
 h.spill.saveText=async()=>{controller.abort();return {locator:'test',bytes:1,retrievalHint:'test'}}
 try{await assert.rejects(h.run({startAnchor:'finished task begins',endAnchor:'finished task complete',summary:'detail'}),/abort/i)
  assert.equal(h.engine._externalSummary,undefined);assert.equal(h.commits,0)
  assert.equal((await h.run({action:'inspect'})).status,'inspect')
 }finally{h.dispose()}
})

test('Code Mode child uses the root call for boundaries and cost but never cleans away its root prose',async()=>{
 const h=harness(20000,true)
 h.exec.callId='root:ptc:1';h.exec.rootCallId='root'
 h.nodes[2].data.message.content=[{type:'text',text:'Important root explanation'},
  {type:'tool-call',id:'root',name:'run_code',arguments:'context_compact(...)'}]
 try{
  const view=await h.run({action:'inspect'});assert.deepEqual(view.groups.flatMap(g=>g.candidates.map(n=>n.seq)),[1,2])
  const p=await h.run({action:'prepare',startSeq:1,endSeq:2});assert.equal(p.status,'ready')
  const done=await h.run({planId:p.planId,summary:'## Complete\nPreserve original user correction, paths, evidence and active next step.'})
  assert.equal(done.status,'compacted');assert.equal(h.commits,1)
  assert.equal(h.nodes[2].data.message.content[0].text,'Important root explanation')
 }finally{h.dispose()}
})
