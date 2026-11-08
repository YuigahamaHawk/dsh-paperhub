import {spawn} from 'node:child_process'
import {access,readFile,unlink,stat} from 'node:fs/promises'
import {join,isAbsolute} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {ReaderError,newId} from './util.js'

const bridge=fileURLToPath(new URL('../tools/mineru_bridge.py',import.meta.url))
export class MineruService {
  constructor({store,launch=spawn}={}){this.store=store;this.launch=launch;this.running=new Map();this.children=new Set();this.statusCache=null;this.queue=Promise.resolve()}
  dispose(){for(const value of this.running.values())value.controller.abort();for(const child of this.children)child.kill()}
  async python(){
    const configured=this.store.getSettings().parser?.python
    const candidate=configured||join(homedir(),'.dsh','tools','mineru',process.platform==='win32'?'Scripts/python.exe':'bin/python')
    if(!isAbsolute(candidate))throw new ReaderError('parser-config','MinerU Python 路径必须是绝对路径')
    try{await access(candidate);return candidate}catch{throw new ReaderError('parser-unavailable','本机 MinerU 尚未安装或路径无效，请在文档解析设置中配置')}
  }
  async run(args,{signal,onProgress=()=>{},timeoutMs=120000}={}) {
    const python=await this.python()
    return new Promise((resolve,reject)=>{
      const child=this.launch(python,[bridge,...args],{windowsHide:true,shell:false,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}})
      this.children.add(child)
      let output='',errors='',pending='',timedOut=false
      const stop=()=>child.kill(),timer=setTimeout(()=>{timedOut=true;stop()},timeoutMs)
      signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop()
      child.stdout.on('data',chunk=>{output+=chunk;pending+=chunk;if(output.length>1000000){output=output.slice(-1000000)};const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)try{const value=JSON.parse(line);if(value.stage)onProgress(value)}catch{}})
      child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-12000)})
      child.on('error',finish);child.on('close',code=>finish(code===0?null:new ReaderError(signal?.aborted?'aborted':'parser-failed',signal?.aborted?'已停止本机解析':timedOut?'本机解析超时，原有内容已保留':'MinerU 解析失败：'+errors.slice(-600))))
      let settled=false
      const children=this.children
      function finish(error){if(settled)return;settled=true;children.delete(child);clearTimeout(timer);signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve(output)}
    })
  }
  async status(){
    const settings=this.store.getSettings().parser??{},key=JSON.stringify(settings)
    if(this.statusCache?.key===key&&Date.now()-this.statusCache.at<30000)return this.statusCache.value
    let value
    try{const text=await this.run(['--status','--tier',settings.tier??'standard'],{timeoutMs:12000}),info=JSON.parse(text.trim().split(/\r?\n/).at(-1));value={available:true,version:info.version,engine:settings.engine??'auto',tier:settings.tier??'standard',local:true}}
    catch(error){value={available:false,engine:settings.engine??'auto',tier:settings.tier??'standard',message:error.message}}
    this.statusCache={key,at:Date.now(),value};return value
  }
  async parse({id,force=false,signal,onProgress=()=>{}}){
    if(signal?.aborted)throw new ReaderError('aborted','已停止本机解析')
    if(this.running.has(id))throw new ReaderError('parser-busy','这篇文献正在进行本机解析')
    const doc=this.store.getDoc(id);if(!doc||doc.format!=='pdf')throw new ReaderError('parser-document','本机解析仅支持书库内的 PDF')
    const output=join(this.store.paths.tmp,'mineru-'+newId(20)+'.json')
    const marker={controller:new AbortController(),started:false};this.running.set(id,marker)
    const combined=signal?AbortSignal.any([signal,marker.controller.signal]):marker.controller.signal
    let task
    try{
      const original=join(this.store.paths.docDir(id),'original.pdf'),bytes=await readFile(original),status=await this.status()
      if(combined.aborted)throw new ReaderError('aborted','已停止本机解析')
      if(!status.available)throw new ReaderError('parser-unavailable',status.message)
      const key=`mineru-local-v2-${status.version}|${status.tier}|image-analysis-off|${createHash('sha256').update(bytes).digest('hex')}`
      if(!force){const cached=await this.store.getCachedReflow(key);if(cached?.middle)return{...cached,cached:true}}
      onProgress({stage:'queued',local:true,tier:status.tier})
      task=this.queue.then(()=>{if(combined.aborted)throw new ReaderError('aborted','已停止本机解析');marker.started=true;onProgress({stage:'starting',local:true,tier:status.tier});return this.run(['--input',original,'--output',output,'--tier',status.tier],{signal:combined,onProgress,timeoutMs:1800000})})
      this.queue=task.catch(()=>{})
      let cancel
      try{await Promise.race([task,new Promise((_,reject)=>{cancel=()=>reject(new ReaderError('aborted','已停止本机解析'));combined.addEventListener('abort',cancel,{once:true});if(combined.aborted)cancel()})])}finally{combined.removeEventListener('abort',cancel)}
      if(combined.aborted)throw new ReaderError('aborted','已停止本机解析')
      if((await stat(output)).size>64*1024*1024)throw new ReaderError('parser-size','本机解析结果过大')
      const result=JSON.parse(await readFile(output,'utf8'))
      if(!Array.isArray(result.middle?.pages)||!result.middle.pages.length)throw new ReaderError('parser-content','本机解析没有返回有效页面')
      await this.store.setCachedReflow(key,result)
      return {...result,cached:false}
    }finally{if(marker.started&&combined.aborted)await task?.catch(()=>{});if(this.running.get(id)===marker)this.running.delete(id);await unlink(output).catch(()=>{});await unlink(output+'.part').catch(()=>{})}
  }
}
