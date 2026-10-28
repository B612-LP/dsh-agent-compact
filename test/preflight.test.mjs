import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { benefit, checkpointMessage, CompactionPlans, seqRegion, inspectSurface, selectionPrices, pureCompactionCall } from '../lib/preflight.js'
import { prefixHits } from '../lib/boundary.js'

const user = (seq, text) => ({ seq, type:'user/message', data:{content:[{type:'text', text}]}})
const assistant = (seq, blocks) => ({seq,type:'assistant/message',data:{message:{content:blocks}}})
const call = (seq, id='active') => assistant(seq,[{type:'tool-call',id,name:'context_compact',arguments:'{}'}])
const text = s => ({type:'text',text:s})
function fixture() {
  const nodes=[user(1,'finished task starts'),assistant(2,[text('finished task ends')]),call(3)]
  const session={surface:{nodes:nodes.map(n=>n.seq),replaceGeneration:0},eventAt:seq=>nodes.find(n=>n.seq===seq)}
  const meter={measure:()=>({nodes:nodes.map(n=>({seq:n.seq,tokens:n.seq===1?20000:1000}))}),estimateMessage:m=>Math.ceil(JSON.stringify(m).length/4)+10}
  const cuts={before:s=>toolPairingBalancedBefore(session,s),after:s=>toolPairingBalancedAfter(session,s)}
  return {nodes,session,meter,cuts}
}

test('472-token and single-message tiny spans skip even with a nearly empty checkpoint',()=>{
  const {meter}=fixture()
  assert.equal(benefit(472,'# done',meter).useful,false)
  assert.equal(benefit(4095,'# done',meter).useful,false)
})
test('framed checkpoint, call/cleanup overhead and net minimum all count',()=>{
  const meter={estimateMessage:()=>1000}
  assert.equal(benefit(5000,'complete',meter,4096,2048,2000).useful,false)
  assert.equal(benefit(20000,'complete',meter,4096,2048,2000).estimatedNetSavings,16488)
  assert.equal(benefit(3560+2048,'complete',meter,4096,2048,2048).useful,true)
})
test('necessary detail may be long, but never shortened automatically to meet a ratio',()=>{
  const meter={estimateMessage:()=>15000}
  assert.equal(benefit(20000,'complete detailed checkpoint',meter,4096,2048,1000).useful,true)
  assert.equal(benefit(17000,'complete detailed checkpoint',meter,4096,2048,1000).useful,false)
})
test('framing matches the installed rc.3 Basic implementation constants and block layout',()=>{
  const require=createRequire(import.meta.url)
  const src=readFileSync(require.resolve('@deepseek-ai/dsh-compaction-basic'),'utf8')
  const preamble=JSON.parse(src.match(/const CHECKPOINT_PREAMBLE = ("[^\n]+")/)[1])
  assert.deepEqual(checkpointMessage('用户纠正 + exact ID 123').content,[
    {type:'text',text:preamble+'\n\n<compacted-summary>'},
    {type:'text',text:'用户纠正 + exact ID 123'},{type:'text',text:'</compacted-summary>'}])
})
test('inspection is bounded, paginated and excludes the current active call even with later inbox input',()=>{
  const f=fixture(); f.nodes.push(user(4,'later inbox'));f.session.surface.nodes.push(4)
  const got=inspectSurface(f.nodes,f.cuts,f.meter,f.session,'active',-1,1)
  assert.deepEqual(got.candidates.map(n=>n.seq),[1]);assert.equal(got.nextAfterSeq,1)
  assert.deepEqual(inspectSurface(f.nodes,f.cuts,f.meter,f.session,'active',1,24).candidates.map(n=>n.seq),[2])
  assert.throws(()=>seqRegion(f.nodes,1,4,f.cuts,'active'),/current tool-call/)
})
test('real official pairing rejects pending parallel calls and user messages between results',()=>{
  const f=fixture()
  f.nodes.splice(2,0,assistant(10,[{type:'tool-call',id:'a'},{type:'tool-call',id:'b'}]),
    {seq:11,type:'tool/result',data:{message:{content:[]}}},user(12,'input between results'))
  f.session.surface.nodes=f.nodes.map(n=>n.seq);f.session.surface.replaceGeneration++
  assert.throws(()=>seqRegion(f.nodes,1,12,f.cuts,'active'),/open tool-call/)
})
test('sequence plans disambiguate identical checkpoint preambles without guessing',()=>{
  const f=fixture();f.nodes[0]=user(1,'same preamble');f.nodes[1]=user(2,'same preamble')
  assert.equal(prefixHits(f.nodes,'same preamble').length,2)
  assert.deepEqual(seqRegion(f.nodes,1,2,f.cuts,'active'),{si:0,ei:1,startSeq:1,endSeq:2})
})
test('pure tool arguments are not legacy text anchors; cleanup never drops nearby prose/reasoning',()=>{
  const n=call(1)
  assert.deepEqual(prefixHits([n,user(2,'real text')],'{}'),[])
  assert.equal(pureCompactionCall(n),true)
  assert.equal(pureCompactionCall(assistant(3,[text('must retain'),...n.data.message.content])),false)
  assert.equal(pureCompactionCall(assistant(4,[{type:'reasoning',text:'retain'},...n.data.message.content])),false)
})
test('plan allows outside appends but rejects rewritten content, new pricing, changed route and other sessions',()=>{
  const f=fixture(),p=new CompactionPlans(),r=seqRegion(f.nodes,1,2,f.cuts,'active')
  const prices=()=>selectionPrices(f.nodes,r,f.meter,f.session)
  const id=p.issue(f.session,f.nodes,r,'route',prices())
  f.nodes.push(user(4,'outside'));f.session.surface.nodes.push(4)
  assert.equal(p.resolve(f.session,id,f.nodes,'route',f.cuts,prices,'active').endSeq,2)
  assert.throws(()=>p.resolve({},id,f.nodes,'route',f.cuts,prices,'active'),/Missing/)
  assert.throws(()=>p.resolve(f.session,id,f.nodes,'different',f.cuts,prices,'active'),/route-changed/)
  assert.throws(()=>p.resolve(f.session,id,f.nodes,'route',f.cuts,()=>[{seq:1,tokens:1}],'active'),/pricing changed/)
  f.nodes[0]=user(1,'rewritten')
  assert.throws(()=>p.resolve(f.session,id,f.nodes,'route',f.cuts,prices,'active'),/content or pricing changed/)
})
test('plans expire and are single-use; stale seq never silently selects a different range',()=>{
  let now=1;const f=fixture(),p=new CompactionPlans(()=>now),r=seqRegion(f.nodes,1,2,f.cuts,'active')
  const prices=()=>selectionPrices(f.nodes,r,f.meter,f.session)
  const id=p.issue(f.session,f.nodes,r,'route',prices());now+=600001
  assert.throws(()=>p.resolve(f.session,id,f.nodes,'route',f.cuts,prices,'active'),/expired/)
  const next=p.issue(f.session,f.nodes,r,'route',prices());p.consume(f.session,next)
  assert.throws(()=>p.resolve(f.session,next,f.nodes,'route',f.cuts,prices,'active'),/Missing/)
  assert.throws(()=>seqRegion(f.nodes,99,2,f.cuts,'active'),/no longer exists/)
})

test('pagination follows surface positions after high-seq checkpoint replacements, without omissions or duplicates',()=>{
  const nodes=[user(100,'replacement checkpoint'),user(20,'older retained A'),user(21,'older retained B'),user(22,'older retained C'),call(101)]
  const meter={measure:()=>({nodes:nodes.map(n=>({seq:n.seq,tokens:1000}))})}
  const cuts={before:()=>true,after:()=>true}
  let cursor=-1;const found=[]
  do {
    const page=inspectSurface(nodes,cuts,meter,{},'active',cursor,1)
    found.push(...page.candidates.map(n=>n.seq));cursor=page.nextAfterSeq
  }while(cursor!==null)
  assert.deepEqual(found,[100,20,21,22])
  const missing=inspectSurface(nodes,cuts,meter,{},'active',999,1)
  assert.equal(missing.candidates.length,0);assert.match(missing.note,/cursor.*missing/)
})
