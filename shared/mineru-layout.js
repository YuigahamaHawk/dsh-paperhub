// Geometry, reading order and source ownership from MinerU's public middle JSON.
// No document-specific labels, page numbers, crops or equations are hard coded.
import { captionLabel, isPanelLabel } from './caption-label.js'

export const MINERU_LAYOUT_VERSION = 3
const imageTypes = new Set(['image','chart','table','equation','algorithm','code'])
const captionTypes = new Set(['image_caption','chart_caption','table_caption','equation_caption','algorithm_caption','code_caption','caption'])
const textOf = value => typeof value==='string'?value:Array.isArray(value)?value.map(item=>textOf(item?.content)).join(''):''
const rectOf = block => block.sourceRect??block.rect
const rect = box => Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[0]>=0&&box[1]>=0&&box[2]<=1&&box[3]<=1&&box[2]>box[0]&&box[3]>box[1]?{x:box[0],y:box[1],w:box[2]-box[0],h:box[3]-box[1]}:null
const overlap = (a,b) => a&&b?Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))/Math.max(1e-12,a.w*a.h):0
const near = (a,b) => a&&b&&a.x+a.w/2>=b.x-.004&&a.x+a.w/2<=b.x+b.w+.004&&a.y+a.h/2>=b.y-.004&&a.y+a.h/2<=b.y+b.h+.004
function unionBoxes(boxes) {
  const valid=boxes.filter(box=>rect(box))
  if(!valid.length)return null
  return [Math.min(...valid.map(b=>b[0])),Math.min(...valid.map(b=>b[1])),Math.max(...valid.map(b=>b[2])),Math.max(...valid.map(b=>b[3]))]
}

function captionItems(children, kind, parent) {
  const captions = children.filter(item => captionTypes.has(item.type) && rect(item.bbox))
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
  const groups = []
  for (const part of captions) {
    const text = textOf(part.content), previous = groups.at(-1)
    const [left, top, right] = part.bbox
    const separate = captionLabel(text) || kind === 'figure' && isPanelLabel(text)
    // A recognizer can attach several disjoint captions (or plot labels) to
    // one region. Keep their source envelopes independent before mapping runs.
    if (previous && !previous.panel && !separate && top - previous.bbox[3] >= -.006 &&
        top - previous.bbox[3] <= .018 && (Math.abs(left - previous.bbox[0]) <= .024 ||
        Math.abs(left + right - previous.bbox[0] - previous.bbox[2]) <= .05)) {
      previous.bbox = unionBoxes([previous.bbox, part.bbox])
      previous.content += ' ' + text
    } else {
      groups.push({ ...part, kind: 'caption', captionKind: kind, parent, content: text, panel: kind === 'figure' && isPanelLabel(text) })
    }
  }
  return groups
}

function semanticItems(page) {
  const result=[]
  for(const block of page.blocks??[]) {
    const children=Array.isArray(block.content)?block.content:[]
    const algorithm=block.type==='code'&&(block.sub_type==='algorithm'||children.some(item=>item.type==='algorithm_body'))
    const kind=algorithm?'algorithm':imageTypes.has(block.type)?block.type:block.type==='paragraph_title'||block.type==='title'?'heading':/header|footer|page_number/.test(block.type)?'artifact':'paragraph'
    const captionKind=['image','chart'].includes(kind)?'figure':kind
    result.push(...captionItems(children,captionKind,block))
    const body=children.find(item=>item.type===kind+'_body'||item.type===block.type+'_body')
    result.push({...block,bbox:body?.bbox??block.bbox,kind,owner:block})
  }
  return result.filter(item=>rect(item.bbox)).map(item=>({...item,rect:rect(item.bbox),ids:[]}))
}

/** Map every immutable PDF run to one structural block, retaining its original ID/text. */
export function mineruPageLayout(sourcePage, parsedPage) {
  const items=semanticItems(parsedPage)
  let source=sourcePage.sourceBlocks??sourcePage.visionSourceBlocks??sourcePage.blocks??[]
  if(!items.length&&(source.some(b=>b.text?.trim())||sourcePage.blocks?.some(b=>b.kind==='pageFigure'))) {
    throw new Error('MinerU returned no structure; the original page is kept')
  }
  // Scanned PDFs have no native glyph anchors. Their first OCR result becomes the immutable source.
  const ocr=source.reduce((n,b)=>n+String(b.text??'').trim().length,0)<12
  if(ocr)source=items.map((item,index)=>({id:`p${sourcePage.n}ocr${index}`,kind:'paragraph',page:sourcePage.n,text:textOf(item.content),rect:item.rect,sourceRect:item.rect,fontSize:sourcePage.fontSize??10}))
  const unknown=[];let missingChars=0,totalChars=0
  for(const block of source) {
    const r=rectOf(block),chars=String(block.text??'').trim().length;totalChars+=chars
    const choices=items.map((item,index)=>({item,index,ratio:overlap(r,item.rect),near:near(r,item.rect)})).filter(v=>v.ratio>=.45||v.near&&v.ratio>=.1).sort((a,b)=>b.ratio-a.ratio||(a.item.rect.w*a.item.rect.h-b.item.rect.w*b.item.rect.h))
    if(choices.length)choices[0].item.ids.push(block.id)
    else {unknown.push(block);missingChars+=chars}
  }
  // A very different coordinate system or an incomplete parse must not create invented crops.
  if(totalChars>100&&missingChars/totalChars>.10)throw new Error(`MinerU geometry could not anchor ${missingChars}/${totalChars} source characters; the original page is kept`)
  const regions=[],textBlocks=[];let previous=null
  for(const item of items) {
    if(!item.ids.length&&!imageTypes.has(item.kind))continue
    if(imageTypes.has(item.kind)) {
      const kind=item.kind==='equation'?'formula':['table','algorithm','code'].includes(item.kind)?item.kind:'figure'
      const captions=items.filter(v=>v.kind==='caption'&&v.parent===item.owner&&!v.panel&&v.ids.length)
      const caption=captions.find(v=>captionLabel(v.content)?.kind===kind)??captions[0]
      const captionId=caption?.ids[0]??null,captionText=textOf(caption?.content)
      const number=kind==='formula'?/\\tag\s*\{([^}]+)\}/.exec(textOf(item.content))?.[1]:kind==='algorithm'?/^\s*(?:algorithm|算法)\s*([\dIVXL]+)\b/i.exec(captionText||textOf(item.content))?.[1]:/^(?:fig(?:ure)?\.?|table|图|表)\s*([\dA-Z]+)\b/i.exec(captionText)?.[1]
      const printed=kind==='formula'&&number?(sourcePage.equationNumbers??[]).filter(v=>String(v.number)===number&&near(v.rect,item.rect)).sort((a,b)=>b.rect.x-a.rect.x)[0]?.rect:null
      regions.push({id:`mineru-${item.index}`,kind,bbox:item.bbox,candidateIds:item.ids,captionId,number:number??null,numberBbox:printed?[printed.x,printed.y,printed.x+printed.w,printed.y+printed.h]:null,afterBlockId:captionId??previous,confidence:1,renderAs:'image',latex:kind==='formula'?textOf(item.content):undefined})
    } else {
      textBlocks.push({ids:item.ids,kind:item.kind,captionKind:item.captionKind,level:item.kind==='heading'?2:undefined,parserSpans:item.kind==='paragraph'?item.content:undefined})
      previous=item.ids[0]??previous
    }
  }
  for(const block of unknown)textBlocks.push({ids:[block.id],kind:'paragraph',unassigned:true})
  const owned=[...regions.flatMap(r=>r.candidateIds),...textBlocks.flatMap(g=>g.ids)]
  if(owned.length!==source.length||new Set(owned).size!==source.length)throw new Error('MinerU source ownership is incomplete or ambiguous')
  return {n:sourcePage.n,regions,textBlocks,paragraphs:[],captionFixes:[],source:'mineru',sourceBlocks:ocr?source:undefined,ocr,anchoredCharacters:totalChars-missingChars,sourceCharacters:totalChars}
}

export function mineruLayout(content,middle,{cached=false,tier='standard'}={}) {
  if(!middle||!Array.isArray(middle.pages))throw new Error('MinerU returned an unsupported middle JSON schema')
  const parsed=new Map(middle.pages.map(page=>[Number(page.page_idx)+1,page])),pages=[]
  for(const source of content.pages??[]) {
    const answer=parsed.get(Number(source.n))
    if(!answer){pages.push({n:source.n,error:'MinerU did not return this page'});continue}
    try{const page=mineruPageLayout(source,answer);for(const group of page.textBlocks)group.parserVersion=String(middle.metadata?.producer?.version??'unknown');pages.push({...page,cached})}catch(error){pages.push({n:source.n,error:error.message})}
  }
  const version=String(middle.metadata?.producer?.version??'unknown')
  return {pages,model:`MinerU ${version} · ${tier} · local`,engine:'mineru',version:MINERU_LAYOUT_VERSION,parserVersion:version,cached}
}
