import {openDocumentArchive} from './epub.js'

export const IMPORT_LIMITS = Object.freeze({files:200,fileBytes:100*1024*1024,inputBytes:300*1024*1024,expandedBytes:512*1024*1024,urls:20})
const supported = name => /\.(pdf|epub|zip)$/i.test(name ?? '')
export const importPath = file => file.relativePath || file.webkitRelativePath || file.name || ''
export function abortImport(signal) { if(signal?.aborted) { const error=new Error('已取消导入');error.name='AbortError';throw error } }

/** Resolve members before importing; each member's bytes are read only when it is processed. */
export async function prepareImportFiles(input,{signal}={}) {
  const files=[],skipped=[],errors=[]
  let inputBytes=0,expanded=0
  const add = file => {
    if(files.length>=IMPORT_LIMITS.files)throw new Error('单批最多导入 200 篇文献，请拆分批次')
    expanded+=Number(file.size)||0
    if(expanded>IMPORT_LIMITS.expandedBytes)throw new Error('本批文献总大小超过 512 MB，请拆分批次')
    files.push(file)
  }
  for(const file of Array.from(input??[])) {
    abortImport(signal)
    const path=importPath(file)
    inputBytes+=Number(file.size)||0
    if(inputBytes>IMPORT_LIMITS.inputBytes)throw new Error('单批所选文件超过 300 MB，请拆分批次')
    if(!supported(file.name)){skipped.push(path);continue}
    if(/\.zip$/i.test(file.name)) {
      if(file.size>IMPORT_LIMITS.fileBytes){errors.push({name:path,message:'单个 ZIP 不能超过 100 MB'});continue}
      try {
        const pack=openDocumentArchive(await file.arrayBuffer())
        for(const entry of pack.files)add({...entry,relativePath:path+'/'+entry.relativePath})
        skipped.push(...pack.skipped.map(name=>path+'/'+name))
      } catch(error) {
        if(/单批最多|本批文献/.test(error.message))throw error
        errors.push({name:path,message:error.message})
      }
    } else add(file)
  }
  return {files,skipped,errors}
}

/** Browser folder drops may return directory entries in multiple 100-entry chunks. */
export async function collectDroppedFiles(transfer) {
  const entries=Array.from(transfer?.items??[]).map(item=>item.webkitGetAsEntry?.()).filter(Boolean)
  const fallback=Array.from(transfer?.files??[]),files=[],visited=new Set()
  if(!entries.length)return fallback
  let total=0
  const visit=async(entry,parent='',depth=0)=>{
    if(++total>5000 || depth>32)throw new Error('文件夹层级或文件数量过多，请拆分导入')
    const path=parent+entry.name
    if(entry.isFile) {
      const file=await new Promise((resolve,reject)=>entry.file(resolve,reject))
      files.push({name:file.name,size:file.size,type:file.type,relativePath:path,arrayBuffer:()=>file.arrayBuffer()})
    } else if(entry.isDirectory) {
      if(visited.has(entry.fullPath))return
      visited.add(entry.fullPath)
      const reader=entry.createReader()
      for(;;){const children=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!children.length)break;for(const child of children)await visit(child,path+'/',depth+1)}
    }
  }
  for(const entry of entries)await visit(entry)
  return files
}
