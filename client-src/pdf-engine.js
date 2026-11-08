// PDF engine: loads the bundled pdf.js legacy ESM build, extracts reflow text, renders
// canvases for the original-layout view.
//
// The pdf.js module is loaded at runtime from a URL (served by the host half under
// /dsh-reader-assets/pdf/) so the plugin bundle stays small and pdf.js can be upgraded
// without rebuilding this file. `new Function('u', 'return import(u)')` is intentional:
// a literal dynamic import would be rewritten by esbuild into its own interop wrapper,
// but the generated function body is opaque to the bundler and keeps a native import().
import {
  groupTextItems,
  mergeLinesToParagraphs,
  detectRepeatedMargins,
  stripRepeatedMargins,
  dropArtifactLines,
  classifyBlock,
  looksLikeDisplayEquation,
  findBlockIdForPage,
  median,
} from './reflow.js'
import { pdfBookmarkTarget } from './toc.js'
import { viewportTextItems, unionRects } from './pdf-geometry.js'

/** Hard extraction limits (see PdfContent meta in DESIGN.md). */
export const DEFAULT_PDF_LIMITS = { maxPages: 800, maxChars: 12_000_000 }

/**
 * Bump whenever extraction/heading heuristics change. Documents stored with an older engine
 * version are re-extracted automatically on next open (no AI tokens involved; translation cache
 * stays valid because it is keyed by source text hash).
 */
export const PDF_ENGINE_VERSION = 43

/** Thumbnail target size: ~360 CSS px wide, never taller than 320 px. */
const THUMB_WIDTH = 360
const THUMB_MAX_HEIGHT = 320

/* ------------------------------------------------------------------ */
/* pdf.js loading                                                     */
/* ------------------------------------------------------------------ */

// Native dynamic import kept outside the bundler's reach.
const dynamicImport = new Function('u', 'return import(u)') // eslint-disable-line no-new-func

/** moduleUrl -> Promise<pdfjs namespace>, so two viewers never load the build twice. */
const pdfjsCache = new Map()
const workerBlobCache = new Map()

/**
 * Serve the pdf.js worker from a same-origin blob URL.
 *
 * The Harness page lives on `dsh-app://app`, so `new Worker('http://127.0.0.1/...')` is blocked as a
 * cross-origin worker and pdf.js silently falls back to its fake (main-thread) worker, whose render
 * tasks can stall after a few pages in this desktop renderer. Fetching the worker source and wrapping
 * it in a Blob makes the worker same-origin and keeps real worker rendering available.
 */
async function blobWorkerUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '' || typeof fetch !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return rawUrl
  const cached = workerBlobCache.get(rawUrl)
  if (cached !== undefined) return cached
  try {
    const response = await fetch(rawUrl, { credentials: 'same-origin' })
    if (!response.ok) return rawUrl
    const code = await response.text()
    if (code.trim() === '') return rawUrl
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    workerBlobCache.set(rawUrl, blobUrl)
    return blobUrl
  } catch {
    return rawUrl
  }
}

const workerApplied = new WeakMap()

async function applyWorkerUrl(mod, assets) {
  const rawUrl = typeof assets?.workerUrl === 'string' ? assets.workerUrl : ''
  if (!mod?.GlobalWorkerOptions || rawUrl === '') return
  if (workerApplied.get(mod) === rawUrl) return
  mod.GlobalWorkerOptions.workerSrc = await blobWorkerUrl(rawUrl)
  workerApplied.set(mod, rawUrl)
}

/**
 * Load (and memoise) the pdf.js build.
 *
 * @param {{ moduleUrl:string, workerUrl:string, cMapUrl?:string, standardFontDataUrl?:string }} assets
 * @returns {Promise<any>} the pdf.js module namespace (`getDocument`, `GlobalWorkerOptions`, `TextLayer`, ...)
 */
export async function loadPdfjs(assets = {}) {
  const moduleUrl = typeof assets?.moduleUrl === 'string' ? assets.moduleUrl : typeof assets?.url === 'string' ? assets.url : ''
  if (moduleUrl === '') throw new Error('pdf.js is not configured: assets.moduleUrl is missing')
  let entry = pdfjsCache.get(moduleUrl)
  if (entry === undefined) {
    entry = (async () => {
      const namespace = await dynamicImport(moduleUrl)
      const mod = normalizePdfjsModule(namespace)
      await applyWorkerUrl(mod, assets)
      return mod
    })()
    entry.catch(() => {
      if (pdfjsCache.get(moduleUrl) === entry) pdfjsCache.delete(moduleUrl)
    })
    pdfjsCache.set(moduleUrl, entry)
  }
  const mod = await entry
  // Keep the worker in sync when the caller passes a different URL after the first load.
  await applyWorkerUrl(mod, assets)
  return mod
}

/** Accept both a module namespace and a `{ default: namespace }` interop object. */
function normalizePdfjsModule(namespace) {
  if (namespace !== null && typeof namespace === 'object' && typeof namespace.getDocument === 'function') return namespace
  if (namespace !== null && typeof namespace === 'object' && typeof namespace.default?.getDocument === 'function') return namespace.default
  throw new Error('pdf.js module did not expose getDocument()')
}

/** getDocument() options shared by every consumer. */
function sourceOptions(assets) {
  const options = {
    cMapPacked: true,
    useSystemFonts: true,
    disableFontFace: false,
    isEvalSupported: true,
  }
  if (typeof assets?.cMapUrl === 'string' && assets.cMapUrl !== '') options.cMapUrl = assets.cMapUrl
  if (typeof assets?.standardFontDataUrl === 'string' && assets.standardFontDataUrl !== '') options.standardFontDataUrl = assets.standardFontDataUrl
  return options
}

/** Copy bytes: pdf.js may transfer the underlying buffer to its worker. */
function toBytes(arrayBuffer) {
  if (arrayBuffer === null || arrayBuffer === undefined) throw new Error('importPdf: missing PDF data')
  if (typeof arrayBuffer.byteLength !== 'number') throw new Error('importPdf: expected an ArrayBuffer or Uint8Array')
  if (arrayBuffer instanceof Uint8Array) return new Uint8Array(arrayBuffer.slice())
  if (typeof arrayBuffer.slice === 'function') return new Uint8Array(arrayBuffer.slice(0))
  return new Uint8Array(arrayBuffer)
}

/** Destroy a document proxy and its loading task, swallowing teardown errors. */
async function destroyDocument(pdf, loadingTask) {
  try {
    if (pdf !== null && pdf !== undefined && typeof pdf.destroy === 'function') await pdf.destroy()
  } catch {
    /* already destroyed */
  }
  try {
    if (loadingTask !== null && loadingTask !== undefined && typeof loadingTask.destroy === 'function') {
      const pending = loadingTask.destroy()
      if (pending !== null && typeof pending?.then === 'function') await pending
    }
  } catch {
    /* already destroyed */
  }
}

/**
 * Open a PDF from an URL (same-origin, cookie-authenticated) and resolve the document.
 *
 * Returns a handle: `{ pdf, mod, destroy() }`. Callers must call `destroy()` when done.
 *
 * @param {string} url
 * @param {{ moduleUrl:string, workerUrl:string, cMapUrl?:string, standardFontDataUrl?:string }} assets
 */
export async function openPdfUrl(url, assets = {}) {
  const mod = await loadPdfjs(assets)
  let response
  try {
    response = await fetch(url, { credentials: 'same-origin' })
  } catch (error) {
    throw new Error(`PDF request failed: ${error?.message ?? error}`)
  }
  if (!response.ok) throw new Error(`PDF request failed (HTTP ${response.status})`)
  // Freshly fetched buffer: safe to hand to pdf.js (it may transfer it to the worker).
  const data = new Uint8Array(await response.arrayBuffer())
  const loadingTask = mod.getDocument({ data, ...sourceOptions(assets) })
  let pdf = null
  try {
    pdf = await loadingTask.promise
  } catch (error) {
    await destroyDocument(null, loadingTask)
    throw error
  }
  let destroyed = false
  return {
    pdf,
    mod,
    loadingTask,
    async destroy() {
      if (destroyed) return
      destroyed = true
      await destroyDocument(pdf, loadingTask)
    },
  }
}

/* ------------------------------------------------------------------ */
/* page rendering                                                     */
/* ------------------------------------------------------------------ */

function createCanvas(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') throw new Error('PDF rendering requires a browser canvas')
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  return canvas
}

/**
 * Render a page into a hi-DPI canvas.
 *
 * @param {any} pdf PDFDocumentProxy (or anything with `getPage`)
 * @param {number} pageNumber 1-based page number
 * @param {{ scale?:number, dpr?:number, signal?:AbortSignal, background?:string }} [opts]
 * @returns {Promise<{ canvas:HTMLCanvasElement, viewport:any, page:any, renderTask:any }>}
 */
export async function renderPdfPage(pdf, pageNumber, opts = {}) {
  if (pdf === null || pdf === undefined || typeof pdf.getPage !== 'function') throw new Error('renderPdfPage: invalid PDF document')
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1
  const dpr = Number(opts.dpr) > 0 ? Number(opts.dpr) : 1
  if (opts.signal?.aborted) throw abortError()
  const page = await pdf.getPage(pageNumber)
  if (opts.signal?.aborted) throw abortError()
  return renderPageObject(page, { ...opts, scale, dpr })
}

/** Render an already resolved PDFPageProxy (internal, reused by the thumbnail). */
async function renderPageObject(page, opts = {}) {
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1
  const dpr = Number(opts.dpr) > 0 ? Number(opts.dpr) : 1
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(viewport.width * dpr, viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  // willReadFrequently keeps the canvas on a CPU-backed surface; on this desktop renderer the
  // hardware-backed surface occasionally stops completing pdf.js render tasks after a few pages.
  const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: false, willReadFrequently: true }) : null
  if (context === null) throw new Error('PDF rendering requires a 2D canvas context')
  const renderTask = page.render({
    canvasContext: context,
    viewport,
    background: typeof opts.background === 'string' ? opts.background : '#ffffff',
    ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : null),
  })
  let aborted = false
  const onAbort = () => {
    aborted = true
    try {
      renderTask.cancel()
    } catch {
      /* already settled */
    }
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    await renderTask.promise
  } catch (error) {
    if (aborted || error?.name === 'RenderingCancelledException' || error?.name === 'AbortError') throw abortError()
    throw error
  } finally {
    opts.signal?.removeEventListener?.('abort', onAbort)
  }
  if (aborted) throw abortError()
  return { canvas, viewport, page, renderTask }
}

/** Abort error helper (never a DOMException dependency). */
function abortError() {
  const error = new Error('PDF page rendering was cancelled')
  error.name = 'AbortError'
  return error
}

/* ------------------------------------------------------------------ */
/* reflow extraction                                                  */
/* ------------------------------------------------------------------ */

function readMetaString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 400)
  }
  return ''
}

/** Best-effort document title/author from info dictionary + XMP metadata. */
async function readDocumentMeta(pdf) {
  let info = null
  let metadata = null
  try {
    const result = await pdf.getMetadata()
    info = result?.info ?? null
    metadata = result?.metadata ?? null
  } catch {
    /* metadata is optional */
  }
  let xmpTitle = ''
  try {
    xmpTitle = String(metadata?.get?.('dc:title') ?? '')
  } catch {
    xmpTitle = ''
  }
  return {
    title: readMetaString([info?.Title, info?.title, xmpTitle]),
    author: readMetaString([info?.Author, info?.author]),
  }
}

/** Resolve an outline destination (name or explicit dest array) to a 1-based page number. */
async function resolveDestPage(pdf, dest) {
  let target = dest
  if (typeof target === 'string' && target !== '') {
    try {
      target = await pdf.getDestination(target)
    } catch {
      return null
    }
  }
  if (!Array.isArray(target) || target.length === 0) return null
  const reference = target[0]
  if (typeof reference === 'number' && Number.isInteger(reference) && reference >= 0) return reference + 1
  if (reference !== null && typeof reference === 'object') {
    try {
      const index = await pdf.getPageIndex(reference)
      return Number.isInteger(index) && index >= 0 ? index + 1 : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Build the PdfContent toc from the PDF outline.
 * Every item maps to a block id (nearest text block when the destination page is empty).
 */
async function buildToc(pdf, pages) {
  let outline = null
  try {
    outline = await pdf.getOutline()
  } catch {
    outline = null
  }
  if (!Array.isArray(outline) || outline.length === 0) return []
  const items = []
  const walk = async (entries, level) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (items.length >= 500) return
      if (entry === null || typeof entry !== 'object') continue
      const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 300) : ''
      if (title !== '') {
        const page = await resolveDestPage(pdf, entry.dest)
        const blockId = page === null ? null : pdfBookmarkTarget({ title, page }, pages)
        const tocItem = { id: `pdf-toc-${items.length}`, title, level: Math.min(6, Math.max(1, Number(level) || 1)) }
        if (blockId !== null) tocItem.blockId = blockId
        if (page !== null) tocItem.page = page
        items.push(tocItem)
      }
      if (Array.isArray(entry.items) && entry.items.length > 0 && level < 6) await walk(entry.items, level + 1)
    }
  }
  await walk(outline, 1)
  return items
}

/** Render page 1 to a small JPEG data URL for the library cover. */
async function renderThumbnail(pdf) {
  let timer = null
  let page = null
  try {
    page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    if (!(base.width > 0) || !(base.height > 0)) return null
    let scale = THUMB_WIDTH / base.width
    if (base.height * scale > THUMB_MAX_HEIGHT) scale = THUMB_MAX_HEIGHT / base.height
    // A stalled pdf.js render task must never block opening or importing a document.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('thumbnail render timeout')), 2500)
    })
    const rendered = await Promise.race([renderPageObject(page, { scale, dpr: 1 }), timeout])
    const dataUrl = rendered.canvas.toDataURL('image/jpeg', 0.82)
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
    try {
      page?.cleanup?.()
    } catch {
      /* ignore */
    }
  }
}

/** Footnote/caption heuristics layered on top of classifyBlock (basic, conservative). */
function refineKind(classification, paragraph, context) {
  if (classification.kind !== 'paragraph') return classification
  const text = classification.text
  if (text.length <= 160 && /^(?:fig(?:ure)?|table|chart|图|表)\s*[\d一二三四五六七八九十]/.test(text)) {
    return { kind: 'caption', level: undefined, text }
  }
  const pageMedian = context.pageMedianFontSize
  const isSmall = paragraph.fontSize > 0 && pageMedian > 0 && paragraph.fontSize < pageMedian * 0.84
  const lowOnPage = paragraph.y > 0 && context.pageHeight > 0 && paragraph.y < context.pageHeight * 0.22
  if (isSmall && lowOnPage && text.length <= 600) return { kind: 'footnote', level: undefined, text }
  if (isSmall && /^[*\u2020\u2021\d]{1,3}\s/.test(text) && context.isLastParagraph) return { kind: 'footnote', level: undefined, text }
  return classification
}

/** Figure/formula region detection constraints (regions are rendered lazily by the viewer). */
const FIGURE_GAP_FONT_MULTIPLE = 2.4
const FIGURE_MAX_PER_PAGE = 2
const FORMULA_MAX_PER_PAGE = 8
const REGION_MIN_WIDTH = 0.16
const REGION_MIN_HEIGHT = 0.012

/** Vertical text gaps on one page that can host a figure/table. */
function findFigureBands(lines, pageHeight, medianFontSize) {
  const list = Array.isArray(lines) ? lines : []
  if (list.length < 3) return []
  const sorted = [...list].sort((a, b) => (Number(b.y) || 0) - (Number(a.y) || 0))
  const font = medianFontSize > 0 ? medianFontSize : 12
  const bands = []
  for (let index = 1; index < sorted.length; index++) {
    const upper = sorted[index - 1]
    const lower = sorted[index]
    const upperBottom = (Number(upper.y) || 0) - (Number(upper.height) || font) * 0.25
    const lowerTop = (Number(lower.y) || 0) + (Number(lower.height) || font) * 0.55
    const height = upperBottom - lowerTop
    if (height < Math.max(font * FIGURE_GAP_FONT_MULTIPLE, 46)) continue
    if (height > pageHeight * 0.82) continue
    const center = (upperBottom + lowerTop) / 2
    if (center < pageHeight * 0.06 || center > pageHeight * 0.94) continue
    bands.push({ top: upperBottom, bottom: lowerTop, height })
    if (bands.length >= FIGURE_MAX_PER_PAGE) break
  }
  return bands
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

/** Normalize a PDF-space rectangle (y up) into 0..1 page coordinates (y down) for lazy rendering. */
function normalizeRegion(x0, x1, top, bottom, pageWidth, pageHeight) {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null
  const width = clamp01((x1 - x0) / pageWidth)
  const height = clamp01((top - bottom) / pageHeight)
  if (width < REGION_MIN_WIDTH || height < REGION_MIN_HEIGHT) return null
  return {
    x: clamp01(x0 / pageWidth),
    y: clamp01((pageHeight - top) / pageHeight),
    w: width,
    h: height,
  }
}

/** Build figure region descriptors from the text gaps of one page. */
function figureRegionsForPage({ pageLines, pageWidth, pageHeight, medianFontSize }) {
  const bands = findFigureBands(pageLines, pageHeight, medianFontSize)
  if (bands.length === 0) return []
  const left = Math.max(0, Math.min(...pageLines.map((line) => Number(line.x) || pageWidth * 0.08)) - 8)
  const right = Math.min(pageWidth, Math.max(...pageLines.map((line) => (Number(line.x) || 0) + (Number(line.width) || 0)), pageWidth * 0.92) + 8)
  const regions = []
  for (const band of bands) {
    const rect = normalizeRegion(left, right, band.top + 4, band.bottom - 4, pageWidth, pageHeight)
    if (rect !== null) regions.push({ rect, y: band.top })
  }
  return regions
}

/** Build a display-equation region descriptor from one paragraph's line geometry. */
function formulaRegionForParagraph(paragraph, pageWidth, pageHeight) {
  const lines = Array.isArray(paragraph?.lines) ? paragraph.lines.filter((line) => line !== null && typeof line === 'object') : []
  if (lines.length === 0) return null
  const x0 = Math.min(...lines.map((line) => Number(line.x) || 0)) - 4
  const x1 = Math.max(...lines.map((line) => (Number(line.x) || 0) + (Number(line.width) || 0))) + 4
  const top = Math.max(...lines.map((line) => (Number(line.y) || 0) + (Number(line.height) || Number(line.fontSize) || 12) * 1.05)) + 2
  const bottom = Math.min(...lines.map((line) => (Number(line.y) || 0) - (Number(line.height) || Number(line.fontSize) || 12) * 0.35)) - 2
  return normalizeRegion(x0, x1, top, bottom, pageWidth, pageHeight)
}

/** Bottom edge of a running page header, used to keep it out of figure crops. */
function pageHeaderBottom(pageLines, pageHeight) {
  const lines = Array.isArray(pageLines) ? pageLines : []
  let best = null
  for (const line of lines) {
    const y = Number(line?.y) || 0
    const text = String(line?.text ?? '').trim()
    if (text.length < 8 || y < pageHeight * 0.9) continue
    if (best === null || y > best.y) best = { y, fontSize: Number(line.fontSize) || 10 }
  }
  return best === null ? null : best.y - best.fontSize * 1.5
}

/** Match the actual PDF lines of one display equation instead of trusting a paragraph rect. */
function formulaRegionFromLines(text, pageLines, pageWidth, pageHeight) {
  const compact = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[−–]/g, '-')
  const target = compact(text)
  if (target.length < 4) return null
  const lines = Array.isArray(pageLines) ? pageLines : []
  const candidates = []
  for (const line of lines) {
    const value = String(line?.text ?? '').trim()
    if (value === '') continue
    if (/^\(\d{1,3}[a-z]?\)$/i.test(value)) continue
    const current = compact(value)
    if (current.length < 2 || !target.includes(current)) continue
    const prose = /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(value) && !/[=≈≤≥∑∫√^_]/u.test(value)
    if (prose) continue
    if (/^(?:where|with|and|but|or|which|that|is|are|was|were|the|this|these|those|in|on|for|from|by|as|at|it|its|their|can|may|should|using|we|our|to|of)\b/i.test(value) && value.split(/\s+/).length > 4) continue
    const normalWords = value.split(/\s+/).filter((word) => /^[A-Za-z]{3,}/.test(word)).length
    if (normalWords >= 5) continue
    candidates.push({ line, weight: current.length, y: Number(line.y) || 0 })
  }
  if (candidates.length === 0) return null
  // Keep only the tight vertical cluster: short symbol lines elsewhere on the page are not part
  // of this equation just because their text happens to be a substring of the merged block.
  candidates.sort((a, b) => b.y - a.y)
  const clusters = []
  let cluster = []
  let previousY = null
  for (const candidate of candidates) {
    if (previousY !== null && previousY - candidate.y > 48) {
      if (cluster.length > 0) clusters.push(cluster)
      cluster = []
    }
    cluster.push(candidate)
    previousY = candidate.y
  }
  if (cluster.length > 0) clusters.push(cluster)
  clusters.sort((a, b) => b.reduce((sum, item) => sum + item.weight, 0) - a.reduce((sum, item) => sum + item.weight, 0))
  const matches = (clusters[0] ?? []).map((item) => item.line)
  if (matches.length === 0) return null
  let x0 = Math.min(...matches.map((line) => Number(line.x) || 0)) - 8
  let x1 = Math.max(...matches.map((line) => (Number(line.x) || 0) + (Number(line.width) || 0))) + 8
  const top = Math.max(...matches.map((line) => (Number(line.y) || 0) + (Number(line.height) || Number(line.fontSize) || 12) * 1.15)) + 2
  const bottom = Math.min(...matches.map((line) => (Number(line.y) || 0) - (Number(line.height) || Number(line.fontSize) || 12) * 0.35)) - 2
  for (const line of lines) {
    const y = Number(line.y) || 0
    if (y < bottom - 12 || y > top + 12) continue
    const value = String(line.text ?? '').trim()
    if (/^\(\d{1,3}[a-z]?\)$/i.test(value)) {
      x1 = Math.min(x1, (Number(line.x) || 0) - 8)
      continue
    }
    // Include a short leading fragment that belongs to the same display line: W* =, arg min,
    // an alignment marker, etc. Long prose lines are never pulled in.
    const compactValue = compact(value)
    if (compactValue.length <= 8 && (Number(line.x) || 0) < x0) x0 = Math.min(x0, Number(line.x) || 0) - 8
  }
  return normalizeRegion(x0, x1, top, bottom, pageWidth, pageHeight)
}

const FORMULA_MATH_RE = /[=≈≤≥±×÷∞∑∏∫√^_/<>−·⋆]|[\u0370-\u03ff]/gu

/** True when a block can start/follow a display equation group. */
function isFormulaLikeBlock(block) {
  const text = String(block?.text ?? '').trim()
  if (text === '') return false
  if (block.kind === 'formula') return true
  if (block.kind !== 'paragraph' && block.kind !== 'list') return false
  if (text.length > 150) return false
  const math = (text.match(FORMULA_MATH_RE) ?? []).length
  const words = text.split(/\s+/).filter(Boolean).length
  if (math === 0) return false
  if (text.length <= 40 && words <= 8) return true
  return math >= 2 && words <= 20
}

/** Merge the fragments of one display equation (numerator, denominator, number) into one block. */
export function mergeFormulaFragments(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const merged = []
  let group = []
  const flush = () => {
    if (group.length === 0) return
    if (group.length === 1) {
      merged.push(group[0])
    } else {
      const combinedText = group.map((block) => String(block.text ?? '').trim()).join('\n')
      const strongMath = /[=≈≤≥±×÷∞∑∏∫√^_−]|[\u0370-\u03ff]/u.test(combinedText)
      if (!strongMath && group.every((block) => block.kind !== 'formula')) {
        // Chart labels and table rows can look "mathy" because of slashes and numbers; if the
        // merged group has no real operator, leave the original blocks untouched.
        merged.push(...group)
        group = []
        return
      }
      const rects = group.map((block) => block.rect).filter((rect) => rect !== undefined && rect !== null)
      let rect =
        rects.length > 0
          ? {
              x: Math.min(...rects.map((value) => value.x)),
              y: Math.min(...rects.map((value) => value.y)),
              w: Math.max(...rects.map((value) => value.x + value.w)) - Math.min(...rects.map((value) => value.x)),
              h: Math.max(...rects.map((value) => value.y + value.h)) - Math.min(...rects.map((value) => value.y)),
            }
          : undefined
      if (rect !== undefined && rect.w < 0.42) {
        const center = rect.x + rect.w / 2
        rect = { ...rect, x: Math.max(0.08, center - 0.28), w: 0.56 }
      }
      if (rect !== undefined) rect = { ...rect, h: Math.max(rect.h, 0.035) }
      merged.push({
        ...group[0],
        kind: 'formula',
        text: group.map((block) => String(block.text ?? '').trim()).join('\n'),
        ...(rect !== undefined ? { rect } : null),
        level: undefined,
      })
    }
    group = []
  }
  for (const block of list) {
    if (block === null || typeof block !== 'object') continue
    const text = String(block.text ?? '').trim()
    const mathChars = (text.match(FORMULA_MATH_RE) ?? []).length
    const proseLike = mathChars === 0 && /^[A-Z][a-z]{2,}(?:\s+[a-z]{2,}){2,}/.test(text)
    const canContinue =
      group.length > 0 &&
      group.length < 10 &&
      (block.kind === 'paragraph' || block.kind === 'formula' || block.kind === 'list' || (block.kind === 'footnote' && text.length <= 4)) &&
      text !== '' &&
      text.length <= 140 &&
      !proseLike &&
      (text.length <= 70 || mathChars > 0)
    if (isFormulaLikeBlock(block) || canContinue) {
      group.push(block)
      continue
    }
    flush()
    merged.push(block)
  }
  flush()
  return merged
}

/**
 * Clean one page's reading blocks: drop pure artifacts/symbols, merge footnote fragments and the
 * author/affiliation cluster on the first page (they would otherwise appear as a stack of tiny
 * spaced-out blocks).
 */
function consolidatePageBlocks(blocks, pageNumber) {
  const cleaned = []
  for (const block of blocks) {
    if (block.kind === 'artifact') continue
    const text = String(block.text ?? '').trim()
    if (text === '') continue
    if (block.kind !== 'heading' && /^[\s*†‡§¶∗·•+]{1,4}\d{0,2}$/u.test(text)) continue
    cleaned.push(block)
  }
  // Merge consecutive footnote fragments into one footnote block.
  const merged = []
  for (const block of cleaned) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.kind === 'footnote' && block.kind === 'footnote' && previous.text.length + block.text.length < 1200) {
      previous.text = `${previous.text} ${block.text}`.replace(/\s+/g, ' ').trim()
      continue
    }
    // A paragraph broken by an inline bold run arrives as two blocks; the first has no terminal
    // punctuation and the continuation starts lowercase. Keep them as one body paragraph so a
    // mixed figure page cannot mistake the opening line for figure text.
    if (
      previous !== undefined &&
      previous.kind === 'paragraph' &&
      block.kind === 'paragraph' &&
      !/[.!?。！？:：;；]$/.test(previous.text.trim()) &&
      /^[a-z(（"“'‘]/.test(block.text.trim()) &&
      (previous.text.match(/\d/g) ?? []).length / Math.max(1, previous.text.length) < 0.08 &&
      previous.text.length + block.text.length < 1600
    ) {
      previous.text = `${previous.text} ${block.text}`.replace(/\s+/g, ' ').trim()
      continue
    }
    merged.push({ ...block })
  }
  if (pageNumber !== 1) return merged
  // Page 1: merge the short author/affiliation lines directly after the title into one block.
  const titleIndex = merged.findIndex((block) => block.kind === 'heading')
  const start = titleIndex >= 0 ? titleIndex + 1 : 0
  const cluster = []
  let cursor = start
  while (cursor < merged.length && cluster.length < 8) {
    const block = merged[cursor]
    const text = String(block.text ?? '').trim()
    if (block.kind !== 'paragraph') break
    if (text.length > 200) break
    if (/@|https?:\/\//i.test(text)) break
    if (/[.。!?！？]$/.test(text) && text.length > 90) break
    cluster.push(block)
    cursor++
  }
  if (cluster.length > 1) {
    const combined = cluster.map((block) => String(block.text ?? '').trim()).join(' ').replace(/\s+/g, ' ').trim()
    merged.splice(start, cluster.length, { ...cluster[0], text: combined, kind: 'paragraph', level: undefined })
  }
  return merged
}

/** Rejoin a caption split by an inline superscript or a wrapped equation fragment. */
function mergeCaptionContinuations(blocks) {
  const out = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.kind !== 'caption') {
      out.push(block)
      continue
    }
    let text = String(block.text ?? '').trim()
    let cursor = index + 1
    while (cursor < blocks.length) {
      const next = blocks[cursor]
      if (next.kind === 'heading' || next.kind === 'figure' || next.kind === 'caption') break
      const nextText = String(next.text ?? '').trim()
      if (nextText === '') break
      const open = !/[.!?。！？:：;；]["'”’)\]]?$/.test(text)
      const mathStart = /^[*⋆=+−≈≤≥<>]/.test(nextText)
      const lowercaseStart = /^[a-z(（"“'‘]/.test(nextText)
      if (!open || (!mathStart && !lowercaseStart)) break
      text = `${text} ${nextText}`.replace(/\s+/g, ' ').trim()
      cursor++
    }
    out.push({ ...block, text })
    index = cursor - 1
  }
  return out
}

/** A wrapped paragraph that crossed a page/figure boundary often ends without punctuation. */
function paragraphEndsOpen(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  return !/[.!?。！？:：;；]["'”’)\]]?$/.test(value) || /[,，、;；:：-]$/.test(value)
}

const CONTINUATION_VERBS = new Set(['read', 'see', 'use', 'used', 'using', 'requires', 'require', 'supports', 'support', 'covers', 'cover', 'includes', 'include', 'via', 'with', 'for', 'from', 'by', 'in', 'on', 'at', 'to', 'of', 'and', 'or', 'that', 'which', 'is', 'are', 'was', 'were', 'be', 'been', 'not', 'no', 'more', 'less', 'than', 'as', 'per', 'into', 'over', 'under', 'between', 'across'])
const NEW_PARAGRAPH_STARTER = /^(?:The|This|These|Those|We|Our|In|However|Moreover|Furthermore|Finally|First|Second|Third|Figure|Table|Section|Appendix|A |An )\b/

function paragraphStartsContinuation(text, previousText = '') {
  const value = String(text ?? '').trim()
  if (/^[a-z(（"“'‘]/.test(value)) return true
  if (!/^[A-Z]/.test(value) || NEW_PARAGRAPH_STARTER.test(value)) return false
  if (!paragraphEndsOpen(previousText)) return false
  const firstToken = value.split(/\s+/)[0] ?? ''
  const lastWord = String(previousText ?? '').trim().split(/\s+/).pop()?.replace(/[^A-Za-z]/g, '').toLowerCase() ?? ''
  return /[A-Za-z].*[\d.\-]/.test(firstToken) || CONTINUATION_VERBS.has(lastWord)
}

/** Join paragraph fragments split by a page break or an inserted figure/caption. */
function mergeParagraphContinuations(pages) {
  for (const page of pages) {
    const blocks = page.blocks
    // Same page: paragraph A, figure/caption, continuation B.
    for (let index = 0; index < blocks.length; index++) {
      const first = blocks[index]
      if (first.kind !== 'paragraph' || !paragraphEndsOpen(first.text)) continue
      let cursor = index + 1
      while (cursor < blocks.length && (blocks[cursor].kind === 'figure' || blocks[cursor].kind === 'caption')) cursor++
      if (cursor >= blocks.length) continue
      const continuation = blocks[cursor]
      if (continuation.kind !== 'paragraph' || !paragraphStartsContinuation(continuation.text, first.text)) continue
      first.text = `${String(first.text).replace(/\s+$/, '')} ${String(continuation.text).replace(/^\s+/, '')}`.replace(/\s+/g, ' ').trim()
      blocks.splice(cursor, 1)
    }
  }
  // Across pages: last paragraph of page N + first paragraph after the figure/caption on N+1.
  let previousParagraph = null
  for (const page of pages) {
    const blocks = page.blocks
    const firstIndex = blocks.findIndex((block) => block.kind === 'paragraph')
    if (firstIndex >= 0 && previousParagraph !== null) {
      const first = blocks[firstIndex]
      if (paragraphEndsOpen(previousParagraph.text) && paragraphStartsContinuation(first.text, previousParagraph.text)) {
        previousParagraph.text = `${String(previousParagraph.text).replace(/\s+$/, '')} ${String(first.text).replace(/^\s+/, '')}`.replace(/\s+/g, ' ').trim()
        blocks.splice(firstIndex, 1)
      }
    }
    for (let index = blocks.length - 1; index >= 0; index--) {
      if (blocks[index].kind === 'paragraph') {
        previousParagraph = blocks[index]
        break
      }
    }
  }
}


function looksLikeReferencesPage(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const firstText = list.map((block) => String(block.text ?? '').trim()).find((text) => text !== '') ?? ''
  if (/^(?:references|bibliography|参考文献|参考资料)/i.test(firstText)) return true
  // Reference entries start with an author name and contain a year; body paragraphs cite inline
  // but do not start that way.
  const entries = list.filter((block) => /^[A-Z][A-Za-z.'’\-]+(?:\s+et\s+al\.)?.*\b(?:19|20)\d{2}\b/.test(String(block.text ?? '').trim())).length
  return entries >= 5
}

/** True for a figure/table caption line ("Figure 2 ...", "Table 1 ..."). */
function isCaptionBlock(block) {
  const value = String(block?.text ?? '').trim()
  if (!/^(?:figure|table|fig\.|图|表)\s*[\d一二三四五六七八九十]/i.test(value)) return false
  // A body sentence can start with "Figure 3 reports ..."; that is a reference, not a caption.
  if (/^(?:figure|table|fig\.|图|表)\s*[\d一二三四五六七八九十][\s:.—-]+(?:reports?|shows?|illustrates?|compares?|summari[sz]es?|presents?|depicts?|indicates?|gives?|lists?|provides?|is|are|was|were)\b/i.test(value)) return false
  return true
}

/** A real body paragraph (not a caption/table cell) that must stay selectable text. */
function isProseBodyBlock(block) {
  if (block === null || typeof block !== 'object') return false
  if (block.kind !== 'paragraph' && block.kind !== 'list') return false
  const text = String(block.text ?? '').trim()
  if (text.length < 240) return false
  if (/^(?:figure|table|fig\.|图|表)\s*[\d一二三四五六七八九十]/i.test(text)) return false
  return (text.match(/[.!?。]\s/g) ?? []).length >= 2
}

/** Looser body test for mixed pages: a short paragraph with real sentences still stays text. */
function isBodyLikeBlock(block) {
  if (isProseBodyBlock(block)) return true
  if (block === null || typeof block !== 'object') return false
  if (block.kind !== 'paragraph' && block.kind !== 'list') return false
  const text = String(block.text ?? '').trim()
  if (text.length < 120) return false
  if (/^(?:figure|table|fig\.|图|表)\s*[\d一二三四五六七八九十]/i.test(text)) return false
  if ((text.match(/[.!?。]\s/g) ?? []).length >= 1 && /[a-z]{3,}\s+[a-z]{3,}/.test(text)) return true
  // Lowercase continuation of a body paragraph (the table caption/rows above stay uppercase or numeric).
  const words = text.split(/\s+/).filter(Boolean).length
  const digits = (text.match(/\d/g) ?? []).length
  return /^[a-z]/.test(text) && words >= 10 && digits / text.length < 0.15
}

/** True when a page is essentially one figure/table/diagram (labels and captions, no body copy). */
function looksLikeFigurePage(blocks) {
  const list = Array.isArray(blocks) ? blocks.filter((block) => block !== null && typeof block === 'object') : []
  if (looksLikeReferencesPage(list)) return false
  if (list.length < 4) return false
  const captions = list.filter((block) => block.kind === 'caption').length
  const captionText = list.filter((block) => /^(?:figure|table|图|表)\s*[\d一二三四五六七八九十]/i.test(String(block.text ?? '').trim())).length
  const longParagraphs = list.filter((block) => (block.kind === 'paragraph' || block.kind === 'list') && String(block.text ?? '').trim().length >= 260).length
  const bodyChars = list
    .filter((block) => block.kind === 'paragraph' || block.kind === 'list')
    .reduce((sum, block) => sum + String(block.text ?? '').trim().length, 0)
  const textBlocks = list.filter((block) => String(block.text ?? '').trim() !== '')
  if (textBlocks.length < 4) return false
  const shortBlocks = textBlocks.filter((block) => String(block.text ?? '').trim().length <= 90).length
  const shortRatio = shortBlocks / textBlocks.length
  const figureBlocks = list.filter((block) => block.kind === 'figure').length
  const headings = list.filter((block) => block.kind === 'heading').length
  if (captions > 0 && longParagraphs === 0 && bodyChars < 1200) return true
  // Figure/table pages: a detected figure region plus mostly labels/caption fragments.
  if ((figureBlocks > 0 || captionText > 0) && shortRatio >= 0.35 && longParagraphs <= 8 && bodyChars < 5000) return true
  // Diagram pages made of many short labels (algorithm/VLM diagrams) with no real body copy.
  if (headings >= 4 && shortRatio >= 0.5 && longParagraphs <= 5 && bodyChars < 4200) return true
  return longParagraphs === 0 && bodyChars < 700 && shortRatio >= 0.7
}

/** Fallback table of contents built from detected heading blocks when the PDF has no outline. */
function buildHeadingToc(pages) {
  const items = []
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
      if (block.kind !== 'heading') continue
      const title = typeof block.text === 'string' ? block.text.trim().slice(0, 200) : ''
      if (title === '') continue
      items.push({
        id: `h-toc-${items.length}`,
        title,
        level: Math.min(3, Math.max(1, Number(block.level) || 1)),
        blockId: block.id,
      })
      if (items.length >= 500) return items
    }
  }
  return items
}

/**
 * Extract reflow text + metadata + cover thumbnail from a PDF.
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @param {{ assets?:object, onProgress?:(progress:{done:number,total:number})=>void,
 *           maxPages?:number, maxChars?:number }} [opts]
 * @returns {Promise<{ meta:{title?:string,author?:string,pageCount:number,truncated?:boolean,
 *           extractedPages?:number,truncationReason?:string},
 *           content:{kind:'pdf',version:1,pageCount:number,pages:Array<{n:number,blocks:object[]}>,toc:object[]},
 *           thumbDataUrl:string|null }>}
 */
export async function importPdf(arrayBuffer, opts = {}) {
  const assets = opts.assets ?? {}
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const maxPages = Number(opts.maxPages) > 0 ? Math.floor(Number(opts.maxPages)) : DEFAULT_PDF_LIMITS.maxPages
  const maxChars = Number(opts.maxChars) > 0 ? Math.floor(Number(opts.maxChars)) : DEFAULT_PDF_LIMITS.maxChars
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : null
  const pdfjs = await loadPdfjs(assets)
  const data = toBytes(arrayBuffer)
  const loadingTask = pdfjs.getDocument({ data, ...sourceOptions(assets) })
  let pdf = null
  try {
    pdf = await loadingTask.promise
    onStage?.('loaded')
    const pageCount = Math.max(1, Number(pdf.numPages) || 1)
    const documentMeta = await readDocumentMeta(pdf)
    const pageLimit = Math.min(pageCount, maxPages)
    onProgress?.({ done: 0, total: pageLimit })

    // Pass 1: text items -> lines for every extracted page (geometry kept for margin detection).
    const extracted = []
    let charCount = 0
    let truncated = false
    let truncationReason = ''
    for (let n = 1; n <= pageLimit; n++) {
      if (charCount >= maxChars) {
        truncated = true
        truncationReason = 'chars'
        break
      }
      let lines = []
      let equationNumbers = []
      let width = 612
      let height = 792
      let viewport
      try {
        const page = await pdf.getPage(n)
        try {
          viewport = page.getViewport({ scale: 1 })
          width = Number(viewport?.width) || width
          height = Number(viewport?.height) || height
        } catch {
          /* keep defaults */
        }
        try {
          const textContent = await page.getTextContent({ disableNormalization: false, includeMarkedContent: false })
          const items = viewportTextItems(Array.isArray(textContent?.items) ? textContent.items : [], textContent.styles, viewport)
          lines = groupTextItems(items)
          equationNumbers = items.flatMap(item => {
            const match = String(item.str ?? '').trim().match(/^\((\d{1,3}[a-z]?)\)$/i)
            if (!match || !Array.isArray(item.transform)) return []
            const font = Math.abs(Number(item.height) || Number(item.transform[3]) || 10)
            return [{ number: match[1], rect: item.sourceRect ?? { x: item.transform[4] / width, y: Math.max(0, 1 - (item.transform[5] + font) / height), w: Number(item.width) / width, h: font * 1.35 / height } }]
          })
        } catch {
          lines = []
        }
        // Release text resources before the page is rendered again (for the cover thumbnail).
        try {
          page.cleanup()
        } catch {
          /* ignore */
        }
      } catch {
        lines = []
      }
      extracted.push({ n, width, height, lines, equationNumbers })
      for (const line of lines) charCount += typeof line.text === 'string' ? line.text.length : 0
      onProgress?.({ done: n, total: pageLimit })
      if (charCount >= maxChars && n < pageLimit) {
        truncated = true
        truncationReason = 'chars'
        break
      }
      // Let the UI paint its progress line every few pages.
      if (n % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (extracted.length < pageCount) {
      truncated = true
      if (truncationReason === '') truncationReason = 'pages'
    }

    // Pass 2: drop repeated running headers/footers.
    const repeated = detectRepeatedMargins(extracted.map((page) => ({ n: page.n, pageHeight: page.height, lines: page.lines })))
    const allLines = []
    for (const page of extracted) for (const line of page.lines) allLines.push(line)
    const documentMedianFontSize = median(allLines.map((line) => line.fontSize)) || 12

    // Pass 3: lines -> paragraphs -> clean blocks (+ lazy figure/formula region descriptors).
    const pages = []
    const sourcePages = new Map()
    const figurePages = []
    let figureCount = 0
    let formulaCount = 0
    let pageFigureCount = 0
    for (const page of extracted) {
      const pageLines = dropArtifactLines(stripRepeatedMargins(page.lines, page.height, repeated))
      if (pageLines.length === 0) {
        // Scanned/image-only page: show the page itself instead of a blank reflow page.
        pages.push({ n: page.n, blocks: [{ id: `p${page.n}page`, kind: 'pageFigure', text: '', page: page.n, rect: { x: 0, y: 0, w: 1, h: 1 } }] })
        figurePages.push(page.n)
        pageFigureCount++
        continue
      }
      const pageMedianFontSize = median(pageLines.map((line) => line.fontSize)) || documentMedianFontSize
      const paragraphs = mergeLinesToParagraphs(pageLines, { medianFontSize: pageMedianFontSize, pageWidth: page.width })
      const blocks = []
      const sourceBlocks = []
      let pageFormulas = 0
      for (let index = 0; index < paragraphs.length; index++) {
        const paragraph = paragraphs[index]
        const classification = refineKind(
          classifyBlock({
            text: paragraph.text,
            fontSize: paragraph.fontSize,
            medianFontSize: pageMedianFontSize,
            pageWidth: page.width,
            fontName: paragraph.fontName,
            lineCount: paragraph.lines?.length ?? 1,
            prevKind: blocks.length > 0 ? blocks[blocks.length - 1].kind : undefined,
          }),
          paragraph,
          { pageMedianFontSize, pageHeight: page.height, isLastParagraph: index === paragraphs.length - 1 },
        )
        const text = typeof classification.text === 'string' ? classification.text.trim() : paragraph.text.trim()
        if (text === '') continue
        const formulaRect =
          classification.kind === 'paragraph' && pageFormulas < FORMULA_MAX_PER_PAGE && looksLikeDisplayEquation(text, paragraph.lines?.length ?? 1)
            ? formulaRegionForParagraph(paragraph, page.width, page.height)
            : null
        const block = { id: `p${page.n}b${blocks.length}`, kind: formulaRect !== null ? 'formula' : classification.kind, text, page: page.n, y: Number(paragraph.y) || 0, x: Number(paragraph.x) || 0, w: Number(paragraph.width) || 0, fontSize: Number(paragraph.fontSize) || 0 }
        const lines = paragraph.lines?.length ? paragraph.lines : [paragraph]
        const x0 = Math.max(0, Math.min(...lines.map(line => Number(line.x) || 0)))
        const x1 = Math.min(page.width, Math.max(...lines.map(line => (Number(line.x) || 0) + (Number(line.width) || 1))))
        const top = Math.max(...lines.map(line => (Number(line.y) || 0) + (Number(line.height) || Number(line.fontSize) || 10)))
        const bottom = Math.min(...lines.map(line => (Number(line.y) || 0) - (Number(line.height) || Number(line.fontSize) || 10) * 0.3))
        block.sourceRect = { x: x0 / page.width, y: Math.max(0, 1 - top / page.height), w: Math.max(0.001, (x1 - x0) / page.width), h: Math.max(0.001, (top - bottom) / page.height) }
        block.sourceRects = lines.flatMap(line => line.sourceRects ?? [])
        block.sourceRect = unionRects(block.sourceRects) ?? block.sourceRect
        if (formulaRect !== null) {
          block.rect = formulaRect
          pageFormulas++
          formulaCount++
        } else if (classification.kind === 'heading') {
          block.level = Math.min(3, Math.max(1, Number(classification.level) || 2))
        }
        blocks.push(block)
        // Vision ownership must be finer than a heuristic paragraph. A merged
        // paragraph can contain a display equation AND its explanation, which
        // cannot be assigned to two roles using the same candidate ID.
        for (const [lineIndex, line] of lines.entries()) {
          const sourceRects = line.sourceRects ?? []
          const candidate = {
            id: lineIndex === 0 ? block.id : `${block.id}l${lineIndex + 1}`,
            kind: lines.length === 1 && block.kind !== 'formula' ? block.kind : 'paragraph',
            text: line.text, page: page.n, x: line.x, y: line.y,
            fontSize: line.fontSize, sourceRects,
            sourceRect: unionRects(sourceRects) ?? block.sourceRect,
          }
          // A visual baseline may contain the end of a prose line beside a
          // tall/multiline equation. Keep individual PDF runs addressable on
          // mathematical lines so the model can separate those roles.
          const separatedRuns = line.sourceItems?.some((run, index, runs) => index > 0 && run.sourceRect && runs[index - 1].sourceRect && (run.sourceRect.x - runs[index - 1].sourceRect.x - runs[index - 1].sourceRect.w) * page.width > Math.max(run.fontSize, runs[index - 1].fontSize) * 2)
          if (line.sourceItems?.length > 1 && (separatedRuns || /[=+∑∫√≤≥≈∈⊤^_{}−]|[\u{1D400}-\u{1D7FF}]/u.test(line.text))) {
            for (const [runIndex, run] of line.sourceItems.entries()) sourceBlocks.push({
              ...candidate, id: runIndex === 0 ? candidate.id : `${candidate.id}r${runIndex + 1}`,
              text: run.text.trim(), x: run.x, y: run.y, fontSize: run.fontSize,
              sourceRect: run.sourceRect ?? candidate.sourceRect, sourceRects: run.sourceRect ? [run.sourceRect] : sourceRects,
            })
          } else sourceBlocks.push(candidate)
        }
      }
      for (const block of blocks) {
        if (block.kind === 'paragraph' && isCaptionBlock(block)) block.kind = 'caption'
      }
      // Preserve text BEFORE formula merging, figure suppression or cross-page
      // heuristics. The visual model must be able to correct those decisions.
      sourcePages.set(page.n, { width: page.width, height: page.height, geometryVersion: 1, fontSize: pageMedianFontSize, equationNumbers: page.equationNumbers, sourceBlocks })
      const referencePage = looksLikeReferencesPage(blocks)
      const preparedBlocks = referencePage
        ? blocks.map((block) => (block.kind === 'formula' ? { ...block, kind: 'paragraph' } : block))
        : mergeFormulaFragments(blocks)
      const consolidated = mergeCaptionContinuations(consolidatePageBlocks(preparedBlocks, page.n))
      // A merged display equation may have no crop rectangle (all fragments were paragraphs).
      // Give it a generous centered region so the viewer can show the original equation instead
      // of a "missing region rectangle" error.
      for (const block of consolidated) {
        if (block.kind !== 'formula') continue
        const numberMatches = [...String(block.text ?? '').matchAll(/\((\d{1,3}[a-z]?)\)/gi)]
        if (numberMatches.length > 0) block.number = numberMatches[numberMatches.length - 1][1]
        const formulaOnly = String(block.text ?? '').split(/\n(?=where\b|with\b|and\b|which\b|that\b|is\b|are\b|constructed\b|using\b|for\b|from\b|by\b|as\b|it\b|its\b|their\b|can\b|may\b|should\b|we\b|our\b)/i)[0].split(/\s+(?=where\b)/i)[0]
        const lineRect = formulaRegionFromLines(formulaOnly, pageLines, page.width, page.height)
        if (lineRect !== null && Number(lineRect.w) > 0.03 && Number(lineRect.h) > 0.012) {
          if (block.number !== undefined && block.number !== '') {
            const maxRight = 0.86
            if (lineRect.x + lineRect.w > maxRight) lineRect.w = Math.max(0.03, maxRight - lineRect.x)
          }
          block.rect = lineRect
          continue
        }
        const hasRect = block.rect !== undefined && Number(block.rect?.w) > 0
        if (!hasRect) {
          const baseline = Number(block.y)
          if (!Number.isFinite(baseline) || baseline <= 0) continue
          const font = Number(block.fontSize) || 10
          const top = Math.max(0.02, Math.min(0.9, 1 - (baseline + font * 1.4) / page.height))
          block.rect = { x: 0.04, y: top, w: 0.92, h: 0.05 }
          continue
        }
        const base = block.rect
        const height = Math.min(0.08, Math.max(0.025, Number(base.h) + 0.006))
        const y = Math.max(0, Math.min(1 - height, Number(base.y) - 0.003))
        block.rect = { x: 0.04, y, w: 0.92, h: height }
      }
      const allCaptions = consolidated.filter(isCaptionBlock)
      const hasTableCaption = allCaptions.some((block) => /^(?:table|表)\s*[\d一二三四五六七八九十]/i.test(String(block.text ?? '').trim()))
      if (!hasTableCaption && allCaptions.length > 1) {
        // A page can hold several charts, each with its own caption. Crop each figure separately and
        // keep every caption as text instead of swallowing the whole page into one image.
        const ordered = [...allCaptions].sort((a, b) => (Number(b.y) || 0) - (Number(a.y) || 0))
        const intervals = []
        for (let index = 0; index < ordered.length; index++) {
          const cap = ordered[index]
          const capY = Number(cap.y) || 0
          const font = Number(cap.fontSize) || 10
          const top = index === 0 ? page.height - 4 : Math.min(page.height - 4, (Number(ordered[index - 1].y) || 0) - font * 1.2 - 4)
          const bottom = capY + font * 0.9 + 2
          if (top - bottom > page.height * 0.05) intervals.push({ top, bottom, cap })
        }
        if (intervals.length > 1) {
          const figures = intervals.map((interval, index) => ({
            id: `p${page.n}fig${index}`,
            kind: 'figure',
            text: '',
            page: page.n,
            rect: { x: 0.02, y: (page.height - interval.top) / page.height, w: 0.96, h: (interval.top - interval.bottom) / page.height },
            y: interval.top,
          }))
          const captionIds = new Set(allCaptions.map((block) => block.id))
          const kept = consolidated.filter((block) => {
            if (captionIds.has(block.id)) return true
            const y = Number(block.y) || 0
            const inside = intervals.some((interval) => y < interval.top && y > interval.bottom)
            return !inside || isBodyLikeBlock(block)
          })
          const output = [...kept, ...figures].sort((a, b) => (Number(b.y) || 0) - (Number(a.y) || 0))
          pages.push({ n: page.n, blocks: output })
          figurePages.push(page.n)
          figureCount += figures.length
          continue
        }
      }
      const caption = consolidated.find(isCaptionBlock)
      if (caption !== undefined) {
        const captionY = Number(caption.y) || 0
        const isTableCaption = /^(?:table|表)\s*[\d一二三四五六七八九十]/i.test(String(caption.text ?? '').trim())
        const top = page.height - 4
        if (isTableCaption) {
          // The caption stays text (so it can be translated); only the grid below it is imaged.
          const bodyAfter = consolidated.filter((block) => isBodyLikeBlock(block) && (Number(block.y) || 0) < captionY)
          const bodyTopY = bodyAfter.length > 0 ? Math.max(...bodyAfter.map((block) => Number(block.y) || 0)) : 0
          const captionFont = Number(caption.fontSize) || 10
          const tableRows = consolidated.filter(
            (block) =>
              block !== caption &&
              (Number(block.y) || 0) < captionY &&
              (bodyTopY === 0 || (Number(block.y) || 0) > bodyTopY + 6) &&
              String(block.text ?? '').trim() !== '',
          )
          const rowTopY = tableRows.length > 0 ? Math.max(...tableRows.map((block) => Number(block.y) || 0)) : captionY - captionFont * 2
          const tableTop = Math.min(page.height - 4, rowTopY + captionFont * 1.2 + 3)
          const bottom = bodyTopY > 12 ? Math.min(tableTop - 8, bodyTopY + captionFont * 1.2 + 3) : 12
          const height = (tableTop - bottom) / page.height
          if (height >= 0.04 && tableRows.length > 0) {
            const tightRows = tableRows.filter((block) => Number(block.w) > 0)
            const x0 = tightRows.length > 0 ? Math.max(0.03, Math.min(...tightRows.map((block) => Number(block.x) / page.width)) - 0.02) : 0.04
            const x1 = tightRows.length > 0 ? Math.min(0.97, Math.max(...tightRows.map((block) => (Number(block.x) + Number(block.w)) / page.width)) + 0.02) : 0.96
            const tableBlock = {
              id: `p${page.n}table`,
              kind: 'figure',
              text: '',
              page: page.n,
              rect: { x: x0, y: (page.height - tableTop) / page.height, w: Math.max(0.25, x1 - x0), h: height },
              y: tableTop,
            }
            const before = consolidated.filter((block) => (Number(block.y) || 0) >= captionY - 2)
            const after = bodyTopY > 0 ? consolidated.filter((block) => (Number(block.y) || 0) <= bodyTopY + 6) : []
            pages.push({ n: page.n, blocks: [...before, tableBlock, ...after] })
            figurePages.push(page.n)
            figureCount++
            continue
          }
        } else {
          // Figure caption: crop from the figure top down to just above the caption. The caption
          // itself and everything below it stay as selectable/translatable text.
          const aboveCaption = consolidated.filter((block) => (Number(block.y) || 0) > captionY + 2)
          const labelBlocks = aboveCaption.filter(
            (block) =>
              String(block.text ?? '').trim() !== '' &&
              Number.isFinite(Number(block.x)) &&
              Number(block.w) > 0 &&
              (Number(block.y) || 0) > captionY,
          )
          let x0 = 0.02
          let x1 = 0.98
          let top = page.height - 14
          if (labelBlocks.length > 0) {
            top = Math.min(page.height - 4, Math.max(...labelBlocks.map((block) => Number(block.y) || 0)) + 36)
          }
          const headerBottom = pageHeaderBottom(pageLines, page.height)
          top = Math.min(top, headerBottom !== null ? headerBottom : page.height * 0.9)
          const bottom = Math.min(top - 10, captionY + (Number(caption.fontSize) || 10) * 0.9 + 2)
          const height = (top - bottom) / page.height
          if (height >= 0.08 && x1 - x0 >= 0.25) {
            const figureBlock = {
              id: `p${page.n}fig`,
              kind: 'figure',
              text: '',
              page: page.n,
              rect: { x: x0, y: (page.height - top) / page.height, w: x1 - x0, h: height },
              y: top,
            }
            const kept = consolidated.filter((block) => (Number(block.y) || 0) <= captionY + 4)
            pages.push({ n: page.n, blocks: [figureBlock, ...kept] })
            figurePages.push(page.n)
            figureCount++
            continue
          }
        }
      }
      for (const block of consolidated) {
        delete block.y
        delete block.x
        delete block.w
        delete block.fontSize
      }
      pages.push({ n: page.n, blocks: consolidated })
    }

    mergeParagraphContinuations(pages)
    for (const page of pages) Object.assign(page, sourcePages.get(page.n) ?? {})
    let toc = await buildToc(pdf, pages)
    if (toc.length === 0) toc = buildHeadingToc(pages)
    onStage?.('blocks')
    const thumbDataUrl = await renderThumbnail(pdf)
    onStage?.('thumb')
    onProgress?.({ done: pageLimit, total: pageLimit })

    const meta = { title: documentMeta.title, author: documentMeta.author, pageCount }
    if (meta.title === '') delete meta.title
    if (meta.author === '') delete meta.author
    if (truncated) {
      meta.truncated = true
      meta.extractedPages = pages.length
      meta.truncationReason = truncationReason || 'pages'
    }
    const content = {
      kind: 'pdf',
      version: 1,
      engineVersion: PDF_ENGINE_VERSION,
      meta: { title: meta.title ?? '', author: meta.author ?? '' },
      pageCount,
      pages,
      toc,
      figurePages,
      regions: { figures: figureCount, formulas: formulaCount, pageFigures: pageFigureCount },
    }
    return { meta, content, thumbDataUrl }
  } finally {
    await destroyDocument(pdf, loadingTask)
  }
}
