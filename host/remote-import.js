import {lookup} from 'node:dns/promises'
import {isIP} from 'node:net'
import http from 'node:http'
import https from 'node:https'
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib'
import {ReaderError} from './util.js'

const MAX_BYTES=100*1024*1024, HTML_BYTES=2*1024*1024
const fakeAddress = address => isIP(address)===4&&/^198\.(?:18|19)\./.test(address)
// Proxy/TUN fake-IP DNS is not the destination's address. Resolve the public name independently
// in that case, then apply exactly the same public-address check and socket pinning.
export async function publicDns(hostname,{signal}={}) {
  for(const type of ['A','AAAA']) {
    const response=await new Promise((resolve,reject)=>{
      const timeout=AbortSignal.timeout(8000),combined=signal?AbortSignal.any([signal,timeout]):timeout
      const request=https.get('https://1.1.1.1/dns-query?'+new URLSearchParams({name:hostname,type}),{signal:combined,headers:{accept:'application/dns-json'}},res=>{
        const chunks=[];let size=0
        res.on('error',reject)
        res.on('data',chunk=>{size+=chunk.length;if(size>65536){request.destroy(new Error('DNS response too large'));return}chunks.push(chunk)})
        res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('DNS HTTP '+res.statusCode);resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(error){reject(error)}})
      })
      request.on('error',reject)
    })
    const result=response.Status===0?(response.Answer??[]).filter(item=>[1,28].includes(item.type)&&isIP(item.data)).map(item=>({address:item.data,family:isIP(item.data)})):[]
    if(result.length)return result
  }
  throw new ReaderError('import-dns','无法解析文献域名，请稍后重试')
}
export function publicAddress(address) {
  if(isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number)
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)
  }
  if(isIP(address)===6){const canonical=new URL(`http://[${address}]`).hostname.slice(1,-1);return /^[23]/i.test(canonical)&&!/^2001:(?:0:|db8:|1[0-9a-f]:|2[0-9a-f]:)|^2002:/i.test(canonical)}
  return false
}

export function normalizeImportUrl(input) {
  let text=String(input??'').trim()
  if(/^10\.\d{4,9}\//.test(text))text='https://doi.org/'+text
  let url
  try{url=new URL(text)}catch{throw new ReaderError('import-url','请输入完整的 HTTP / HTTPS 文献网址')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new ReaderError('import-url','仅支持不含账号密码的 HTTP / HTTPS 网址')
  url.hash=''
  if(/^(?:www\.)?arxiv\.org$/i.test(url.hostname)&&/^\/(?:abs|html)\//.test(url.pathname)) {
    url.protocol='https:';url.pathname=url.pathname.replace(/^\/(?:abs|html)\//,'/pdf/');url.search=''
  }
  return url
}

/** Resolve and pin public DNS addresses; redirects are validated afresh by the caller. */
export async function readPublicUrl(url,{signal,resolve=lookup,fallbackResolve=publicDns}={}) {
  const hostname=url.hostname.replace(/^\[|\]$/g,'')
  const controller=AbortSignal.timeout(45000),combined=signal?AbortSignal.any([signal,controller]):controller
  combined.throwIfAborted()
  let abortDns
  const cancelled=new Promise((_,reject)=>{abortDns=()=>reject(new ReaderError('aborted',signal?.aborted?'已取消网址拉取':'网址响应超时'));combined.addEventListener('abort',abortDns,{once:true})})
  let addresses
  try{addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await Promise.race([resolve(hostname,{all:true,verbatim:true}),cancelled])}
  finally{combined.removeEventListener('abort',abortDns)}
  if(!isIP(hostname)&&addresses.length&&addresses.every(item=>fakeAddress(item.address)))addresses=await fallbackResolve(hostname,{signal:combined})
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new ReaderError('import-address','网址指向本机、内网或保留地址，无法拉取')
  const pinned=addresses.find(item=>item.family===4)??addresses[0]
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).request(url,{
      method:'GET',signal:combined,family:pinned.family,
      lookup:(_host,options,callback)=>options.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family),
      headers:{'user-agent':'DSH-Reader/1.5 (document import)','accept':'application/pdf,application/epub+zip,text/html;q=0.8,*/*;q=0.1','accept-encoding':'identity'},
    },response=>{
      const status=response.statusCode??0,headers=response.headers
      response.on('error',reject)
      if([301,302,303,307,308].includes(status)){response.destroy();resolve({status,headers,bytes:Buffer.alloc(0),url});return}
      if(status<200||status>=300){response.destroy();reject(new ReaderError('import-http',`网址返回 HTTP ${status}；请使用可直接访问的 PDF / EPUB 链接`));return}
      const limit=/text\/html|application\/xhtml/i.test(headers['content-type']??'')?HTML_BYTES:MAX_BYTES
      if(Number(headers['content-length'])>limit){response.destroy();reject(new ReaderError('import-size','下载内容过大；单篇最大 100 MB'));return}
      const chunks=[];let size=0
      response.on('data',chunk=>{
        size+=chunk.length
        if(size>limit){request.destroy(new ReaderError('import-size','下载内容超过大小限制'));return}
        chunks.push(chunk)
      })
      response.on('end',()=>{
        try {
          let bytes=Buffer.concat(chunks),encoding=String(headers['content-encoding']??'').toLowerCase()
          if(encoding==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:limit})
          else if(encoding==='br')bytes=brotliDecompressSync(bytes,{maxOutputLength:limit})
          else if(encoding==='deflate')bytes=inflateSync(bytes,{maxOutputLength:limit})
          if(bytes.length>limit)throw new Error('下载内容超过大小限制')
          resolve({status,headers,bytes,url})
        }catch(error){reject(new ReaderError('import-content','无法读取下载内容：'+error.message))}
      })
    })
    request.on('error',reject);request.end()
  })
}

const entity = text => String(text??'').replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[\da-f]+|\d+);/gi,value=>{
  const known={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'}
  if(known[value.toLowerCase()])return known[value.toLowerCase()]
  const code=Number.parseInt(value.slice(value[2].toLowerCase()==='x'?3:2,-1),value[2].toLowerCase()==='x'?16:10)
  return code>0&&code<=0x10ffff?String.fromCodePoint(code):''
})
function attributes(tag) {
  const result={}
  for(const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))result[match[1].toLowerCase()]=entity(match[2]??match[3]??match[4])
  return result
}
export function documentLinks(html,base) {
  const links=[],others=[];let title=''
  for(const tag of String(html).matchAll(/<(?:meta|link|a)\b[^>]{0,8192}>/gi)){
    const attrs=attributes(tag[0]),name=String(attrs.name??attrs.property??'').toLowerCase()
    if(name==='citation_title')title=String(attrs.content??'').slice(0,400)
    const candidate=name==='citation_pdf_url'||name==='wkhealth_pdf_url'?attrs.content:/application\/(?:pdf|epub\+zip)/i.test(attrs.type??'')?attrs.href:null
    if(candidate)links.push(candidate)
    else if(attrs.href&&/\.(?:pdf|epub)(?:[?#]|$)/i.test(attrs.href))others.push(attrs.href)
  }
  return {title,urls:[...new Set([...links,...others].flatMap(value=>{try{return [normalizeImportUrl(new URL(value,base).href).href]}catch{return []}}))].slice(0,3)}
}
function downloadedName(response,format) {
  const disposition=String(response.headers['content-disposition']??'')
  let name=/filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1]??/filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1]??/filename\s*=\s*([^;]+)/i.exec(disposition)?.[1]
  try{name=decodeURIComponent(name??new URL(response.url).pathname.split('/').pop()??'document')}catch{name='document'}
  name=String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,'_').trim().slice(0,180)||'document'
  if(!new RegExp('\\.'+format+'$','i').test(name))name=name.replace(/\.(?:html?|aspx?|php|pdf|epub)$/i,'')+'.'+format
  return name
}

/** Public PDF/EPUB links, arXiv abstract URLs, and accessible scholarly landing pages. */
export async function fetchDocument(input,{transport=readPublicUrl,signal}={}) {
  const follow=async raw=>{
    let url=normalizeImportUrl(raw)
    for(let redirects=0;redirects<=5;redirects++){
      if(signal?.aborted)throw new ReaderError('aborted','已取消网址拉取')
      const response=await transport(url,{signal});response.url=url.href
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.location
        if(!location)throw new ReaderError('import-redirect','重定向没有提供目标地址')
        url=normalizeImportUrl(new URL(location,url).href);continue
      }
      return response
    }
    throw new ReaderError('import-redirect','网址重定向次数过多')
  }
  const asDocument=response=>{
    const bytes=response.bytes,mime=String(response.headers['content-type']??'')
    let format=null
    if(bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))format='pdf'
    else if(bytes.readUInt32LE?.(0)===0x04034b50&&(/epub/i.test(mime+response.url+String(response.headers['content-disposition']??''))||bytes.subarray(0,65536).includes(Buffer.from('application/epub+zip'))))format='epub'
    if(!format)return null
    return {bytes,format,name:downloadedName(response,format),resolvedUrl:response.url}
  }
  try {
    const response=await follow(input),direct=response.bytes.length>=4?asDocument(response):null
    if(direct)return direct
    if(response.bytes.length>HTML_BYTES)throw new ReaderError('import-content','网址没有返回有效的 PDF / EPUB 文件')
    const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(String(response.headers['content-type']??'')+' '+response.bytes.subarray(0,1024).toString('latin1'))?.[1]??'utf-8'
    let html
    try{html=new TextDecoder(charset).decode(response.bytes)}catch{html=response.bytes.toString('utf8')}
    if(!/<(?:!doctype|html|head|meta)\b/i.test(html))throw new ReaderError('import-content','网址没有返回有效的 PDF / EPUB 文件')
    const found=documentLinks(html,response.url)
    for(const url of found.urls)try{const candidate=await follow(url),document=candidate.bytes.length>=4?asDocument(candidate):null;if(document)return {...document,title:found.title}}catch(error){if(signal?.aborted)throw error}
    throw new ReaderError('import-no-file','该网页未提供可直接下载的 PDF / EPUB；可粘贴下载链接，需登录或付费的内容请自行下载后导入')
  }catch(error){if(signal?.aborted)throw new ReaderError('aborted','已取消网址拉取');throw error}
}
