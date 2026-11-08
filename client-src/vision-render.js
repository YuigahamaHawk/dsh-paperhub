// Render the few pages that need visual layout into low-cost JPEGs.
//
// This runs in the renderer (pdf.js canvas) and only sends an image when the Host has a vision
// route. Page selection is deliberately structural: asset pages and pages whose text mentions a
// figure/table/algorithm, not every page of the document.

import { loadPdfjs, renderPdfPage } from './pdf-engine.js'
import { pageInk } from './figure-geometry.js'

function pdfAssets(api) {
  return {
    moduleUrl: api.assetUrl('pdf/pdf.mjs'),
    workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
    cMapUrl: api.assetUrl('pdf/cmaps/'),
    standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
  }
}

/** Pages worth one vision call: existing assets plus pages that mention a structure. */
export function visionPageNumbers(content, limit = Infinity) {
  const pages = Array.isArray(content?.pages) ? content.pages : []
  const picked = []
  for (const page of pages) {
    picked.push(Number(page.n))
  }
  return [...new Set(picked)].sort((a, b) => a - b).slice(0, Math.max(1, limit))
}

export function candidatesForPage(page) {
  const blocks = page?.sourceBlocks ?? page?.visionSourceBlocks ?? page?.blocks ?? []
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && typeof block.id === 'string')
    .slice(0, 2000)
    .map((block) => ({
      id: block.id,
      kind: typeof block.kind === 'string' ? block.kind : 'paragraph',
      bbox: (block.sourceRect ?? block.rect) !== undefined && (block.sourceRect ?? block.rect) !== null
        ? [Number((block.sourceRect ?? block.rect).x) || 0, Number((block.sourceRect ?? block.rect).y) || 0, (Number((block.sourceRect ?? block.rect).x) || 0) + (Number((block.sourceRect ?? block.rect).w) || 0), (Number((block.sourceRect ?? block.rect).y) || 0) + (Number((block.sourceRect ?? block.rect).h) || 0)]
        : undefined,
      text: typeof block.text === 'string' ? block.text.slice(0, 6000) : '',
    }))
}

/**
 * @returns {Promise<Array<{n:number,imageBase64:string,width:number,height:number,pageCount:number,candidates:Array}>>}
 */
export async function renderVisionPages({ api, docId, content, limit = Infinity, pageNumbers, signal, onPage, captureInk = false, onProgress = () => undefined }) {
  const numbers = pageNumbers ?? visionPageNumbers(content, limit)
  const pages = []
  await forRenderedPages({ api, docId, numbers, signal }, async (n, canvas, pdf, index) => {
    const payload = {
      n,
      imageBase64: canvas.toDataURL('image/jpeg', 0.88).replace(/^data:image\/jpeg;base64,/, ''),
      width: canvas.width,
      height: canvas.height,
      pageCount: Number(content?.pageCount) || pdf.numPages,
      candidates: candidatesForPage(pdfjsPage(content, n)),
    }
    if (onPage) await onPage(payload, captureInk ? pageInk(canvas) : undefined)
    else pages.push(payload)
    onProgress({ done: index + 1, total: numbers.length, page: n })
  })
  return pages
}

export async function renderLayoutInkPages({ api, docId, pageNumbers, signal, onPage }) {
  await forRenderedPages({ api, docId, numbers: pageNumbers, signal }, (n, canvas) => onPage(n, pageInk(canvas)))
}

async function forRenderedPages({ api, docId, numbers, signal }, visit) {
  if (!numbers.length) return
  const buffer = await (await fetch(api.fileUrl(docId, 'original'), { signal })).arrayBuffer()
  const assets = pdfAssets(api)
  const pdfjs = await loadPdfjs(assets)
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), cMapUrl: assets.cMapUrl, cMapPacked: true, standardFontDataUrl: assets.standardFontDataUrl }).promise
  try {
    for (const [index, n] of numbers.entries()) {
      if (signal?.aborted) throw new Error('Layout cancelled')
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const { canvas } = await renderPdfPage(pdf, n, { scale: Math.min(2, 1500 / base.height), dpr: 1 })
      try {
        await visit(n, canvas, pdf, index)
      } finally {
        page.cleanup()
        canvas.width = 1
        canvas.height = 1
      }
    }
  } finally {
    await pdf.destroy()
  }
}

function pdfjsPage(content, n) {
  return (Array.isArray(content?.pages) ? content.pages : []).find((page) => Number(page?.n) === Number(n)) ?? { n, blocks: [] }
}
