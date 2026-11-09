import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {EventEmitter} from 'node:events'
import {MineruService,mineruProcessEnv} from '../host/mineru.js'
import {ReaderStore} from '../host/store.js'
import {ReaderError} from '../host/util.js'
import {mineruPageLayout,mineruLayout} from '../shared/mineru-layout.js'
import {applyVisionLayout} from '../client-src/vision-layout.js'
import {runVisualLayout,keepFailedPagesOriginal,hasCurrentVisualLayout} from '../client-src/layout-pipeline.js'
import {VISION_LAYOUT_VERSION} from '../client-src/vision-layout.js'
import {MINERU_LAYOUT_VERSION} from '../shared/mineru-layout.js'
import {buildMediaIndex} from '../shared/media-index.js'

const source=(id,text,x,y,w,h)=>({id,text,kind:'paragraph',page:1,rect:{x,y,w,h},sourceRect:{x,y,w,h},fontSize:10})
test('parser contract upgrades invalidate only older local mappings, preserving completed visual-model documents',()=>{
 const content={visionLayoutStatus:'complete',visionLayoutVersion:VISION_LAYOUT_VERSION}
 assert.equal(hasCurrentVisualLayout(content),true)
 assert.equal(hasCurrentVisualLayout({...content,parser:{engine:'mineru',version:MINERU_LAYOUT_VERSION-1}}),false)
 assert.equal(hasCurrentVisualLayout({...content,parser:{engine:'mineru',version:MINERU_LAYOUT_VERSION}}),true)
})
function example(){
 const page={n:1,width:600,height:800,fontSize:10,sourceBlocks:[source('intro','A complete introduction before the equation.',.08,.08,.38,.03),source('equation','a + b = c (7)',.1,.15,.35,.04),source('cap1','TABLE II',.18,.24,.1,.015),source('cap2','Reward specifications',.13,.26,.22,.015),source('header','Name Formula Weight',.08,.30,.38,.02),source('row1','Term one formula alpha 1.2',.08,.34,.38,.02),source('row2','Last row complete -0.1',.08,.52,.38,.02),source('right','The right column stays independent and readable.',.54,.30,.37,.06)]}
 page.blocks=[source('bad','old overlapping heuristic crop',.08,.3,.85,.3)]
 const parsed={page_idx:0,blocks:[{type:'text',index:0,bbox:[.07,.07,.47,.12],content:[{type:'text',content:page.sourceBlocks[0].text}]},{type:'equation',index:1,bbox:[.08,.14,.47,.20],content:'a+b=c\\tag{7}'},{type:'table',index:4,bbox:[.07,.29,.47,.55],content:[{type:'table_caption',index:2,bbox:[.18,.24,.28,.255],content:'TABLE II'},{type:'table_caption',index:3,bbox:[.13,.26,.35,.275],content:'Reward specifications'},{type:'table_body',index:4,bbox:[.07,.29,.47,.55],content:'table'}]},{type:'text',index:5,bbox:[.53,.29,.92,.38],content:page.sourceBlocks.at(-1).text}]}
 return{page,parsed,content:{kind:'pdf',pageCount:1,pages:[page]}}
}
const cleanup=async dir=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));await rm(dir,{recursive:true,force:true})}

test('a whole table owns all rows once, equations remain separate, and adjacent columns never join',()=>{
 const {page,parsed,content}=example(),before=JSON.stringify(page.sourceBlocks),answer=mineruPageLayout(page,parsed)
 const table=answer.regions.find(r=>r.kind==='table'),formula=answer.regions.find(r=>r.kind==='formula')
 assert.deepEqual(table.candidateIds,['header','row1','row2']);assert.deepEqual(formula.candidateIds,['equation']);assert.equal(formula.number,'7')
 const result=applyVisionLayout(content,{pages:[answer],model:'MinerU fixture'}).content.pages[0].blocks
 const rendered=result.find(b=>b.structure==='table');assert.ok(rendered.cropRect.x+rendered.cropRect.w<.51);assert.ok(rendered.cropRect.y+rendered.cropRect.h>=.54)
 assert.equal(result.find(b=>b.kind==='caption').text,'TABLE II Reward specifications')
 assert.equal(result.find(b=>b.id==='right').text,page.sourceBlocks.at(-1).text)
 assert.equal(result.filter(b=>b.kind==='formula').length,1);assert.equal(JSON.stringify(page.sourceBlocks),before)
})
test('invalid or mismatched parser geometry is rejected and original sources survive fallback',()=>{
 const {page,parsed,content}=example();for(const b of parsed.blocks)b.bbox=[.85,.85,.99,.99]
 assert.throws(()=>mineruPageLayout(page,parsed),/geometry/)
 const value=keepFailedPagesOriginal(content,[{page:1,message:'No reliable structure'}]).pages[0]
 assert.equal(value.layoutFailed,true);assert.equal(value.blocks.length,1);assert.equal(value.blocks[0].kind,'pageFigure');assert.deepEqual(value.sourceBlocks,page.sourceBlocks)
})
test('a scanned page creates OCR source anchors, and missing returned pages remain failures',()=>{
 const parsed={page_idx:0,blocks:[{type:'text',index:0,bbox:[.1,.1,.8,.2],content:'OCR paragraph with actual text.'}]}
 const answer=mineruPageLayout({n:1,blocks:[],width:600,height:800},parsed)
 assert.equal(answer.ocr,true);assert.equal(answer.sourceBlocks[0].text,'OCR paragraph with actual text.')
 const result=mineruLayout({pages:[{n:1,blocks:[]},{n:2,blocks:[]}]},{pages:[parsed]});assert.match(result.pages[1].error,/did not return/)
 const unreadScan={n:1,sourceBlocks:[],blocks:[{kind:'pageFigure'}]}
 const unread=mineruLayout({pages:[unreadScan]},{pages:[{page_idx:0,blocks:[]}]})
 assert.match(unread.pages[0].error,/original page is kept/)
})
test('table structure takes precedence over a missing or nonstandard caption label',()=>{
 const media=buildMediaIndex([{id:'table',kind:'figure',structure:'table',alt:'Reward specifications'},{id:'eq',kind:'formula',number:'7'}])
 assert.equal(media[0].kind,'table');assert.equal(media[1].kind,'formula')
})
test('chart bodies and chart captions form a figure without consuming the separate caption',()=>{
 const page={n:1,width:600,height:800,sourceBlocks:[source('plot','A B C axis values',.1,.1,.7,.3),source('caption','Figure 2: Experimental comparisons across conditions.',.1,.42,.7,.03)]}
 const parsed={blocks:[{type:'chart',index:0,bbox:[.09,.09,.82,.46],content:[{type:'chart_body',bbox:[.09,.09,.82,.41],content:'chart'},{type:'chart_caption',index:1,bbox:[.09,.42,.82,.46],content:page.sourceBlocks[1].text}]}]}
 const answer=mineruPageLayout(page,parsed);assert.equal(answer.regions[0].kind,'figure');assert.deepEqual(answer.regions[0].candidateIds,['plot']);assert.equal(answer.regions[0].captionId,'caption');assert.ok(answer.textBlocks.some(group=>group.kind==='caption'))
})
test('MinerU maps disjoint labels independently even when it puts them under the same visual parent',()=>{
 const page={n:1,sourceBlocks:[
  source('first','Figure 6. Measurements from two panels.',.12,.30,.72,.014),
  source('panel','(a) Frequency response',.18,.46,.19,.014),
  source('second','Figure 7. Calibration measurements.',.12,.53,.70,.014),
 ]}
 const parsed={blocks:[{type:'chart',index:1,bbox:[.10,.34,.87,.50],content:[
  {type:'chart_body',bbox:[.10,.34,.87,.45]},
  {type:'chart_caption',bbox:[.11,.30,.86,.315],content:page.sourceBlocks[0].text},
  {type:'chart_caption',bbox:[.17,.46,.38,.475],content:page.sourceBlocks[1].text},
  {type:'chart_caption',bbox:[.11,.53,.84,.545],content:page.sourceBlocks[2].text},
 ]}]}
 const mapped=mineruPageLayout(page,parsed)
 assert.deepEqual(mapped.textBlocks.filter(b=>b.kind==='caption').map(b=>b.ids),[['first'],['panel'],['second']])
 assert.deepEqual(mapped.regions[0].bbox,[.10,.34,.87,.45])
})
test('MinerU code wrappers preserve two algorithm boxes and leave adjacent prose selectable',()=>{
 const page={n:1,width:600,height:800,sourceBlocks:[
  source('algorithm-a','Algorithm 1: Training',.08,.08,.35,.02),
  source('step-a','44 return π',.08,.48,.28,.02),
  source('algorithm-b','Algorithm 2: Inference',.53,.08,.33,.02),
  source('prose','The following prose describes the inference procedure.',.53,.33,.39,.04),
 ]}
 const parsed={blocks:[
  {type:'code',sub_type:'algorithm',index:0,bbox:[.07,.07,.48,.52],content:[{type:'algorithm_body',bbox:[.07,.07,.48,.52],content:'Algorithm 1: Training\n    44 return π'}]},
  {type:'code',index:1,bbox:[.52,.07,.93,.31],content:[{type:'algorithm_body',bbox:[.52,.07,.93,.31],content:'Algorithm 2: Inference'}]},
  {type:'text',index:2,bbox:[.52,.32,.94,.38],content:page.sourceBlocks[3].text},
 ]}
 const answer=mineruPageLayout(page,parsed)
 assert.deepEqual(answer.regions.map(({kind,number,candidateIds})=>[kind,number,candidateIds]),[
  ['algorithm','1',['algorithm-a','step-a']],['algorithm','2',['algorithm-b']],
 ])
 const blocks=applyVisionLayout({pages:[page]},{pages:[answer]}).content.pages[0].blocks
 assert.deepEqual(buildMediaIndex(blocks).map(block=>block.kind),['algorithm','algorithm'])
 assert.equal(blocks.find(block=>block.id==='prose').text,page.sourceBlocks[3].text)
})
test('local layout skips both paid visual and paragraph calls and preserves parser provenance',async()=>{
 const {content,parsed}=example(),calls=[],saves=[]
 const api={rpc:async(method,params)=>{if(method==='parser.status')return{available:true,engine:'auto'};if(method==='content.save')saves.push(params.content);return{}},stream:async method=>{calls.push(method);assert.equal(method,'parser.parse');return{middle:{pages:[parsed],metadata:{producer:{version:'4.test'}}},tier:'standard',elapsedMs:125,cached:true}}}
 const result=await runVisualLayout({api,doc:{id:'doc'},content,renderPages:()=>{throw new Error('No page images should be sent')}})
 assert.equal(result.complete,true);assert.deepEqual(calls,['parser.parse']);assert.equal(saves.at(-1).parser.engine,'mineru');assert.equal(saves.at(-1).parser.local,true)
})
test('retrying a failed MinerU page preserves earlier page blocks even if settings changed',async()=>{
 const {page,parsed}=example()
 const first={...page,blocks:[{id:'existing',kind:'paragraph',text:'Already completed.'}],vision:{version:VISION_LAYOUT_VERSION,engine:'mineru',regions:0}}
 const content={kind:'pdf',pageCount:2,pages:[first,{...page,n:2}],visionLayoutStatus:'partial',visionLayoutModel:'MinerU test',visionLayoutErrors:[{page:2,message:'failed'}]}
 const api={
  rpc:async method=>method==='parser.status'?{engine:'vision'}:{},
  stream:async (method,params)=>{
   assert.equal(method,'parser.parse')
   assert.equal(params.force,true)
   assert.deepEqual(params.pageNumbers,[2])
   return {middle:{pages:[{...parsed,page_idx:1}],metadata:{producer:{version:'4.test'}}},cached:false}
  },
 }
 const result=await runVisualLayout({api,doc:{id:'doc'},content,retryFailed:true})
 assert.equal(result.complete,true)
 assert.deepEqual(result.content.pages[0],first)
 assert.equal(result.content.pages[1].vision.engine,'mineru')
 assert.equal(result.content.visionLayoutPages,2)
})

test('retrying caption verification requests only the failed pages and keeps the parser cache enabled',async()=>{
 const {page,parsed}=example()
 const before={...page,vision:{version:VISION_LAYOUT_VERSION,engine:'mineru'},blocks:[{id:'existing',kind:'paragraph',text:'Already arranged.'}]}
 const content={pages:[before,{...page,n:2}],visionLayoutStatus:'partial',visionLayoutModel:'MinerU test',
  visionLayoutErrors:[{page:2,message:'Ambiguous caption ownership',original:true}]}
 const api={rpc:async method=>method==='parser.status'?{engine:'mineru'}:{},
  stream:async(method,params)=>{
   assert.equal(method,'parser.parse')
   assert.deepEqual(params,{id:'doc',force:false,pageNumbers:[2]})
   return {middle:{pages:[{...parsed,page_idx:1}]},cached:true}
  }}
 const result=await runVisualLayout({api,doc:{id:'doc'},content,retryFailed:true})
 assert.equal(result.complete,true)
 assert.deepEqual(result.content.pages[0],before)
 assert.equal(result.cachedPages,1)
})

test('retrying a whole-document MinerU failure replaces the previous visual layout only after parsing',async()=>{
 const {page,parsed}=example()
 const previous={...page,blocks:[{id:'existing',kind:'paragraph',text:'Previously arranged by the vision model.'}],vision:{version:VISION_LAYOUT_VERSION,engine:'vision',regions:0}}
 const content={kind:'pdf',pageCount:1,pages:[previous],visionLayoutStatus:'partial',visionLayoutModel:'MinerU · local',visionLayoutErrors:[{page:null,message:'Model allocation failed'}]}
 const api={
  rpc:async method=>method==='parser.status'?{engine:'mineru'}:{},
  stream:async (method,params)=>{
   assert.equal(method,'parser.parse')
   assert.equal(params.force,true)
   assert.equal(params.pageNumbers,undefined)
   return {middle:{pages:[parsed]},tier:'basic'}
  },
 }
 const result=await runVisualLayout({api,doc:{id:'doc'},content,retryFailed:true})
 assert.equal(result.complete,true)
 assert.equal(result.content.pages[0].vision.engine,'mineru')
 assert.equal(result.content.parser.tier,'basic')
 assert.deepEqual(result.content.pages[0].sourceBlocks,page.sourceBlocks)
})
test('local failure retains an original-page fallback and never silently invokes a paid model',async()=>{
 const {content}=example(),methods=[],saves=[]
 const api={rpc:async(method,params)=>{if(method==='parser.status')return{available:true,engine:'mineru'};if(method==='content.save')saves.push(params.content);return{}},stream:async method=>{methods.push(method);throw new Error('Local model unavailable')}}
 await assert.rejects(runVisualLayout({api,doc:{id:'doc'},content}),/Local model/)
 assert.deepEqual(methods,['parser.parse']);assert.equal(saves.at(-1).pages[0].layoutFailed,true);assert.equal(saves.at(-1).visionLayoutStatus,'partial')
})

async function serviceFixture(){
 const dir=await mkdtemp(join(tmpdir(),'reader-mineru-')),store=new ReaderStore(dir);await store.init()
 const add=async name=>{const upload=await store.saveUpload(name+'.pdf','pdf',Buffer.from('%PDF-'+name));return store.addDoc({storedPath:upload.path,format:'pdf',name:name+'.pdf',meta:{title:name},content:{kind:'pdf',pages:[{n:1,blocks:[]}]}})}
 const docs=[await add('one'),await add('two')],service=new MineruService({store});service.status=async()=>({available:true,version:'4.test',tier:'standard'})
 return{dir,store,docs,service}
}
test('parser results cache by source bytes and force bypasses that cache',async()=>{
 const {dir,service,docs}=await serviceFixture();let calls=0
 service.run=async args=>{calls++;await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[{page_idx:0,blocks:[]}]},tier:'standard'}));return''}
 try{assert.equal((await service.parse({id:docs[0].id})).cached,false);assert.equal((await service.parse({id:docs[0].id})).cached,true);await service.parse({id:docs[0].id,force:true});assert.equal(calls,2)}finally{service.dispose();await cleanup(dir)}
})
test('the local parser can answer a scoped retry from a verified full-document cache',async()=>{
 const {dir,store,service,docs}=await serviceFixture()
 const id=docs[0].id
 let calls=0
 await store.saveContent(id,{pageCount:3,pages:[]})
 service.run=async args=>{
  calls++
  await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[0,1,2].map(page_idx=>({page_idx,blocks:[]})),is_full_document:true},tier:'standard'}))
  return ''
 }
 try{
  const complete=await service.parse({id})
  assert.equal(complete.cached,false)
  const scoped=await service.parse({id,pageNumbers:[3,1]})
  assert.equal(scoped.cached,true)
  assert.equal(scoped.middle.is_full_document,false)
  assert.deepEqual(scoped.middle.pages.map(p=>p.page_idx),[0,2])
  assert.equal(calls,1)
  assert.equal((await service.parse({id})).middle.pages.length,3)
 }finally{service.dispose();await cleanup(dir)}
})
test('different binary PDFs never share a cache key through lossy UTF-8 coercion',async()=>{
 const {dir,service,docs}=await serviceFixture();let calls=0
 service.run=async args=>{calls++;await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[{page_idx:0,blocks:[]}]}}));return''}
 try{for(const byte of [254,255]){await writeFile(service.store.paths.original(docs[0].id,'pdf'),Buffer.from([37,80,68,70,byte]));await service.parse({id:docs[0].id})}assert.equal(calls,2)}finally{service.dispose();await cleanup(dir)}
})
test('one global local-parser queue prevents overlapping GPU work and cancels waiting documents',async()=>{
 const {dir,service,docs}=await serviceFixture();let release,entered,active=0,maxActive=0,calls=0
 const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve)
 service.run=async(args)=>{calls++;active++;maxActive=Math.max(maxActive,active);entered();await held;await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[{page_idx:0,blocks:[]}]}}));active--;return''}
 try{
  const first=service.parse({id:docs[0].id});await started
  await assert.rejects(service.parse({id:docs[0].id}),error=>error.code==='parser-busy')
  const controller=new AbortController(),second=service.parse({id:docs[1].id,signal:controller.signal}),cancelled=assert.rejects(second,error=>error.code==='aborted')
  controller.abort();await cancelled;release();await first;assert.equal(maxActive,1);assert.equal(calls,1);assert.deepEqual(await readdir(service.store.paths.tmp),[])
 }finally{release?.();service.dispose();await cleanup(dir)}
})
test('subprocess runner passes argument arrays without a shell, times out and kills cancelled work',async()=>{
 const launch=(_python,args,options)=>{assert.equal(options.shell,false);assert.ok(args.includes('--status'));const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{setImmediate(()=>child.emit('close',1));return true};return child}
 const service=new MineruService({store:{},launch});service.python=async()=>'/isolated/python'
 await assert.rejects(service.run(['--status'],{timeoutMs:5}),/超时/)
 const controller=new AbortController(),running=service.run(['--status'],{signal:controller.signal});controller.abort();await assert.rejects(running,error=>error.code==='aborted');assert.equal(service.children.size,0)
})

test('MinerU bounds Windows parser workers and page windows when memory is limited',()=>{
 const gib=1024**3
 const env={MINERU_PROCESSING_WINDOW_SIZE:'64',MINERU_PDF_RENDER_THREADS:'8',OPENBLAS_NUM_THREADS:'12'}
 const smallMachine={total:16*gib,free:8*gib}
 const busyMachine={total:32*gib,free:3*gib}
 for(const memory of [smallMachine,busyMachine]) {
  const child=mineruProcessEnv(env,'win32',memory)
  assert.equal(child.OPENBLAS_NUM_THREADS,'1')
  assert.equal(child.OPENBLAS_DEFAULT_NUM_THREADS,'1')
  assert.equal(child.MINERU_PROCESSING_WINDOW_SIZE,'3')
  assert.equal(child.MINERU_PDF_RENDER_THREADS,'1')
  assert.equal(child.DOCVORTEX_PDF_RENDER_THREADS,'1')
 }
 assert.equal(mineruProcessEnv({MINERU_PROCESSING_WINDOW_SIZE:'2'},'win32',busyMachine).MINERU_PROCESSING_WINDOW_SIZE,'2')
 assert.equal(mineruProcessEnv(env,'win32',{total:32*gib,free:12*gib}).MINERU_PROCESSING_WINDOW_SIZE,'64')
 assert.equal(mineruProcessEnv(env,'linux',busyMachine).OPENBLAS_NUM_THREADS,'12')
 assert.equal(env.OPENBLAS_NUM_THREADS,'12')
})

test('MinerU reports memory exhaustion and unexpected worker exits without a Python traceback',async()=>{
 const cases=[
  ['OpenBLAS error: Memory allocation still failed after 10 retries\nRuntimeError: PDF render worker exited: 1','parser-memory'],
  ['numpy._core._exceptions._ArrayMemoryError: Unable to allocate 5.18 MiB','parser-memory'],
  ['DmlFusedConv\0 failed with HRESULT 8007000E\0\nUnicodeDecodeError: invalid continuation byte','parser-accelerator'],
  ['onnxruntime.capi.onnxruntime_pybind11_state.Fail: [ONNXRuntimeError] : FAIL : Load model from model.onnx failed:bad allocation','parser-model-memory'],
  ['onnxruntime.capi.onnxruntime_pybind11_state.RuntimeException: [ONNXRuntimeError] : RUNTIME_EXCEPTION : running Loop node. Status Message: std::bad_alloc','parser-model-memory'],
  ['OSError: [WinError 1455] The paging file is too small for this operation to complete','parser-memory'],
  ['RuntimeError: PDF render worker exited: 1','parser-render-worker'],
 ]
 for(const [stderr,code] of cases) {
  const launch=()=>{
   const child=new EventEmitter()
   child.stdout=new EventEmitter()
   child.stderr=new EventEmitter()
   setImmediate(()=>{child.stderr.emit('data',stderr);child.emit('close',1)})
   return child
  }
  const service=new MineruService({store:{},launch})
  service.python=async()=>'/isolated/python'
  await assert.rejects(service.run(['--status']),error=>error.code===code&&!error.message.includes('RuntimeError'))
 }
})

test('critical Windows commit pressure stops parsing before a second launch',async()=>{
 const {dir,service,docs}=await serviceFixture()
 service.python=async()=>'/isolated/python'
 let launches=0
 service.launch=()=>{
  launches++
  const child=new EventEmitter()
  child.stdout=new EventEmitter()
  child.stderr=new EventEmitter()
  setImmediate(()=>{
   child.stdout.emit('data','{"error":"parser-commit-')
   child.stdout.emit('data','low","availableMiB":200}\n')
   child.emit('close',1)
  })
  return child
 }
 try {
  await assert.rejects(service.parse({id:docs[0].id}),error=>error.code==='parser-commit-low'&&error.message.includes('200 MiB'))
  assert.equal(launches,1)
 } finally {service.dispose();await cleanup(dir)}
})

test('a Basic ONNX allocation failure uses one fresh CPU attempt at the same tier',async()=>{
 const {dir,service,docs}=await serviceFixture()
 service.status=async()=>({available:true,version:'4.test',tier:'basic'})
 const attempts=[]
 service.run=async(args,{env})=>{
  attempts.push({args,env})
  if(attempts.length===1)throw new ReaderError('parser-model-memory','Allocation failed')
  await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[{page_idx:0,blocks:[]}]},tier:'basic'}))
 }
 try {
  const result=await service.parse({id:docs[0].id})
  assert.equal(result.recovery,'cpu')
  assert.equal(attempts.length,2)
  assert.ok(attempts.every(({args})=>args[args.indexOf('--tier')+1]==='basic'))
  assert.equal(attempts[1].env.MINERU_MODEL_ONNX_DEVICE,'cpu')
  assert.equal(attempts[1].env.MINERU_PROCESSING_WINDOW_SIZE,'1')
 } finally {service.dispose();await cleanup(dir)}
})

test('runtime memory failures retry serially, then accelerator failure switches only this attempt to CPU',async()=>{
 const {dir,service,docs}=await serviceFixture()
 const calls=[],profiles=[]
 service.run=async(args,{env,timeoutMs})=>{
  calls.push({args,env,timeoutMs})
  if(calls.length===1)throw new ReaderError('parser-memory','Allocation failed')
  if(calls.length===2)throw new ReaderError('parser-accelerator','Accelerator allocation failed')
  await writeFile(args[args.indexOf('--output')+1],JSON.stringify({middle:{pages:[{page_idx:0,blocks:[]}]},tier:'standard'}))
 }
 try {
  const result=await service.parse({id:docs[0].id,onProgress:progress=>{
   if(progress.stage==='recovering')profiles.push(progress.profile)
  }})
  assert.equal(result.recovery,'cpu')
  assert.equal(result.tier,'standard')
  assert.deepEqual(profiles,['serial','cpu'])
  assert.equal(calls[1].env.MINERU_PROCESSING_WINDOW_SIZE,'1')
  assert.equal(calls[2].env.MINERU_MODEL_ONNX_DEVICE,'cpu')
  assert.equal(calls[2].env.MINERU_LLAMA_CPP_BACKEND,'cpu')
  assert.ok(calls[2].timeoutMs<=calls[0].timeoutMs)
  assert.equal((await service.parse({id:docs[0].id})).cached,true)
  assert.equal(calls.length,3)
 } finally {service.dispose();await cleanup(dir)}
})

test('a repeatable render error isolates the affected page and does not cache an incomplete document',async()=>{
 const {dir,store,service,docs}=await serviceFixture()
 const id=docs[0].id, allPages=[1,2,3,4,5], ranges=[]
 await store.saveContent(id,{kind:'pdf',pageCount:5,pages:allPages.map(n=>({n,blocks:[]}))})
 let badPage=3
 service.run=async args=>{
  const range=args.includes('--page-range')?args[args.indexOf('--page-range')+1]:null
  ranges.push(range)
  const pages=range?range.split(',').map(Number):allPages
  if(pages.includes(badPage))throw new ReaderError('parser-render-worker','Page render worker exited')
  await writeFile(args[args.indexOf('--output')+1],JSON.stringify({
   middle:{pages:pages.map(n=>({page_idx:n-1,blocks:[]}))},tier:'standard',
  }))
 }
 try {
  const result=await service.parse({id})
  assert.equal(result.recovery,'pages')
  assert.deepEqual(result.middle.pages.map(page=>page.page_idx+1),[1,2,4,5])
  assert.deepEqual(ranges,[null,null,'1,2,3','4,5','1,2','3'])
  badPage=null
  const retry=await service.parse({id,pageNumbers:[3],force:true})
  assert.deepEqual(retry.middle.pages.map(page=>page.page_idx+1),[3])
  assert.equal(ranges.at(-1),'3')
  assert.equal((await service.parse({id})).cached,false)
  assert.equal(ranges.at(-1),null)
 } finally {service.dispose();await cleanup(dir)}
})

test('a worker startup failure retries once without splitting every page',async()=>{
 const {dir,service,docs}=await serviceFixture()
 let calls=0
 service.run=async args=>{
  calls++
  assert.equal(args.includes('--page-range'),false)
  const error=new ReaderError('parser-render-worker','Worker could not open PDF')
  error.openingPdf=true
  throw error
 }
 try {
  await assert.rejects(service.parse({id:docs[0].id}),error=>error.code==='parser-render-worker')
  assert.equal(calls,2)
 } finally {service.dispose();await cleanup(dir)}
})
