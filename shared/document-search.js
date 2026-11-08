/** Search original text plus already generated translations; never generates text for search. */
export function findInBlocks(blocks,query,{entries,translated=false,limit=80}={}){
  const needle=String(query??'').trim(),lower=needle.toLowerCase(),results=[]
  if(!needle)return results
  for(const block of blocks){
    const entry=entries?.get?.(block.id),sources=[{text:String(block.text??''),translated:false}]
    if(translated&&entry?.status==='done')sources.push({text:String(entry.text??'').replace(/⟦DSHMATH_[A-Z]+⟧/g,'〔公式〕'),translated:true})
    for(const source of sources){
      const text=source.text,haystack=text.toLowerCase();let at=haystack.indexOf(lower)
      while(at>=0&&results.length<limit){
        results.push({blockId:block.id,page:block.page,translated:source.translated,before:text.slice(Math.max(0,at-40),at),match:text.slice(at,at+needle.length),after:text.slice(at+needle.length,at+needle.length+60)})
        at=haystack.indexOf(lower,at+needle.length)
      }
      if(results.length>=limit)return results
    }
  }
  return results
}
