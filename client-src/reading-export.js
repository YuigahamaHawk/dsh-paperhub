import {escapeText,sanitizeInlineHtml} from './sanitize.js'
import {inlineMathMarkup,protectInlineMath,translatedMathSegments} from '../shared/inline-math.js'
import {translatableIndex} from '../shared/translation-blocks.js'
import {zipStored} from '../shared/zip-writer.js'
import {openPdfUrl} from './pdf-engine.js'
import {renderRegionImage} from './pdf-view.jsx'
import {downloadFile} from './util.js'

export const readingBlocks=content=>Array.isArray(content?.blocks)?content.blocks:(content?.pages??[]).flatMap(page=>page.blocks??[])
const escape=escapeText
const segmentsHtml=segments=>segments.map(s=>s.type==='math'?inlineMathMarkup(s.latex):escape(s.text)).join('')
const nameFor=doc=>String(doc.title||'document').replace(/[\\/:*?"<>|]+/g,'_').slice(0,100)
const STYLE=`:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f5f3;color:#222;font:18px/1.8 Georgia,'Times New Roman','Noto Serif CJK SC','SimSun',serif}main{max-width:1000px;margin:30px auto;padding:44px 48px;background:white}h1{font-size:1.8em;line-height:1.35}h2,h3,h4,h5,h6{line-height:1.4;break-after:avoid}p,section{overflow-wrap:anywhere}.meta,.coverage,.page-marker{font:13px/1.6 system-ui,sans-serif;color:#666}.coverage{border-left:3px solid #888;padding:8px 12px;background:#f6f6f6}section{margin:1em 0}.translation{color:#555;border-left:2px solid #bbb;padding-left:14px;margin-top:.6em}.missing{font:13px/1.6 system-ui,sans-serif;color:#8a5a00}.page-marker{border-top:1px solid #ddd;margin:2em 0 1em;padding-top:8px}.figure{text-align:center;margin:1.5em 0;break-inside:avoid}.figure img{max-width:100%;height:auto}.formula{display:flex;align-items:center;justify-content:center;gap:1em}.formula .number{margin-left:auto;white-space:nowrap}pre{white-space:pre-wrap;font-size:.8em;background:#f4f4f4;padding:12px}.math-inline{display:inline-block;vertical-align:middle;max-width:100%;overflow-x:auto}math{font-size:1em}img{max-width:100%;height:auto}a{color:inherit}.print-control{font:14px system-ui;float:right}nav{font:14px/1.8 system-ui;margin:1.5em 0}nav a{display:block}blockquote{border-left:3px solid #ddd;padding-left:1em}.caption{font-size:.9em}.footnote{font-size:.8em}@media(max-width:700px){main{margin:0;padding:24px 18px}body{font-size:17px}}@media print{@page{margin:16mm}body{background:white;font-size:11pt}main{margin:0;max-width:none;padding:0}.print-control{display:none}.figure img{max-height:235mm;object-fit:contain}.page-marker{break-before:auto}.translation{color:#333}a{text-decoration:none}}`

/** Serialize every saved block; this does not depend on which pages are mounted in the UI. */
export function buildReadingDocument({doc,content,entries=new Map(),records={},assets={},mode='bilingual',targetLang='zh-CN'}){
  const blocks=readingBlocks(content),eligible=translatableIndex(blocks),body=[];let done=0,page=0,figures=0,maths=0
  for(const block of blocks){
    if(!block||!block.id)continue
    const id=escape(block.id),record=records[block.id],mathRecord=record?.enabled&&record.source===block.text?record:null
    const entry=entries instanceof Map?entries.get(block.id):entries[block.id]
    const source=mathRecord?.maths?protectInlineMath(mathRecord):block.text
    const translated=entry?.status==='done'&&(!entry.source||entry.source===source)&&entry.text?.trim()?entry.text:null
    if(translated&&eligible.has(block.id))done++
    if(block.page&&block.page!==page){page=block.page;body.push(`<div class="page-marker" id="source-page-${Number(page)}">原文第 ${Number(page)} 页</div>`)}
    if(['figure','formula','pageFigure'].includes(block.kind)){
      const asset=assets[block.id];if(!asset?.src)throw new Error('Missing exported figure: '+block.id)
      figures++
      const width=block.kind==='formula'&&asset.width?` style="width:${Math.round(asset.width/3*18/(Number(block.fontSize)||10))}px"`:''
      body.push(`<figure class="figure ${block.kind==='formula'?'formula':''}" id="${id}"><img src="${escape(asset.src)}" alt="${escape(block.alt||block.kind)}"${width} />${block.number&&!block.numberPlacedInImage?`<span class="number">${escape(block.number)}</span>`:''}</figure>`);continue
    }
    let original=mathRecord?.maths?segmentsHtml(mathRecord.segments):block.html?sanitizeInlineHtml(block.html):escape(block.text??'')
    if(block.kind==='image'&&block.image){
      if(!/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(block.image))throw new Error('Image is not embedded: '+block.id)
      original=`<img src="${escape(block.image)}" alt="${escape(block.alt??'')}" />`
    }
    if(block.kind==='code')original=`<pre><code>${escape(block.text??'')}</code></pre>`
    if(block.kind==='quote')original=`<blockquote>${original}</blockquote>`
    if(block.kind==='heading'){const level=Math.max(2,Math.min(6,(Number(block.level)||1)+1));original=`<h${level}>${original}</h${level}>`}
    let translation=''
    if(translated){
      const segments=mathRecord?.maths?translatedMathSegments(translated,mathRecord):null
      translation=segments?segmentsHtml(segments):escape(translated)
    }
    if(mathRecord?.maths)maths+=mathRecord.maths
    const missing=mode!=='original'&&eligible.has(block.id)&&!translated?'<div class="missing">本段尚未翻译，保留原文。</div>':''
    body.push(`<section id="${id}" class="${escape(block.kind||'paragraph')}">${mode==='translation'&&translation?translation:original}${mode==='bilingual'&&translation?`<div class="translation" lang="${escape(targetLang)}">${translation}</div>`:''}${missing}</section>`)
  }
  const title=escape(doc.title||'Untitled'),toc=(content.toc??[]).filter(item=>item.blockId&&blocks.some(b=>b.id===item.blockId)).map(item=>`<a href="#${escape(item.blockId)}">${escape(item.title??'')}</a>`).join('')
  const coverage=mode==='original'?'仅原文':`已翻译 ${done}/${eligible.size} 段${done<eligible.size?'；未完成段落保留原文':''}`
  const article=`<h1>${title}</h1><p class="meta">${escape(doc.author||'')} · ${escape(doc.format?.toUpperCase()||'')} · ${mode==='bilingual'?'中外文逐段对照':mode==='translation'?'译文阅读':'精排原文'}</p><p class="coverage">${coverage}${content.kind==='pdf'&&content.visionLayoutStatus!=='complete'?' · 视觉精排尚未全部完成，导出当前已保存版本':''}</p>${toc?`<nav aria-label="目录">${toc}</nav>`:''}${body.join('\n')}`
  const html=`<!doctype html><html lang="${escape(targetLang)}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${title}</title><style>${STYLE}</style></head><body><main><button class="print-control" type="button" onclick="window.print()">打印 / 保存为 PDF</button>${article}</main></body></html>`
  const navigation=(content.toc??[]).filter(item=>item.blockId&&blocks.some(block=>block.id===item.blockId)).map(item=>({id:item.blockId,title:item.title??''}))
  return {html,article,title,navigation,style:STYLE,translated:done,total:eligible.size,blocks:blocks.length,figures,maths}
}

export function readingEpub(document,{doc,targetLang='zh-CN',identifier=globalThis.crypto?.randomUUID?.()??String(Date.now())}){
  const entries=[['mimetype','application/epub+zip'],['META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>']],images=[],seen=new Map()
  let article=document.article.replace(/data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,([A-Za-z0-9+/=]+)/gi,(uri,type,base64)=>{
    if(seen.has(uri))return seen.get(uri)
    const filename=`images/image-${images.length+1}.${type==='jpeg'?'jpg':type==='svg+xml'?'svg':type}`
    const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));images.push({filename,type:`image/${type}`,bytes});seen.set(uri,filename);return filename
  }).replace(/<(br|img)\b([^>]*?)(?:\s*\/)?>/gi,(_,tag,attrs)=>`<${tag}${attrs.replace(/\s*\/$/,'')} />`)
  const xhtml=`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="${escape(targetLang)}"><head><title>${document.title}</title><style>${document.style}</style></head><body><main>${article}</main></body></html>`
  const toc=document.navigation?.length?document.navigation.map(item=>`<li><a href="content.xhtml#${escape(item.id)}">${escape(item.title)}</a></li>`).join(''):`<li><a href="content.xhtml">${document.title}</a></li>`
  entries.push(['OEBPS/content.xhtml',xhtml],['OEBPS/nav.xhtml',`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${toc}</ol></nav></body></html>`])
  for(const image of images)entries.push(['OEBPS/'+image.filename,image.bytes])
  const manifest=images.map((image,i)=>`<item id="img${i}" href="${image.filename}" media-type="${image.type}" />`).join('')
  const mathProperty=document.article.includes('<math')?' properties="mathml"':''
  entries.push(['OEBPS/package.opf',`<?xml version="1.0" encoding="utf-8"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:${escape(identifier)}</dc:identifier><dc:title>${document.title}</dc:title><dc:creator>${escape(doc.author||'')}</dc:creator><dc:language>${escape(targetLang)}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/,'Z')}</meta></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"${mathProperty} /><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />${manifest}</manifest><spine><itemref idref="content" /></spine></package>`])
  return zipStored(entries)
}

export async function prepareReadingDocument({api,doc,content,translate,records,mode,targetLang,signal,onProgress=()=>undefined}){
  const regions=readingBlocks(content).filter(block=>['figure','formula','pageFigure'].includes(block.kind)),assets={}
  let opened
  try{
    if(regions.length)opened=await openPdfUrl(api.fileUrl(doc.id,'original'),{moduleUrl:api.assetUrl('pdf/pdf.mjs'),workerUrl:api.assetUrl('pdf/pdf.worker.mjs'),cMapUrl:api.assetUrl('pdf/cmaps/'),standardFontDataUrl:api.assetUrl('pdf/standard_fonts/')})
    for(const [index,block] of regions.entries()){
      if(signal?.aborted)throw new Error('Export cancelled')
      const src=await renderRegionImage(opened.pdf,block,block.kind==='pageFigure'?'page':block.kind,doc.id)
      const image=new Image();image.src=src;await image.decode()
      assets[block.id]={src,width:image.naturalWidth,height:image.naturalHeight};onProgress({done:index+1,total:regions.length})
      await new Promise(resolve=>setTimeout(resolve,0))
    }
    if(signal?.aborted)throw new Error('Export cancelled')
    return buildReadingDocument({doc,content,entries:translate?.entries??new Map(),records,assets,mode,targetLang})
  }finally{await opened?.destroy?.()}
}

export function downloadReadingDocument(document,{doc,format,mode,targetLang}){
  const name=`${nameFor(doc)}-${mode==='original'?'精排原文':mode==='translation'?'译文':'双语精排'}`
  if(format==='epub')downloadFile(name+'.epub',readingEpub(document,{doc,targetLang}),'application/epub+zip')
  else downloadFile(name+'.html',document.html,'text/html;charset=utf-8')
}
