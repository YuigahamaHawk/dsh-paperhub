export const VISION_LAYOUT_VERSION = 4
export const VISUAL_KINDS = new Set(['figure', 'table', 'formula', 'algorithm', 'code', 'listing', 'theorem', 'definition', 'proof', 'box', 'other'])
const TEXT_KINDS = new Set(['paragraph', 'heading', 'caption', 'footnote', 'list', 'quote', 'artifact'])
const IMAGE_KINDS = new Set(['figure', 'table', 'formula', 'algorithm'])

export function validBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null
  const box = value.map(Number)
  if (!box.every(Number.isFinite)) return null
  const [x0, y0, x1, y1] = box
  return x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && x1 > x0 && y1 > y0 ? box : null
}

export function validateVisionPage(parsed, page) {
  if (!parsed || !Array.isArray(parsed.regions)) throw new Error('The visual model did not return a valid layout object; retry this page.')
  if (parsed.page !== undefined && Number(parsed.page) !== Number(page.n)) throw new Error('The visual model returned the wrong page number.')
  const known = new Set((page.candidates ?? []).map(block => block.id))
  const candidateById = new Map((page.candidates ?? []).map(block => [block.id, block]))
  const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(id => typeof id === 'string' && known.has(id)))]
  const regions = []
  for (const [index, value] of parsed.regions.slice(0, 80).entries()) {
    const bbox = validBox(value?.bbox)
    if (!bbox || !VISUAL_KINDS.has(value?.kind)) continue
    const confidence = value.confidence === undefined ? 1 : Number(value.confidence)
    if (!Number.isFinite(confidence) || confidence < 0.65) continue
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.88 && known.size > 3) continue
    const captionId = known.has(value.captionId) ? value.captionId : null
    regions.push({
      id: typeof value.id === 'string' ? value.id.slice(0, 60) : `r${index + 1}`,
      kind: value.kind, bbox, confidence,
      numberBbox: validBox(value.numberBbox),
      candidateIds: ids(value.candidateIds).filter(id => id !== captionId), captionId,
      afterBlockId: known.has(value.afterBlockId) ? value.afterBlockId : null,
      number: value.number === null || value.number === undefined ? null : String(value.number).replace(/^\(|\)$/g, '').slice(0, 30),
      renderAs: value.renderAs === 'text' && !IMAGE_KINDS.has(value.kind) ? 'text' : 'image',
    })
  }
  if (parsed.regions.length > 0 && regions.length === 0) throw new Error('All visual regions failed validation; the old layout was kept.')
  if (known.size > 0 && !regions.length && !parsed.textBlocks?.length && !parsed.paragraphs?.length && !parsed.captionFixes?.length) throw new Error('The visual model did not classify the page text; retry this page.')
  const textBlocks = (Array.isArray(parsed.textBlocks) ? parsed.textBlocks : []).filter(group => TEXT_KINDS.has(group?.kind)).map(group => ({ ids: ids(group.ids), kind: group.kind, level: Math.max(1, Math.min(6, Number(group.level) || 2)) })).filter(group => group.ids.length > 0).slice(0, 2000)
  const paragraphs = (Array.isArray(parsed.paragraphs) ? parsed.paragraphs : []).map(ids).filter(group => group.length > 0).slice(0, 160)
  const captionFixes = (Array.isArray(parsed.captionFixes) ? parsed.captionFixes : []).filter(fix => known.has(fix?.id) && ['caption', 'paragraph'].includes(fix.kind)).slice(0, 160).map(({ id, kind }) => ({ id, kind }))
  const owners = new Map()
  for (const [index, region] of regions.entries()) for (const id of region.candidateIds) {
    const text = String(candidateById.get(id)?.text ?? '').trim()
    if (region.kind === 'formula' && /[:：]$/.test(text) && /^[\p{L}\s,.'’–-]+[:：]$/u.test(text) && /[\p{L}]{3}/u.test(text)) {
      const error = new Error(`The formula incorrectly owns prose line ${id}: "${text.slice(0,100)}". Keep that introduction in textBlocks and assign only the actual equation lines to the formula.`)
      error.code = 'vision-ownership'; throw error
    }
    if (owners.has(id)) {
      const error = new Error(`Ambiguous visual ownership: ${id} belongs to more than one region. Return each candidate in exactly one region OR textBlocks, never both.`)
      error.code = 'vision-ownership'; throw error
    }
    owners.set(id, index)
  }
  const conflicts = [...textBlocks.flatMap(group => group.ids), ...paragraphs.flat(), ...captionFixes.map(fix => fix.id)].filter(id => owners.has(id))
  if (conflicts.length) {
    const error = new Error(`Ambiguous visual ownership: ${[...new Set(conflicts)].slice(0, 24).join(', ')} appear in both region candidateIds and textBlocks. Assign EACH LINE to exactly one role. Formula lines belong only in a formula; surrounding explanation lines belong only in textBlocks.`)
    error.code = 'vision-ownership'; throw error
  }
  const classified = new Set([...owners.keys(), ...textBlocks.flatMap(group => group.ids), ...regions.map(region => region.captionId).filter(Boolean), ...paragraphs.flat(), ...captionFixes.map(fix => fix.id)])
  const missing = [...known].filter(id => !classified.has(id))
  if (missing.length) {
    const error = new Error(`The layout omitted ${missing.length} candidate lines: ${missing.join(', ')}. Classify EVERY remaining line in textBlocks as its complete paragraph, heading, caption, footnote or artifact. Include all continuation lines; do not return a partial layout.`)
    error.code = 'vision-ownership'; throw error
  }
  return {
    regions,
    captionFixes,
    paragraphs,
    textBlocks,
    warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : []).filter(w => typeof w === 'string').map(w => w.slice(0, 300)).slice(0, 20),
  }
}
