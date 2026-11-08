import { findNearestBlockId } from './reflow.js'

const pdfBookmark = entry => typeof entry?.id === 'string' && entry.id.startsWith('pdf-toc-')
const normalizedTitle = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()

export function pdfBookmarkTarget(entry, pages) {
  const title = normalizedTitle(entry.title)
  const blocks = pages.find(page => page.n === entry.page)?.blocks ?? []
  const heading = blocks.find(block =>
    block.kind === 'heading' && normalizedTitle(block.text) === title)
  if (heading) return heading.id
  const anchored = entry.blockId && blocks.find(block => block.id === entry.blockId || block.sourceIds?.includes(entry.blockId))
  return anchored?.id ?? findNearestBlockId(pages, entry.page)
}

// Visual layout can replace the original anchor block. Keep the author's
// hierarchy and bind each bookmark to the new heading or its original page.
export function remapPdfBookmarks(content, pages) {
  const entries = (content.toc ?? []).filter(pdfBookmark)
  if (!entries.length) return []
  const oldPages = new Map(content.pages.flatMap(page => (page.blocks ?? []).map(block => [block.id, page.n])))
  return entries.map(({ blockId, ...entry }) => {
    const page = entry.page ?? oldPages.get(blockId)
    const target = pdfBookmarkTarget({ ...entry, page, blockId }, pages)
    return target ? { ...entry, page, blockId: target } : entry
  })
}

export function outlineLevels(entries, format) {
  if (!entries.length) return []
  const levels = entries.map(entry => Math.max(1, Math.min(6, Number(entry.level) || 1)))
  const base = Math.min(...levels)
  const declared = levels.map(level => level - base + 1)
  if ((format === 'epub' || entries.every(pdfBookmark)) && declared.some(level => level > 1)) return declared

  let chapter = '', numberedSection = false, letter = '', appendix = ''
  return entries.map((entry, index) => {
    const title = String(entry.title ?? '').trim()
    const number = title.match(/^(\d+(?:\.\d+){0,5})\.?\s+\S/)?.[1]
    if (number) {
      const path = number.split('.')
      if (path.length === 1) {
        chapter = path[0]
        numberedSection = false
        letter = appendix = ''
        return 1
      }
      if (path[0] === chapter) return path.length
    }
    // IEEE headings often use I., A., 1) for successive levels.
    if (/^(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})\.\s+\S/.test(title)) {
      numberedSection = true
      chapter = letter = appendix = ''
      return 1
    }
    const appendixTitle = title.match(/^appendix(?:\s+([A-Z]))?(?:\b|$)/i)
    if (appendixTitle) {
      appendix = appendixTitle[1]?.toUpperCase() ?? ''
      numberedSection = false
      chapter = letter = ''
      return 1
    }
    const subsection = title.match(/^([A-Z])\.\s+\S/)?.[1]
    if (subsection && numberedSection) {
      letter = subsection
      return 2
    }
    if (letter && /^\d+\)\s+\S/.test(title)) return 3
    const appendixNumber = title.match(/^([A-Z])((?:\.\d+){1,5})\.?\s+\S/)
    if (appendixNumber?.[1] === appendix) return appendixNumber[2].split('.').length
    return declared[index]
  })
}
