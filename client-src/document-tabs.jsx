import React from 'react'
import {IconBook, IconClose, IconLibrary, IconSettings} from './icons.jsx'
import {IconButton} from './ui.jsx'
import {moveTab} from '../shared/reader-tabs.js'

const TAB_DRAG = 'application/x-dsh-reader-tab'
export function DocumentTabs({docs, ids, activeId, onLibrary, onOpen, onClose, onReorder, onSettings, status, t}) {
  const selectedRef = React.useRef(null)
  React.useEffect(() => { selectedRef.current?.scrollIntoView({block:'nearest', inline:'nearest'}) }, [activeId, ids.length])
  const byId = new Map(docs.map(doc => [doc.id, doc]))
  const keyboard = (event, id) => {
    const all = [null, ...ids], at = all.indexOf(id)
    let next
    if (event.key === 'ArrowRight') next = all[(at + 1) % all.length]
    else if (event.key === 'ArrowLeft') next = all[(at + all.length - 1) % all.length]
    else if (event.key === 'Home') next = null
    else if (event.key === 'End') next = all[all.length - 1]
    else if (event.key === 'Delete' && id) { event.preventDefault(); onClose(id); return }
    else return
    event.preventDefault()
    if (next === null) onLibrary(); else onOpen(next)
    const list=event.currentTarget.closest('[role="tablist"]')
    requestAnimationFrame(() => list?.querySelector('[aria-selected="true"]')?.focus())
  }
  return <header className="dr-workspace-bar">
    <div className="dr-document-tabs" role="tablist" aria-label={t('tabs.documents','Open documents')}>
      <button className={`dr-document-tab dr-library-tab ${!activeId ? 'is-active' : ''}`} role="tab" aria-selected={!activeId} tabIndex={!activeId ? 0 : -1} onClick={onLibrary} onKeyDown={e=>keyboard(e,null)}><IconLibrary size={15}/><span>{t('nav.library','Library')}</span></button>
      {ids.map(id => {
        const doc=byId.get(id); if (!doc) return null
        const selected=id===activeId
        return <div className={`dr-document-tab-wrap ${selected ? 'is-active' : ''}`} key={id} draggable onDragStart={event=>{event.dataTransfer.setData(TAB_DRAG,id);event.dataTransfer.effectAllowed='move'}} onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes(TAB_DRAG)){event.preventDefault();event.dataTransfer.dropEffect='move'}}} onDrop={event=>{const source=event.dataTransfer.getData(TAB_DRAG);if(source){event.preventDefault();event.stopPropagation();onReorder(moveTab(ids,source,id))}}} onAuxClick={event=>{if(event.button===1){event.preventDefault();onClose(id)}}}>
          <button ref={selected ? selectedRef : null} className="dr-document-tab" role="tab" data-tab-doc-id={id} aria-selected={selected} tabIndex={selected ? 0 : -1} title={doc.title} onClick={()=>onOpen(id)} onKeyDown={e=>keyboard(e,id)}><IconBook size={14}/><span>{doc.title || t('common.untitled','Untitled')}</span><small>{doc.format?.toUpperCase()}</small></button>
          <button type="button" className="dr-tab-close" aria-label={t('tabs.close','Close {title}',{title:doc.title})} title={t('tabs.close','Close {title}',{title:doc.title})} onClick={()=>onClose(id)}><IconClose size={12}/></button>
        </div>
      })}
    </div>
    {status}
    <IconButton icon={<IconSettings size={17}/>} label={t('nav.settings','Settings')} onClick={onSettings}/>
  </header>
}
