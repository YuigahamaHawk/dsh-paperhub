export const STUDY_MAP_VERSION=1
export const STUDY_CATEGORIES=['background','objective','method','results','limitations']
const canonical=value=>String(value??'').normalize('NFKC').replace(/\s/g,'')
export function studyBlocks(content){
  const blocks=Array.isArray(content?.blocks)?content.blocks:(content?.pages??[]).flatMap(page=>page.blocks??[])
  const out=[];let size=0
  for(const block of blocks){
    const text=String(block?.text??'').trim()
    if(!block?.id||text.length<12||block.kind==='artifact'||block.layoutFailed)continue
    if(size+text.length>220000)throw new Error('这份文献过长，当前重点梳理最多读取 22 万字符；请按章节处理')
    size+=text.length;out.push({id:block.id,page:block.page??null,kind:block.kind,text})
  }
  return out
}
export function validStudyEvidence(evidence,byId){
  if(!Array.isArray(evidence)||!evidence.length||evidence.length>4)return false
  return evidence.every(item=>typeof item?.blockId==='string'&&typeof item.quote==='string'&&canonical(item.quote).length>=12&&canonical(item.quote).length<=1000&&canonical(byId.get(item.blockId)?.text).includes(canonical(item.quote)))
}
export function validateStudyMap(value,blocks,{discardInvalid=false}={}){
  if(!Array.isArray(value?.groups))throw new Error('重点梳理必须返回分类列表')
  const byId=new Map(blocks.map(block=>[block.id,block])),seen=new Set(),texts=new Set(),rejected=[];let count=0
  const groups=value.groups.map(group=>{
    if(!STUDY_CATEGORIES.includes(group?.id)||seen.has(group.id)||!Array.isArray(group.points)||group.points.length>8)throw new Error('重点分类无效或重复')
    seen.add(group.id)
    return{id:group.id,points:group.points.map((point,index)=>{
      try{
      const text=String(point?.text??'').trim()
      if(text.length<8||text.length>800||!validStudyEvidence(point.evidence,byId))throw new Error(`重点 ${group.id}/${index+1} 缺少能在原文核对的段落与引文`)
      if(texts.has(canonical(text)))throw new Error('重点卡片内容重复，请按研究逻辑重新组织')
      if(group.id==='results'){
        const supported=(point.evidence.map(item=>item.quote).join(' ').match(/[−-]?\d+(?:\.\d+)?/g)??[]).map(n=>Number(n.replace('−','-')))
        const claimed=(text.match(/[−-]?\d+(?:\.\d+)?/g)??[]).map(n=>Number(n.replace('−','-')))
        if(claimed.some(n=>!supported.includes(n)))throw new Error('实验结果卡片包含引文未支持的数字')
      }
      texts.add(canonical(text))
      count++
      return{id:`${group.id}-${index+1}`,text,evidence:point.evidence.map(item=>({blockId:item.blockId,quote:item.quote.trim(),page:byId.get(item.blockId).page??null}))}
      }catch(error){if(!discardInvalid)throw error;rejected.push({category:group.id,index:index+1,reason:error.message});return null}
    }).filter(Boolean)}
  })
  if(!count||count>32)throw new Error('重点梳理未提供有效的原文依据，或卡片数量过多')
  return{version:STUDY_MAP_VERSION,groups:STUDY_CATEGORIES.map(id=>groups.find(group=>group.id===id)??{id,points:[]}),sourceBlocks:blocks.length,points:count,...(discardInvalid?{rejected}:{} )}
}
