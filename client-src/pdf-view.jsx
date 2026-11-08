// PDF reading view: two renderers over the same PdfContent.
//
//  - mode "reflow":  reflowed text blocks rendered through <ParagraphBlock>, paginated by
//    small page separators and mounted progressively (IntersectionObserver sentinel) so a
//    500-page PDF opens instantly.
//  - mode "original": a virtualized stack of pdf.js page canvases with a selectable text
//    layer, hi-DPI rendering, zoom / fit-width controls, pdf-kind annotation rects and
//    in-page text selection that reports normalized rects back to the reader session.
//
// The shell owns the scroll container (`.dr-reader-scroll`), so this module never creates a
// nested scroller: it reads `useReader().scrollRoot` for virtualization and page tracking.
// Every failure (module load, document open, page render) is shown inline with a Retry
// button — rendering must never throw.
import React from 'react'
import { useReader } from './store.jsx'
import { ParagraphBlock } from './paragraph.jsx'
import { Button, EmptyState } from './ui.jsx'
import { IconBook, IconRefresh, Spinner } from './icons.jsx'
import { openPdfUrl, renderPdfPage } from './pdf-engine.js'
import { createPdfRenderQueue, PDF_PAGE_TIMEOUT } from './pdf-render-queue.js'
import { latexToMathML } from './latex.js'
import { clamp, clsx } from './util.js'
import { cropRegionCanvas } from './region-crop.js'

const h = React.createElement

/** First paint batch (blocks) and batch size added by the sentinel. */
const INITIAL_BLOCKS = 64
const BLOCK_BATCH = 128

/** Horizontal breathing room around the original page stack. */
const PAGE_GUTTER = 18

/** Minimum / maximum original-view zoom factor. */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 5

/** Small stylesheet: only the pdf-prefixed classes this view needs. */
const PDF_CSS = `
.dr-pdf-original{position:relative;width:100%;box-sizing:border-box;padding:6px 0 72px;display:flex;flex-direction:column;align-items:center}
.dr-pdf-toolbar{position:sticky;top:8px;z-index:6;display:flex;align-items:center;gap:5px;padding:4px 6px;margin:2px 0 12px;border-radius:10px;background:var(--dr-paper-surface,var(--dsw-alias-bg-layer-1));border:1px solid var(--dr-paper-border,var(--dsw-alias-border-l1));box-shadow:0 8px 24px rgba(0,0,0,.14);opacity:.97}
.dr-pdf-toolbar .dr-btn{height:26px;min-width:26px;padding:0 8px;font-size:12.5px;border-radius:7px}
.dr-pdf-zoom-value{min-width:46px;text-align:center;font-size:12px;color:var(--dr-paper-muted,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;user-select:none}
.dr-pdf-page-counter{font-size:12px;color:var(--dr-paper-muted,var(--dsw-alias-label-secondary));white-space:nowrap;padding:0 5px;font-variant-numeric:tabular-nums}
.dr-pdf-toolbar-sep{width:1px;height:18px;background:var(--dr-paper-border,var(--dsw-alias-border-l1));margin:0 2px}
.dr-pdf-pages{display:flex;flex-direction:column;align-items:center;gap:20px;width:100%;padding:0 ${PAGE_GUTTER}px;box-sizing:border-box}
.dr-pdf-page{position:relative;flex:none;background:#fff;border-radius:2px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.18),0 1px 2px rgba(0,0,0,.1)}
.dr-pdf-page.is-idle{background:color-mix(in srgb,#fff 62%,var(--dr-paper-surface,#f4f4f6))}
.dr-pdf-canvas-host{position:absolute;inset:0}
.dr-pdf-canvas-host canvas{display:block;width:100%;height:100%}
.dr-pdf-text-layer{position:absolute;inset:0;z-index:2;overflow:clip;line-height:1;text-align:initial;opacity:1}
.dr-pdf-text-layer span,.dr-pdf-text-layer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.dr-pdf-text-layer .markedContent{display:contents}
.dr-pdf-text-layer span::selection{background:rgba(64,128,255,.34);color:transparent}
.dr-pdf-text-layer span::-moz-selection{background:rgba(64,128,255,.34);color:transparent}
.dr-pdf-ann-layer{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden}
.dr-pdf-ann-layer .dr-highlight-rect{pointer-events:auto}
.dr-pdf-page-status{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,#fff 64%,transparent)}
.dr-pdf-page-status.is-error{color:var(--dsw-alias-state-error-primary)}
.dr-pdf-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:84px 26px;text-align:center;color:var(--dr-paper-muted,var(--dsw-alias-label-secondary));font-size:13px;line-height:1.6}
.dr-pdf-status-text{max-width:460px;color:var(--dr-paper-fg,var(--dsw-alias-label-primary));font-size:13.5px}
.dr-pdf-status-error{max-width:520px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;overflow-wrap:anywhere}
.dr-pdf-loadmore{display:flex;align-items:center;justify-content:center;gap:8px;padding:30px 0 10px;color:var(--dr-paper-muted,var(--dsw-alias-label-secondary));font-size:12px;user-select:none}
.dr-pdf-page-sep{display:flex;align-items:center;gap:12px;margin:1.7em 0 .5em;color:var(--dr-paper-muted,var(--dsw-alias-label-secondary));font-size:11.5px;letter-spacing:.05em;user-select:none}
.dr-pdf-page-sep::before,.dr-pdf-page-sep::after{content:'';flex:1;height:1px;background:color-mix(in srgb,var(--dr-paper-fg,#333) 12%,transparent)}
`

/* ------------------------------------------------------------------ */
/* public component                                                    */
/* ------------------------------------------------------------------ */

/**
 * PDF content view.
 *
 * @param {{ content:any, mode?:'reflow'|'original', pageRequest?:{page:number,nonce:number}|null }} props
 */
export function PdfView({ content = null, mode = 'reflow', pageRequest = null }) {
  const reader = useReader()
  const t = typeof reader.t === 'function' ? reader.t : (key) => key
  const pdf = content !== null && content !== undefined && typeof content === 'object' && Array.isArray(content.pages) ? content : null
  const viewMode = mode === 'original' ? 'original' : 'reflow'
  return h(
    React.Fragment,
    null,
    h('style', { key: 'dr-pdf-css', dangerouslySetInnerHTML: { __html: PDF_CSS } }),
    h(
      PdfErrorBoundary,
      { key: `${viewMode}-boundary`, t },
      viewMode === 'original'
        ? h(PdfOriginal, { key: 'original', content: pdf, pageRequest, reader, t })
        : h(PdfReflow, { key: 'reflow', content: pdf, reader, t }),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* reflow mode                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* lazy figure / formula regions                                       */
/* ------------------------------------------------------------------ */

const REGION_CACHE_MAX = 48
const regionCache = new Map()
const pageCanvasCache = new Map()
const pageRenderTasks = new WeakMap()
const enqueueRender = createPdfRenderQueue()

function pdfRegionVariant(block) {
  if (block?.kind === 'pageFigure') return 'page'
  if (block?.kind === 'figure' || block?.kind === 'formula') return block.kind
  return null
}

/** Drop rendered region images after a document/layout replacement. */
export function clearRegionCache() {
  regionCache.clear()
}

/** Render a whole page once (serialized, cached) so all regions on it share one render task. */
async function pageCanvasFor(pdf, pageNumber, docId) {
  const key = `${docId}|${pageNumber}`
  const cached = pageCanvasCache.get(key)
  if (cached !== undefined) return cached
  // An old PDF handle may be destroyed while switching tabs. Only share its
  // in-flight draws with that handle. Completed canvases are safe to reuse.
  let tasks = pageRenderTasks.get(pdf)
  if (!tasks) {
    tasks = new Map()
    pageRenderTasks.set(pdf, tasks)
  }
  const pending = tasks.get(key)
  if (pending !== undefined) return pending
  const task = enqueueRender(async signal => {
    const ready = pageCanvasCache.get(key)
    if (ready !== undefined) return ready
    const rendered = await renderPdfPage(pdf, pageNumber, { scale: 3, dpr: 1, signal })
    if (signal.aborted) throw signal.reason
    try {
      rendered.page?.cleanup?.()
    } catch {
      /* ignore */
    }
    const canvas = rendered.canvas
    if (pageCanvasCache.size >= 8) {
      const oldest = pageCanvasCache.keys().next().value
      if (oldest !== undefined) pageCanvasCache.delete(oldest)
    }
    pageCanvasCache.set(key, canvas)
    return canvas
  })
  tasks.set(key, task)
  try {
    return await task
  } finally {
    tasks.delete(key)
  }
}

function pdfAssetsFor(api) {
  const assetUrl = typeof api?.assetUrl === 'function' ? api.assetUrl : (relative) => `/dsh-reader-assets/${String(relative).replace(/^\/+/, '')}`
  return {
    moduleUrl: assetUrl('pdf/pdf.mjs'),
    workerUrl: assetUrl('pdf/pdf.worker.mjs'),
    cMapUrl: assetUrl('pdf/cmaps/'),
    standardFontDataUrl: assetUrl('pdf/standard_fonts/'),
  }
}

/** Render one normalized page region (0..1 coords) to an image data URL. */
export function regionImageKey(docId,block,variant){
  const rect=block?.cropRect??block?.rect
  const key=rect?`${Number(rect.x).toFixed(5)},${Number(rect.y).toFixed(5)},${Number(rect.w).toFixed(5)},${Number(rect.h).toFixed(5)}`:'none'
  return `${docId}|${block.id}|${variant}|${key}|${JSON.stringify(block.numberRect??null)}|${JSON.stringify(block.exclusionRects??[])}`
}
export async function renderRegionImage(pdf, block, variant, docId) {
  const key=regionImageKey(docId,block,variant)
  if(regionCache.has(key))return regionCache.get(key)
  const pageNumber = Math.max(1, Number(block?.page) || 1)
  const rawRect = block?.cropRect ?? block?.rect
  const hasRect =
    rawRect !== null &&
    typeof rawRect === 'object' &&
    Number.isFinite(Number(rawRect.x)) &&
    Number.isFinite(Number(rawRect.y)) &&
    Number(rawRect.w) > 0 &&
    Number(rawRect.h) > 0
  // A figure/formula without a real crop rectangle must never silently fall back to the whole
  // page: that produces the confusing "entire page as an image" cards.
  if (!hasRect && variant !== 'page') throw new Error('missing region rectangle')
  const rect = hasRect ? rawRect : { x: 0, y: 0, w: 1, h: 1 }
  const canvas = await pageCanvasFor(pdf, pageNumber, docId)
  const { crop, context } = cropRegionCanvas(canvas, rect, { masks: block.exclusionRects ?? [], numberRect: variant === 'formula' ? block.numberRect : undefined, fontSize: block.fontSize, pageWidth: block.pageWidth, pageHeight: block.pageHeight })
  // Trim the white page margins around the actual figure/table/equation. The candidate crop is
  // deliberately generous (page top to the caption); this pass removes the surrounding paper.
  let output = crop
  try {
    const probe = context.getImageData(0, 0, crop.width, crop.height).data
    let minX = crop.width
    let minY = crop.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < crop.height; y += 2) {
      for (let x = 0; x < crop.width; x += 2) {
        const index = (y * crop.width + x) * 4
        if (probe[index] < 246 || probe[index + 1] < 246 || probe[index + 2] < 246) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0 || maxY < 0) {
      const blank = new Error('blank region')
      blank.blank = true
      throw blank
    }
    const pad = 6
    const bx = Math.max(0, minX - pad)
    const by = Math.max(0, minY - pad)
    const bw = Math.min(crop.width - bx, maxX - minX + 1 + pad * 2)
    const bh = Math.min(crop.height - by, maxY - minY + 1 + pad * 2)
    if (bw >= 20 && bh >= 20) {
      const tight = document.createElement('canvas')
      tight.width = bw
      tight.height = bh
      const tightContext = tight.getContext('2d')
      if (tightContext !== null) {
        tightContext.fillStyle = '#ffffff'
        tightContext.fillRect(0, 0, bw, bh)
        tightContext.drawImage(crop, bx, by, bw, bh, 0, 0, bw, bh)
        output = tight
      }
    }
  } catch (error) {
    if (error?.blank === true) throw error
    /* getImageData may be unavailable; keep the generous crop */
  }
  const src=variant==='formula'?output.toDataURL('image/png'):output.toDataURL('image/jpeg',0.94)
  if(regionCache.size>=REGION_CACHE_MAX)regionCache.delete(regionCache.keys().next().value)
  regionCache.set(key,src)
  return src
}

/**
 * One lazily rendered page region in the reflow: figures and display equations are cropped from
 * the original page only when they scroll near the viewport, then cached in memory.
 */
function PdfRegion({ pdf, docId, block, variant, number, reader, t, failed: pdfFailed = false }) {
  // Include the crop rectangle: after a reflow/re-extraction the block id often survives while
  // the rect changes, and a doc|block|variant key would replay the old, wrong crop.
  const cacheKey = regionImageKey(docId, block, variant)
  const [inkPixelWidth, setInkPixelWidth] = React.useState(null)
  const [src, setSrc] = React.useState(() => regionCache.get(cacheKey) ?? '')
  const [failure, setFailure] = React.useState(null)
  React.useEffect(() => {
    setSrc(regionCache.get(cacheKey) ?? '')
    setInkPixelWidth(null)
    setFailure(null)
  }, [cacheKey])
  const hostRef = React.useRef(null)
  React.useEffect(()=>{
    reader.registerBlockEl?.(block.id,hostRef.current)
    return()=>reader.registerBlockEl?.(block.id,null)
  },[block.id,reader.registerBlockEl])
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null || src !== '') return undefined
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            break
          }
        }
      },
      { root: reader.scrollRoot ?? null, rootMargin: '900px 0px', threshold: 0 },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [reader.scrollRoot, src])

  React.useEffect(() => {
    if (!visible || src !== '' || !pdf || failure) return undefined
    let cancelled = false
    renderRegionImage(pdf, block, variant, docId)
      .then((dataUrl) => {
        if (cancelled) return
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('empty region image')
        setSrc(dataUrl)
      })
      .catch((reason) => {
        if (!cancelled) setFailure({ code: reason?.blank ? 'blank' : reason?.code, detail: String(reason?.message ?? reason).slice(0, 180) })
      })
    return () => { cancelled = true }
  }, [block, cacheKey, docId, failure, pdf, src, variant, visible])

  const openOriginal = () => {
    try {
      reader.setMode?.('original')
      reader.requestPage?.(Number(block.page) || 1)
    } catch {
      /* stale reader session */
    }
  }
  const label = block.structure === 'algorithm' ? t('media.algorithm', 'Algorithm') : variant === 'formula' ? t('reader.formula', 'Formula') : variant === 'page' ? t('reader.figurePage', 'Figure page') : t('reader.figure', 'Figure')
  let failureMessage
  if (failure?.code === 'blank') failureMessage = t('reader.regionBlank', 'This region has no visible content. Open the original page.')
  else if (failure?.code === PDF_PAGE_TIMEOUT) failureMessage = t('reader.regionTimeout', 'The original PDF page took too long to render.')
  else if (failure) failureMessage = `${t('reader.regionFailed', 'This region could not be rendered.')} (${failure.detail})`

  return h(
    'div',
    {
      className: clsx('dr-region', `dr-region-${variant}`),
      ref: hostRef,
      'data-block-id': block.id,
      'data-region': variant,
      'data-layout-source': block.layoutSource ?? 'extraction',
    },
    src !== ''
      ? h('button', {type:'button',className:'dr-media-open','aria-label':t('media.enlarge','Enlarge figure'),title:t('media.enlarge','Enlarge figure'),onClick:()=>reader.previewMedia?.({blockId:block.id,src})},h('img', { className: 'dr-region-img', src, onLoad: event => setInkPixelWidth(event.currentTarget.naturalWidth), style: variant === 'formula' && inkPixelWidth ? { width: `${Math.round(inkPixelWidth / 3 * (Number(reader.settings?.appearance?.fontSize) || 18) / (Number(block.fontSize) || 10))}px` } : undefined, alt: `${label} · ${t('reader.page', undefined, { page: block.page, total: '—' })}`, loading: 'lazy' }))
      : h(
          'div',
          { className: 'dr-region-placeholder' },
          failure
            ? h('span', null, failureMessage)
            : pdfFailed
              ? h('span', null, t('reader.regionUnavailable', 'Original pages are unavailable right now.'))
              : h('span', null, pdf === null || pdf === undefined ? t('reader.regionLoadingOriginal', 'Loading original page…') : t('reader.regionRendering', 'Rendering this region…')),
          failure && failure.code !== 'blank' && pdf
            ? h('button', { type: 'button', className: 'dr-region-open', onClick: () => setFailure(null) }, t('reader.regionRetry', 'Retry rendering'))
            : null,
          h(
            'button',
            { type: 'button', className: 'dr-region-open', onClick: openOriginal, title: t('reader.regionOpen', 'Open this page in the original layout') },
            h(IconBook, { size: 12 }),
            ` ${label} · ${block.page}`,
          ),
        ),
    src !== ''
      ? h(
          'button',
          { type: 'button', className: 'dr-region-open is-floating', onClick: openOriginal, title: t('reader.regionOpen', 'Open this page in the original layout') },
          h(IconBook, { size: 11 }),
        )
      : null,
    variant === 'formula' && typeof number === 'string' && number !== '' ? h('span', { className: 'dr-formula-number' }, `(${number})`) : null,
  )
}

/** AI-reconstructed display equation rendered as native MathML. */
function MathFormula({ latex, fallbackText, t }) {
  const html = React.useMemo(() => latexToMathML(latex), [latex])
  if (html === '') {
    return h('div', { className: 'dr-formula-fallback' }, fallbackText !== undefined && fallbackText !== '' ? fallbackText : t('reader.formula', 'Formula'))
  }
  return h('div', { className: 'dr-formula-math', dangerouslySetInnerHTML: { __html: html } })
}

function PdfReflow({ content, reader, t }) {
  const pages = React.useMemo(() => (content !== null && Array.isArray(content.pages) ? content.pages.filter((page) => page !== null && typeof page === 'object') : []), [content])
  // Region keys include source document, coordinates, number masks and exclusions. Retain the
  // bounded cache across tab switches rather than re-rendering every visible figure on return.
  const figurePages = React.useMemo(() => new Set(Array.isArray(content?.figurePages) ? content.figurePages : []), [content])
  const totalPages = Math.max(1, Number(content?.pageCount) || pages.length)
  const totalBlocks = React.useMemo(() => pages.reduce((sum, page) => sum + (Array.isArray(page.blocks) ? page.blocks.length : 0), 0), [pages])
  const [visibleBlocks, setVisibleBlocks] = React.useState(INITIAL_BLOCKS)
  const rootRef = React.useRef(null)
  const sentinelRef = React.useRef(null)
  const registerBlockEl = reader.registerBlockEl
  const hasRegions = React.useMemo(
    () => pages.some((page) => Array.isArray(page.blocks) && page.blocks.some((block) => pdfRegionVariant(block) !== null)),
    [pages],
  )
  const [regionPdf, setRegionPdf] = React.useState(null)
  const [regionPdfError, setRegionPdfError] = React.useState(null)
  const api = reader.api
  const docId = reader.doc?.id ?? ''

  React.useEffect(() => {
    if (!hasRegions || typeof docId !== 'string' || docId === '' || typeof api?.fileUrl !== 'function') return undefined
    let cancelled = false
    let handle = null
    setRegionPdfError(null)
    openPdfUrl(api.fileUrl(docId, 'original'), pdfAssetsFor(api))
      .then((opened) => {
        handle = opened
        if (cancelled) {
          opened.destroy?.()
          return
        }
        setRegionPdf(opened.pdf)
      })
      .catch((error) => {
        if (!cancelled) setRegionPdfError(String(error?.message ?? error))
      })
    return () => {
      cancelled = true
      try {
        handle?.destroy?.()
      } catch {
        /* ignore */
      }
      setRegionPdf(null)
    }
  }, [api, docId, hasRegions])

  React.useEffect(() => {
    const flat = pages.flatMap(page => page.blocks ?? [])
    const locator = reader.doc?.progress?.locator
    let at = flat.findIndex(block => block.id === locator || block.sourceIds?.includes(locator))
    if (at < 0) {
      const savedPage = Number(String(locator ?? '').match(/^p(\d+)/)?.[1])
      if (savedPage) at = flat.findIndex(block => Number(block.page) >= savedPage)
    }
    setVisibleBlocks(Math.max(INITIAL_BLOCKS, at >= 0 ? at + BLOCK_BATCH : INITIAL_BLOCKS))
  }, [docId])

  React.useEffect(()=>{
    const id=reader.reflowRequest?.blockId
    if(!id)return
    const flat=pages.flatMap(page=>page.blocks??[]),at=flat.findIndex(block=>block.id===id||block.sourceIds?.includes(id))
    if(at>=0)setVisibleBlocks(current=>Math.max(current,at+BLOCK_BATCH))
  },[reader.reflowRequest,pages])

  const view = React.useMemo(() => {
    const entries = []
    let budget = Math.max(0, visibleBlocks)
    let hasMore = false
    outer: for (const page of pages) {
      const blocks = Array.isArray(page.blocks) ? page.blocks : []
      if (blocks.length === 0) continue // scanned pages only appear in original mode
      entries.push({ type: 'page', key: `pdf-page-${page.n}`, page: Number(page.n) || entries.length + 1 })
      for (const block of blocks) {
        if (budget <= 0) {
          hasMore = true
          break outer
        }
        entries.push({ type: 'block', key: block?.id ?? `pdf-block-${entries.length}`, block, regionVariant: pdfRegionVariant(block) })
        budget--
      }
    }
    return { entries, hasMore }
  }, [pages, visibleBlocks])

  // ParagraphBlock registers itself, but re-register the mounted set here as the batch grows
  // so a block element is always known to the reader session (scroll / highlight geometry).
  React.useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof registerBlockEl !== 'function') return undefined
    const registered = []
    const nodes = root.querySelectorAll('[data-block-id]')
    for (const node of nodes) {
      const blockId = node.getAttribute('data-block-id')
      if (typeof blockId === 'string' && blockId !== '') {
        registerBlockEl(blockId, node)
        registered.push(blockId)
      }
    }
    return () => {
      for (const blockId of registered) registerBlockEl(blockId, null)
    }
  }, [view.entries, registerBlockEl])

  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || !view.hasMore || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver(
      (observed) => {
        for (const entry of observed) {
          if (!entry.isIntersecting) continue
          setVisibleBlocks((current) => (current >= totalBlocks ? current : current + BLOCK_BATCH))
          break
        }
      },
      { root: reader.scrollRoot ?? null, rootMargin: '1400px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [view.hasMore, totalBlocks, visibleBlocks, reader.scrollRoot])

  if (content === null || totalBlocks === 0) {
    const switchToOriginal = typeof reader.setMode === 'function' ? () => reader.setMode('original') : null
    return h(
      'div',
      { className: 'dr-pdf-status' },
      h(EmptyState, {
        icon: h(IconBook, { size: 26 }),
        title: t('reader.pdfNoText', 'No extractable text'),
        body: t('reader.pdfNoTextHint', 'This PDF looks like scanned images. Switch to the original view to read the pages.'),
        action: switchToOriginal !== null ? h(Button, { variant: 'primary', onClick: switchToOriginal }, t('reader.original', 'Original')) : undefined,
      }),
    )
  }

  return h(
    'div',
    { className: 'dr-reader-content dr-pdf-reflow', ref: rootRef },
    view.entries.map((entry) =>
      entry.type === 'page'
        ? h(
            'div',
            { key: entry.key, className: 'dr-pdf-page-sep', role: 'separator', 'aria-label': t('reader.page', undefined, { page: entry.page, total: totalPages }) },
            h('span', { className: 'dr-pdf-page-sep-label' }, t('reader.page', undefined, { page: entry.page, total: totalPages })),
            h(
              'button',
              {
                type: 'button',
                className: clsx('dr-pdf-sep-btn', figurePages.has(entry.page) && 'is-figure'),
                title: figurePages.has(entry.page)
                  ? `${t('reader.figurePageHint', 'This page contains a figure/table — open it in the original layout')} · ${t('reader.page', undefined, { page: entry.page, total: totalPages })}`
                  : `${t('reader.original', 'Original')} · ${t('reader.page', undefined, { page: entry.page, total: totalPages })}`,
                onClick: () => {
                  try {
                    reader.setMode?.('original')
                    reader.requestPage?.(entry.page)
                  } catch {
                    /* stale reader session */
                  }
                },
              },
              h(IconBook, { size: 11 }),
              ` ${entry.page}`,
            ),
          )
        : entry.regionVariant
          ? h(PdfRegion, {
              key: entry.key,
              pdf: regionPdf,
              docId,
              block: entry.block,
              variant: entry.regionVariant,
              number: entry.block.numberPlacedInImage ? undefined : entry.block.number,
              reader,
              t,
              failed: regionPdfError !== null,
            })
          : h(ParagraphBlock, { key: entry.key, block: entry.block }),
    ),
    view.hasMore
      ? h('div', { key: 'pdf-load-more', className: 'dr-pdf-loadmore', ref: sentinelRef }, h(Spinner, { size: 14 }), t('reader.loadingMore', 'Loading more text…'))
      : h('div', { key: 'pdf-end', className: 'dr-pdf-loadmore' }, '·'),
  )
}

/* ------------------------------------------------------------------ */
/* original mode                                                       */
/* ------------------------------------------------------------------ */

function PdfOriginal({ content, pageRequest, reader, t }) {
  const api = reader.api
  const doc = reader.doc
  const scrollRoot = reader.scrollRoot ?? null
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState({ status: 'loading', error: null, pdf: null, mod: null, pageCount: 0, baseWidth: 612, baseHeight: 792 })
  const [sizes, setSizes] = React.useState(() => reader.session?.pdfSizes ?? {})
  const [availableWidth, setAvailableWidth] = React.useState(0)
  const savedView = React.useRef(reader.session?.ui.originalView)
  const restoring = React.useRef(Boolean(savedView.current))
  const [zoomMode, setZoomMode] = React.useState(savedView.current?.zoomMode ?? 'fit')
  const [zoom, setZoom] = React.useState(savedView.current?.zoom ?? 1)
  const [currentPage, setCurrentPage] = React.useState(savedView.current?.page ?? 1)
  const rootRef = React.useRef(null)
  const pagesRef = React.useRef(new Map())
  const handleRef = React.useRef(null)

  const assets = React.useMemo(() => pdfAssetsFor(api), [api])

  // ----- open the document ----------------------------------------------------------
  const tRef = React.useRef(t)
  tRef.current = t
  React.useEffect(() => {
    const docId = doc?.id
    if (typeof docId !== 'string' || docId === '' || typeof api?.fileUrl !== 'function') {
      setState({ status: 'error', error: tRef.current('reader.pdfUnavailable', 'The PDF file is unavailable.'), pdf: null, mod: null, pageCount: 0, baseWidth: 612, baseHeight: 792 })
      return undefined
    }
    let cancelled = false
    setState({ status: 'loading', error: null, pdf: null, mod: null, pageCount: 0, baseWidth: 612, baseHeight: 792 })
    ;(async () => {
      let handle = null
      try {
        handle = await openPdfUrl(api.fileUrl(docId, 'original'), assets)
        const pdf = handle.pdf
        const firstPage = await pdf.getPage(1)
        const viewport = firstPage.getViewport({ scale: 1 })
        if (cancelled) {
          await handle.destroy()
          return
        }
        handleRef.current = handle
        setState({
          status: 'ready',
          error: null,
          pdf,
          mod: handle.mod,
          pageCount: Math.max(1, Number(pdf.numPages) || 1),
          baseWidth: Number(viewport?.width) || 612,
          baseHeight: Number(viewport?.height) || 792,
        })
      } catch (error) {
        if (handle !== null) {
          try {
            await handle.destroy()
          } catch {
            /* ignore */
          }
        }
        if (!cancelled) setState({ status: 'error', error: readErrorMessage(error), pdf: null, mod: null, pageCount: 0, baseWidth: 612, baseHeight: 792 })
      }
    })()
    return () => {
      cancelled = true
      const handle = handleRef.current
      handleRef.current = null
      if (handle !== null) {
        try {
          const pending = handle.destroy()
          if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => undefined)
        } catch {
          /* ignore */
        }
      }
    }
  }, [doc?.id, api, assets, attempt])

  // ----- measure the available width (fit width) -------------------------------------
  React.useEffect(() => {
    const element = rootRef.current
    if (element === null) return undefined
    const measure = () => setAvailableWidth(Math.max(0, Math.round(element.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    return undefined
  }, [state.status])

  const baseWidth = Math.max(1, Number(state.baseWidth) || 612)
  const baseHeight = Math.max(1, Number(state.baseHeight) || 792)
  const fitScale = availableWidth > 0 ? Math.max(MIN_ZOOM, (availableWidth - PAGE_GUTTER * 2) / baseWidth) : 1
  const scale = zoomMode === 'fit' ? fitScale : zoom

  const zoomBy = React.useCallback(
    (factor) => {
      const current = zoomMode === 'fit' ? fitScale : zoom
      setZoomMode('manual')
      setZoom(clamp(current * factor, MIN_ZOOM, MAX_ZOOM))
    },
    [zoomMode, fitScale, zoom],
  )
  const fitWidth = React.useCallback(() => {
    setZoomMode('fit')
    setZoom(fitScale)
  }, [fitScale])

  const onSize = React.useCallback((pageNumber, width, height) => {
    if (!(width > 0) || !(height > 0)) return
    setSizes((current) => {
      const existing = current[pageNumber]
      if (existing !== undefined && Math.abs(existing.width - width) < 0.5 && Math.abs(existing.height - height) < 0.5) return current
      const next = { ...current, [pageNumber]: { width, height } }
      return next
    })
  }, [])

  React.useLayoutEffect(() => {
    if (reader.session) reader.session.pdfSizes = sizes
  }, [reader.session, sizes])

  const setPageRef = React.useCallback((pageNumber, element) => {
    if (element === null || element === undefined) pagesRef.current.delete(pageNumber)
    else pagesRef.current.set(pageNumber, element)
  }, [])

  // ----- annotations of this document, grouped by page -------------------------------
  const annotationsByPage = React.useMemo(() => {
    const grouped = new Map()
    const list = Array.isArray(reader.annotations) ? reader.annotations : []
    for (const annotation of list) {
      const target = annotation?.target
      if (target === null || typeof target !== 'object' || target.kind !== 'pdf') continue
      const page = Number(target.page)
      if (!Number.isFinite(page) || page < 1) continue
      const bucket = grouped.get(page)
      if (bucket === undefined) grouped.set(page, [annotation])
      else bucket.push(annotation)
    }
    return grouped
  }, [reader.annotations])

  const focusAnn = reader.focusAnn
  const activeAnnId = reader.activeAnnId
  const onSelect = reader.onSelect

  // Restore against page geometry after pdf.js creates the page placeholders.
  React.useLayoutEffect(() => {
    if (!restoring.current || state.status !== 'ready' || !scrollRoot || availableWidth <= 0) return
    const saved = savedView.current
    const element = pagesRef.current.get(saved.page)
    if (element && !pageRequest?.page) {
      const rect = element.getBoundingClientRect()
      const top = scrollRoot.scrollTop + rect.top - scrollRoot.getBoundingClientRect().top + saved.offset * rect.height
      scrollRoot.scrollTo({ top, behavior: 'instant' })
    }
    restoring.current = false
  }, [availableWidth, pageRequest?.page, scrollRoot, state.status])

  // ----- current page tracking -------------------------------------------------------
  const currentOriginalView = React.useCallback(() => {
    if (!scrollRoot || state.status !== 'ready' || restoring.current) return null
    const rootTop = scrollRoot.getBoundingClientRect().top
    const threshold = rootTop + Math.max(80, scrollRoot.clientHeight * 0.35)
    let page = 1
    for (const [number, element] of pagesRef.current) {
      if (number > page && element.getBoundingClientRect().top <= threshold) page = number
    }
    const rect = pagesRef.current.get(page)?.getBoundingClientRect()
    return rect?.height > 0 ? { page, offset: (rootTop - rect.top) / rect.height, zoomMode, zoom } : null
  }, [scrollRoot, state.status, zoomMode, zoom])
  const saveOriginalOnExit = React.useRef(null)
  saveOriginalOnExit.current = () => {
    const view = currentOriginalView()
    if (reader.session && view) reader.session.ui.originalView = view
  }
  React.useLayoutEffect(() => () => saveOriginalOnExit.current?.(), [])

  React.useEffect(() => {
    const root = scrollRoot
    if (state.status !== 'ready' || root === null || root === undefined || typeof root.addEventListener !== 'function') return undefined
    let frame = 0
    const update = () => {
      frame = 0
      const view = currentOriginalView()
      if (!view) return
      setCurrentPage(view.page)
      if (reader.session) reader.session.ui.originalView = view
    }
    const schedule = () => {
      if (frame !== 0) return
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(update)
      else update()
    }
    root.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      root.removeEventListener('scroll', schedule)
      if (frame !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
    }
  }, [state.status, scrollRoot, scale, reader.session, currentOriginalView])

  // ----- jump to a requested page (TOC / annotation focus) ---------------------------
  const requestedPage = Number(pageRequest?.page)
  const requestedNonce = pageRequest?.nonce
  React.useEffect(() => {
    if (state.status !== 'ready' || !Number.isFinite(requestedPage) || requestedPage < 1) return undefined
    const run = () => {
      const root = scrollRoot
      const element = pagesRef.current.get(requestedPage)
      if (root === null || root === undefined || element === null || element === undefined) return
      try {
        const rootRect = root.getBoundingClientRect()
        const elementRect = element.getBoundingClientRect()
        const top = root.scrollTop + (elementRect.top - rootRect.top) - 8
        root.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
        setCurrentPage(requestedPage)
      } catch {
        /* ignore */
      }
    }
    const timer = window.setTimeout(run, 60)
    return () => window.clearTimeout(timer)
  }, [state.status, requestedNonce, requestedPage, scrollRoot, scale])

  if (state.status === 'loading') {
    return h('div', { className: 'dr-pdf-status' }, h(Spinner, { size: 20 }), h('div', { className: 'dr-pdf-status-text' }, t('reader.loading', 'Opening document…')))
  }
  if (state.status === 'error') {
    return h(
      'div',
      { className: 'dr-pdf-status' },
      h('div', { className: 'dr-pdf-status-text' }, t('reader.pdfLoadFailed', 'Could not open this PDF.')),
      h('div', { className: 'dr-pdf-status-error' }, state.error ?? ''),
      h(Button, { variant: 'primary', icon: h(IconRefresh, { size: 14 }), onClick: () => setAttempt((current) => current + 1) }, t('common.retry', 'Retry')),
    )
  }

  const pageNumbers = []
  for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber++) pageNumbers.push(pageNumber)

  return h(
    'div',
    { className: 'dr-pdf-original', ref: rootRef },
    h(
      'div',
      { className: 'dr-pdf-toolbar', role: 'toolbar', 'aria-label': t('reader.original', 'Original') },
      h(Button, { size: 'sm', variant: 'ghost', onClick: () => zoomBy(1 / 1.15), title: t('reader.zoomOut', 'Zoom out'), 'aria-label': t('reader.zoomOut', 'Zoom out') }, '−'),
      h('span', { className: 'dr-pdf-zoom-value' }, `${Math.round(scale * 100)}%`),
      h(Button, { size: 'sm', variant: 'ghost', onClick: () => zoomBy(1.15), title: t('reader.zoomIn', 'Zoom in'), 'aria-label': t('reader.zoomIn', 'Zoom in') }, '+'),
      h(Button, { size: 'sm', variant: zoomMode === 'fit' ? 'default' : 'ghost', onClick: fitWidth, title: t('reader.fitWidth', 'Fit width') }, t('reader.fitWidth', 'Fit width')),
      h('span', { className: 'dr-pdf-toolbar-sep', 'aria-hidden': true }),
      h('span', { className: 'dr-pdf-page-counter' }, t('reader.page', undefined, { page: currentPage, total: state.pageCount })),
    ),
    h(
      'div',
      { className: 'dr-pdf-pages' },
      pageNumbers.map((pageNumber) => {
        const size = sizes[pageNumber] ?? { width: baseWidth, height: baseHeight }
        return h(PdfPage, {
          key: pageNumber,
          pdf: state.pdf,
          mod: state.mod,
          pageNumber,
          totalPages: state.pageCount,
          scale,
          size,
          pageAnnotations: annotationsByPage.get(pageNumber) ?? EMPTY_LIST,
          activeAnnId,
          focusAnn,
          onSelect,
          onSize,
          onPageRef: setPageRef,
          scrollRoot,
          t,
        })
      }),
    ),
  )
}

const EMPTY_LIST = []

/* ------------------------------------------------------------------ */
/* one original page                                                   */
/* ------------------------------------------------------------------ */

function PdfPage({ pdf, mod, pageNumber, totalPages, scale, size, pageAnnotations, activeAnnId, focusAnn, onSelect, onSize, onPageRef, scrollRoot, t }) {
  const wrapRef = React.useRef(null)
  const canvasHostRef = React.useRef(null)
  const textHostRef = React.useRef(null)
  const textLayerRef = React.useRef(null)
  const [inRange, setInRange] = React.useState(false)
  const [status, setStatus] = React.useState('idle')
  const [error, setError] = React.useState(null)
  const [reload, setReload] = React.useState(0)
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))

  // Attach the wrapper element so the parent can track / scroll to this page.
  const setWrapRef = React.useCallback(
    (element) => {
      wrapRef.current = element
      onPageRef?.(pageNumber, element)
    },
    [onPageRef, pageNumber],
  )
  React.useEffect(
    () => () => {
      onPageRef?.(pageNumber, null)
    },
    [onPageRef, pageNumber],
  )

  // Virtualize: only pages within ~1.5 page heights of the viewport are rendered.
  React.useEffect(() => {
    const element = wrapRef.current
    if (element === null) return undefined
    if (typeof IntersectionObserver !== 'function') {
      setInRange(true)
      return undefined
    }
    const margin = Math.round(clamp(height * 1.5, 600, 2800))
    const observer = new IntersectionObserver(
      (entries) => {
        let next = false
        for (const entry of entries) if (entry.isIntersecting) next = true
        setInRange(next)
      },
      { root: scrollRoot ?? null, rootMargin: `${margin}px 0px ${margin}px 0px`, threshold: 0 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRoot, height])

  // Render the canvas + optional selectable text layer while in range.
  React.useEffect(() => {
    if (!inRange || pdf === null || pdf === undefined) return undefined
    const canvasHost = canvasHostRef.current
    if (canvasHost === null) return undefined
    const textHost = textHostRef.current
    const controller = new AbortController()
    let cancelled = false
    let renderTimer = null
    setStatus((current) => (current === 'ready' ? current : 'loading'))
    if (textHost !== null) textHost.replaceChildren()
    ;(async () => {
      try {
        const renderPromise = renderPdfPage(pdf, pageNumber, {
          scale,
          dpr: Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)),
          signal: controller.signal,
        })
        // A wedged GPU/pdf.js render task must not leave the page spinning forever.
        const timeout = new Promise((_, reject) => {
          renderTimer = setTimeout(() => reject(new Error(t('reader.pdfRenderTimeout', 'PDF rendering timed out. Retry the page; if it keeps happening, restart the app.'))), 9000)
        })
        const rendered = await Promise.race([renderPromise, timeout])
        if (cancelled) return
        canvasHost.replaceChildren(rendered.canvas)
        setStatus('ready')
        setError(null)
        // Report the unscaled page box so the parent can size the placeholder at any zoom.
        const viewportScale = Number(rendered.viewport?.scale) || scale
        onSize?.(pageNumber, rendered.viewport.width / viewportScale, rendered.viewport.height / viewportScale)
        const TextLayerCtor = mod?.TextLayer
        if (textHost !== null && typeof TextLayerCtor === 'function') {
          try {
            const textContent = await rendered.page.getTextContent({ disableNormalization: false, includeMarkedContent: false })
            if (cancelled) return
            const layer = new TextLayerCtor({ textContentSource: textContent, container: textHost, viewport: rendered.viewport })
            textLayerRef.current = layer
            await layer.render()
          } catch {
            /* selectable text is a progressive enhancement */
          }
        }
        try {
          rendered.page.cleanup()
        } catch {
          /* ignore */
        }
      } catch (renderError) {
        if (cancelled || controller.signal.aborted || renderError?.name === 'AbortError' || renderError?.name === 'RenderingCancelledException') return
        setStatus('error')
        setError(readErrorMessage(renderError))
      } finally {
        if (renderTimer !== null) clearTimeout(renderTimer)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      try {
        textLayerRef.current?.cancel?.()
      } catch {
        /* ignore */
      }
      textLayerRef.current = null
    }
  }, [inRange, pdf, pageNumber, scale, mod, reload, onSize])

  // Drop canvases well outside the viewport to keep memory bounded.
  React.useEffect(() => {
    if (inRange) return
    if (canvasHostRef.current !== null) canvasHostRef.current.replaceChildren()
    if (textHostRef.current !== null) textHostRef.current.replaceChildren()
    setStatus('idle')
    setError(null)
  }, [inRange])

  // ----- selection -> reader session ------------------------------------------------
  const captureSelection = React.useCallback(() => {
    const element = wrapRef.current
    if (element === null || typeof window === 'undefined') return
    let selection = null
    try {
      selection = window.getSelection()
    } catch {
      selection = null
    }
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (!element.contains(range.commonAncestorContainer)) return
    const text = String(selection.toString() || '').replace(/\s+/g, ' ').trim()
    if (text === '') return
    const box = element.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return
    const rects = []
    let bounds = null
    let clientRects = []
    try {
      clientRects = Array.from(range.getClientRects())
    } catch {
      clientRects = []
    }
    for (const rect of clientRects) {
      const w = Number(rect.width) || 0
      const h = Number(rect.height) || 0
      if (w < 0.5 || h < 0.5) continue
      const x = clamp((rect.left - box.left) / box.width, 0, 1)
      const y = clamp((rect.top - box.top) / box.height, 0, 1)
      const cw = clamp(w / box.width, 0, 1 - x)
      const ch = clamp(h / box.height, 0, 1 - y)
      if (!(cw > 0.0005) || !(ch > 0.0005)) continue
      rects.push({ x: round3(x), y: round3(y), w: round3(cw), h: round3(ch) })
      bounds = bounds === null ? { left: rect.left, top: rect.top, right: rect.left + w, bottom: rect.top + h } : { left: Math.min(bounds.left, rect.left), top: Math.min(bounds.top, rect.top), right: Math.max(bounds.right, rect.left + w), bottom: Math.max(bounds.bottom, rect.top + h) }
    }
    if (rects.length === 0) return
    onSelect?.({
      text,
      page: pageNumber,
      rects,
      kind: 'pdf',
      // Viewport-space bounds used by the floating selection toolbar.
      rect: bounds === null ? null : { left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
    })
  }, [onSelect, pageNumber])

  // ----- click on an existing pdf annotation ----------------------------------------
  const handleClick = React.useCallback(
    (event) => {
      if (pageAnnotations.length === 0) return
      const element = wrapRef.current
      if (element === null) return
      const box = element.getBoundingClientRect()
      if (!(box.width > 0) || !(box.height > 0)) return
      const x = (event.clientX - box.left) / box.width
      const y = (event.clientY - box.top) / box.height
      if (x < 0 || y < 0 || x > 1 || y > 1) return
      for (const annotation of pageAnnotations) {
        const targetRects = Array.isArray(annotation?.target?.rects) ? annotation.target.rects : []
        for (const rect of targetRects) {
          if (x >= Number(rect.x) && x <= Number(rect.x) + Number(rect.w) && y >= Number(rect.y) && y <= Number(rect.y) + Number(rect.h)) {
            focusAnn?.(annotation.id)
            return
          }
        }
      }
    },
    [focusAnn, pageAnnotations],
  )

  return h(
    'div',
    {
      className: clsx('dr-pdf-page', status === 'ready' ? 'is-ready' : 'is-idle'),
      'data-page': pageNumber,
      ref: setWrapRef,
      style: { width: `${width}px`, height: `${height}px` },
      onMouseUp: captureSelection,
      onClick: handleClick,
    },
    h('div', { className: 'dr-pdf-canvas-host', ref: canvasHostRef }),
    h('div', { className: 'dr-pdf-text-layer', ref: textHostRef, style: { '--scale-factor': String(scale) }, 'aria-hidden': true }),
    pageAnnotations.length > 0
      ? h(
          'div',
          { className: 'dr-pdf-ann-layer' },
          pageAnnotations.flatMap((annotation) => {
            const rects = Array.isArray(annotation?.target?.rects) ? annotation.target.rects : []
            return rects.map((rect, index) =>
              h('div', {
                key: `${annotation.id ?? 'ann'}-${index}`,
                className: clsx('dr-highlight-rect', activeAnnId === annotation.id && 'is-active'),
                'data-color': annotation.color ?? 'yellow',
                'data-style': annotation.style === 'underline' ? 'underline' : 'highlight',
                'data-ann-id': annotation.id,
                role: 'button',
                tabIndex: -1,
                title: typeof annotation.note === 'string' && annotation.note !== '' ? annotation.note : (annotation.text ?? ''),
                style: {
                  left: `${clamp(Number(rect.x) || 0, 0, 1) * 100}%`,
                  top: `${clamp(Number(rect.y) || 0, 0, 1) * 100}%`,
                  width: `${clamp(Number(rect.w) || 0, 0, 1) * 100}%`,
                  height: `${clamp(Number(rect.h) || 0, 0, 1) * 100}%`,
                },
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  focusAnn?.(annotation.id)
                },
              }),
            )
          }),
        )
      : null,
    status === 'loading' ? h('div', { className: 'dr-pdf-page-status' }, h(Spinner, { size: 16 }), h('span', null, t('reader.page', undefined, { page: pageNumber, total: totalPages }))) : null,
    status === 'error'
      ? h(
          'div',
          { className: 'dr-pdf-page-status is-error' },
          h('span', null, t('reader.pdfPageFailed', 'Could not render this page.')),
          error !== null ? h('span', null, error) : null,
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefresh, { size: 13 }), onClick: () => setReload((current) => current + 1) }, t('common.retry', 'Retry')),
        )
      : null,
  )
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Round normalized coordinates to 3 decimals (enough for 0..1 page boxes). */
function round3(value) {
  const number = Number(value) || 0
  return Math.round(number * 1000) / 1000
}

/** Human readable error text; never throws. */
function readErrorMessage(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message !== '') return error.message
  try {
    return String(error)
  } catch {
    return ''
  }
}

/** Inline error boundary: a rendering bug shows a Retry instead of unmounting the reader. */
class PdfErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.retry = this.retry.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error: error ?? new Error('render failed') }
  }

  componentDidCatch(error) {
    try {
      this.props?.onError?.(error)
    } catch {
      /* diagnostics must not break the fallback */
    }
  }

  retry() {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error !== null) {
      const t = typeof this.props?.t === 'function' ? this.props.t : (key, fallback) => (typeof fallback === 'string' ? fallback : key)
      return h(
        'div',
        { className: 'dr-pdf-status' },
        h('div', { className: 'dr-pdf-status-text' }, t('reader.pdfRenderFailed', 'PDF view failed to render.')),
        h('div', { className: 'dr-pdf-status-error' }, readErrorMessage(this.state.error)),
        h(Button, { variant: 'primary', icon: h(IconRefresh, { size: 14 }), onClick: this.retry }, t('common.retry', 'Retry')),
      )
    }
    return this.props.children
  }
}
