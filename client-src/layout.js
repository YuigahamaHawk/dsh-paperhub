// Pure transform for AI layout results (`ai.layout`): whole-page figure decisions and
// AI-reconstructed LaTeX for display equations. Kept DOM-free so Node tests can cover it.
import { latexToMathML } from './latex.js'

/**
 * Apply AI-reconstructed LaTeX from one `ai.formulas` call. Only blocks the model returned are
 * promoted to formula blocks; invalid LaTeX is ignored so the crop/text fallback stays.
 *
 * @param {object} content
 * @param {{formulas?:Array<{id:string,latex:string}>}|null} result
 * @param {{now?:number}} [options]
 */
export function applyFormulaLatex(content, result, options = {}) {
  const source = content !== null && typeof content === 'object' ? content : {}
  const pages = Array.isArray(source.pages) ? source.pages : []
  const formulas = Array.isArray(result?.formulas) ? result.formulas : []
  if (pages.length === 0 || formulas.length === 0) {
    return { content: source, changed: 0, formulaCount: 0 }
  }
  const byId = new Map()
  for (const formula of formulas) {
    const id = typeof formula?.id === 'string' ? formula.id : ''
    const latex = typeof formula?.latex === 'string' ? formula.latex.trim() : ''
    if (id === '' || latex === '') continue
    if (latexToMathML(latex) === '') continue
    byId.set(id, latex)
  }
  if (byId.size === 0) return { content: source, changed: 0, formulaCount: 0 }
  let changed = 0
  let formulaCount = 0
  const nextPages = pages.map((page) => {
    if (page === null || typeof page !== 'object' || !Array.isArray(page.blocks)) return page
    let pageChanged = false
    const nextBlocks = page.blocks.map((block) => {
      if (block === null || typeof block !== 'object') return block
      const latex = byId.get(block.id)
      if (latex === undefined) return block
      formulaCount++
      if (block.kind === 'formula' && block.latex === latex) return block
      pageChanged = true
      return { ...block, kind: 'formula', latex }
    })
    if (!pageChanged) return page
    changed++
    return { ...page, blocks: nextBlocks }
  })
  return {
    content: {
      ...source,
      pages: nextPages,
      aiMathAt: typeof options.now === 'number' ? options.now : Date.now(),
      aiMathModel: typeof result?.model === 'string' ? result.model : null,
    },
    changed,
    formulaCount,
  }
}

/**
 * Apply one `ai.layout` result to stored PDF content.
 *
 * @param {object} content PdfContent
 * @param {{pages?:Array<{n:number,figurePage?:boolean,formulas?:Array<{id:string,latex:string}>}>,model?:string}|null} result
 * @param {{now?:number}} [options]
 * @returns {{content:object,changed:number,formulaCount:number,figurePageCount:number}}
 */
export function applyAiLayout(content, result, options = {}) {
  const source = content !== null && typeof content === 'object' ? content : {}
  const pages = Array.isArray(source.pages) ? source.pages : []
  const entries = new Map()
  for (const entry of Array.isArray(result?.pages) ? result.pages : []) {
    const pageNumber = Number(entry?.n)
    if (Number.isFinite(pageNumber)) entries.set(pageNumber, entry)
  }
  if (pages.length === 0 || entries.size === 0) {
    return { content: source, changed: 0, formulaCount: 0, figurePageCount: 0 }
  }
  const figurePages = new Set(Array.isArray(source.figurePages) ? source.figurePages : [])
  let changed = 0
  let formulaCount = 0
  let figurePageCount = 0
  const nextPages = pages.map((page) => {
    const entry = entries.get(Number(page?.n))
    if (entry === undefined || page === null || typeof page !== 'object') return page
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    if (entry.figurePage === true && !blocks.some((block) => block?.kind === 'pageFigure')) {
      figurePages.add(Number(page.n))
      figurePageCount++
      changed++
      return {
        ...page,
        blocks: [{ id: `p${page.n}page`, kind: 'pageFigure', text: '', page: Number(page.n), rect: { x: 0, y: 0, w: 1, h: 1 } }],
      }
    }
    const formulas = new Map()
    for (const formula of Array.isArray(entry.formulas) ? entry.formulas : []) {
      const id = typeof formula?.id === 'string' ? formula.id : ''
      const latex = typeof formula?.latex === 'string' ? formula.latex.trim() : ''
      if (id === '' || latex === '') continue
      // Only keep LaTeX the client can actually render; otherwise keep the crop/text fallback.
      if (latexToMathML(latex) === '') continue
      formulas.set(id, latex)
    }
    if (formulas.size === 0) return page
    let pageChanged = false
    const nextBlocks = blocks.map((block) => {
      if (block === null || typeof block !== 'object') return block
      const latex = formulas.get(block.id)
      if (latex === undefined) return block
      formulaCount++
      if (block.kind === 'formula' && block.latex === latex) return block
      pageChanged = true
      return { ...block, kind: 'formula', latex }
    })
    if (!pageChanged) return page
    changed++
    return { ...page, blocks: nextBlocks }
  })
  let toc = source.toc
  if (figurePageCount > 0) {
    toc = []
    for (const page of nextPages) {
      for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
        if (block?.kind !== 'heading') continue
        toc.push({
          id: `h-toc-${toc.length}`,
          title: String(block.text ?? '').slice(0, 200),
          level: Math.min(3, Math.max(1, Number(block.level) || 1)),
          blockId: block.id,
        })
        if (toc.length >= 500) break
      }
    }
  }
  return {
    content: {
      ...source,
      pages: nextPages,
      toc,
      figurePages: [...figurePages].sort((a, b) => a - b),
      aiLayoutAt: typeof options.now === 'number' ? options.now : Date.now(),
      aiLayoutModel: typeof result?.model === 'string' ? result.model : null,
    },
    changed,
    formulaCount,
    figurePageCount,
  }
}
