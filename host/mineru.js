import {spawn} from 'node:child_process'
import {access,readFile,unlink,stat} from 'node:fs/promises'
import {join,isAbsolute} from 'node:path'
import {freemem,homedir,totalmem} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {ReaderError,newId} from './util.js'

const bridge=fileURLToPath(new URL('../tools/mineru_bridge.py',import.meta.url))
const parseTimeoutMs = 30 * 60 * 1000
const serialRender = {
  MINERU_PDF_RENDER_THREADS: '1',
  DOCVORTEX_PDF_RENDER_THREADS: '1',
}
const singlePage = {
  ...serialRender,
  OPENBLAS_NUM_THREADS: '1',
  OPENBLAS_DEFAULT_NUM_THREADS: '1',
  MINERU_PROCESSING_WINDOW_SIZE: '1',
}
const cpuRuntime = {
  MINERU_MODEL_ONNX_DEVICE: 'cpu',
  MINERU_LLAMA_CPP_BACKEND: 'cpu',
  MINERU_DEVICE_MODE: 'cpu',
}

export function mineruProcessEnv(env=process.env, platform=process.platform, memory={total:totalmem(),free:freemem()}) {
  const childEnv={...env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}
  if(platform!=='win32')return childEnv
  // Each spawned PDF worker otherwise starts a separate OpenBLAS thread pool.
  childEnv.OPENBLAS_NUM_THREADS='1'
  childEnv.OPENBLAS_DEFAULT_NUM_THREADS='1'
  const gib=1024**3
  if(memory.total<=16*gib||memory.free<4*gib) {
    const requestedWindow=Number(env.MINERU_PROCESSING_WINDOW_SIZE)
    childEnv.MINERU_PROCESSING_WINDOW_SIZE=Number.isInteger(requestedWindow)&&requestedWindow>0?String(Math.min(3,requestedWindow)):'3'
    Object.assign(childEnv, serialRender)
  }
  return childEnv
}

function parserExitError(stderr) {
  // DirectML can write UTF-16 to stderr and then fail to decode its localized native error.
  const message = stderr.replaceAll('\0', '')
  if (/Dml(?:ExecutionProvider|FusedConv)[^\r\n]*(?:8007000e|out of memory)|ptxas fatal\s*:\s*Memory allocation failure|CUDA[^\r\n]*out of memory|(?:VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|OutOfDeviceMemoryError)/i.test(message)) {
    return new ReaderError('parser-accelerator', 'The local MinerU accelerator could not allocate memory.')
  }
  if (/OpenBLAS error:[^\r\n]*memory allocation|_ArrayMemoryError|(?:^|\n)MemoryError\b/i.test(message)) {
    return new ReaderError('parser-memory', 'MinerU ran out of memory during local PDF parsing.')
  }
  if (/PDF render worker (?:exited|disconnected|\w+Error:)|PDF render session timed out/i.test(message)) {
    const error = new ReaderError('parser-render-worker', 'A MinerU PDF rendering worker stopped unexpectedly.')
    error.openingPdf = /\bin _ensure_workers\b/.test(message)
    return error
  }
  return new ReaderError('parser-failed', 'MinerU 解析失败：' + message.slice(-600))
}

function requestedPages(value, total) {
  if (!Array.isArray(value) || !value.length || value.length > 800 ||
      value.some(page => !Number.isSafeInteger(page) || page < 1 || (total && page > total))) {
    throw new ReaderError('parser-page-range', 'Invalid PDF page range for MinerU.')
  }
  return [...new Set(value)].sort((a, b) => a - b)
}

function coversPages(result, requested, total) {
  const pages = result?.middle?.pages
  if (!Array.isArray(pages) || !pages.length) return false
  const numbers = new Set(pages.map(page => page?.page_idx + 1))
  if (numbers.size !== pages.length || [...numbers].some(page => !Number.isInteger(page) || page < 1)) return false
  if (requested) return numbers.size === requested.length && requested.every(page => numbers.has(page))
  return !total || (numbers.size === total && [...numbers].every(page => page <= total))
}

export class MineruService {
  constructor({store,launch=spawn}={}){this.store=store;this.launch=launch;this.running=new Map();this.children=new Set();this.statusCache=null;this.queue=Promise.resolve()}
  dispose(){for(const value of this.running.values())value.controller.abort();for(const child of this.children)child.kill()}
  async python(){
    const configured=this.store.getSettings().parser?.python
    const candidate=configured||join(homedir(),'.dsh','tools','mineru',process.platform==='win32'?'Scripts/python.exe':'bin/python')
    if(!isAbsolute(candidate))throw new ReaderError('parser-config','MinerU Python 路径必须是绝对路径')
    try{await access(candidate);return candidate}catch{throw new ReaderError('parser-unavailable','本机 MinerU 尚未安装或路径无效，请在文档解析设置中配置')}
  }
  async run(args,{signal,onProgress=()=>{},timeoutMs=120000,env=mineruProcessEnv()}={}) {
    const python=await this.python()
    return new Promise((resolve,reject)=>{
      const child=this.launch(python,[bridge,...args],{windowsHide:true,shell:false,env})
      this.children.add(child)
      let output='',errors='',pending='',timedOut=false
      const stop=()=>child.kill(),timer=setTimeout(()=>{timedOut=true;stop()},timeoutMs)
      signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop()
      child.stdout.on('data',chunk=>{output+=chunk;pending+=chunk;if(output.length>1000000){output=output.slice(-1000000)};const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)try{const value=JSON.parse(line);if(value.stage)onProgress(value)}catch{}})
      child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-48000)})
      child.on('error',finish)
      child.on('close',code=>{
        if(code===0)return finish(null)
        if(signal?.aborted)return finish(new ReaderError('aborted','已停止本机解析'))
        if(timedOut)return finish(new ReaderError('parser-timeout','本机解析超时，原有内容已保留'))
        finish(parserExitError(errors))
      })
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

  async parsePdf({id,original,output,tier,pages,signal,onProgress}) {
    const started = Date.now()
    const env = mineruProcessEnv()
    let recovery
    const attempt = async requested => {
      if (signal.aborted) throw new ReaderError('aborted','已停止本机解析')
      const timeoutMs = parseTimeoutMs - (Date.now() - started)
      if (timeoutMs <= 0) throw new ReaderError('parser-timeout','本机解析超时，原有内容已保留')
      const args = ['--input', original, '--output', output, '--tier', tier]
      if (requested) args.push('--page-range', requested.join(','))
      await unlink(output).catch(() => {})
      const runEnv = recovery ? {...env, ...singlePage, ...(recovery === 'cpu' ? cpuRuntime : {})} : env
      await this.run(args, {signal, onProgress, timeoutMs, env: runEnv})
      if (signal.aborted) throw new ReaderError('aborted','已停止本机解析')
      if ((await stat(output)).size > 64 * 1024 * 1024) throw new ReaderError('parser-size','本机解析结果过大')
      const result = JSON.parse(await readFile(output, 'utf8'))
      const parsed = result.middle?.pages
      if (!Array.isArray(parsed) || !parsed.length) throw new ReaderError('parser-content','本机解析没有返回有效页面')
      if (requested && parsed.some(page => !requested.includes(page?.page_idx + 1))) {
        throw new ReaderError('parser-content','MinerU did not preserve the requested PDF page numbers.')
      }
      return recovery ? {...result, recovery, elapsedMs: Date.now() - started} : result
    }
    for (;;) {
      try {
        return await attempt(pages)
      } catch (error) {
        if (signal.aborted) throw error
        if (error.code === 'parser-accelerator' && recovery !== 'cpu') {
          recovery = 'cpu'
        } else if (!recovery && (error.code === 'parser-memory' || error.code === 'parser-render-worker')) {
          recovery = 'serial'
        } else if (error.code === 'parser-render-worker' && !error.openingPdf) {
          const source = pages ?? (await this.store.getContent(id))?.pages?.map(page => page.n)
          if (!source || source.length < 2) throw error
          const result = await this.recoverPages(source, attempt, error, onProgress)
          return {...result, elapsedMs: Date.now() - started}
        } else {
          throw error
        }
        onProgress({stage:'recovering', profile:recovery, code:error.code})
      }
    }
  }

  async recoverPages(pages, attempt, originalError, onProgress) {
    // A recurring renderer failure can be page-specific. Bisect only that class
    // of error, with a fixed attempt budget and the original job's deadline.
    const queue = []
    const split = range => {
      const midpoint = Math.ceil(range.length / 2)
      queue.push(range.slice(0, midpoint), range.slice(midpoint))
    }
    split(pages)
    let firstResult
    const recovered = new Map()
    onProgress({stage:'recovering', profile:'pages', code:originalError.code})
    for (let attempts = 0; queue.length && attempts < 16; attempts++) {
      const range = queue.shift()
      try {
        const result = await attempt(range)
        firstResult ??= result
        for (const page of result.middle.pages) recovered.set(page.page_idx, page)
      } catch (error) {
        if (error.code !== 'parser-render-worker' || error.openingPdf) {
          if (error.code === 'aborted' || !firstResult) throw error
          break
        }
        if (range.length > 1) split(range)
      }
    }
    if (!firstResult) throw originalError
    const sortedPages = [...recovered.values()].sort((a, b) => a.page_idx - b.page_idx)
    return {...firstResult, recovery:'pages', middle:{...firstResult.middle, pages:sortedPages, is_full_document:false}}
  }

  async parse({id,force=false,pageNumbers,signal,onProgress=()=>{}}){
    if(signal?.aborted)throw new ReaderError('aborted','已停止本机解析')
    if(this.running.has(id))throw new ReaderError('parser-busy','这篇文献正在进行本机解析')
    const doc=this.store.getDoc(id);if(!doc||doc.format!=='pdf')throw new ReaderError('parser-document','本机解析仅支持书库内的 PDF')
    const pages = pageNumbers === undefined ? null : requestedPages(pageNumbers, doc.pageCount)
    const output=join(this.store.paths.tmp,'mineru-'+newId(20)+'.json')
    const marker={controller:new AbortController(),started:false};this.running.set(id,marker)
    const combined=signal?AbortSignal.any([signal,marker.controller.signal]):marker.controller.signal
    let task
    try{
      const original=join(this.store.paths.docDir(id),'original.pdf'),bytes=await readFile(original),status=await this.status()
      if(combined.aborted)throw new ReaderError('aborted','已停止本机解析')
      if(!status.available)throw new ReaderError('parser-unavailable',status.message)
      const baseKey=`mineru-local-v2-${status.version}|${status.tier}|image-analysis-off|${createHash('sha256').update(bytes).digest('hex')}`
      const key = pages ? baseKey + '|pages:' + pages.join(',') : baseKey
      if(!force){const cached=await this.store.getCachedReflow(key);if(coversPages(cached,pages,doc.pageCount))return{...cached,cached:true}}
      onProgress({stage:'queued',local:true,tier:status.tier})
      task=this.queue.then(()=>{
        if(combined.aborted)throw new ReaderError('aborted','已停止本机解析')
        marker.started=true
        onProgress({stage:'starting',local:true,tier:status.tier})
        return this.parsePdf({id,original,output,tier:status.tier,pages,signal:combined,onProgress})
      })
      this.queue=task.catch(()=>{})
      let cancel, result
      try{result=await Promise.race([task,new Promise((_,reject)=>{cancel=()=>reject(new ReaderError('aborted','已停止本机解析'));combined.addEventListener('abort',cancel,{once:true});if(combined.aborted)cancel()})])}finally{combined.removeEventListener('abort',cancel)}
      if(combined.aborted)throw new ReaderError('aborted','已停止本机解析')
      if (result.recovery !== 'pages' && coversPages(result,pages,doc.pageCount)) await this.store.setCachedReflow(key,result)
      return {...result,cached:false}
    }finally{if(marker.started&&combined.aborted)await task?.catch(()=>{});if(this.running.get(id)===marker)this.running.delete(id);await unlink(output).catch(()=>{});await unlink(output+'.part').catch(()=>{})}
  }
}
