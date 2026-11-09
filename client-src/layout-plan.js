import { validateInlineMath } from '../shared/inline-math.js'

export const LAYOUT_PLAN_VERSION = 6

const TEXTUAL = new Set(['paragraph', 'list', 'caption', 'heading'])
const FLOATS = new Set(['figure', 'table', 'algorithm', 'code', 'listing', 'caption', 'footnote', 'artifact'])
const TERMINAL = /[.!?。！？]["'”’）)\]]*$/u
const OPEN_END = /[,，、:：;；\u00ad-]$|\b(?:and|or|of|for|to|by|in|is|with|using|that|the|a|an)$/iu
const CJK_END = /[\p{Script=Han}，、；：]$/u
const CJK_START = /^\p{Script=Han}/u
const visualKind = block => block.structure ?? block.kind
const mediaRect = block => block.visionRect ?? block.sourceRect ?? block.rect

function isPageNumber(block) {
  const rect = block.sourceRect ?? block.rect
  return ['paragraph', 'footnote', 'artifact'].includes(block.kind) && rect && rect.w < .20 && (rect.y < .07 || rect.y + rect.h > .93) &&
    /^(?:page\s+|第\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:[/／]|of)\s*\d+|\s*页)?$/iu.test(String(block.text ?? '').trim())
}

export function buildLayoutWindows(content, options = {}) {
  const pages = restoreParagraphFlow(content)?.pages ?? []
  const size = Math.max(2, Math.min(10, Number(options.size) || 6))
  const stride = Math.max(1, Math.min(size, Number(options.stride) || 4))
  const windows = []
  for (let start = 0; start < pages.length; start += stride) {
    const prepared = pages.slice(start, start + size).map(page => ({
      n: Number(page.n),
      blocks: (page.blocks ?? []).flatMap(block => {
        if (typeof block?.id !== 'string' || !block.id || isPageNumber(block)) return []
        const kind = visualKind(block)
        if (TEXTUAL.has(kind) && String(block.text ?? '').trim()) return [{ id: block.id, kind, text: block.text.slice(0, 6000) }]
        // Tell the model why adjacent prose is separated without sending image labels or table cells.
        return FLOATS.has(kind) || ['formula', 'pageFigure'].includes(kind)
          ? [{ id: block.id, kind, text: '[' + kind + ']' }] : []
      }),
    }))
    if (prepared.some(page => page.blocks.some(block => block.kind === 'paragraph'))) windows.push({ id: 'w' + (windows.length + 1), pages: prepared })
    if (start + size >= pages.length) break
  }
  return windows
}

function edgeLine(block, tail = false) {
  const rects = block.sourceRects
  if (!rects?.length) return null
  const first = tail ? rects.at(-1) : rects[0]
  const sameLine = rect => Math.abs(rect.y + rect.h / 2 - first.y - first.h / 2) <= .004
  const line = rects.filter(sameLine)
  const next = tail ? rects.find(rect => !sameLine(rect)) : rects.find(rect => rect.y > first.y + .004)
  if (!next) return null
  return { left: Math.min(...line.map(rect => rect.x)), right: Math.max(...line.map(rect => rect.x + rect.w)), next }
}

function hasIndent(block) {
  const line = edgeLine(block)
  return line && line.left - line.next.x > .012 && line.left - line.next.x < .065
}

function hasFloatingGap(left, right, floats) {
  const tail = left.sourceRects?.at(-1) ?? mediaRect(left)
  const head = right.sourceRects?.[0] ?? mediaRect(right)
  if (!tail || !head || head.y - tail.y - tail.h < .015) return false
  return floats.some(rect => {
    const sharesColumn = [tail, head].every(line => line.x + line.w > rect.x && line.x < rect.x + rect.w)
    return sharesColumn && Math.min(rect.y + rect.h, head.y) - Math.max(rect.y, tail.y + tail.h) > .012
  })
}

function continuesSentence(left, right) {
  if (TERMINAL.test(left) || !right) return false
  if (CJK_END.test(left) && CJK_START.test(right)) return true
  if (/^[\p{Ll}]/u.test(right)) return true
  return OPEN_END.test(left) && /^(?:[\p{L}\d("“‘$]|\\)/u.test(right)
}

function continuesIndentedFlow(left, right, nearby) {
  const tail = edgeLine(left, true), head = edgeLine(right)
  if (!tail || !head || Math.abs(head.left - head.next.x) > .006) return false
  // In a document that indents new paragraphs, a flush-left continuation
  // after a full line can carry on even when the break falls between sentences.
  const columnWidth = tail.next.w
  return columnWidth > .24 && tail.right - tail.left >= .90 * columnWidth &&
    nearby.some(block => block !== left && block !== right && hasIndent(block))
}

function joinParagraphs(members) {
  let text = ''
  const formulas = []
  let origin
  for (const { block } of members) {
    const original = String(block.text ?? ''), part = original.trim()
    const record = block.parserInlineMath
    if (text && /[\p{L}][\u00ad\u2010-]$/u.test(text) && /^\p{Ll}/u.test(part) &&
        !/[\p{L}][-\u2010][\p{L}]+[-\u2010]$/u.test(text) && formulas.at(-1)?.end !== text.length) {
      text = text.slice(0, -1)
    } else if (text && !(CJK_END.test(text) && CJK_START.test(part))) {
      text += ' '
    }
    if (record?.source === original && Array.isArray(record.segments)) {
      let offset = text.length - (original.length - original.trimStart().length)
      for (const segment of record.segments) {
        const value = segment?.type === 'math' ? segment.source : segment?.text
        if (typeof value !== 'string') break
        const end = offset + value.length
        if (segment.type === 'math') formulas.push({ start: offset, end, segment })
        offset = end
      }
      origin ??= record.origin
    }
    text += part
  }
  if (!formulas.length) return { text, parserInlineMath: undefined }
  const segments = []
  let offset = 0
  for (const { start, end, segment } of formulas) {
    if (start < offset || text.slice(start, end) !== segment.source) continue
    if (start > offset) segments.push({ type: 'text', text: text.slice(offset, start) })
    segments.push(segment)
    offset = end
  }
  if (!offset) return { text, parserInlineMath: undefined }
  if (offset < text.length) segments.push({ type: 'text', text: text.slice(offset) })
  try {
    const record = validateInlineMath({ segments }, text, { sourceAlignedParser: true })
    return { text, parserInlineMath: { ...record, origin, enabled: true, request: null } }
  } catch {
    return { text, parserInlineMath: undefined }
  }
}

// Undo only the paragraph presentation layer. Per-page retry always starts
// from the recognized blocks, including fragments previously moved off-page.
export function restoreParagraphFlow(content) {
  if (!content?.pages?.some(page => Array.isArray(page.flowBaseBlocks))) return content
  const pages = content.pages.map(page => {
    if (!Array.isArray(page.flowBaseBlocks)) return page
    const { flowBaseBlocks, ...base } = page
    return { ...base, blocks: flowBaseBlocks }
  })
  return { ...content, pages }
}

export function applyLayoutPlan(content, plan, { inferContinuations = false, paragraphsOnly = false, failedPages = [] } = {}) {
  const source = restoreParagraphFlow(content)
  if (!Array.isArray(source?.pages)) return { content, merged: 0, captions: 0, windows: 0 }
  const pages = source.pages.map(page => ({ ...page, blocks: (page.blocks ?? []).map(block => ({ ...block })) }))
  const windows = Array.isArray(plan?.windows) ? plan.windows.filter(window => window && !window.error) : []
  const byId = new Map(pages.flatMap(page => page.blocks.map(block => [block.id, block])))
  const paired = new Set(pages.flatMap(page => page.blocks.map(block => block.captionId).filter(Boolean)))
  let captionCount = 0
  if (!paragraphsOnly) for (const window of windows) {
    for (const id of window.demoteCaptions ?? []) {
      const block = byId.get(id)
      if (block?.kind === 'caption' && !paired.has(id)) block.kind = 'paragraph'
    }
    for (const id of window.captions ?? []) {
      const block = byId.get(id)
      if (block && ['paragraph', 'caption'].includes(block.kind) && !(window.demoteCaptions ?? []).includes(id)) {
        block.kind = 'caption'
        captionCount++
      }
    }
  }

  const unavailable = new Set(failedPages.map(Number))
  const entries = new Map(), edges = new Map(), removed = new Set(), changed = new Set()
  let previous = null, interrupted = false, previousPage = null
  for (const [pageIndex, page] of pages.entries()) {
    if (previousPage !== null && Number(page.n) !== previousPage + 1) previous = null
    previousPage = Number(page.n)
    if (page.layoutFailed || unavailable.has(previousPage) || !page.blocks.length) {
      previous = null
      continue
    }
    const floats = page.blocks.filter(block => FLOATS.has(visualKind(block)) && block.visionGenerated).map(mediaRect).filter(Boolean)
    for (const block of page.blocks) {
      if (inferContinuations && isPageNumber(block)) {
        removed.add(block.id)
        changed.add(pageIndex)
        interrupted = true
        continue
      }
      if (FLOATS.has(visualKind(block))) {
        interrupted = true
        continue
      }
      if (block.kind !== 'paragraph' || !String(block.text ?? '').trim()) {
        previous = null
        continue
      }
      const entry = { block, pageIndex, order: entries.size }
      entries.set(block.id, entry)
      if (previous) edges.set(block.id, { left: previous, right: entry, interrupted:
        interrupted || previous.pageIndex !== pageIndex || hasFloatingGap(previous.block, block, floats) })
      previous = entry
      interrupted = false
    }
  }

  const accepted = new Map()
  const accept = edge => accepted.set(edge.right.block.id, edge.left.block.id)
  if (inferContinuations) for (const edge of edges.values()) {
    if (!edge.interrupted) continue
    const left = edge.left.block, right = edge.right.block
    if (hasIndent(right)) continue
    const nearby = [...pages[edge.left.pageIndex].blocks, ...pages[edge.right.pageIndex].blocks].filter(block => block.kind === 'paragraph')
    if (continuesSentence(left.text.trimEnd(), right.text.trimStart()) || continuesIndentedFlow(left, right, nearby)) accept(edge)
  }
  for (const window of windows) for (const group of window.groups ?? []) {
    if (!Array.isArray(group)) continue
    const members = [...new Set(group)].map(id => entries.get(id)).filter(Boolean).sort((a, b) => a.order - b.order)
    if (members.length < 2) continue
    const joins = members.slice(1).map(member => edges.get(member.block.id))
    if (joins.some((edge, index) => edge?.left !== members[index])) continue
    if (joins.some(({ left, right, interrupted }) => hasIndent(right.block) ||
        !interrupted && TERMINAL.test(left.block.text.trimEnd()))) continue
    for (const edge of joins) accept(edge)
  }

  const groups = new Map(), roots = new Map()
  for (const [id, entry] of entries) {
    const root = roots.get(accepted.get(id)) ?? id
    roots.set(id, root)
    if (root === id) groups.set(root, [])
    groups.get(root).push(entry)
  }
  let merged = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const anchor = members[0].block
    const pageNumbers = [...new Set(members.flatMap(({ block, pageIndex }) => block.continuedPages ?? [Number(pages[pageIndex].n)]))]
    const sourceIds = [...new Set(members.flatMap(({ block }) => [block.id, ...(block.sourceIds ?? [])]))]
    Object.assign(anchor, joinParagraphs(members), { continuedPages: pageNumbers, sourceIds })
    for (const { pageIndex } of members) changed.add(pageIndex)
    for (const { block } of members.slice(1)) removed.add(block.id)
    merged++
  }
  for (const [index, page] of pages.entries()) {
    if (!changed.has(index)) continue
    page.blocks = page.blocks.filter(block => !removed.has(block.id))
    if (inferContinuations) page.flowBaseBlocks = source.pages[index].blocks
  }
  return { content: { ...source, pages }, merged, captions: captionCount, windows: windows.length }
}
