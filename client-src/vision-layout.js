import { VISION_LAYOUT_VERSION, validBox, VISUAL_KINDS } from '../shared/vision-contract.js'
import { unionRects } from './pdf-geometry.js'
import {parserInlineMath} from '../shared/parser-inline.js'
import { remapPdfBookmarks } from './toc.js'
export { VISION_LAYOUT_VERSION }

const isImage = block => ['figure', 'formula', 'pageFigure', 'table'].includes(block?.kind)
const rectOf = block => block?.sourceRect ?? block?.rect
const clone = block => ({ ...block, ...(block.rect ? { rect: { ...block.rect } } : {}) })
function coverage(a, b) {
  if (!a || !b || !(a.w * a.h > 0)) return 0
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) / (a.w * a.h)
}
function joinText(blocks) {
  return blocks.reduce((text, block) => {
    const next = String(block.text ?? '').trim()
    if (!text) return next
    return /[-\u2010]$/.test(text) && /^[a-z]/.test(next) ? text.slice(0, -1) + next : `${text} ${next}`
  }, '').replace(/\s+/g, ' ')
}
function mergeGroups(blocks, groups) {
  const byId = new Map(blocks.map(block => [block.id, block]))
  const used = new Set(), removed = new Set(), ordered = []
  for (const group of groups) {
    const members = (group.ids ?? []).map(id => byId.get(id)).filter(block => block && !used.has(block.id) && !isImage(block))
    if (!members.length) continue
    for (const member of members) used.add(member.id)
    const anchor = members[0]
    if (group.kind === 'artifact') {
      if (members.some(member => String(member.text ?? '').length > 250)) { ordered.push(...members); continue }
      for (const member of members) removed.add(member.id)
      continue
    }
    anchor.text = joinText(members)
    if(group.parserSpans){const record=parserInlineMath(anchor.text,group.parserSpans,group.parserVersion);if(record)anchor.parserInlineMath=record}
    anchor.kind = group.kind ?? 'paragraph'
    anchor.sourceIds = members.flatMap(block => block.sourceIds ?? [block.id])
    anchor.sourceRects = members.flatMap(block=>block.sourceRects?.length?block.sourceRects:[rectOf(block)]).filter(Boolean)
    if(anchor.sourceRects.length)anchor.sourceRect=unionRects(anchor.sourceRects)
    if (anchor.kind === 'heading') anchor.level = group.level ?? 2
    ordered.push(anchor)
    for (const member of members.slice(1)) removed.add(member.id)
  }
  for (const block of blocks) {
    if (used.has(block.id) || removed.has(block.id)) continue
    const at = ordered.findIndex(anchor => blocks.indexOf(anchor) > blocks.indexOf(block))
    ordered.splice(at < 0 ? ordered.length : at, 0, block)
  }
  return ordered
}

// Rebuild successful pages from immutable candidates, so earlier geometry cannot
// delete prose and another run cannot duplicate or overwrite unrelated assets.
export function applyVisionLayout(content, result) {
  if (!content || !Array.isArray(content.pages)) return { content, regions: 0, created: 0, captions: 0, pages: 0 }
  const next = { ...content, pages: content.pages.map(page => ({ ...page, blocks: (page.blocks ?? []).map(clone) })) }
  let regions = 0, created = 0, captions = 0, pages = 0
  for (const answer of result?.pages ?? []) {
    if (answer?.error || (answer?.regions !== undefined && !Array.isArray(answer.regions))) continue
    const page = next.pages.find(page => Number(page.n) === Number(answer.n))
    if (!page) continue
    const source = answer.sourceBlocks ?? page.sourceBlocks ?? page.visionSourceBlocks ?? page.blocks.filter(block => !block.visionGenerated)
    if(answer.sourceBlocks)page.sourceBlocks=answer.sourceBlocks.map(clone)
    page.visionSourceBlocks = source.map(clone)
    let blocks = source.map(clone)
    const byId = new Map(blocks.map(block => [block.id, block]))
    for (const fix of answer.captionFixes ?? []) {
      const block = byId.get(fix.id)
      if (block && ['caption', 'paragraph'].includes(fix.kind)) { block.kind = fix.kind; captions++ }
    }
    const used = new Set(), consumed = new Set(), assets = []
    const captionIds = new Set((answer.regions ?? []).map(r => r.captionId).filter(Boolean))
    const paragraphIds = [...(answer.paragraphs ?? []).flat(), ...(answer.captionFixes ?? []).map(fix => fix.id), ...(answer.regions ?? []).filter(region => region.renderAs === 'text').flatMap(region => region.candidateIds ?? [])]
    const textIds = new Set([...(answer.textBlocks ?? []).filter(group => group.kind !== 'artifact').flatMap(group => group.ids ?? []), ...paragraphIds])
    const excludedIds = new Set([...(answer.textBlocks ?? []).flatMap(group => group.ids ?? []), ...paragraphIds, ...captionIds])
    for (const [index, region] of (answer.regions ?? []).entries()) {
      const bbox = validBox(region?.bbox)
      if (!bbox || !VISUAL_KINDS.has(region?.kind) || Number(region.confidence ?? 1) < 0.65 || region.renderAs === 'text') continue
      let rect = { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] }
      const candidates = (region.candidateIds ?? []).map(id => byId.get(id)).filter(block => block && !used.has(block.id) && !captionIds.has(block.id))
      const owned = candidates.filter(block => !textIds.has(block.id) && (isImage(block) || !rectOf(block) || coverage(rectOf(block), rect) > 0.1 || String(block.text ?? '').length < 200))
      // The model owns semantic membership. Align its approximate visual box to
      // the exact PDF bounds of those declared glyphs (legends, last operands,
      // subscripts). This is a coverage constraint, not a region classifier.
      const evidenceRects = owned.map(rectOf).filter(Boolean)
      if (evidenceRects.length) {
        const x0 = Math.max(0, Math.min(rect.x, ...evidenceRects.map(r => r.x)))
        const y0 = Math.max(0, Math.min(rect.y, ...evidenceRects.map(r => r.y)))
        const x1 = Math.min(1, Math.max(rect.x + rect.w, ...evidenceRects.map(r => r.x + r.w)))
        const y1 = Math.min(1, Math.max(rect.y + rect.h, ...evidenceRects.map(r => r.y + r.h)))
        rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
      let target = owned.find(isImage) ?? owned[0]
      if (!target) target = blocks.filter(block => isImage(block) && !used.has(block.id) && coverage(rectOf(block), rect) > 0.35).sort((a,b) => coverage(rectOf(b), rect) - coverage(rectOf(a), rect))[0]
      const id = target?.id ?? `p${page.n}vision${index + 1}`
      if (!target) created++
      const inside = blocks.filter(block => !captionIds.has(block.id) && !textIds.has(block.id) && !used.has(block.id) && rectOf(block) && coverage(rectOf(block), rect) > 0.85)
      const members = [...new Map([...owned, ...inside, ...(target ? [target] : [])].map(block => [block.id, block])).values()]
      for (const block of members) { used.add(block.id); consumed.add(block.id) }
      const asset = {
        id, kind: region.kind === 'formula' ? 'formula' : 'figure', text: joinText(members),
        page: page.n, rect, structure: region.kind, number: region.number ?? undefined,
        pageWidth: Number(page.width) || 612, pageHeight: Number(page.height) || 792, fontSize: Number(page.fontSize) || Number(target?.fontSize) || 10,
        captionId: region.captionId ?? undefined, visionGenerated: true, layoutSource: answer.source??'vision',
        recognizedLatex:region.latex,
        confidence: Number(region.confidence ?? 1), sourceIds: members.flatMap(block => block.sourceIds ?? [block.id]),
        visionRect: { x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] },
      }
      if (region.kind === 'formula' && region.number) {
        const printed = (page.equationNumbers ?? []).filter(item => String(item.number) === String(region.number) && item.rect.y + item.rect.h / 2 >= rect.y && item.rect.y + item.rect.h / 2 <= rect.y + rect.h).sort((a,b) => b.rect.x - a.rect.x)[0]
        const box = validBox(region.numberBbox)
        asset.numberRect = printed?.rect ?? (box ? { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] } : undefined)
        asset.numberPlacedInImage = !asset.numberRect
      }
      assets.push({ block: asset, region, position: target ? blocks.indexOf(target) : -1 })
      if (byId.has(region.captionId)) { byId.get(region.captionId).kind = 'caption'; captions++ }
      regions++
    }
    // A valid model box can still clip part of a neighboring line. The text
    // stays selectable outside the asset; it must not appear a second time in
    // the image. Mask only the exact glyph runs that are NOT owned by this
    // region, never an entire paragraph's bounding rectangle. This also keeps
    // captions, running headers and footnotes out of generous model boxes.
    for (const { block, region } of assets) {
      // Model coordinates are approximate. Preserve thin table rules and
      // antialiased edge strokes with a small physical guard band; text masks
      // are calculated against that final crop as well. White margins are
      // removed after rendering, so this does not add a visible paper border.
      const pad = block.kind === 'formula' ? Math.min(2, Math.max(0.75, block.fontSize * 0.15)) : Math.min(10, Math.max(3, block.fontSize * 0.75))
      const px = pad / (Number(page.width) || 612), py = pad / (Number(page.height) || 792)
      const [left, top, right, bottom] = validBox(region.clipBox) ?? [0, 0, 1, 1]
      const x0 = Math.max(left, block.rect.x - px), y0 = Math.max(top, block.rect.y - py)
      block.cropRect = { x: x0, y: y0, w: Math.min(right, block.rect.x + block.rect.w + px) - x0, h: Math.min(bottom, block.rect.y + block.rect.h + py) - y0 }
      const ownedIds = new Set(block.sourceIds)
      if (block.kind === 'formula') {
        // The page row supplies safe geometry, while the declared formula
        // glyphs supply its horizontal content span. Keep vertical room for
        // vector accents/fraction rules; exclude isolated prose punctuation
        // at a different column's left margin.
        const ink = unionRects(source.filter(item => ownedIds.has(item.id)).flatMap(item => item.sourceRects?.length ? item.sourceRects : [rectOf(item)]).filter(Boolean))
        if (ink) {
          const margin = Math.max(1.5, block.fontSize * 0.2) / block.pageWidth
          const left = Math.max(block.cropRect.x, ink.x - margin)
          const right = Math.min(block.cropRect.x + block.cropRect.w, ink.x + ink.w + margin)
          if (right > left) block.cropRect = { ...block.cropRect, x: left, w: right - left }
        }
      }
      const otherIds = new Set(assets.filter(asset => asset.block !== block).flatMap(asset => asset.block.sourceIds))
      block.exclusionRects = source.filter(item => !ownedIds.has(item.id) && (excludedIds.has(item.id) || otherIds.has(item.id)))
        .flatMap(item => item.sourceRects?.length ? item.sourceRects : [rectOf(item)])
        .filter(Boolean)
        .map(rect => ({ ...rect }))
    }
    blocks = blocks.filter(block => !consumed.has(block.id) && (!isImage(block) || !page.sourceBlocks))
    blocks = mergeGroups(blocks, [...(answer.textBlocks ?? []), ...(answer.paragraphs ?? []).map(ids => ({ ids, kind: 'paragraph' }))])
    for (const { block, region, position } of assets) {
      const matches = (item, id) => item.id === id || item.sourceIds?.includes(id)
      let at = -1
      if (region.afterBlockId) {
        const anchor = blocks.findIndex(item => matches(item, region.afterBlockId))
        if (anchor >= 0) { at = anchor + 1; while (at < blocks.length && blocks[at].visionGenerated && blocks[at].rect.y <= block.rect.y) at++ }
      }
      if (at < 0 && region.captionId) {
        const caption = blocks.findIndex(item => matches(item, region.captionId))
        if (caption >= 0) at = caption + (rectOf(blocks[caption])?.y < block.rect.y ? 1 : 0)
      }
      if (at < 0) at = blocks.findIndex(item => rectOf(item) && rectOf(item).y >= block.rect.y)
      if (at < 0) at = position >= 0 ? Math.min(position, blocks.length) : blocks.length
      blocks.splice(at, 0, block)
    }
    page.blocks = blocks
    page.layoutFailed=false
    page.vision = { version: VISION_LAYOUT_VERSION, engine:answer.source??'vision',at: Date.now(), cached: answer.cached === true, model: result.model ?? '', evidence: answer.evidence ?? null, request: answer.request ?? null, regions: assets.length }
    pages++
  }
  next.figurePages = next.pages.filter(page => page.blocks.some(isImage)).map(page => page.n)
  next.toc = remapPdfBookmarks(content, next.pages)
  if (!next.toc.length) next.toc = next.pages.flatMap(page => page.blocks.filter(block => block.kind === 'heading').map(block => ({ id: 'toc-' + block.id, blockId: block.id, title: block.text, level: block.level ?? 2 })))
  if (!next.toc.length) next.toc = content.toc ?? []
  return { content: next, regions, created, captions, pages }
}
