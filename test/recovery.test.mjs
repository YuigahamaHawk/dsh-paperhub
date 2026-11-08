import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createApi} from '../client-src/api.js'
import {createPendingSaves} from '../shared/pending-saves.js'
import {ReaderStore} from '../host/store.js'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
const ok=value=>new Response(JSON.stringify({ok:true,value}),{headers:{'content-type':'application/json'}})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('a transient read failure reconnects once without replaying a mutation/model request',async()=>{
 let fail=true,calls=[]
 const api=createApi({recoveryDelays:[10000],fetchImpl:async(url,init)=>{const {method}=JSON.parse(init.body);calls.push(method);if(fail){fail=false;throw new TypeError('Failed to fetch')}return ok({docs:[]})}})
 const states=[];api.subscribeConnection(()=>states.push(api.getConnection().status))
 await api.rpc('library.list');assert.deepEqual(calls,['library.list','library.list']);assert.equal(api.getConnection().status,'connected');assert.ok(states.includes('offline'))
 fail=true;calls=[];await assert.rejects(api.rpc('ai.translate'),/无法连接/);assert.deepEqual(calls,['ai.translate'])
 await api.reconnect();assert.equal(api.getConnection().status,'connected');api.dispose()
})

test('a disconnected carrier probes and recovers automatically; 401 stops automatic retries',async()=>{
 let online=false,calls=0
 const api=createApi({recoveryDelays:[10],fetchImpl:async()=>{calls++;if(!online)throw new TypeError('Failed to fetch');return ok({})}})
 await assert.rejects(api.rpc('annotations.save',{}));online=true
 for(let i=0;i<50&&api.getConnection().status!=='connected';i++)await sleep(10)
 assert.equal(api.getConnection().status,'connected');assert.equal(api.getConnection().revision,1);api.dispose()
 let authCalls=0
 const auth=createApi({recoveryDelays:[10],fetchImpl:async()=>{authCalls++;return new Response('',{status:401})}})
 await assert.rejects(auth.rpc('library.list'));await sleep(40);assert.equal(authCalls,1);assert.equal(auth.getConnection().status,'unauthorized');auth.dispose()
})

test('host persists translated text anchors without changing legacy original anchors',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-anchor-test-')),store=new ReaderStore(directory)
 try{
  await store.init()
  // Standalone fixture with no user documents or account configuration.
  const storedPath=join(directory,'fixture.epub');await writeFile(storedPath,'epub fixture')
  const doc=await store.addDoc({storedPath,format:'epub',name:'anchors.epub',meta:{title:'Anchor fixture'},content:{kind:'epub',blocks:[]}})
  const annotations=[{id:'one',text:'Original',target:{kind:'reflow',blockId:'p1',start:0,end:8}},{id:'two',text:'译文',target:{kind:'reflow',blockId:'p1',start:0,end:2,layer:'translation',lang:'zh-CN'}}]
  await store.saveAnnotations(doc.id,annotations)
  const saved=await store.getAnnotations(doc.id)
  assert.equal(saved[0].target.layer,undefined);assert.equal(saved[1].target.layer,'translation');assert.equal(saved[1].target.lang,'zh-CN')
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));await rm(directory,{recursive:true,force:true})}
})

test('annotation snapshots survive lost acknowledgements and retry the latest version per document',async()=>{
 const raw=new Map(),storage={getItem:key=>raw.get(key),setItem:(key,value)=>raw.set(key,value),removeItem:key=>raw.delete(key)},calls=[]
 let online=false
 const saves=createPendingSaves({storage,delay:10000,save:async(id,value)=>{calls.push([id,value]);if(!online)throw new Error('network')}})
 saves.set('doc-a',[{id:'a',note:'first'}]);await saves.flush();assert.equal(saves.size,1);assert.equal(raw.size,1)
 saves.set('doc-a',[{id:'a',note:'edited offline'}]);online=true;await saves.flush()
 assert.equal(saves.size,0);assert.equal(raw.size,0);assert.equal(calls.at(-1)[1][0].note,'edited offline')
 saves.set('doc-b',[{id:'b',note:'restored after reopening'}])
 const restored=createPendingSaves({storage,delay:10000,save:async(id,value)=>calls.push([id,value])});restored.recover(['doc-b']);assert.equal(restored.peek('doc-b')[0].note,'restored after reopening')
 await saves.flush();await restored.flush()
})

test('writes for one document are serialized while a later edit wins over an older response',async()=>{
 let release;const calls=[]
 const saves=createPendingSaves({delay:10000,save:async(id,value)=>{calls.push(value);if(calls.length===1)await new Promise(resolve=>release=resolve)}})
 saves.set('a',[1]);const pending=saves.flush();await sleep(0);saves.set('a',[2]);const waiting=saves.flush();assert.equal(calls.length,1)
 release();await Promise.all([pending,waiting]);assert.deepEqual(calls,[[1],[2]]);assert.equal(saves.size,0)
})

test('temporarily missing Host routes and interrupted response bodies enter recovery',async()=>{
 for(const failure of [new Response('Host restarting',{status:503}),{status:200,json:async()=>{throw new TypeError('Body stream lost')}}]){
  let online=false
  const api=createApi({recoveryDelays:[10000],fetchImpl:async()=>online?ok({docs:[]}):failure})
  await assert.rejects(api.rpc('library.list'),error=>error.code==='network');assert.equal(api.getConnection().status,'offline')
  online=true;await api.reconnect();assert.equal(api.getConnection().status,'connected');api.dispose()
 }
})
