import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVisualLayout } from '../client-src/layout-pipeline.js'
import { applyVisionLayout, VISION_LAYOUT_VERSION } from '../client-src/vision-layout.js'
import { constrainMediaCaptions } from '../client-src/layout-captions.js'
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

const fromBox = ([x, y, right, bottom]) => ({ x, y, w: right - x, h: bottom - y })
function interruptedDocument() {
  const block = (page, id, text, bbox, kind = 'paragraph') => ({ page, id, text, kind, sourceRect: fromBox(bbox) })
  return { kind: 'pdf', pages: [
    { n: 1, blocks: [
      block(1, 'a', 'The sensor measures', [.1, .17, .8, .19]),
      block(1, 'cf', 'Figure 1: Two synchronized traces.', [.1, .24, .8, .26], 'caption'),
      block(1, 'b', 'motion around the station and', [.1, .53, .8, .55]),
      block(1, 'pn', '1', [.48, .96, .50, .98]),
    ] },
    { n: 2, blocks: [
      block(2, 'ct', 'TABLE II: Accuracy by sensor.', [.1, .46, .8, .48], 'caption'),
      block(2, 'c', 'reports every event to the monitor.', [.1, .72, .8, .74]),
      block(2, 'h', '2. Results', [.1, .77, .5, .80], 'heading'),
      block(2, 'd', 'The separate results are reported below.', [.1, .84, .8, .86]),
    ] },
  ] }
}

for (const engine of ['mineru', 'vision']) test(engine + ' publishes one caption per object and one complete paragraph across pages and floats', async () => {
  const content = interruptedDocument()
  const [a, cf, b, pn] = content.pages[0].blocks
  const [ct, c, h, d] = content.pages[1].blocks
  const left = [.11, .30, .43, .48], right = [.48, .30, .84, .48], table = [.11, .20, .83, .43], algo = [.11, .53, .83, .67]
  const region = (kind, bbox, captionId) => ({ kind, bbox, captionId, candidateIds: [] })
  const asBox = ({ x, y, w, h }) => [x, y, x + w, y + h]
  const item = (block, type, index) => ({ type, index, bbox: asBox(block.sourceRect), content: block.text })
  const middle = { pages: [
    { page_idx: 0, blocks: [item(a, 'text', 0),
      { type: 'image', index: 1, bbox: left, content: [{ type: 'image_body', bbox: left }, item(cf, 'image_caption', 2)] },
      { type: 'image', index: 3, bbox: right, content: [{ type: 'image_body', bbox: right }] },
      item(b, 'text', 4), item(pn, 'page_number', 5)] },
    { page_idx: 1, blocks: [{ type: 'table', index: 0, bbox: table, content: [{ type: 'table_body', bbox: table }, item(ct, 'table_caption', 1)] },
      { type: 'code', sub_type: 'algorithm', index: 2, bbox: algo }, item(c, 'text', 3), item(h, 'paragraph_title', 4), item(d, 'text', 5)] },
  ] }
  const replies = [
    { n: 1, regions: [region('figure', left, 'cf'), region('figure', right, 'cf')], textBlocks: [a, cf, b, pn].map(block => ({ kind: block.kind, ids: [block.id] })) },
    { n: 2, regions: [region('table', table, null), region('algorithm', algo)], textBlocks: [ct, c, h, d].map(block => ({ kind: block.kind, ids: [block.id] })) },
  ]
  const calls = []
  const api = {
    rpc: async method => method === 'parser.status' ? { engine } : {},
    stream: async (method, params) => {
      calls.push(method)
      if (method === 'parser.parse') return { middle }
      if (method === 'ai.visionLayout') return { pages: [replies[params.pages[0].n - 1]], model: 'test' }
      return { windows: params.windows.map(window => ({ id: window.id, groups: [['a', 'b', 'c', 'd']], demoteCaptions: ['cf', 'ct'] })) }
    },
  }
  const renderInkPages = async ({ onPage }) => onPage(1, { width: 100, height: 100, pixels: new Uint8Array(10000) })
  const result = await runVisualLayout({ api, doc: { id: 'contract' }, content, renderPages, renderInkPages })
  assert.equal(result.complete, true, JSON.stringify(result.errors))
  const [first, second] = result.content.pages.map(page => page.blocks)
  assert.equal(first[0].text, 'The sensor measures motion around the station and reports every event to the monitor.')
  assert.deepEqual(first[0].continuedPages, [1, 2])
  assert.deepEqual(first[0].sourceIds, ['a', 'b', 'c'])
  assert.deepEqual(first.map(block => block.kind), ['paragraph', 'figure', 'caption'])
  assert.equal(first[1].captionId, 'cf')
  assert.equal(first[1].visionRect.w, .84 - .11)
  assert.deepEqual(second.map(block => block.structure ?? block.kind), ['caption', 'table', 'algorithm', 'heading', 'paragraph'])
  assert.equal(second[1].captionId, 'ct')
  assert.equal(second[1].number, 'II')
  assert.equal(second.at(-1).text, d.text)
  if (engine === 'mineru') assert.deepEqual(calls, ['parser.parse'])
  const retry = await runVisualLayout({ api, doc: { id: 'contract' }, content: result.content, force: true, renderPages, renderInkPages })
  assert.deepEqual(retry.content.pages.map(page => page.blocks), [first, second])
})

test('an uncaptioned crop with only a body reference is kept as an original page and really retried', async () => {
  const source = { id: 'ref', kind: 'caption', text: 'Figure 1 shows the readings.', sourceRect: fromBox([.12, .44, .8, .47]) }
  const content = { pages: [{ n: 1, blocks: [source], sourceBlocks: [source] }] }
  const calls = []
  let corrected = false
  const api = {
    rpc: async () => ({}),
    stream: async (method, params) => {
      if (method === 'ai.layoutPlan') return { windows: params.windows.map(({ id }) => ({ id, groups: [] })) }
      calls.push(params.force)
      const caption = { ...source, id: 'caption', text: 'Figure 1. Readings by time.' }
      return { pages: [{ n: 1, sourceBlocks: corrected ? [source, caption] : [source], regions: [
        { kind: 'figure', bbox: [.1, .14, .85, .43], captionId: corrected ? 'caption' : 'ref', number: '1' },
      ], textBlocks: corrected ? [{ ids: ['caption'], kind: 'caption' }] : [], captionFixes: [{ id: 'ref', kind: 'paragraph' }] }] }
    },
  }
  const doc = { id: 'caption-retry' }
  const first = await runVisualLayout({ api, doc, content, renderPages })
  assert.equal(first.complete, false)
  assert.equal(first.content.pages[0].blocks[0].kind, 'pageFigure')
  assert.deepEqual(first.content.pages[0].sourceBlocks, [source])
  assert.match(first.errors[0].message, /unique caption/)
  corrected = true
  const next = await runVisualLayout({ api, doc, content: first.content, retryFailed: true, renderPages })
  assert.equal(next.complete, true, JSON.stringify(next.errors))
  assert.deepEqual(calls, [false, true])
  assert.equal(next.content.pages[0].blocks.find(block => block.id === 'ref').kind, 'paragraph')
})

test('omitting a crop cannot silently turn its native caption into a paragraph', () => {
  const page = { n: 1, blocks: [{ id: 'cap', kind: 'caption', text: 'Figure 2. A set of measurements.' }] }
  const result = constrainMediaCaptions(page, { n: 1, regions: [], textBlocks: [{ ids: ['cap'], kind: 'paragraph' }] })
  assert.match(result.error, /figure for its caption 2/)
  assert.equal(result.original, true)
})

test('an algorithm caption is independent of the figure and table contract', () => {
  const page = { n: 1, blocks: [{ id: 'cap', kind: 'caption', text: 'Algorithm 1. Monitoring and recovery.' }] }
  const result = constrainMediaCaptions(page, { n: 1, regions: [{ kind: 'algorithm', bbox: [.1, .1, .9, .4], captionId: 'cap' }],
    textBlocks: [{ ids: ['cap'], kind: 'caption', captionKind: 'algorithm' }] })
  assert.equal(result.error, undefined)
  assert.equal(result.regions[0].captionId, 'cap')
})

test('shared reconciliation separates stacked multipanel figures even when a model claims the preceding caption', () => {
  const source = (id, text, bbox) => ({ id, text, kind: 'paragraph', sourceRect: fromBox(bbox) })
  const page = { n: 1, blocks: [
    source('a', '(a) First measurement', [.20, .215, .37, .230]),
    source('b', '(b) Second measurement', [.61, .215, .80, .230]),
    source('cap1', 'Figure 6. Measurements by group.', [.20, .252, .80, .265]),
    source('c', '(a) First calibration', [.20, .455, .37, .470]),
    source('d', '(b) Second calibration', [.61, .455, .80, .470]),
    source('cap2', 'Figure 7. Calibrations by group.', [.20, .492, .80, .505]),
  ] }
  const region = (bbox, captionId, number) => ({ kind: 'figure', bbox, captionId, number })
  const answer = constrainMediaCaptions(page, {
    n: 1,
    textBlocks: [{ kind: 'caption', ids: ['a', 'b', 'cap1', 'c', 'd', 'cap2'] }],
    regions: [
      region([.12, .09, .46, .21], 'a'), region([.53, .09, .89, .21], 'b'),
      region([.12, .29, .46, .45], 'cap1', '6'), region([.53, .29, .89, .45], 'd'),
    ],
  }, { width: 10, height: 10, pixels: new Uint8Array(100) })
  assert.equal(answer.error, undefined)
  assert.deepEqual(answer.regions.map(r => [r.captionId, r.number, r.candidateIds]), [['cap1', '6', ['a', 'b']], ['cap2', '7', ['c', 'd']]])
  const [first, firstCaption, second, secondCaption] = applyVisionLayout({ pages: [page] }, { pages: [answer] }).content.pages[0].blocks
  assert.equal(firstCaption.id, first.captionId)
  assert.equal(secondCaption.id, second.captionId)
  assert.equal(firstCaption.text, 'Figure 6. Measurements by group.')
  assert.equal(secondCaption.text, 'Figure 7. Calibrations by group.')
  assert.ok(first.cropRect.y + first.cropRect.h < second.cropRect.y)
})
