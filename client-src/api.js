// Browser half -> host half transport.
//
// The page is served by the DSH web carrier, so a same-origin fetch carries the authenticated
// session cookie and reaches the exact Fetch routes registered by the host half. No AI key ever
// reaches the browser, and no CORS is involved.

const RPC = '/api/dsh-reader/rpc'
const UPLOAD = '/api/dsh-reader/upload'
const FILE = '/api/dsh-reader/file'
const STREAM = '/api/dsh-reader/stream'

/** Error carrying the host RPC code. */
export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code ?? 'unknown'
    this.status = status
  }
}

function absolute(path) {
  try {
    return new URL(path, window.location.origin).toString()
  } catch {
    return path
  }
}

/**
 * Origin that serves the plugin's read-only static assets (pdf.js module/worker/cmaps/fonts).
 *
 * In the desktop shell the page runs on the privileged `dsh-app://app` scheme: ordinary fetch()
 * works there (the shell forwards to the Host HTTP server), but Chromium refuses to load ES
 * modules and workers from that custom scheme. `__DSH_TRANSPORT__.streamBaseUrl` names the real
 * Host HTTP origin, and the asset route sends `Access-Control-Allow-Origin: *`, so the browser can
 * import pdf.js from there. A normally served HTTP(S) page keeps same-origin assets.
 */
function assetOrigin() {
  try {
    if (typeof window === 'undefined') return ''
    const protocol = window.location?.protocol ?? ''
    if (protocol === 'http:' || protocol === 'https:') return window.location.origin
    const transport = window.__DSH_TRANSPORT__
    const base = typeof transport?.streamBaseUrl === 'string' ? transport.streamBaseUrl : ''
    if (base !== '') return new URL(base).origin
  } catch {
    /* fall through */
  }
  return typeof window !== 'undefined' ? window.location.origin : ''
}

/** Create the reader API bound to one client context. */
export function createApi({ fetchImpl, recoveryDelays = [500, 1000, 2000, 5000, 15000] } = {}) {
  let streamCount = 0
  const listeners=new Set()
  let connection=Object.freeze({status:'connected',revision:0,error:'',method:''}),timer=null,probe=null,attempt=0,disposed=false
  const safeReads=new Set(['ping','library.list','library.get','folders.list','annotations.list','aux.get','settings.get','ai.models','ai.translationCache','ai.cache.stats','inline.list','zotero.status','parser.status'])
  const send=(input,init)=>fetchImpl?fetchImpl(input,init):(globalThis.__DSH_TRANSPORT__?.fetch??globalThis.fetch)(input,init)
  function publish(status,error='',method=''){
    if(connection.status===status&&connection.error===error)return
    const revision=connection.revision+(status==='connected'&&connection.status!=='connected'?1:0)
    connection=Object.freeze({status,revision,error,method})
    for(const listener of [...listeners])listener()
  }
  function ready(){
    if(timer!==null)clearTimeout(timer);timer=null;attempt=0;publish('connected')
  }
  function scheduleRecovery(){
    if(disposed||timer!==null||connection.status==='connected'||connection.status==='unauthorized')return
    timer=setTimeout(()=>{timer=null;reconnect().catch(()=>undefined)},recoveryDelays[Math.min(attempt++,recoveryDelays.length-1)])
  }
  async function reconnect(){
    if(probe)return probe
    publish('reconnecting',connection.error,connection.method)
    probe=rpc('ping',{}, {retry:false,probe:true}).finally(()=>{probe=null;scheduleRecovery()})
    return probe
  }

  async function rpc(method, params = {}, options = {}) {
    let response
    for(let attempt=0;;attempt++)try {
      response = await send(absolute(RPC), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        signal:options.signal,
        body: JSON.stringify({ method, params }),
      })
      break
    } catch (error) {
      if(options.signal?.aborted)throw new ApiError('aborted','已取消导入')
      publish('offline',String(error?.message??error),method)
      if(!options.probe)scheduleRecovery()
      // Only replay read-only requests; a dropped response can follow a committed write/model call.
      if(options.retry!==false&&safeReads.has(method)&&attempt<1){await new Promise(resolve=>setTimeout(resolve,200));continue}
      throw new ApiError('network', `无法连接阅读器后端：${error?.message ?? error}`)
    }
    if (response.status === 401 || response.status === 403) {
      if(timer!==null)clearTimeout(timer);timer=null
      publish('unauthorized','登录状态已失效',method)
      throw new ApiError('unauthorized', '登录状态已失效，请刷新页面后重试。', response.status)
    }
    if([404,502,503,504].includes(response.status)){
      publish('offline',`HTTP ${response.status}`,method);if(!options.probe)scheduleRecovery()
      throw new ApiError('network',`阅读器后端暂时不可用（HTTP ${response.status}）`,response.status)
    }
    let payload
    try {
      payload = await response.json()
    } catch(error) {
      if(error instanceof TypeError){publish('offline',String(error.message),method);if(!options.probe)scheduleRecovery();throw new ApiError('network',`无法读取阅读器后端响应：${error.message}`,response.status)}
      throw new ApiError('bad-response', `阅读器后端返回了无法解析的响应（HTTP ${response.status}）`, response.status)
    }
    if (payload?.ok !== true) {
      throw new ApiError(payload?.error?.code, payload?.error?.message ?? '阅读器后端返回失败', response.status)
    }
    ready()
    return payload.value
  }

  /** Upload raw bytes; returns `{ uploadId, name, format, size }`. */
  async function upload(file, format, name) {
    const filename = name ?? file?.name ?? 'document.pdf'
    const kind = format ?? (filename.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf')
    const query = new URLSearchParams({ name: filename, format: kind })
    const body = file instanceof Blob ? file : new Blob([file])
    let response
    try{response = await send(absolute(`${UPLOAD}?${query.toString()}`), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      credentials: 'same-origin',
      body,
    })}catch(error){publish('offline',String(error?.message??error),'upload');scheduleRecovery();throw new ApiError('network',`无法连接阅读器后端：${error?.message??error}`)}
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new ApiError('bad-response', `上传失败（HTTP ${response.status}）`, response.status)
    }
    if (payload?.ok !== true) throw new ApiError(payload?.error?.code, payload?.error?.message ?? '上传失败', response.status)
    return payload.value
  }

  /** Stable URL of a document's original file / thumbnail (cookie-authenticated). */
  function fileUrl(docId, kind = 'original') {
    return absolute(`${FILE}?docId=${encodeURIComponent(docId)}&kind=${encodeURIComponent(kind)}`)
  }

  async function readUpload(uploadId,signal) {
    try {
      const response=await send(absolute(`${FILE}?uploadId=${encodeURIComponent(uploadId)}`),{credentials:'same-origin',signal})
      if(!response.ok)throw new ApiError('import-read',`无法读取下载的文献（HTTP ${response.status}）`,response.status)
      return await response.arrayBuffer()
    } catch(error) {
      if(signal?.aborted)throw new ApiError('aborted','已取消导入')
      if(error instanceof ApiError)throw error
      publish('offline',String(error.message),'import-read');scheduleRecovery()
      throw new ApiError('network','无法连接阅读器后端：'+error.message)
    }
  }

  /** URL of a bundled static asset (pdf.js module, worker, cmaps, fonts). */
  function assetUrl(relative) {
    try {
      return new URL(`/dsh-reader-assets/${String(relative).replace(/^\/+/, '')}`, assetOrigin()).toString()
    } catch {
      return absolute(`/dsh-reader-assets/${String(relative).replace(/^\/+/, '')}`)
    }
  }

  /**
   * Run a streaming host method, consuming Server-Sent-Events frames.
   * @returns {Promise<void>} resolves after the `done` frame; rejects on error or abort.
   */
  async function stream(method, params, handlers = {}, signal) {
    const id = ++streamCount
    let response
    try {
      response = await send(absolute(STREAM), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ method, params }),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new ApiError('aborted', '已取消')
      publish('offline',String(error?.message??error),method);scheduleRecovery()
      throw new ApiError('network', `无法连接阅读器后端：${error?.message ?? error}`)
    }
    if (response.status === 401 || response.status === 403) throw new ApiError('unauthorized', '登录状态已失效，请刷新页面后重试。', response.status)
    if (!response.ok || response.body === null) throw new ApiError('bad-response', `流式请求失败（HTTP ${response.status}）`, response.status)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
    let result
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseSseBlock(block)
          if (frame === null) continue
          if (frame.type === 'delta') handlers.onDelta?.(frame.text, frame)
          else if (frame.type === 'progress') handlers.onProgress?.(frame.value, frame)
          else if (frame.type === 'start') handlers.onStart?.(frame)
          else if (frame.type === 'done') {
            finished = true
            result = frame.value
            handlers.onDone?.(frame.value, frame)
          } else if (frame.type === 'error') {
            const error = new ApiError(frame.code, frame.message)
            error.request = frame.usage
            handlers.onError?.(error)
            throw error
          }
        }
      }
    } catch(error){
      if(signal?.aborted)throw new ApiError('aborted','已取消')
      if(error instanceof ApiError)throw error
      publish('offline',String(error?.message??error),method);scheduleRecovery()
      throw new ApiError('network',`无法连接阅读器后端：${error?.message??error}`)
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* already released */
      }
    }
    if (!finished) {
      if (signal?.aborted) throw new ApiError('aborted', '已取消')
      throw new ApiError('stream-ended', '回复流意外结束，请重试。')
    }
    ready()
    return result
  }

  return {
    rpc,
    upload,
    readUpload,
    fileUrl,
    assetUrl,
    stream,
    ping: () => rpc('ping'),
    getConnection:()=>connection,
    subscribeConnection:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    reconnect,
    dispose(){disposed=true;if(timer!==null)clearTimeout(timer);listeners.clear()},
    get streamCount() {
      return streamCount
    },
    /** Diagnostics breadcrumb (never blocks the caller). */
    report(kind, payload) {
      return rpc('diag.report', { kind, payload }).catch(() => undefined)
    },
  }
}

function parseSseBlock(block) {
  let event = 'message'
  const dataLines = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  let data
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  const type = typeof data?.type === 'string' ? data.type : event
  return { ...data, type }
}
