// Pure transform for AI structure refinement results (host `ai.reflow`).
//
// Kept free of React/DOM so it is unit-testable in Node: the reader shell only performs the RPC,
// caches and persistence around this function.

/**
 * Apply one `ai.reflow` result to a stored PDF content object.
 *
 * The deterministic reflow supplies paragraph text and heuristic headings; the model suggestion
 * confirms/corrects heading blocks, drops page furniture, and never rewrites paragraph text.
 * Pages where the model returned no opinion are left untouched (so a model failure cannot demote
 * every heuristic heading). Long "merged heading + body" blocks are never promoted to headings.
 * Headings the model did not confirm are demoted back to paragraphs on pages the model examined.
 *
 * @param {{pages?:Array<{n:number,blocks:object[]}>,toc?:object[]}} content
 * @param {{pages?:Array<{n:number,headings?:Array<{id:string,level?:number}>,drop?:string[]}>}|null} result
 * @param {{now?:number,model?:string|null}} [options]
 * @returns {{content:object, changed:number, headingCount:number, dropCount:number}}
 */
export function applyStructureRefinement(content, result, options = {}) {
  const source = content !== null && typeof content === 'object' ? content : {}
  const pages = Array.isArray(source.pages) ? source.pages : []
  const suggestions = Array.isArray(result?.pages) ? result.pages : []
  if (pages.length === 0 || suggestions.length === 0) {
    return { content: source, changed: 0, headingCount: 0, dropCount: 0 }
  }
  const headingById = new Map()
  const dropIds = new Set()
  const confirmedPages = new Set()
  const blocksById = new Map()
  for (const page of pages) for (const block of Array.isArray(page.blocks) ? page.blocks : []) if (block !== null && typeof block === 'object') blocksById.set(block.id, block)
  const droppableKinds = new Set(['paragraph', 'heading', 'footnote', 'artifact'])
  for (const entry of suggestions) {
    const pageNumber = Number(entry?.n)
    const headings = Array.isArray(entry?.headings) ? entry.headings : []
    const drops = Array.isArray(entry?.drop) ? entry.drop : []
    // `explicit` means the model answered and reviewed this page: an empty answer is a real
    // "none of these heuristic headings are headings" and should demote them. Entries without the
    // flag (legacy/failed pages) are skipped so a failed call can never wipe a page's structure.
    if (entry?.explicit !== true && headings.length === 0 && drops.length === 0) continue
    confirmedPages.add(pageNumber)
    for (const heading of headings) {
      const id = typeof heading?.id === 'string' ? heading.id : ''
      if (id === '') continue
      const block = blocksById.get(id)
      if (block === undefined) continue
      if (!['paragraph', 'heading'].includes(String(block.kind ?? 'paragraph'))) continue
      const text = String(block.text ?? '').trim()
      // A long block is a merged heading+paragraph: promoting it would render body text as a heading.
      if (text.length > 160 || text.split(/\s+/).filter((word) => word !== '').length > 30) continue
      const level = Number(heading.level)
      headingById.set(id, Math.min(3, Math.max(1, Number.isFinite(level) ? Math.round(level) : 1)))
    }
    for (const id of drops) {
      if (typeof id !== 'string') continue
      const block = blocksById.get(id)
      if (block === undefined || !droppableKinds.has(String(block.kind ?? 'paragraph'))) continue
      dropIds.add(id)
    }
  }
  let changed = 0
  let dropCount = 0
  let headingCount = 0
  const nextPages = pages.map((page) => {
    if (!confirmedPages.has(Number(page?.n))) return page
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const nextBlocks = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (dropIds.has(block.id)) {
        changed++
        dropCount++
        continue
      }
      const level = headingById.get(block.id)
      if (level !== undefined) {
        if (block.kind !== 'heading' || block.level !== level) changed++
        nextBlocks.push({ ...block, kind: 'heading', level })
        headingCount++
      } else if (block.kind === 'heading') {
        // A heuristic heading the model did not confirm after seeing the page: demote it.
        changed++
        nextBlocks.push({ ...block, kind: 'paragraph', level: undefined })
      } else {
        nextBlocks.push(block)
      }
    }
    return { ...page, blocks: nextBlocks }
  })
  const toc = []
  for (const page of nextPages) {
    for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
      if (block.kind !== 'heading') continue
      toc.push({
        id: `ai-toc-${toc.length}`,
        title: String(block.text ?? '').slice(0, 200),
        level: Math.min(3, Math.max(1, Number(block.level) || 1)),
        blockId: block.id,
      })
      if (toc.length >= 500) break
    }
  }
  return {
    content: {
      ...source,
      pages: nextPages,
      toc,
      aiRefined: true,
      aiRefinedAt: typeof options.now === 'number' ? options.now : Date.now(),
      aiRefinedModel:
        typeof options.model === 'string'
          ? options.model
          : typeof result?.model === 'string'
            ? result.model
            : null,
    },
    changed,
    headingCount,
    dropCount,
  }
}
