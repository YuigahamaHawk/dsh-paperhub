import { validBox } from '../shared/vision-contract.js'
import { captionLabel as labelOf, isPanelLabel, startsWithMediaLabel as startsWithLabel } from '../shared/caption-label.js'
import { checkFigureGeometry } from './figure-geometry.js'

const isMedia = region => ['figure', 'table'].includes(region.kind) && region.renderAs !== 'text'
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
const intersection = (a, b) => overlap(a[0], a[2], b[0], b[2]) * overlap(a[1], a[3], b[1], b[3])
const area = b => (b[2] - b[0]) * (b[3] - b[1])
const isFigure = region => region.kind === 'figure' && isMedia(region) && validBox(region.bbox)
const envelope = boxes => boxes.length ? [
  Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
  Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3])),
] : null

function blockBox(block) {
  const rect = block.sourceRect ?? block.rect
  return rect && validBox([rect.x, rect.y, rect.x + rect.w, rect.y + rect.h])
}

const isNumberedReference = text => startsWithLabel(text) && !labelOf(text)
const groupText = (group, byId) => group.ids.map(id => byId.get(id)?.text ?? '').join(' ').trim()
const groupBox = (group, byId) => envelope(group.ids.map(id => byId.get(id)).filter(Boolean).map(blockBox).filter(Boolean))

function splitCaptionGroups(groups, blocks) {
  return groups.flatMap(group => {
    if (group.kind !== 'caption') return [group]
    const parts = []
    let ids = [], previous
    for (const id of group.ids) {
      const block = blocks.get(id)
      const box = block && blockBox(block)
      if (ids.length && (labelOf(block?.text) || isPanelLabel(block?.text) ||
          previous && box && box[1] - previous[3] > .023)) {
        parts.push({ ...group, ids })
        ids = []
      }
      ids.push(id)
      previous = box
    }
    if (ids.length) parts.push({ ...group, ids })
    return parts
  })
}

function readCaptions(source, answer) {
  const blocks = new Map(source.map(block => [block.id, block]))
  const fixes = new Map((answer.captionFixes ?? []).map(({ id, kind }) => [id, kind]))
  const claims = new Set(answer.regions.map(region => region.captionId).filter(Boolean))
  const captions = []
  const assigned = new Set()
  const add = (ids, group, explicit) => {
    const members = ids.filter(id => !assigned.has(id) && fixes.get(id) !== 'paragraph').map(id => blocks.get(id)).filter(Boolean)
    if (!members.length) return
    const text = members.map(block => String(block.text ?? '').trim()).join(' ').trim()
    if (!text || group?.captionKind !== 'table' && isPanelLabel(text)) return
    const label = labelOf(text)
    // A declared caption can be unnumbered. Short in-plot labels, panel letters
    // and body references cannot establish an unnumbered caption.
    const unnumbered = explicit && (['figure', 'table'].includes(group?.captionKind) || ids.some(id => claims.has(id))) &&
      !startsWithLabel(text) && (text.match(/\p{L}/gu)?.length ?? 0) >= 12
    if (!label && !unnumbered) return
    const memberIds = members.map(block => block.id)
    for (const id of memberIds) assigned.add(id)
    captions.push({
      ids: memberIds, group, label, kind: label?.kind ?? group?.captionKind, explicit,
      bbox: envelope(members.map(blockBox).filter(Boolean)),
    })
  }
  for (const group of answer.textBlocks ?? []) if (group.kind === 'caption') add(group.ids, group, true)
  for (const block of source) {
    const label = labelOf(String(block.text ?? ''))
    const explicit = fixes.get(block.id) === 'caption' || block.kind === 'caption' && (label?.separated || claims.has(block.id))
    if (explicit || label && (label.separated || block.kind === 'caption' || claims.has(block.id))) {
      add([block.id], null, explicit)
    }
  }
  const groups = answer.textBlocks ?? []
  for (const caption of captions.filter(value => value.label && value.group && value.bbox)) {
    // Recover consecutive caption lines split into separate engine groups.
    // A new numbered label or a second explicit asset claim starts a new object.
    let index = groups.indexOf(caption.group) + 1
    for (; index < groups.length && groups[index].kind === 'caption'; index++) {
      const group = groups[index], members = group.ids.map(id => blocks.get(id)).filter(Boolean)
      const text = members.map(block => String(block.text ?? '')).join(' ').trim()
      if (!text || startsWithLabel(text) || isPanelLabel(text) || group.ids.some(id => assigned.has(id) || claims.has(id))) break
      const box = envelope(members.map(blockBox).filter(Boolean))
      const aligned = box && (Math.abs(box[0] - caption.bbox[0]) <= .025 ||
        Math.abs(box[0] + box[2] - caption.bbox[0] - caption.bbox[2]) <= .05)
      if (!aligned || box[1] < caption.bbox[3] - .004 ||
          box[1] - caption.bbox[3] > .016 || (text.match(/\p{L}/gu)?.length ?? 0) < 8) break
      caption.ids.push(...group.ids)
      caption.bbox = envelope([caption.bbox, box])
      for (const id of group.ids) assigned.add(id)
    }
  }
  return captions
}

function nearCaption(caption, region, captions, allowWithoutBox) {
  if (caption.kind && caption.kind !== region.kind) return false
  const box = validBox(region.bbox), label = caption.bbox
  if (!box || !label) return allowWithoutBox
  const width = Math.min(box[2] - box[0], label[2] - label[0])
  const gap = Math.max(box[1], label[1]) - Math.min(box[3], label[3])
  if (gap > .085 || gap < -.022) return false
  const sharedWidth = overlap(box[0], box[2], label[0], label[2])
  // A short left-aligned caption can start well outside a centered plot.
  const shortLeftAligned = caption.label && label[0] < box[0] && label[2] - label[0] < .30 &&
    sharedWidth >= .025 && gap <= .04
  if (sharedWidth < .45 * width && !shortLeftAligned) return false
  const between = [Math.min(box[3], label[3]), Math.max(box[1], label[1])]
  return !captions.some(other => {
    const obstacle = other.bbox
    return other !== caption && other.label && obstacle &&
      overlap(box[0], box[2], obstacle[0], obstacle[2]) > .55 * Math.min(box[2] - box[0], obstacle[2] - obstacle[0]) &&
      obstacle[1] >= between[0] - .003 && obstacle[3] <= between[1] + .003
  })
}

function matchCaption(region, captions) {
  const claimed = captions.find(caption => caption.ids.includes(region.captionId))
  const nearby = captions.filter(caption => caption.label && nearCaption(caption, region, captions, false))
  const expectedSide = nearby.filter(({ bbox }) => region.kind === 'figure'
    ? bbox[1] >= region.bbox[3] - .012 : bbox[3] <= region.bbox[1] + .012)
  // When a caption sits between two objects, test their normal caption sides
  // before trusting a recognizer's parent or number. Reversed originals are
  // still supported when no credible caption exists on the normal side.
  const choices = expectedSide.length ? expectedSide : nearby
  const exact = choices.filter(caption => region.number && caption.label.number.toUpperCase() === String(region.number).toUpperCase())
  if (exact.length === 1) return exact[0]
  if (claimed && (!expectedSide.length || expectedSide.includes(claimed)) && nearCaption(claimed, region, captions, true)) return claimed
  if (choices.length === 1) return choices[0]
  return null
}

function mergePanels(panels, caption, captions, answer, source) {
  if (panels.length === 1) return panels[0]
  const boxes = panels.map(panel => validBox(panel.bbox))
  if (panels[0].kind !== 'figure' || boxes.some(box => !box)) return null
  const bbox = envelope(boxes)
  const owned = new Set(panels.flatMap(panel => panel.candidateIds ?? []))
  const captionIds = new Set(captions.flatMap(label => label.ids))
  const blocked = answer.regions.some(region => !panels.includes(region) && region.renderAs !== 'text' &&
    validBox(region.bbox) && intersection(bbox, region.bbox) > .2 * area(region.bbox))
  if (blocked || (caption.bbox && intersection(bbox, caption.bbox) > .2 * area(caption.bbox))) return null
  if (captions.some(other => other !== caption && other.bbox && intersection(bbox, other.bbox) > .2 * area(other.bbox))) return null
  const groups = [...(answer.textBlocks ?? []), ...(answer.paragraphs ?? []).map(ids => ({ ids, kind: 'paragraph' }))]
  const prose = new Set(groups.filter(group => ['paragraph', 'heading', 'list', 'quote', 'footnote'].includes(group.kind)).flatMap(group => group.ids))
  for (const block of source) {
    if (owned.has(block.id) || captionIds.has(block.id) || !prose.has(block.id)) continue
    const box = blockBox(block)
    if (box && intersection(bbox, box) > .2 * area(box) && (block.text?.length ?? 0) > 16) return null
  }
  return { ...panels[0], bbox, clipBox: undefined, candidateIds: [...owned] }
}

function neighboringPanels(a, b) {
  const width = Math.min(a[2] - a[0], b[2] - b[0])
  const height = Math.min(a[3] - a[1], b[3] - b[1])
  const horizontalGap = Math.max(a[0], b[0]) - Math.min(a[2], b[2])
  const verticalGap = Math.max(a[1], b[1]) - Math.min(a[3], b[3])
  return horizontalGap >= -.014 && horizontalGap <= .15 && overlap(a[1], a[3], b[1], b[3]) >= .7 * height ||
    verticalGap >= -.012 && verticalGap <= .045 && overlap(a[0], a[2], b[0], b[2]) >= .7 * width
}

function ownedPlotLabels(answer, panels, caption, labels, byId) {
  const boxes = panels.map(panel => panel.bbox)
  const claimedBy = new Map(answer.regions.filter(region => region.captionId).map(region => [region.captionId, region]))
  return labels.filter(group => {
    const box = groupBox(group, byId), text = groupText(group, byId)
    if (!box || !text || startsWithLabel(text) ||
        caption.bbox && intersection(box, caption.bbox) > .15 * area(box)) return false
    const panel = isPanelLabel(text)
    const claimant = group.ids.map(id => claimedBy.get(id)).find(Boolean)
    const misplacedLegend = claimant && !isMedia(claimant) && /[+▲▼◆●■↑↓]/u.test(text) &&
      overlap(box[0], box[2], claimant.bbox[0], claimant.bbox[2]) === 0
    return boxes.some(bounds => {
      if (overlap(bounds[0], bounds[2], box[0], box[2]) < .65 * (box[2] - box[0])) return false
      if (panel) return box[1] >= bounds[3] - .012 && box[3] - bounds[3] <= .032
      return misplacedLegend && box[3] <= bounds[1] + .006 && bounds[1] - box[3] <= .022
    })
  })
}

function prepareFigurePanels(answer, captions, source) {
  const figures = answer.regions.filter(isFigure)
  const owners = new Map(figures.map(region => [region, matchCaption(region, captions)]))
  const proposals = new Map()
  for (const caption of new Set([...owners.values()].filter(value => value?.label && value.bbox))) {
    const seeds = figures.filter(region => owners.get(region) === caption)
    const above = seeds.every(region => region.bbox[3] <= caption.bbox[1] + .012)
    const below = seeds.every(region => region.bbox[1] >= caption.bbox[3] - .012)
    if (!above && !below) continue
    const reached = new Set(seeds)
    for (const region of reached) for (const peer of figures) {
      if (reached.has(peer) || owners.get(peer) || !neighboringPanels(region.bbox, peer.bbox)) continue
      if (above && peer.bbox[3] > caption.bbox[1] + .012 || below && peer.bbox[1] < caption.bbox[3] - .012) continue
      reached.add(peer)
      if (!proposals.has(peer)) proposals.set(peer, [])
      proposals.get(peer).push(caption)
    }
  }
  const replacements = new Map(), reassigned = new Set()
  const byId = new Map(source.map(block => [block.id, block]))
  const captionIds = new Set(captions.filter(caption => ['figure', 'table'].includes(caption.kind)).flatMap(caption => caption.ids))
  const labels = (answer.textBlocks ?? []).filter(group => group.kind === 'caption' && group.ids.every(id => !captionIds.has(id)))
  for (const caption of new Set([...owners.values()].filter(Boolean))) {
    const seeds = figures.filter(region => owners.get(region) === caption)
    const extra = figures.filter(region => proposals.get(region)?.length === 1 && proposals.get(region)[0] === caption)
    const panels = [...seeds, ...extra]
    const region = mergePanels(panels, caption, captions, answer, source)
    if (!region) continue
    const attached = ownedPlotLabels(answer, panels, caption, labels.filter(group => !reassigned.has(group)), byId)
    if (panels.length === 1 && !attached.length) continue
    for (const group of attached) reassigned.add(group)
    replacements.set(panels[0], {
      ...region, captionId: caption.ids[0], afterBlockId: null,
      bbox: envelope([region.bbox, ...attached.map(group => groupBox(group, byId))]),
      candidateIds: [...new Set([...(region.candidateIds ?? []), ...attached.flatMap(group => group.ids)])],
    })
    for (const panel of panels.slice(1)) replacements.set(panel, null)
  }
  const adopted = new Set([...reassigned].flatMap(group => group.ids))
  return {
    ...answer,
    textBlocks: (answer.textBlocks ?? []).filter(group => !reassigned.has(group)),
    captionFixes: (answer.captionFixes ?? []).filter(fix => !adopted.has(fix.id)),
    regions: answer.regions.map(region => replacements.has(region) ? replacements.get(region) : region).filter(Boolean)
      .map(region => adopted.has(region.captionId) ? { ...region, captionId: null, afterBlockId: null } : region),
  }
}

/** Apply the same source-backed figure/table contract after either recognizer. */
export function constrainMediaCaptions(page, answer, ink) {
  if (answer.error) return answer
  const source = answer.sourceBlocks ?? page.sourceBlocks ?? page.visionSourceBlocks ?? page.blocks ?? []
  const referenceIds = new Set(source.filter(block => isNumberedReference(String(block.text ?? ''))).map(block => block.id))
  const byId = new Map(source.map(block => [block.id, block]))
  answer = {
    ...answer,
    textBlocks: splitCaptionGroups(answer.textBlocks ?? [], byId).map(group => group.kind === 'caption' && referenceIds.has(group.ids[0])
      ? { ...group, kind: 'paragraph', captionKind: undefined } : group),
    captionFixes: (answer.captionFixes ?? []).map(fix => referenceIds.has(fix.id) ? { ...fix, kind: 'paragraph' } : fix),
  }
  let captions = readCaptions(source, answer)
  // Discard unsupported associations while keeping the visual proposals.
  const prepared = { ...answer, regions: answer.regions.map(region => {
    if (!isMedia(region)) return region
    const caption = matchCaption(region, captions)
    return { ...region, captionId: caption?.ids[0] ?? null }
  }) }
  const checked = checkFigureGeometry(page, ink ? prepareFigurePanels(prepared, captions, source) : prepared, ink)
  captions = readCaptions(source, checked)
  const matches = new Map()
  for (const region of checked.regions.filter(isMedia)) {
    const caption = matchCaption(region, captions)
    if (!caption) return { ...checked, error: `Cannot verify a unique caption for ${region.kind}${region.number ? ' ' + region.number : ''}`, original: true }
    if (!matches.has(caption)) matches.set(caption, [])
    matches.get(caption).push(region)
  }
  const missing = captions.find(caption => caption.explicit && ['figure', 'table'].includes(caption.kind) && !matches.has(caption))
  if (missing) return { ...checked, error: `Cannot verify the ${missing.kind} for its caption${missing.label ? ' ' + missing.label.number : ''}`, original: true }

  const paired = new Map()
  for (const [caption, panels] of matches) {
    const region = mergePanels(panels, caption, captions, checked, source)
    if (!region) return { ...checked, error: 'Several visual regions compete for one caption', original: true }
    paired.set(panels[0], { ...region, captionId: caption.ids[0], number: caption.label?.number ?? region.number })
    for (const panel of panels.slice(1)) paired.set(panel, null)
  }
  if (!matches.size) return { ...checked, mediaContract: true }

  // Keep each caption at its text-group position. Transfer its source IDs from
  // the previous owner, so the same text cannot also occur in prose or a crop.
  const owner = new Map([...matches.keys()].flatMap(caption => caption.ids.map(id => [id, caption])))
  const groups = [], placed = new Set()
  const place = caption => {
    if (placed.has(caption)) return
    placed.add(caption)
    groups.push({ ids: caption.ids, kind: 'caption' })
  }
  const positions = new Map(source.map(({ id }, index) => [id, index]))
  const ungrouped = [...matches.keys()].filter(caption => !caption.group).sort((a, b) => positions.get(a.ids[0]) - positions.get(b.ids[0]))
  for (const group of checked.textBlocks ?? []) {
    const first = positions.get(group.ids[0])
    while (ungrouped.length && positions.get(ungrouped[0].ids[0]) < first) place(ungrouped.shift())
    if (group.ids.every(id => !owner.has(id))) {
      groups.push(group)
      continue
    }
    let remaining = []
    const flush = () => {
      if (remaining.length) groups.push({ ...group, ids: remaining, parserSpans: undefined })
      remaining = []
    }
    for (const id of group.ids) {
      if (owner.has(id)) { flush(); place(owner.get(id)) }
      else remaining.push(id)
    }
    flush()
  }
  for (const caption of matches.keys()) place(caption)
  return {
    ...checked,
    mediaContract: true,
    textBlocks: groups,
    paragraphs: (checked.paragraphs ?? []).map(ids => ids.filter(id => !owner.has(id))).filter(ids => ids.length),
    captionFixes: (checked.captionFixes ?? []).filter(({ id }) => !owner.has(id)),
    regions: checked.regions.map(region => paired.has(region) ? paired.get(region) : region).filter(Boolean)
      .map(region => ({ ...region, candidateIds: (region.candidateIds ?? []).filter(id => !owner.has(id)) })),
  }
}
