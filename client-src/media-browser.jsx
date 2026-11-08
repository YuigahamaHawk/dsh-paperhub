import React from 'react'
import {useReader} from './store.jsx'
import {Button, IconButton, EmptyState, LoadingBlock} from './ui.jsx'
import {IconGrid, IconClose, IconPlus, IconBook, IconChat} from './icons.jsx'

const h = React.createElement
const listingLabels = { algorithm: 'Algorithm', code: 'Code', listing: 'Listing' }
const labelFor = (entry, t) => t(`media.${entry.kind}`, listingLabels[entry.kind] ?? entry.kind) + (entry.number ? ` ${entry.number}` : '')

function Caption({entry, reader}) {
  const service = reader.translate
  const subscribe = React.useCallback(listener => service?.subscribe?.(listener) ?? (() => {}), [service])
  const snapshot = React.useCallback(() => service?.get?.(entry.captionId), [service, entry.captionId])
  const translated = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  return h(React.Fragment, null,
    h('span', {className:'dr-media-caption-source'}, entry.caption || labelFor(entry, reader.t)),
    service?.enabled && translated?.status === 'done' && (!translated.source || translated.source === entry.caption)
      ? h('span', {className:'dr-media-caption-translation'}, translated.text) : null)
}

export function MediaPanel() {
  const reader = useReader(), {media, mediaImages: images, t} = reader
  const [filter, setFilter] = React.useState(reader.session?.ui.mediaFilter ?? '')
  const changeFilter = value => {
    setFilter(value)
    if (reader.session) reader.session.ui.mediaFilter = value
  }
  if (!images) return h(LoadingBlock, {label:t('reader.loading', 'Opening document…')})
  const query = filter.trim().toLocaleLowerCase()
  const catalog = media.filter(entry=>entry.kind==='figure'||entry.kind==='table')
  const visible = catalog.filter(entry => `${labelFor(entry,t)} ${entry.caption} ${entry.page ?? ''}`.toLocaleLowerCase().includes(query))
  return h('div', {className:'dr-media-index'},
    h('input', {className:'dr-media-filter', value:filter, onChange:event=>changeFilter(event.target.value), placeholder:t('media.find','Find a figure or table…'), 'aria-label':t('media.find','Find a figure or table…')}),
    catalog.length === 0 ? h(EmptyState,{icon:h(IconGrid,{size:22}),title:t('media.empty','No figures indexed'),body:t('media.emptyHint','Extracted figures, tables and EPUB images appear here.')}) : null,
    visible.map(entry=>h(MediaCard,{key:entry.id+'|'+JSON.stringify(entry.block.cropRect??entry.block.rect),entry,reader,images})),
    catalog.length > 0 && visible.length === 0 ? h('p',null,t('reader.search.noResults','No matches')) : null)
}

function MediaCard({entry,reader,images}){
  const host=React.useRef(null),[src,setSrc]=React.useState(''),[failed,setFailed]=React.useState(false),[visible,setVisible]=React.useState(false)
  const {t}=reader
  const selected = reader.askSource?.kind === 'media' && reader.askSource.id === entry.id
  const source = {
    kind: 'media', id: entry.id, title: labelFor(entry, t), page: entry.page, mediaKind: entry.kind,
    text: [...new Set([entry.caption, entry.block.text].filter(Boolean))].join('\n\n'),
  }
  const select = () => {
    reader.selectAskSource(source)
    reader.jumpTo({ blockId: entry.id })
  }
  React.useEffect(()=>{if(!host.current)return;const observer=new IntersectionObserver(values=>{if(values.some(value=>value.isIntersecting)){setVisible(true);observer.disconnect()}},{rootMargin:'80px'});observer.observe(host.current);return()=>observer.disconnect()},[])
  React.useEffect(()=>{if(!visible)return;let stopped=false;images.image(entry).then(value=>{if(!stopped){setSrc(value);setFailed(!value)}}).catch(()=>{if(!stopped)setFailed(true)});return()=>{stopped=true}},[images,entry.block,visible])
  return h('div',{className:`dr-media-card${selected ? ' is-selected' : ''}`,ref:host},
    h('button',{type:'button',className:'dr-media-item',title:entry.caption,'data-media-id':entry.id,'aria-pressed':selected,onClick:select},
      h('span',{className:'dr-media-thumbnail'},src?h('img',{src,alt:labelFor(entry,t),loading:'lazy'}):h('span',null,failed?t('media.thumbnailFailed','Preview unavailable; open the original page'):t('media.thumbnailLoading','Loading preview…'))),
      h('span',{className:'dr-media-item-meta'},labelFor(entry,t),entry.page?` · p.${entry.page}`:''),entry.caption?h(Caption,{entry,reader}):null),
    src || selected ? h('div',{className:'dr-media-card-actions'},
      selected ? h(Button,{size:'sm',variant:'ghost',icon:h(IconChat,{size:13}),onClick:()=>reader.askAbout(source)},t('ai.askSource','Ask about this')) : null,
      src ? h(Button,{size:'sm',variant:'ghost',onClick:()=>reader.previewMedia?.({blockId:entry.id,src})},t('media.enlarge','Enlarge figure')) : null,
    ) : null)
}

/** Enlarges the already rendered image. No second crop, OCR or paid model request. */
export function MediaPreview({request, onClose}) {
  const reader = useReader(), {t} = reader
  const entry = reader.media.find(item=>item.id===request.blockId)
  const frame = React.useRef(null), stage = React.useRef(null), close = React.useRef(null), drag = React.useRef(null)
  const [size,setSize] = React.useState({width:0,height:0})
  const [natural,setNatural] = React.useState({width:0,height:0})
  const [scale,setScale] = React.useState(1)
  React.useEffect(()=>{
    const opener = document.activeElement
    close.current?.focus()
    const observer = new ResizeObserver(()=>{if(stage.current)setSize({width:stage.current.clientWidth,height:stage.current.clientHeight})})
    if(stage.current)observer.observe(stage.current)
    return()=>{observer.disconnect();if(opener?.isConnected)opener.focus({preventScroll:true})}
  },[])
  const fit = natural.width && size.width ? Math.min(1, Math.max(1,size.width-40)/natural.width, Math.max(1,size.height-40)/natural.height) : 1
  const zoom = value => {
    const next = Math.max(1,Math.min(8,value)), el = stage.current
    if(el) {
      const x=(el.scrollLeft+el.clientWidth/2)/Math.max(el.scrollWidth,1), y=(el.scrollTop+el.clientHeight/2)/Math.max(el.scrollHeight,1)
      requestAnimationFrame(()=>{if(el.isConnected){el.scrollLeft=x*el.scrollWidth-el.clientWidth/2;el.scrollTop=y*el.scrollHeight-el.clientHeight/2}})
    }
    setScale(next)
  }
  const onKey = event => {
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return}
    if(event.key==='Tab') {
      const buttons=[...frame.current.querySelectorAll('button:not(:disabled),[tabindex="0"]')]
      if(!buttons.length)return
      if(event.shiftKey&&document.activeElement===buttons[0]){event.preventDefault();buttons.at(-1).focus()}
      else if(!event.shiftKey&&document.activeElement===buttons.at(-1)){event.preventDefault();buttons[0].focus()}
    }
    if(event.key==='+'||event.key==='='){event.preventDefault();event.stopPropagation();zoom(scale*1.4)}
    if(event.key==='-'){event.preventDefault();event.stopPropagation();zoom(scale/1.4)}
    if(event.key==='0'){event.preventDefault();event.stopPropagation();setScale(1)}
  }
  if(!entry)return null
  const width=natural.width*fit*scale, height=natural.height*fit*scale
  return h('div',{className:'dr-modal-backdrop dr-media-backdrop',onMouseDown:event=>{if(event.target===event.currentTarget)onClose()}},
    h('section',{className:'dr-media-dialog',ref:frame,role:'dialog','aria-modal':'true','aria-label':t('media.preview','Figure preview'),onKeyDownCapture:onKey},
      h('header',{className:'dr-media-head'},
        h('strong',null,labelFor(entry,t),entry.page?` · p.${entry.page}`:''),
        h('div',{className:'dr-media-zoom'},
          h(IconButton,{label:t('media.zoomOut','Zoom out'),icon:'−',disabled:scale<=1,onClick:()=>zoom(scale/1.4)}),
          h('output',{'aria-live':'polite'},`${Math.round(fit*scale*100)}%`),
          h(IconButton,{label:t('media.zoomIn','Zoom in'),icon:h(IconPlus,{size:16}),disabled:scale>=8,onClick:()=>zoom(scale*1.4)}),
          h(Button,{size:'sm',onClick:()=>setScale(1)},t('media.fit','Fit'))),
        h('button',{type:'button',ref:close,className:'dr-iconbtn','aria-label':t('common.close','Close'),onClick:onClose},h(IconClose,{size:18}))),
      h('div',{className:'dr-media-stage',ref:stage,tabIndex:0,'aria-label':t('media.pan','Scroll or drag to inspect; +/− zoom, 0 fits'),onPointerDown:event=>{
        if(event.button!==0)return
        drag.current={x:event.clientX,y:event.clientY,left:stage.current.scrollLeft,top:stage.current.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()
      },onPointerMove:event=>{if(drag.current){stage.current.scrollLeft=drag.current.left+drag.current.x-event.clientX;stage.current.scrollTop=drag.current.top+drag.current.y-event.clientY}},onPointerUp:()=>{drag.current=null},onPointerCancel:()=>{drag.current=null}},
        h('div',{className:'dr-media-plane',style:{width:Math.max(size.width,width+40),height:Math.max(size.height,height+40)}},
          h('img',{src:request.src,alt:entry.caption||labelFor(entry,t),draggable:false,onLoad:event=>setNatural({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight}),style:{width:width||undefined,height:height||undefined}}))),
      h('footer',{className:'dr-media-caption'},h(Caption,{entry,reader}),
        reader.doc.format==='pdf'&&entry.page?h(Button,{size:'sm',icon:h(IconBook,{size:14}),onClick:()=>{onClose();reader.jumpTo({page:entry.page})}},t('media.original','Open original page')):null,
        h('small',null,t('media.pan','Scroll or drag to inspect; +/− zoom, 0 fits')))))
}
