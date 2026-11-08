import {test} from 'node:test'
import assert from 'node:assert/strict'
import {deflateRawSync} from 'node:zlib'
import {zipStored,crc} from '../shared/zip-writer.js'
import {prepareImportFiles,collectDroppedFiles,abortImport} from '../client-src/import-sources.js'
import {openDocumentArchive} from '../client-src/epub.js'
import {publicAddress,normalizeImportUrl,documentLinks,fetchDocument,readPublicUrl} from '../host/remote-import.js'
import {createApi} from '../client-src/api.js'
import {ReaderStore} from '../host/store.js'
import {createRpcSurface} from '../host/rpc.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'

const bytes=text=>new TextEncoder().encode(text)
const file=(name,data)=>({name,size:data.byteLength,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)})

test('ZIP batch reads nested Chinese names, skips unrelated files and checks member CRC',async()=>{
 const data=zipStored([['资料/论文.pdf',bytes('%PDF-fixture')],['book.epub',bytes('epub fixture')],['readme.txt','not a paper']])
 const pack=openDocumentArchive(data.buffer)
 assert.deepEqual(pack.files.map(item=>item.relativePath),['资料/论文.pdf','book.epub']);assert.deepEqual(pack.skipped,['readme.txt'])
 assert.equal(new TextDecoder().decode(await pack.files[0].arrayBuffer()),'%PDF-fixture')
 const bad=data.slice();bad[30+bytes('资料/论文.pdf').length]^=1
 await assert.rejects(openDocumentArchive(bad.buffer).files[0].arrayBuffer(),/校验失败/)
})

test('ZIP member decompression supports real deflate, independent of EPUB parsing',async()=>{
 const name=Buffer.from('compressed/paper.pdf'),input=Buffer.from('%PDF-compressed fixture '.repeat(100)),payload=deflateRawSync(input)
 const local=Buffer.alloc(30+name.length);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc(input),14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(input.length,22);local.writeUInt16LE(name.length,26);name.copy(local,30)
 const central=Buffer.alloc(46+name.length);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc(input),16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(input.length,24);central.writeUInt16LE(name.length,28);name.copy(central,46)
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length+payload.length,16)
 const zip=Buffer.concat([local,payload,central,end]),pack=openDocumentArchive(zip)
 assert.deepEqual(Buffer.from(await pack.files[0].arrayBuffer()),input)
})

test('batch preparation isolates bad archives, rejects excessive input and respects cancellation',async()=>{
 const good=file('paper.pdf',bytes('%PDF-test')),bad=file('broken.zip',bytes('not zip'))
 const result=await prepareImportFiles([good,bad,file('notes.txt',bytes('skip'))])
 assert.equal(result.files.length,1);assert.equal(result.errors.length,1);assert.equal(result.skipped.length,1)
 await assert.rejects(prepareImportFiles([{name:'huge.pdf',size:301*1024*1024}]),/300 MB/)
 const controller=new AbortController();controller.abort();assert.throws(()=>abortImport(controller.signal),{name:'AbortError'})
 await assert.rejects(prepareImportFiles([good],{signal:controller.signal}),{name:'AbortError'})
})

test('folder drops read every directory chunk and retain relative paths',async()=>{
 const doc=name=>({name,isFile:true,file:done=>done(file(name,bytes('%PDF-file')))})
 const chunks=[[doc('one.pdf')],[doc('two.epub')],[]]
 const directory={name:'papers',fullPath:'/papers',isDirectory:true,createReader:()=>({readEntries:done=>done(chunks.shift())})}
 const files=await collectDroppedFiles({items:[{webkitGetAsEntry:()=>directory}],files:[]})
 assert.deepEqual(files.map(item=>item.relativePath),['papers/one.pdf','papers/two.epub'])
})

test('URL normalization supports DOI/arXiv but rejects credentials and non-HTTP protocols',()=>{
 assert.equal(normalizeImportUrl('https://arxiv.org/abs/1701.06538?x=y').href,'https://arxiv.org/pdf/1701.06538')
 assert.equal(normalizeImportUrl('10.1234/abc').href,'https://doi.org/10.1234/abc')
 for(const url of ['file:///secret.pdf','https://user:pass@example.org/a.pdf','javascript:alert(1)'])assert.throws(()=>normalizeImportUrl(url),/HTTP/)
})

test('remote imports block private, mapped, reserved and mixed public/private DNS addresses',async()=>{
 for(const address of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','2001:0db8::1'])assert.equal(publicAddress(address),false,address)
 assert.equal(publicAddress('1.1.1.1'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true)
 await assert.rejects(readPublicUrl(new URL('http://127.0.0.1/private.pdf')),/内网/)
 await assert.rejects(readPublicUrl(new URL('https://example.org/a.pdf'),{resolve:async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]}),/内网/)
 let fallbackCalled=false
 await assert.rejects(readPublicUrl(new URL('https://example.org/a.pdf'),{resolve:async()=>[{address:'198.18.1.1',family:4}],fallbackResolve:async()=>{fallbackCalled=true;return[{address:'127.0.0.1',family:4}]}}),/内网/)
 assert.equal(fallbackCalled,true)
})

test('URL retrieval follows redirects, recognizes file signatures and discovers citation PDF links',async()=>{
 const visited=[]
 const transport=async url=>{
  visited.push(url.href)
  if(url.pathname==='/doi')return{status:302,headers:{location:'/paper'},bytes:Buffer.alloc(0)}
  if(url.pathname==='/paper')return{status:200,headers:{'content-type':'text/html'},bytes:Buffer.from('<html><head><meta content="A &amp; B" name="citation_title"><meta name="citation_pdf_url" content="/download?id=1&amp;format=pdf"></head></html>')}
  return{status:200,headers:{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf"},bytes:Buffer.from('%PDF-1.7 fixture')}
 }
 const document=await fetchDocument('https://papers.example/doi',{transport})
 assert.equal(document.format,'pdf');assert.equal(document.name,'论文.pdf');assert.equal(document.title,'A & B');assert.equal(visited.length,3);assert.match(visited[2],/id=1&format=pdf/)
 assert.deepEqual(documentLinks('<meta name="citation_pdf_url" content="file:///private.pdf">','https://x.example').urls,[])
 await assert.rejects(fetchDocument('https://x.example/no-file',{transport:async()=>({status:200,headers:{},bytes:Buffer.from('<html><p>Sign in required</p></html>')})}),/未提供/)
})

test('cancelling a URL RPC is not a connection failure and is never retried',async()=>{
 let calls=0
 const api=createApi({fetchImpl:async(_url,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('cancelled'))))}})
 const controller=new AbortController(),request=api.rpc('import.fetchUrl',{url:'https://x.example/a.pdf'},{signal:controller.signal})
 controller.abort();await assert.rejects(request,error=>error.code==='aborted');assert.equal(calls,1);assert.equal(api.getConnection().status,'connected');api.dispose()
})

test('download staging is readable by token and a commit assigns its target folder atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-import-test-')),store=new ReaderStore(dir)
 try{
  await store.init();const surface=createRpcSurface({store,version:'test'}),folder=await store.createFolder('Batch')
  const staged=await store.saveUpload('paper.pdf','pdf',Buffer.from('%PDF-staged fixture'))
  const fileRoute=surface.routes.find(route=>route.path.endsWith('/file'))
  const response=await fileRoute.fetch(new Request('http://local/api/dsh-reader/file?uploadId='+staged.uploadId))
  assert.equal(await response.text(),'%PDF-staged fixture');assert.equal(response.headers.get('cache-control'),'no-store')
  await assert.rejects(surface.unary['upload.commit']({uploadId:staged.uploadId,folderId:'missing-folder'}),/文件夹/)
  assert.equal(store.listDocs().length,0)
  const committed=await surface.unary['upload.commit']({uploadId:staged.uploadId,folderId:folder.id,meta:{title:'Staged'},content:{kind:'pdf',pages:[]}})
  assert.equal(committed.doc.folderId,folder.id)
  assert.equal((await fileRoute.fetch(new Request('http://local/api/dsh-reader/file?uploadId='+staged.uploadId))).status,404)
  assert.equal((await fileRoute.fetch(new Request('http://local/api/dsh-reader/file?uploadId=../../private'))).status,404)
 }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));await rm(dir,{recursive:true,force:true})}
})

test('ZIP traversal paths are rejected and member limits are enforced before reading file bytes',async()=>{
 const zip=zipStored([['ab/p.pdf',bytes('%PDF-fixture')]])
 for(let i=0;i<zip.length-8;i++)if(new TextDecoder().decode(zip.subarray(i,i+8))==='ab/p.pdf')zip.set(bytes('../p.pdf'),i)
 assert.throws(()=>openDocumentArchive(zip.buffer),/不安全/)
 await assert.rejects(prepareImportFiles(Array.from({length:201},(_,i)=>file(i+'.pdf',bytes('x')))),/200/)
})
