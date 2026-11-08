/** Translation eligibility is based on content role and section boundaries, never an author/year-looking prose prefix. */
export function isTranslatable(block) {
  if (!block || typeof block.id !== 'string' || !block.id) return false
  if (['image', 'figure', 'pageFigure', 'formula', 'code'].includes(block.kind)) return false
  const text = String(block.text ?? '').trim()
  if (text.length < 3) return false
  if (/^(?:https?:\/\/|doi:\s*10\.)/i.test(text) && text.split(/\s+/).length < 20) return false
  return true
}

export function translatableIndex(blocks) {
  const index = new Map()
  let inReferences = false
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = String(block?.text ?? '').trim()
    if (/^(?:(?:[IVXLCDM]+|[A-Z]|\d+(?:\.\d+)*)[.\s]+)?(?:references|bibliography|参考文献|参考资料)\s*[:：]?$/i.test(text)) { inReferences = true; continue }
    if (inReferences) {
      if (block.kind === 'heading' && /^(?:appendix|appendices|supplementary|附录|[A-Z][.\s])/i.test(text)) inReferences = false
      else continue
    }
    if (isTranslatable(block)) index.set(block.id, block)
  }
  return index
}
