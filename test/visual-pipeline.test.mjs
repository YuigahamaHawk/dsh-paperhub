import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVisualLayout } from '../client-src/layout-pipeline.js'
import { applyVisionLayout, VISION_LAYOUT_VERSION } from '../client-src/vision-layout.js'
import { validateVisionPage } from '../shared/vision-contract.js'
import { visionPageNumbers } from '../client-src/vision-render.js'
import { ReaderStore } from '../host/store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function document(count = 3) {
  return { kind: 'pdf', pageCount: count, pages: Array.from({length: count}, (_, index) => ({ n: index + 1, blocks: [{id:`p${index + 1}`,kind:'paragraph',text:`Page ${index + 1} complete paragraph.`}] })) }
}
const renderPages = async ({pageNumbers, onPage}) => { for (const n of pageNumbers) await onPage({n, candidates:[{id:`p${n}`}], imageBase64:'test'}) }
function apiFixture(failedPages = new Set()) {
  const calls=[], saves=[]
  return { calls,saves,
    rpc: async (method,params) => { if(method === 'content.save') saves.push(structuredClone(params.content)); return {} },
    stream: async (method,params) => {
      calls.push({method,params})
      if(method === 'ai.layoutPlan') return {windows:params.windows.map(window=>({id:window.id,groups:[]})),model:'test'}
      const n=params.pages[0].n
      await new Promise(resolve=>setTimeout(resolve, n === 1 ? 12 : 1))
      return {model:'test', pages:[failedPages.has(n) ? {n,error:'network unavailable'} : {n,regions:[],captionFixes:[],textBlocks:[{ids:[`p${n}`],kind:'paragraph'}]}]}
    },
  }
}

test('all pages are eligible, including pages without heuristic figure hints', () => {
  assert.equal(visionPageNumbers(document(41)).length,41)
})
test('disk layout cache preserves visual boxes, paragraph groups and formula data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reader-layout-cache-'))
  try {
    const store=new ReaderStore(dir);await store.init()
    for(const value of [{regions:[{bbox:[.1,.2,.8,.4]}],textBlocks:[{ids:['p1'],kind:'paragraph'}]}, {groups:[['p1','p2']],captions:['c1']}, {latex:'x^2'}]) {
      await store.setCachedReflow('schema-test',value)
      assert.deepEqual(await store.getCachedReflow('schema-test'),value)
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})
test('out-of-order model completions preserve both pages and semantic work runs last',async()=>{
  const api=apiFixture();const content=document(3)
  const result=await runVisualLayout({api,doc:{id:'doc'},content,renderPages})
  assert.equal(result.complete,true)
  assert.ok(result.content.pages.every(page=>page.vision.version===VISION_LAYOUT_VERSION))
  assert.deepEqual(result.content.pages.map(page=>page.blocks[0].text),content.pages.map(page=>page.blocks[0].text))
  assert.equal(api.calls.at(-1).method,'ai.layoutPlan')
  assert.ok(api.saves.some(content=>content.pages[1].vision && !content.pages[0].vision),'first completed page is published immediately')
})
test('failed pages are never complete, and retry requests only unfinished pages',async()=>{
  const failed=new Set([2]);const api=apiFixture(failed)
  const first=await runVisualLayout({api,doc:{id:'doc'},content:document(3),renderPages})
  assert.equal(first.complete,false);assert.equal(first.content.visionLayoutStatus,'partial')
  assert.equal(first.content.pages[1].vision,undefined)
  failed.clear();api.calls.length=0
  const second=await runVisualLayout({api,doc:{id:'doc'},content:first.content,renderPages})
  assert.equal(second.complete,true)
  assert.deepEqual(api.calls.filter(call=>call.method==='ai.visionLayout').map(call=>call.params.pages[0].n),[2])
})
test('explicit visual retry retains the prior route and only requests failed pages',async()=>{
  const failed=new Set([2]),api=apiFixture(failed),doc={id:'doc'}
  const first=await runVisualLayout({api,doc,content:document(3),renderPages})
  const rpc=api.rpc
  api.rpc=(method,params)=>method==='parser.status'?Promise.resolve({engine:'auto',available:true}):rpc(method,params)
  failed.clear()
  api.calls.length=0
  const second=await runVisualLayout({api,doc,content:first.content,renderPages,retryFailed:true})
  assert.equal(second.complete,true)
  assert.deepEqual(api.calls.filter(call=>call.method==='ai.visionLayout').map(call=>call.params.pages[0].n),[2])
  assert.deepEqual(second.content.pages[0].vision,first.content.pages[0].vision)
  assert.deepEqual(second.content.pages[2].vision,first.content.pages[2].vision)
})
test('forced rebuild bypasses both visual and paragraph caches',async()=>{
  const api=apiFixture();const first=await runVisualLayout({api,doc:{id:'doc'},content:document(2),renderPages})
  api.calls.length=0
  await runVisualLayout({api,doc:{id:'doc'},content:first.content,renderPages,force:true})
  assert.equal(api.calls.filter(call=>call.method==='ai.visionLayout').length,2)
  assert.ok(api.calls.every(call=>call.params.force===true))
})
test('multiple figures get distinct blocks, intact captions and stable repeat results',()=>{
  const content={pages:[{n:1,sourceBlocks:[
    {id:'a',kind:'paragraph',text:'Diagram A',sourceRect:{x:.1,y:.1,w:.3,h:.1}},
    {id:'ca',kind:'caption',text:'Figure 1 caption'},
    {id:'b',kind:'paragraph',text:'Diagram B',sourceRect:{x:.1,y:.5,w:.3,h:.1}},
    {id:'cb',kind:'caption',text:'Figure 2 caption'},
    {id:'prose',kind:'paragraph',text:'The results are discussed here.'},
  ],blocks:[]}]}
  const answer={pages:[{n:1,regions:[{kind:'figure',candidateIds:['a'],captionId:'ca',bbox:[.09,.09,.41,.21]}, {kind:'figure',candidateIds:['b'],captionId:'cb',bbox:[.09,.49,.41,.61]}]}]}
  const first=applyVisionLayout(content,answer).content
  const second=applyVisionLayout(first,answer).content
  assert.equal(first.pages[0].blocks.filter(block=>block.kind==='figure').length,2)
  assert.equal(new Set(first.pages[0].blocks.map(block=>block.id)).size,first.pages[0].blocks.length)
  assert.deepEqual(first.pages[0].blocks.map(block=>[block.id,block.text]),second.pages[0].blocks.map(block=>[block.id,block.text]))
  assert.ok(first.pages[0].blocks.some(block=>block.id==='prose'))
  assert.deepEqual(first.pages[0].blocks.filter(block=>block.kind==='caption').map(block=>block.text),['Figure 1 caption','Figure 2 caption'])
})
test('unparseable, wrong-page and unreliable answers are rejected before caching',()=>{
  assert.throws(()=>validateVisionPage(null,{n:1,candidates:[]}))
  assert.throws(()=>validateVisionPage({page:2,regions:[]},{n:1,candidates:[]}))
  assert.throws(()=>validateVisionPage({page:1,regions:[{kind:'figure',bbox:[.1,.1,.8,.8],confidence:.2}]},{n:1,candidates:[]}))
  assert.deepEqual(validateVisionPage({page:1,regions:[]},{n:1,candidates:[]}).regions,[],'a valid empty page is allowed')
})

test('a text line cannot be cached as both equation ink and standalone prose',()=>{
  assert.throws(()=>validateVisionPage({page:1,regions:[{kind:'formula',bbox:[.1,.2,.9,.3],candidateIds:['eq']}],textBlocks:[{ids:['eq'],kind:'paragraph'}]}, {n:1,candidates:[{id:'eq'}]}), error=>error.code==='vision-ownership')
})

test('omitting paragraph continuation lines is not a complete visual page',()=>{
  assert.throws(()=>validateVisionPage({page:1,regions:[],textBlocks:[{ids:['head'],kind:'heading'}]}, {n:1,candidates:[{id:'head'},{id:'continuation'}]}),error=>error.code==='vision-ownership')
})

test('a prose introduction ending in a colon must remain outside an equation image',()=>{
  assert.throws(()=>validateVisionPage({page:1,regions:[{kind:'formula',bbox:[.1,.2,.9,.3],candidateIds:['intro','eq']}],textBlocks:[]}, {n:1,candidates:[{id:'intro',text:'The following terms:'},{id:'eq',text:'x = y'}]}),error=>error.code==='vision-ownership')
})

test('legacy paragraph groups have the same protected text ownership as textBlocks',()=>{
  const intro={id:'intro',kind:'paragraph',text:'The following terms:',sourceRect:{x:.1,y:.2,w:.2,h:.02}}
  const continuation={id:'rest',kind:'paragraph',text:'continued prose',sourceRect:{x:.1,y:.1,w:.2,h:.02}}
  const eq={id:'eq',kind:'paragraph',text:'x = y',sourceRect:{x:.4,y:.23,w:.2,h:.02}}
  const result=applyVisionLayout({pages:[{n:1,sourceBlocks:[intro,continuation,eq],blocks:[]}]},{pages:[{n:1,regions:[{kind:'formula',bbox:[.05,.19,.95,.27],candidateIds:['eq']}],paragraphs:[['rest','intro']]}]})
  const formula=result.content.pages[0].blocks.find(block=>block.kind==='formula')
  assert.ok(!formula.sourceIds.includes('intro'))
  assert.ok(formula.exclusionRects.some(rect=>rect.x===intro.sourceRect.x&&rect.y===intro.sourceRect.y))
  assert.throws(()=>validateVisionPage({regions:[{kind:'formula',bbox:[.1,.2,.9,.3],candidateIds:['eq']}],paragraphs:[['eq','rest']]},{n:1,candidates:[eq,continuation]}),error=>error.code==='vision-ownership')
})

test('an explicit caption demotion is classified prose and is protected from image consumption',()=>{
  const body={id:'body',kind:'caption',text:'Table 1 gives the model sizes.',sourceRect:{x:.1,y:.2,w:.3,h:.02}}
  const eq={id:'eq',kind:'paragraph',text:'x = y',sourceRect:{x:.4,y:.23,w:.2,h:.02}}
  const value=validateVisionPage({page:1,regions:[{kind:'formula',bbox:[.05,.19,.95,.27],candidateIds:['eq']}],captionFixes:[{id:'body',kind:'paragraph'}]},{n:1,candidates:[body,eq]})
  const result=applyVisionLayout({pages:[{n:1,sourceBlocks:[body,eq],blocks:[]}]},{pages:[{n:1,...value}]})
  assert.equal(result.content.pages[0].blocks.find(block=>block.id==='body').kind,'paragraph')
  assert.ok(!result.content.pages[0].blocks.find(block=>block.kind==='formula').sourceIds.includes('body'))
})
test('an AI-owned legend outside an approximate box is covered and not duplicated as prose',()=>{
  const sourceBlocks=[{id:'legend',kind:'paragraph',text:'Legend A',sourceRect:{x:.2,y:.51,w:.3,h:.02}},{id:'body',kind:'paragraph',text:'Body remains selectable.'}]
  const result=applyVisionLayout({pages:[{n:1,sourceBlocks,blocks:sourceBlocks}]},{pages:[{n:1,regions:[{kind:'figure',candidateIds:['legend'],bbox:[.1,.1,.9,.5]}],textBlocks:[{ids:['body'],kind:'paragraph'}]}]})
  const image=result.content.pages[0].blocks.find(block=>block.kind==='figure')
  assert.ok(image.rect.y+image.rect.h>=.53)
  assert.ok(!result.content.pages[0].blocks.some(block=>block.id==='legend'&&block.kind==='paragraph'))
  assert.equal(result.content.pages[0].blocks.find(block=>block.id==='body').text,'Body remains selectable.')
})
