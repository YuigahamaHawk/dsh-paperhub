// AI layout plan: window construction + validation of model-provided paragraph groups.
//
// The model only labels block ids. Cropping, ordering and text ownership stay deterministic; a
// hallucinated id is ignored instead of deleting content. Windows overlap so a paragraph crossing
// a page boundary is seen in full by at least one window.

export const LAYOUT_PLAN_VERSION = 5

const GROUPABLE = new Set(['paragraph'])
const TEXTUAL = new Set(['paragraph', 'list', 'caption', 'heading'])

export function buildLayoutWindows(content, options = {}) {
  const pages = Array.isArray(content?.pages) ? content.pages : []
  const size = Math.max(2, Math.min(10, Number(options.size) || 6))
  const stride = Math.max(1, Math.min(size, Number(options.stride) || 4))
  const windows = []
  for (let start = 0; start < pages.length; start += stride) {
    const slice = pages.slice(start, start + size)
    if (slice.length === 0) break
    const prepared = slice.map((page) => ({
      n: Number(page?.n) || 0,
      blocks: (Array.isArray(page?.blocks) ? page.blocks : [])
        .filter((block) => block !== null && typeof block === 'object' && TEXTUAL.has(block.kind) && typeof block.id === 'string' && String(block.text ?? '').trim() !== '')
        .map((block) => ({ id: block.id, kind: block.kind, text: String(block.text).slice(0, 6000) })),
    }))
    if (prepared.some((page) => page.blocks.length > 0)) windows.push({ id: `w${windows.length + 1}`, pages: prepared })
    if (start + size >= pages.length) break
  }
  return windows
}

function joinParagraphText(left, right) {
  const a = String(left ?? '').trimEnd()
  const b = String(right ?? '').trimStart()
  if (a === '') return b
  if (b === '') return a
  if (/[-\u2010\u2011]$/.test(a)) return `${a.slice(0, -1)}${b}`
  return `${a} ${b}`.replace(/\s+/g, ' ')
}

/**
 * Apply validated groups/captions from the AI plan.
 * - only paragraph blocks are groupable;
 * - only groups that cross a page boundary or skip intervening blocks are applied (same-page
 *   consecutive paragraphs are already deterministic, and a model mistake there is not worth it);
 * - captions are only re-labelled, never moved.
 */
export function applyLayoutPlan(content, plan) {
  const source = content !== null && typeof content === 'object' ? content : null
  if (source === null || !Array.isArray(source.pages)) return { content, merged: 0, captions: 0, windows: 0 }
  const pages = source.pages.map((page) => ({
    ...page,
    blocks: Array.isArray(page?.blocks) ? page.blocks.map((block) => ({ ...block })) : [],
  }))
  const indexOf = new Map()
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const blocks = pages[pageIndex].blocks
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex]
      if (typeof block.id === 'string' && block.id !== '') indexOf.set(block.id, { pageIndex, blockIndex, block })
    }
  }
  const parent = new Map()
  const find = (id) => {
    let current = id
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)
    return current
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(b, a)
  }
  const windows = Array.isArray(plan?.windows) ? plan.windows : []
  const captions = new Set()
  const demoteCaptions = new Set()
  for (const window of windows) {
    for (const id of Array.isArray(window?.demoteCaptions) ? window.demoteCaptions : []) {
      if (typeof id === 'string' && indexOf.has(id)) demoteCaptions.add(id)
    }
  }
  // Demote before interpreting groups: the model may put a body sentence that starts with
  // "Figure 3 ..." into a paragraph group and also flag it in demoteCaptions.
  for (const id of demoteCaptions) {
    const found = indexOf.get(id)
    if (found !== undefined) found.block.kind = 'paragraph'
  }
  for (const window of windows) {
    const captionIds = Array.isArray(window?.captions) ? window.captions : []
    for (const id of captionIds) {
      if (typeof id === 'string' && indexOf.has(id)) captions.add(id)
    }
    const groups = Array.isArray(window?.groups) ? window.groups : []
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 2) continue
      const ids = []
      for (const id of group) {
        if (typeof id !== 'string' || !indexOf.has(id)) continue
        const found = indexOf.get(id)
        if (found.block.kind !== 'paragraph') continue
        if (!ids.includes(id)) ids.push(id)
      }
      if (ids.length < 2) continue
      const sorted = ids
        .map((id) => ({ id, ...indexOf.get(id) }))
        .sort((a, b) => a.pageIndex - b.pageIndex || a.blockIndex - b.blockIndex)
      const crossesPage = sorted[0].pageIndex !== sorted[sorted.length - 1].pageIndex
      const spansGap = sorted.some((entry, index) => index > 0 && entry.pageIndex === sorted[index - 1].pageIndex && entry.blockIndex > sorted[index - 1].blockIndex + 1)
      const hasHeadingBetween = sorted.some((entry, index) => {
        if (index === 0 || entry.pageIndex !== sorted[index - 1].pageIndex) return false
        const blocks = pages[entry.pageIndex].blocks
        for (let cursor = sorted[index - 1].blockIndex + 1; cursor < entry.blockIndex; cursor++) {
          if (blocks[cursor]?.kind === 'heading') return true
        }
        return false
      })
      if (hasHeadingBetween) continue
      const anchorOpen = !/[.!?。！？:：;；]["'”’)\]]?$/.test(String(sorted[0].block.text ?? '').trim())
      if (!anchorOpen && !spansGap) continue
      // Same-page groups are accepted only when the anchor is unfinished; a model error on two
      // complete paragraphs is still rejected.
      for (let index = 1; index < sorted.length; index++) union(sorted[0].id, sorted[index].id)
    }
  }

  let captionCount = 0
  for (const id of captions) {
    const found = indexOf.get(id)
    if (found === undefined || demoteCaptions.has(id)) continue
    found.block.kind = 'caption'
    captionCount++
  }

  const groups = new Map()
  for (const [id, found] of indexOf) {
    if (found.block.kind !== 'paragraph') continue
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push({ id, ...found })
  }
  let merged = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    members.sort((a, b) => a.pageIndex - b.pageIndex || a.blockIndex - b.blockIndex)
    const anchor = members[0]
    anchor.block.sourceIds = members.flatMap(member => member.block.sourceIds ?? [member.id])
    anchor.block.continuedPages = [...new Set(members.map(member => Number(pages[member.pageIndex].n)))]
    let text = anchor.block.text
    for (let index = 1; index < members.length; index++) {
      text = joinParagraphText(text, members[index].block.text)
      members[index].block.text = ''
    }
    anchor.block.text = text
    merged++
  }
  for (const page of pages) page.blocks = page.blocks.filter((block) => String(block.text ?? '').trim() !== '' || block.kind === 'figure' || block.kind === 'formula')
  return { content: { ...source, pages }, merged, captions: captionCount, windows: windows.length }
}
