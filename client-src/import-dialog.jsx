import React from 'react'
import {useApp} from './store.jsx'
import {Modal,Button,Tabs,Select,ProgressBar} from './ui.jsx'
import {IconUpload,IconFolder,IconGlobe,Spinner} from './icons.jsx'
import {collectDroppedFiles,importPath} from './import-sources.js'
import {formatBytes} from './util.js'

export function ImportDialog({open,onClose}) {
  const {state,actions,t}=useApp()
  const [mode,setMode]=React.useState('files'),[files,setFiles]=React.useState([]),[urls,setUrls]=React.useState(''),[target,setTarget]=React.useState(''),[collecting,setCollecting]=React.useState(false)
  const fileInput=React.useRef(null),folderInput=React.useRef(null)
  const job=state.importing,result=state.importResult,busy=Boolean(job)
  React.useEffect(()=>{if(open){setTarget(state.importTarget??'');if(!busy){setFiles([]);setUrls('')}}},[open])
  const textUrls=urls.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)
  const stage=list=>{setFiles(Array.from(list??[]));actions.clearImportResult()}
  const drop=async event=>{
    event.preventDefault();event.stopPropagation()
    if(busy)return
    const captured=collectDroppedFiles(event.dataTransfer)
    setCollecting(true)
    try{stage(await captured)}catch(error){actions.toast(error.message,'error')}finally{setCollecting(false)}
  }
  const start=()=>actions.importFiles(mode==='urls'?[]:files,{folderId:target||null,urls:mode==='urls'?textUrls:[]})
  const reset=()=>{actions.clearImportResult();setFiles([]);setUrls('')}
  const phase=job?t(`import.phase.${job.phase}`,job.phase):''
  const footer=busy?<>
    <Button variant="ghost" onClick={onClose}>{t('import.background','Continue in background')}</Button>
    <Button variant="danger" onClick={actions.cancelImport} disabled={job.phase==='cancelling'}>{t('import.stop','Stop this batch')}</Button>
  </>:result?<>
    <Button variant="ghost" onClick={reset}>{t('import.again','Import more')}</Button><Button variant="primary" onClick={onClose}>{t('common.done','Done')}</Button>
  </>:<>
    <Button variant="ghost" onClick={onClose}>{t('common.cancel','Cancel')}</Button>
    <Button variant="primary" onClick={start} disabled={collecting||(mode==='urls'?textUrls.length===0:files.length===0)}>{t('import.start','Start import')}</Button>
  </>
  return <Modal open={open} onClose={onClose} title={t('import.title','Import documents')} className="dr-import-dialog" width={650} footer={footer}>
    {busy?<div className="dr-import-job" role="status">
      <div className="dr-import-job-title"><Spinner size={17}/><strong>{phase}</strong></div>
      <p className="dr-import-path" title={job.name}>{job.name}</p>
      <ProgressBar value={job.total?(job.done+(job.progress??0))/job.total:0}/>
      <p>{t('import.progress','Processed {done} / {total}',{done:job.done??0,total:job.total??0})}</p>
      <p className="dr-import-hint">{job.phase==='cancelling'?t('import.stopping','Stopping after the current step; completed documents are kept.'):t('import.queueHint','Documents are processed in order. Closing this window keeps the import running.')}</p>
    </div>:result?<div className="dr-import-result" role="status">
      <strong>{result.cancelled?t('import.cancelled','Import stopped'):t('import.complete','Import complete')}</strong>
      <p>{t('import.summary','Imported {done} · failed {failed} · skipped {skipped}',{done:result.imported.length,failed:result.errors.length,skipped:result.skipped.length+result.duplicates.length})}</p>
      {result.cancelled?<p className="dr-import-hint">{t('import.stopping','Completed documents are kept.')}</p>:null}
      {result.errors.length?<ul className="dr-import-errors">{result.errors.map((error,index)=><li key={index}><span>{error.name}</span><span>{error.message}</span></li>)}</ul>:null}
      {result.skipped.length+result.duplicates.length>0?<details><summary>{t('import.skipped','Skipped unsupported or duplicate files')}</summary><ul className="dr-import-files">{[...result.skipped,...result.duplicates].slice(0,200).map((name,index)=><li key={index} title={name}>{name}</li>)}</ul></details>:null}
      {result.imported.length?<details><summary>{t('import.imported','Imported documents')}</summary><ul className="dr-import-files">{result.imported.map(item=><li key={item.id} title={item.name}>{item.title}</li>)}</ul></details>:null}
    </div>:<>
      <Tabs value={mode} onChange={setMode} tabs={[
        {id:'files',label:t('import.files','Files / ZIP'),icon:<IconUpload size={14}/>},
        {id:'folder',label:t('import.folder','Folder'),icon:<IconFolder size={14}/>},
        {id:'urls',label:t('import.urls','From URLs'),icon:<IconGlobe size={14}/>},
      ]}/>
      <label className="dr-import-destination"><span>{t('import.destination','Destination')}</span><Select value={target} onChange={setTarget} options={[{value:'',label:t('library.unfiled','Unfiled')},...state.folders.map(folder=>({value:folder.id,label:folder.name}))]}/></label>
      {mode==='urls'?<>
        <textarea className="dr-textarea dr-import-urls" aria-label={t('import.urlInput','Document URLs, one per line')} value={urls} onChange={event=>setUrls(event.target.value)} placeholder="https://arxiv.org/abs/…"/>
        <p className="dr-import-hint">{t('import.urlHint','Paste PDF / EPUB links, arXiv pages or accessible scholarly pages. One URL per line, up to 20. Pages requiring sign-in or payment may need a manual download.')}</p>
      </>:<>
        <input ref={fileInput} type="file" multiple hidden data-import-source="files" accept=".pdf,.epub,.zip,application/pdf,application/epub+zip,application/zip" onChange={event=>{stage(event.target.files);event.target.value=''}}/>
        <input ref={folderInput} type="file" multiple hidden webkitdirectory="" directory="" data-import-source="folder" onChange={event=>{stage(event.target.files);event.target.value=''}}/>
        <div className="dr-import-drop" onDragEnter={event=>{event.preventDefault();event.stopPropagation()}} onDragOver={event=>{event.preventDefault();event.stopPropagation()}} onDrop={drop}>
          <Button icon={mode==='folder'?<IconFolder size={15}/>:<IconUpload size={15}/>} onClick={()=>mode==='folder'?folderInput.current?.click():fileInput.current?.click()} disabled={collecting}>{mode==='folder'?t('import.pickFolder','Choose folder'):t('import.pickFiles','Choose files (multiple allowed)')}</Button>
          <p>{collecting?t('import.collecting','Reading folder…'):t('import.dropHint','Or drop files, ZIP archives or a folder here')}</p>
        </div>
        {files.length?<ul className="dr-import-files dr-import-selection">{files.slice(0,200).map((file,index)=><li key={index} title={importPath(file)}><span>{importPath(file)}</span><small>{formatBytes(file.size||0)}</small></li>)}</ul>:null}
        <p className="dr-import-hint">{t('import.fileHint','PDF / EPUB. ZIP and folders may contain subfolders; other files are skipped. Up to 200 documents per batch; each document or ZIP up to 100 MB. All documents go into the selected library folder.')}</p>
      </>}
    </>}
  </Modal>
}
