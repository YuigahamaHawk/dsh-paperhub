import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {studyBlocks,validateStudyMap,validStudyEvidence,STUDY_CATEGORIES} from '../shared/study-map.js'
import {createStudyMap} from '../host/study-map.js'
import {ReaderStore} from '../host/store.js'
import {createRpcSurface} from '../host/rpc.js'

const text='The method succeeded in 98 of 100 hardware trials under the evaluated conditions.'
const blocks=[{id:'result',page:4,kind:'paragraph',text}]
const example=()=>({groups:[{id:'results',points:[{text:'在评估条件下，100 次硬件实验中成功 98 次。',evidence:[{blockId:'result',quote:text}]}]}]})

test('categorized cards preserve explicit verified block IDs, source quotes and source pages',()=>{
 const result=validateStudyMap(example(),blocks)
 assert.deepEqual(result.groups.map(group=>group.id),STUDY_CATEGORIES);assert.equal(result.groups.find(g=>g.id==='results').points[0].evidence[0].page,4)
 assert.equal(result.groups.find(g=>g.id==='background').points.length,0)
})
test('unknown anchors and fabricated source quotations cannot become successful cards',()=>{
 for(const patch of [{blockId:'wrong',quote:text},{blockId:'result',quote:'A fabricated quotation that is absent from the paper.'}]){
  const value=example();value.groups[0].points[0].evidence=[patch];assert.throws(()=>validateStudyMap(value,blocks),/引文/)
 }
})
test('numeric experimental claims must be supported by the quoted evidence',()=>{
 const value=example();value.groups[0].points[0].text='硬件实验取得了 999 次成功。';assert.throws(()=>validateStudyMap(value,blocks),/数字/)
})
test('one bad candidate is explicitly excluded without discarding verified cards or weakening their checks',()=>{
 const value=example();value.groups[0].points.push({text:'伪造的999次成功不应进入阅读重点',evidence:[{blockId:'result',quote:text}]})
 const result=validateStudyMap(value,blocks,{discardInvalid:true})
 assert.equal(result.points,1);assert.equal(result.rejected.length,1);assert.match(result.rejected[0].reason,/数字/)
 assert.equal(result.groups.find(g=>g.id==='results').points[0].evidence[0].quote,text)
 assert.throws(()=>validateStudyMap({groups:[{id:'results',points:[value.groups[0].points[1]]}]},blocks,{discardInvalid:true}),/有效的原文依据/)
})
test('repeated categories/cards are rejected rather than padded into a fake logical outline',()=>{
 const value=example();value.groups.push(structuredClone(value.groups[0]));assert.throws(()=>validateStudyMap(value,blocks),/重复/)
 const duplicate=example();duplicate.groups[0].points.push(structuredClone(duplicate.groups[0].points[0]));assert.throws(()=>validateStudyMap(duplicate,blocks),/重复/)
})
test('stale source text disables card anchoring, while harmless whitespace differences do not',()=>{
 const evidence=example().groups[0].points[0].evidence
 assert.equal(validStudyEvidence(evidence,new Map([['result',{text:text.replaceAll(' ','\n')}]])),true)
 assert.equal(validStudyEvidence(evidence,new Map([['result',{text:'This source block has changed.'}]])),false)
})
test('oversized source is reported before requesting a partial-document map',()=>{
 assert.throws(()=>studyBlocks({blocks:[{id:'long',text:'x'.repeat(220001)}]}),/过长/)
})
test('real persistence owns the correct document and cache reuse does not call the model again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-study-map-')),store=new ReaderStore(dir);await store.init();let calls=0
 try{
  const upload=await store.saveUpload('paper.pdf','pdf',Buffer.from('%PDF-test')),doc=await store.addDoc({storedPath:upload.path,format:'pdf',name:'paper.pdf',meta:{title:'Grounded fixture'},content:{kind:'pdf',pages:[{n:4,blocks}]}})
  const ai={chat:async()=>{calls++;return{text:JSON.stringify(example()),model:'test-model',usage:{totalTokens:123}}}}
  const first=await createStudyMap({store,ai,id:doc.id});assert.equal(first.cached,false);assert.equal((await store.getAux(doc.id)).keypoints.points,1)
  const second=await createStudyMap({store,ai,id:doc.id});assert.equal(second.cached,true);assert.equal(calls,1)
  ai.chat=async()=>({text:JSON.stringify({groups:[{id:'results',points:[{text:'无依据的结果不会覆盖先前的卡片',evidence:[{blockId:'fake',quote:text}]}]}]})})
  await assert.rejects(createStudyMap({store,ai,id:doc.id,force:true}),/原文依据/);assert.equal((await store.getAux(doc.id)).keypoints.usage.totalTokens,123)
 }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));await rm(dir,{recursive:true,force:true})}
})
test('cancelling a summary stream reaches the model signal and does not touch document metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-summary-cancel-')),store=new ReaderStore(dir);await store.init();let entered
 const started=new Promise(resolve=>entered=resolve),controller=new AbortController(),ai={summarize:async({signal})=>{assert.ok(signal);entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('cancelled')}}
 const surface=createRpcSurface({store,ai,zotero:{},parser:{dispose(){}},version:'test'})
 try{const response=await surface.routes.find(route=>route.path.endsWith('/stream')).fetch(new Request('http://localhost/api/dsh-reader/stream',{method:'POST',body:JSON.stringify({method:'ai.summarize',params:{text:'A source paragraph.',docId:'not-saved'}}),signal:controller.signal}));const body=response.text();await started;controller.abort();assert.match(await body,/cancelled/);assert.equal(store.listDocs().length,0)}finally{surface.dispose();await rm(dir,{recursive:true,force:true})}
})
