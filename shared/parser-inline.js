import {validateInlineMath,inlineMathMarkup} from './inline-math.js'

const canonical=value=>String(value??'').normalize('NFKC').replace(/\s|\u00ad/g,'')
const variables=value=>new Set(String(value).normalize('NFKC').match(/[A-Za-z\p{Script=Greek}]/gu)??[])
function preservesNativeVariables(source,latex){
  // OCR-only source may already contain LaTeX. Native glyphs provide an independent check.
  if(source.includes('\\'))return true
  const rendered=inlineMathMarkup(latex).replace(/<[^>]+>/g,'').replace(/&(?:amp|lt|gt|quot|apos);/g,''),before=variables(source),after=variables(rendered)
  return before.size===after.size&&[...before].every(char=>after.has(char))
}

/** Only replace math uniquely delimited by the parser's unchanged surrounding prose. */
export function parserInlineMath(source,content,parserVersion='unknown'){
  if(!Array.isArray(content))return null
  const spans=[]
  for(const item of content){
    if(!['text','equation_inline'].includes(item?.type)||typeof item.content!=='string')return null
    if(item.type==='equation_inline'&&spans.at(-1)?.type==='equation_inline')spans.at(-1).content+='\\,'+item.content
    else spans.push({...item})
  }
  let searchable='',offset=0;const starts=[],ends=[]
  for(const char of source){for(const unit of canonical(char)){searchable+=unit;for(let i=0;i<unit.length;i++){starts.push(offset);ends.push(offset+char.length)}}offset+=char.length}
  const located=[]
  for(let i=0;i<spans.length;i++){
    if(spans[i].type!=='equation_inline')continue
    const before=canonical(spans[i-1]?.type==='text'?spans[i-1].content:'').slice(-96),after=canonical(spans[i+1]?.type==='text'?spans[i+1].content:'').slice(0,96)
    if(before.length+after.length<12)continue
    const from=[]
    if(before){for(let at=searchable.indexOf(before);at>=0&&from.length<40;at=searchable.indexOf(before,at+1))from.push(at+before.length)}
    else if(i===0)from.push(0)
    const matches=[]
    for(const start of from){
      const finish=[]
      if(after){for(let at=searchable.indexOf(after,start+1);at>=0&&at-start<=240&&finish.length<40;at=searchable.indexOf(after,at+1))finish.push(at)}
      else if(i===spans.length-1&&searchable.length-start<=240)finish.push(searchable.length)
      for(const end of finish)if(end>start&&starts[start]!==undefined&&ends[end-1]!==undefined)matches.push({start:starts[start],end:ends[end-1]})
    }
    if(matches.length===1)located.push({...matches[0],latex:spans[i].content})
  }
  located.sort((a,b)=>a.start-b.start)
  const segments=[];let at=0
  for(const item of located){
    if(item.start<at)continue
    const math={type:'math',source:source.slice(item.start,item.end),latex:item.latex,alignment:'unique-prose-context'}
    try{validateInlineMath({segments:[math]},math.source,{sourceAlignedParser:true});if(!preservesNativeVariables(math.source,math.latex))continue}catch{continue}
    if(item.start>at)segments.push({type:'text',text:source.slice(at,item.start)})
    segments.push(math);at=item.end
  }
  if(!segments.length)return null
  if(at<source.length)segments.push({type:'text',text:source.slice(at)})
  try{return{...validateInlineMath({segments},source,{sourceAlignedParser:true}),enabled:true,origin:{engine:'mineru',parserVersion,alignment:'unique-prose-context'},request:null}}catch{return null}
}

export function contentInlineRecords(content,manual={}){
  const blocks=Array.isArray(content?.blocks)?content.blocks:(content?.pages??[]).flatMap(page=>page.blocks??[]),result={},byId=new Map(blocks.map(block=>[block.id,block]))
  for(const block of blocks)if(block.parserInlineMath?.source===block.text)result[block.id]=block.parserInlineMath
  for(const [id,record] of Object.entries(manual))if(!byId.has(id)||record?.source===byId.get(id).text)result[id]=record
  return result
}
