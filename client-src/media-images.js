import {openPdfUrl} from './pdf-engine.js'
import {renderRegionImage,regionImageKey} from './pdf-view.jsx'

/** One lazy PDF handle and one render queue per mounted catalog. No model calls. */
export function createMediaImages({api,doc}){
  let opened=null,queue=Promise.resolve(),closed=false
  const tasks=new Map()
  const image=entry=>{
    if(doc.format!=='pdf')return Promise.resolve(entry.block.image??entry.block.src??'')
    const key=regionImageKey(doc.id,entry.block,entry.block.kind)
    if(tasks.has(key))return tasks.get(key)
    const task=queue.then(async()=>{
      if(closed)throw new Error('Catalog closed')
      opened??=openPdfUrl(api.fileUrl(doc.id,'original'),{moduleUrl:api.assetUrl('pdf/pdf.mjs'),workerUrl:api.assetUrl('pdf/pdf.worker.mjs'),cMapUrl:api.assetUrl('pdf/cmaps/'),standardFontDataUrl:api.assetUrl('pdf/standard_fonts/')})
      const handle=await opened
      if(closed)throw new Error('Catalog closed')
      return renderRegionImage(handle.pdf,entry.block,entry.block.kind==='pageFigure'?'page':entry.block.kind,doc.id)
    })
    queue=task.catch(()=>{})
    tasks.set(key,task);task.catch(()=>tasks.delete(key))
    return task
  }
  return {image,dispose(){closed=true;queue.finally(async()=>{if(opened)try{await(await opened).destroy()}catch{}})}}
}
