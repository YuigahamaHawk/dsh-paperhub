import React from 'react'
import { loadPdfjs, renderPdfPage } from './pdf-engine.js'
import { inlineMathMarkup, paragraphSourceRects, protectInlineMath, translatedMathSegments, validateInlineMath, INLINE_MATH_VERSION, inlineTokenTotal, inlineMathBatchBlocks, isInlineMathParagraph } from '../shared/inline-math.js'
import { IconRefresh, IconSpark, IconCheck, Spinner } from './icons.jsx'
import { MenuItem } from './ui.jsx'
import { contentInlineRecords } from '../shared/parser-inline.js'

const h = React.createElement

async function openInlinePdf(api, docId, signal) {
  const assets = { moduleUrl: api.assetUrl('pdf/pdf.mjs'), workerUrl: api.assetUrl('pdf/pdf.worker.mjs'), cMapUrl: api.assetUrl('pdf/cmaps/'), standardFontDataUrl: api.assetUrl('pdf/standard_fonts/') }
  const pdfjs = await loadPdfjs(assets)
  const response = await fetch(api.fileUrl(docId, 'original'), { signal })
  if (!response.ok) throw new Error(`PDF request failed (HTTP ${response.status})`)
  const bytes = await response.arrayBuffer()
  return pdfjs.getDocument({ data: new Uint8Array(bytes), cMapUrl: assets.cMapUrl, cMapPacked: true, standardFontDataUrl: assets.standardFontDataUrl }).promise
}

export async function renderParagraphImages({ api, docId, content, block, signal, sharedPdf }) {
  const locations = paragraphSourceRects(content, block)
  if (!locations.length || locations.length > 4) throw new Error('无法定位本段的原版区域，或本段超过4页')
  const pdf = sharedPdf ?? await openInlinePdf(api, docId, signal)
  const images = []
  try {
    for (const location of locations) {
      if (signal?.aborted) throw new Error('cancelled')
      const { canvas } = await renderPdfPage(pdf, location.page, { scale: 2.5, dpr: 1, signal })
      const { x, y, w, h } = location.rect
      const crop = document.createElement('canvas')
      crop.width = Math.max(1, Math.ceil(canvas.width * w)); crop.height = Math.max(1, Math.ceil(canvas.height * h))
      const ctx = crop.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, crop.width, crop.height)
      ctx.drawImage(canvas, canvas.width * x, canvas.height * y, canvas.width * w, canvas.height * h, 0, 0, crop.width, crop.height)
      images.push({ ...location, imageBase64: crop.toDataURL('image/jpeg', 0.92).split(',')[1] })
      canvas.width = canvas.height = crop.width = crop.height = 1
    }
  } finally { if (!sharedPdf) await pdf.destroy() }
  return images
}

export function useInlineMath({ api, doc, content, settings, onLayout, session }) {
  const matching = entries => {
    const blocks=content?.blocks??(content?.pages??[]).flatMap(page=>page.blocks??[]),byId=new Map(blocks.map(block=>[block.id,block]))
    return Object.fromEntries(Object.entries(entries??{}).filter(([id,entry])=>byId.has(id)&&(!entry.record||entry.record.source===byId.get(id).text)))
  }
  const seeds=()=>Object.fromEntries(Object.entries(contentInlineRecords(content)).map(([id,record])=>[id,{record,cached:true}]))
  const [entries, setEntries] = React.useState(()=>({...seeds(),...matching(session?.inlineEntries)}))
  const [ready, setReady] = React.useState(false)
  const [batch, setBatch] = React.useState(null)
  const batchRun = React.useRef(null)
  const controllers = React.useRef(new Map()), epoch = React.useRef(0)
  const snapshot = React.useRef(null); snapshot.current = { content, settings, entries, ready }
  React.useEffect(() => {
    const generation = ++epoch.current
    setReady(false)
    setBatch(null)
    setEntries({...seeds(),...matching(session?.inlineEntries)})
    if (doc?.format === 'pdf') api.rpc('inline.list', { id: doc.id }).then(result => {
      const loaded = {}
      for (const [id, record] of Object.entries(result.blocks ?? {})) {
        try { if (record.version === INLINE_MATH_VERSION) loaded[id] = { record: { ...record, ...validateInlineMath(record, record.source, {sourceAlignedParser:record.origin?.engine==='mineru'}) }, cached: true } } catch { /* keep the readable original */ }
      }
      if (generation === epoch.current) setEntries(current => ({ ...matching(current), ...matching(loaded), ...Object.fromEntries(Object.entries(matching(current)).filter(([,entry])=>entry.pending||entry.record&&!entry.cached)) }))
    }).catch(() => {}).finally(() => { if (generation === epoch.current) setReady(true) })
    return () => {
      epoch.current++
      batchRun.current?.abort()
      batchRun.current = null
      for (const c of controllers.current.values()) c.abort()
      controllers.current.clear()
      if(session?.inlineEntries)session.inlineEntries=Object.fromEntries(Object.entries(session.inlineEntries).map(([id,entry])=>[id,{...entry,pending:false}]))
    }
  }, [api, doc?.id, content?.visionLayoutAt, content?.parser?.version])
  React.useEffect(() => { onLayout?.() }, [entries, onLayout])
  React.useEffect(()=>{if(session)session.inlineEntries=entries},[session,entries])

  const run = React.useCallback(async (block, force = false, { sharedPdf, signal } = {}) => {
    if (signal?.aborted || (batchRun.current && !signal) || controllers.current.size >= 2 || controllers.current.has(block.id)) return null
    const controller = new AbortController(), generation = epoch.current
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    controllers.current.set(block.id, controller)
    setEntries(current => ({ ...current, [block.id]: { ...current[block.id], pending: true, error: '' } }))
    try {
      const { content, settings } = snapshot.current
      const images = await renderParagraphImages({ api, docId: doc.id, content, block, signal: controller.signal, sharedPdf })
      const result = await api.stream('ai.inlineMath', { docId: doc.id, blockId: block.id, source: block.text, images, force, modelRef: settings.ai.active?.vision }, {}, controller.signal)
      if (generation !== epoch.current || controller.signal.aborted) return null
      setEntries(current => ({ ...current, [block.id]: { record: result.record, cached: result.cached, pending: false } }))
      return { ok: true }
    } catch (error) {
      if (generation === epoch.current) setEntries(current => ({ ...current, [block.id]: { ...current[block.id], pending: false, error: controller.signal.aborted ? '' : String(error.message ?? error), errorCode: error.code, failedRequest: controller.signal.aborted ? null : error.request } }))
      return controller.signal.aborted ? null : { ok: false, code: error.code, message: String(error.message ?? error) }
    } finally {
      signal?.removeEventListener('abort', abort)
      if (controllers.current.get(block.id) === controller) controllers.current.delete(block.id)
      if (controller.signal.aborted && generation === epoch.current) {
        setEntries(current => current[block.id]?.pending ? { ...current, [block.id]: { ...current[block.id], pending: false } } : current)
      }
    }
  }, [api, doc?.id])
  const runBatch = React.useCallback(async () => {
    const { content, entries, ready } = snapshot.current
    if (doc?.format !== 'pdf' || !ready || batchRun.current || controllers.current.size) return null
    const blocks = inlineMathBatchBlocks(content, entries)
    const result = { total: blocks.length, processed: 0, failed: 0, error: '' }
    if (!blocks.length) return result
    const controller = new AbortController(), generation = epoch.current
    batchRun.current = controller
    setBatch({ ...result })
    let sharedPdf
    try {
      sharedPdf = await openInlinePdf(api, doc.id, controller.signal)
      for (const block of blocks) {
        if (controller.signal.aborted) break
        const outcome = await run(block, false, { sharedPdf, signal: controller.signal })
        if (controller.signal.aborted) break
        if (outcome) {
          result.processed++
          if (!outcome.ok) result.failed++
        }
        setBatch({ ...result })
        if (['model-not-configured', 'model-unavailable', 'vision-unsupported', 'vision-unavailable', 'unauthorized', 'network'].includes(outcome?.code)) {
          result.error = outcome.message
          break
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) result.error = String(error.message ?? error)
    } finally {
      try { await sharedPdf?.destroy() } catch { /* the batch is already finished */ }
      if (batchRun.current === controller) {
        batchRun.current = null
        setBatch(null)
      }
    }
    return generation === epoch.current && !controller.signal.aborted ? result : null
  }, [api, doc?.id, doc?.format, run])
  const toggle = React.useCallback(async (block, enabled) => {
    const generation = epoch.current
    try {
      const result = await api.rpc('inline.enabled', { id: doc.id, blockId: block.id, enabled })
      if (generation !== epoch.current) return
      setEntries(current => ({ ...current, [block.id]: { ...current[block.id], record: result.record } }))
    } catch (error) { if (generation === epoch.current) setEntries(current => ({ ...current, [block.id]: { ...current[block.id], error: String(error.message) } })) }
  }, [api, doc?.id])
  return { entries, run, toggle, ready, batch, runBatch, cancelBatch: () => batchRun.current?.abort(),
    busy: batch ? 2 : Object.values(entries).filter(entry => entry.pending).length,
    cancel: id => controllers.current.get(id)?.abort(),
    available: block => doc?.format === 'pdf' && isInlineMathParagraph(block),
    record: block => { const r = entries[block.id]?.record; return r?.enabled && r.source === block.text ? r : null },
  }
}

export function inlineTranslationBlocks(blocks, entries) {
  return blocks.map(block => {
    if (!block) return block
    const record = entries[block.id]?.record
    return record?.enabled && record.source === block.text && record.maths ? { ...block, text: protectInlineMath(record) } : block
  })
}

export function InlineMathText({ segments, sourceAnchors = false }) {
  return segments.map((segment, index) => segment.type === 'text' ? segment.text : h('span', {
    key: index, className: 'dr-inline-math', 'data-latex': segment.latex,
    ...(sourceAnchors ? { 'data-math-source': segment.source } : {}),
    title: segment.latex, dangerouslySetInnerHTML: { __html: inlineMathMarkup(segment.latex) },
  }))
}

export function InlineTranslation({ text, record }) {
  if (!record?.maths) return text
  const segments = translatedMathSegments(text, record)
  return segments ? h(InlineMathText, { segments, sourceAnchors:true }) : text
}

export function InlineMathTools({ block, service, t }) {
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState({})
  const root = React.useRef(null), trigger = React.useRef(null)
  const tooltipId = React.useId()
  React.useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    const close = () => setOpen(false)
    const key = event => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', closeOutside, true); document.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key) }
  }, [open])
  if (!service?.available(block)) return null
  const state = service.entries[block.id] ?? {}, record = state.record?.source === block.text ? state.record : null
  const tokens = inlineTokenTotal(record?.request), failedTokens = inlineTokenTotal(state.failedRequest)
  const tokenLabel = value => value === null ? t('inline.noUsage', 'Provider did not return token usage') : `${value.toLocaleString()} tokens`
  const usageLabel=record?.origin?.engine==='mineru'?t('inline.localUsage','MinerU local recognition · no additional model API call'):tokenLabel(tokens)
  const action = t('inline.action', 'Refine inline math')
  const status = state.pending ? t('inline.cancelHint', 'Recognizing… click to cancel')
    : state.error ? t('inline.errorHint', 'Recognition failed; original text kept. Click to retry.')
    : record ? t(record.maths ? 'inline.completed' : 'inline.none', record.maths ? 'Completed' : 'No inline math found') : ''
  const errorReason = state.error ? `${t('inline.reason', 'Reason')}: ${state.error}` : ''
  const openMenu = () => {
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(280, window.innerWidth - 24)
    setPosition({ position: 'fixed', left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)), top: Math.max(12, Math.min(window.innerHeight - 210, rect.bottom + 6)), width })
    setOpen(value => !value)
  }
  const click = () => {
    if (state.pending) service.cancel(block.id)
    else if (record) openMenu()
    else service.run(block, !!state.error)
  }
  const operate = callback => { setOpen(false); callback() }
  return h('div', { className: 'dr-inline-tools', ref: root, onMouseDown: event => event.stopPropagation(), 'data-state': state.pending ? 'loading' : state.error ? 'error' : record ? 'done' : 'idle' },
    h('button', { type: 'button', ref: trigger, className: `dr-inline-logo${record?.enabled ? ' is-done' : ''}${state.error ? ' is-error' : ''}`,
      'aria-label': state.pending ? t('inline.cancelLabel', 'Cancel inline math recognition') : action, 'aria-describedby': tooltipId,
      'aria-expanded': record ? open : undefined, 'aria-haspopup': record ? 'menu' : undefined,
      disabled: !record && !state.pending && service.busy >= 2, onClick: click,
      onContextMenu: event => { if (record) { event.preventDefault(); openMenu() } } },
      state.pending ? h(Spinner, { size: 16 }) : h(IconSpark, { size: 17 }),
      record?.enabled && !state.pending ? h(IconCheck, { size: 8, className: 'dr-inline-done-badge' }) : null),
    h('div', { className: 'dr-inline-tooltip', id: tooltipId, role: 'tooltip', 'data-suppressed': open },
      h('strong', null, action), status ? h('div', null, status) : null,
      record ? h('div', null, `${t('inline.savedUsage', 'Saved recognition usage')}: ${usageLabel}`) : null,
      state.error ? h('div', null, `${t('inline.attemptUsage', 'Last attempt')}: ${tokenLabel(failedTokens)}`) : null,
      errorReason ? h('div', { className: 'dr-inline-error-detail' }, errorReason) : null,
      record ? h('div', { className: 'dr-inline-tooltip-note' }, t('inline.menuHint', 'Click for restore or recognition options; reopening uses the saved result.')) : null),
    open ? h('div', { className: 'dr-inline-menu', style: position, role: 'menu' },
      h('div', { className: 'dr-inline-menu-usage' }, `${action} · ${usageLabel}`),
      state.error ? h('div', { className: 'dr-inline-error-detail' }, errorReason) : null,
      h(MenuItem, { onClick: () => operate(() => service.toggle(block, !record.enabled)) }, record.enabled ? t('inline.restore', 'Restore extracted text') : t('inline.enable', 'Use refined formulas')),
      h(MenuItem, { icon: h(IconRefresh, { size: 14 }), disabled: service.busy >= 2, onClick: () => operate(() => service.run(block, true)) }, t('inline.forceMenu', 'Recognize again (uses tokens)')),
    ) : null)
}
