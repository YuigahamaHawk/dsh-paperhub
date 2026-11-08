// Index existing reading blocks only. No PDF rendering or model requests are needed here.
export function buildMediaIndex(blocks = []) {
  const byId = new Map(blocks.map(block => [block.id, block]))
  return blocks.flatMap((block, index) => {
    if (!['figure', 'table', 'formula', 'image', 'pageFigure'].includes(block.kind)) return []
    let caption = byId.get(block.captionId)
    const listing = ['algorithm', 'code', 'listing'].includes(block.structure)
    if (!caption && block.kind !== 'formula' && !listing) {
      // Older extraction has no explicit association. Accept only an adjacent caption on the
      // same page/chapter; never search across intervening prose or another figure.
      caption = [blocks[index + 1], blocks[index - 1]].find(candidate =>
        candidate?.kind === 'caption' && candidate.page === block.page && candidate.chapter === block.chapter)
    }
    const text = caption?.text || block.alt || ''
    const kind = listing ? block.structure : block.kind === 'formula' ? 'formula' : block.kind==='table'||block.structure==='table'||/^(?:table|表)\s*[\dA-Z]/i.test(text.trim()) ? 'table' : block.kind === 'pageFigure' ? 'page' : 'figure'
    return [{ id: block.id, block, kind, captionId: caption?.id, caption: text, number: block.number, page: block.page }]
  })
}
