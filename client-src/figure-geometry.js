import { validBox } from '../shared/vision-contract.js'

const figureNumber = text => /^(?:fig(?:ure)?\.?\s*|图\s*)([A-Z]?\d+(?:[.\-]\d+)*[a-z]?)\b/i.exec(text)?.[1]
const otherCaption = text => figureNumber(text) || /^(?:table|algorithm|表|算法)\s*(?:[A-Z]?\d+|[IVX]+)\b/i.test(text)
const panelLabel = text => /^(?:\([a-z]\)|[a-z][.)]?)$/i.test(text)
const isFigure = region => region.kind === 'figure' && region.renderAs !== 'text'
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
const boxOverlap = (a, b) => overlap(a[0], a[2], b[0], b[2]) * overlap(a[1], a[3], b[1], b[3])
const area = box => (box[2] - box[0]) * (box[3] - box[1])
const containsMost = (box, inner) => boxOverlap(box, inner) >= area(inner) * .65

function blockBoxes(block) {
  const rects = block.sourceRects?.length ? block.sourceRects : [block.sourceRect ?? block.rect]
  return rects.filter(Boolean).map(r => validBox([r.x, r.y, r.x + r.w, r.y + r.h])).filter(Boolean)
}

function groupGeometry(group, byId) {
  const blocks = group.ids.map(id => byId.get(id)).filter(Boolean)
  const boxes = blocks.flatMap(blockBoxes)
  if (!boxes.length) return null
  const text = blocks.map(block => block.text ?? '').join(' ').trim()
  const markers = group.kind === 'caption' && blocks.every(block => panelLabel(String(block.text ?? '').trim()))
  return { group, boxes, text, markers, bbox: [
    Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
    Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3])),
  ] }
}

function shortLabel({ bbox, text }) {
  return text && bbox[2] - bbox[0] < .32 && bbox[3] - bbox[1] < .024 && !/[.!?。！？]$/u.test(text)
}

function adjacentPanels(a, b) {
  const [left, top, right, bottom] = a
  const [otherLeft, otherTop, otherRight, otherBottom] = b
  const gap = Math.max(left, otherLeft) - Math.min(right, otherRight)
  return gap >= -.015 && gap <= .08 &&
    overlap(top, bottom, otherTop, otherBottom) > Math.min(bottom - top, otherBottom - otherTop) * .5
}

function alongsidePanel([left, top, right, bottom], [x0, y0, x1, y1], maxGap) {
  return Math.max(left, x0) - Math.min(right, x1) <= maxGap &&
    overlap(top, bottom, y0, y1) >= (bottom - top) * .75
}

// A parser may put panel letters in a caption, a plot heading in a paragraph,
// or a centered axis title in a caption. Require native line geometry and
// nearby visual proposals before allowing those labels inside a crop.
function possiblePlotLabels(geometry, captions, figures, labelFor) {
  const markers = captions.filter(value => value.markers)
  const labels = new Set(markers)
  for (const value of geometry) {
    if (otherCaption(value.text)) continue
    const [left, top, right, bottom] = value.bbox
    const narrow = right - left < .028 && bottom - top > (right - left) * 2.5
    if (value.group.kind === 'paragraph' && value.boxes.length === 1 && narrow &&
        figures.some(region => alongsidePanel(value.bbox, region.bbox, .025))) {
      labels.add(value)
      continue
    }
    if (!shortLabel(value)) continue
    const center = (left + right) / 2
    if (value.group.kind === 'paragraph' && markers.some(marker => overlap(top, bottom, marker.bbox[1], marker.bbox[3]) > 0) &&
        figures.some(({ bbox: [x0, y0, x1] }) => center > x0 && center < x1 && y0 >= top && y0 - bottom <= .018)) {
      labels.add(value)
    }
    if (value.group.kind === 'caption' && figures.some(figure => {
      const [x0, , x1, y1] = figure.bbox
      return labelFor.get(figure.captionId) === value && Math.abs(top - y1) <= .018 &&
        Math.abs(center - (x0 + x1) / 2) <= (x1 - x0) * .23 &&
        figures.some(peer => peer !== figure && adjacentPanels(figure.bbox, peer.bbox))
    })) labels.add(value)
  }
  return labels
}

// The original PDF has vector drawings as well as images. Sampling its rendered
// ink works for both and never asks an OCR/model to read plot labels as prose.
export function pageInk(canvas) {
  const height = Math.min(960, canvas.height), width = Math.max(1, Math.round(canvas.width * height / canvas.height))
  const sample = document.createElement('canvas')
  sample.width = width
  sample.height = height
  const ctx = sample.getContext('2d', { alpha: false, willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const pixels = new Uint8Array(width * height)
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4
    pixels[i] = Math.min(data[offset], data[offset + 1], data[offset + 2]) < 235 ? 1 : 0
  }
  return { width, height, pixels }
}

function inkBounds({ width, height, pixels }, [left, top, right, bottom], seed) {
  const x0 = Math.ceil(left * width), x1 = Math.floor(right * width)
  const maxGap = Math.max(2, Math.round(.018 * height))
  const bands = []
  let band
  for (let y = Math.ceil(top * height); y < Math.floor(bottom * height); y++) {
    let start = x1, end = -1, count = 0
    for (let x = x0; x < x1; x++) {
      if (!pixels[y * width + x]) continue
      start = Math.min(start, x)
      end = x
      count++
    }
    if (count < 2) continue
    if (!band || y - band[3] > maxGap) {
      band = [start, y, end + 1, y + 1]
      bands.push(band)
    } else {
      band[0] = Math.min(start, band[0])
      band[2] = Math.max(end + 1, band[2])
      band[3] = y + 1
    }
  }
  const boxes = bands.map(([x0, y0, x1, y1]) => [x0 / width, y0 / height, x1 / width, y1 / height])
  const relevant = boxes.filter(box => boxOverlap(box, seed) >= area(seed) * .12)
  if (!relevant.length) return null
  return [
    Math.min(...relevant.map(box => box[0])), Math.min(...relevant.map(box => box[1])),
    Math.max(...relevant.map(box => box[2])), Math.max(...relevant.map(box => box[3])),
  ]
}

// Some publishers draw a running rule instead of exposing a header text run.
// Only cut a thin, isolated full-width rule with header ink above it.
function runningRuleBottom({ width, height, pixels }, seedTop) {
  const rows = []
  const end = Math.floor(Math.min(.10, seedTop) * height)
  for (let y = 0; y < end; y++) {
    let count = 0, first = width, last = -1
    for (let x = 0; x < width; x++) {
      if (!pixels[y * width + x]) continue
      count++
      first = Math.min(first, x)
      last = x
    }
    rows.push({ ink: count > 1, solid: count > width * .70 && count >= (last - first + 1) * .93 })
  }
  const gap = Math.max(2, Math.round(.003 * height))
  for (let y = gap; y < end - gap; y++) {
    if (!rows[y].solid || rows[y - 1].ink) continue
    let bottom = y + 1
    while (bottom < end && rows[bottom].solid) bottom++
    if (bottom - y > .005 * height || bottom + gap > end) continue
    if (rows.slice(y - gap, y).some(row => row.ink) || rows.slice(bottom, bottom + gap).some(row => row.ink)) continue
    if (rows.slice(Math.max(0, y - Math.round(.022 * height)), y - gap).some(row => row.ink)) return bottom / height
  }
  return 0
}

export function canCheckFigureGeometry(answer) {
  return !answer.error && answer.regions?.some(region => isFigure(region) && region.captionId)
}

/** Reconcile independently captioned figures using original page geometry. */
export function checkFigureGeometry(sourcePage, answer, ink) {
  if (!sourcePage || !ink || !canCheckFigureGeometry(answer)) return answer
  const source = answer.sourceBlocks ?? sourcePage.sourceBlocks ?? sourcePage.visionSourceBlocks ?? sourcePage.blocks ?? []
  const byId = new Map(source.map(block => [block.id, block]))
  let groups = [...(answer.textBlocks ?? [])]
  const captionIds = new Set(groups.filter(group => group.kind === 'caption').flatMap(group => group.ids))
  for (const region of answer.regions) {
    if (!isFigure(region) || !region.captionId || captionIds.has(region.captionId)) continue
    if (groups.some(group => group.ids.includes(region.captionId))) continue
    groups.push({ kind: 'caption', ids: [region.captionId] })
    captionIds.add(region.captionId)
  }
  const geometry = groups.map(group => groupGeometry(group, byId)).filter(Boolean)
  const captions = geometry.filter(({ group }) => group.kind === 'caption')
  const labelFor = new Map(captions.flatMap(value => value.group.ids.map(id => [id, value])))
  const figures = answer.regions.filter(region => isFigure(region) && validBox(region.bbox))
  const plotLabels = possiblePlotLabels(geometry, captions, figures, labelFor)
  const obstacles = [...geometry, ...(answer.paragraphs ?? []).map(ids => groupGeometry({ ids, kind: 'paragraph' }, byId)).filter(Boolean)]
    .filter(value => !plotLabels.has(value) && (value.group.kind === 'caption' || value.group.kind === 'heading' || otherCaption(value.text) || value.text.length >= 30))
  const otherVisuals = answer.regions.filter(region => !isFigure(region) && region.renderAs !== 'text').map(region => validBox(region.bbox)).filter(Boolean)
  const replaced = new Map(), merged = new Set(), absorbedIds = new Set()
  for (const caption of captions) {
    const number = figureNumber(caption.text)
    const anchor = figures.find(region => caption.group.ids.includes(region.captionId))
    if (!number || !anchor || merged.has(anchor)) continue
    const seed = anchor.bbox, [capLeft, capTop, capRight] = caption.bbox
    // Captions below the figure only. A neighboring labeled caption starts
    // its own figure, even if the two captions sit on the same baseline.
    if (capTop <= seed[1] || capTop > seed[3] + .12) continue
    const continuation = capRight < .52 && capRight - capLeft > .24 ? captions.find(value => {
      const [x0, y0, x1] = value.bbox
      return x0 >= .50 && x0 >= capRight - .005 && x1 - x0 > .20 &&
        Math.abs(y0 - capTop) <= .009 && !otherCaption(value.text) && !plotLabels.has(value) &&
        (/^\p{Ll}/u.test(value.text) || !/[.!?。！？]["’”)]*$/u.test(caption.text))
    }) : null
    const left = capLeft >= .50 && seed[0] >= .48 ? .50 : 0
    const right = !continuation && capRight <= .51 && seed[2] <= .52 ? .50 : 1
    const knownText = obstacles.filter(value => value !== caption && value !== continuation).flatMap(value => value.boxes)
    const prior = [...knownText, ...otherVisuals]
      .filter(box => box[3] < capTop && overlap(box[0], box[2], left, right) > Math.min(.12, (box[2] - box[0]) * .6))
    // A wide repair is unsafe if a known text line already occupies the
    // proposed figure's rows. Native text above the seed is a hard boundary.
    if (prior.some(box => box[3] > seed[1] + .008 && box[1] < seed[3] - .008)) continue
    const top = Math.max(runningRuleBottom(ink, seed[1]), ...prior.filter(box => box[3] <= seed[1] + .008).map(box => box[3]))
    const clipBox = [left, top, right, capTop]
    const bbox = inkBounds(ink, clipBox, seed)
    if (!bbox) continue

    const fragments = figures.filter(region => region !== anchor && !merged.has(region) && containsMost(bbox, region.bbox))
    const covered = new Set([anchor, ...fragments])
    const padded = [bbox[0] - .006, bbox[1] - .006, bbox[2] + .006, Math.min(capTop, bbox[3] + .006)]
    const labelInside = value => value.boxes.every(box => containsMost(padded, box)) &&
      figures.every(region => labelFor.get(region.captionId) !== value || covered.has(region) || merged.has(region))
    const embedded = new Set([...plotLabels].filter(labelInside))
    // MinerU may leave small pieces of a legend outside all of its proposed
    // boxes. Keep those native glyphs in the proven figure envelope.
    for (const value of geometry) {
      if (value.group.unassigned && !otherCaption(value.text) && shortLabel(value) && labelInside(value)) embedded.add(value)
    }
    // The box and its ownership are committed together. Another figure can
    // share this crop only if its alleged caption is itself inside the plot.
    const fragmentLabels = fragments.map(fragment => {
      const label = labelFor.get(fragment.captionId)
      const shared = label && (label === caption || label === continuation)
      const internal = label && !shared && !otherCaption(label.text) && (embedded.has(label) || shortLabel(label) && labelInside(label))
      return { label, internal, conflict: replaced.has(fragment) || Boolean(fragment.captionId && !shared && !internal) }
    })
    if (fragmentLabels.some(value => value.conflict)) continue
    for (const { label, internal } of fragmentLabels) if (internal) embedded.add(label)
    const candidateIds = new Set([anchor, ...fragments].flatMap(region => region.candidateIds ?? []))
    for (const fragment of fragments) merged.add(fragment)
    const reassigned = new Set([...embedded].map(value => value.group))
    for (const group of reassigned) for (const id of group.ids) {
      candidateIds.add(id)
      absorbedIds.add(id)
    }
    groups = groups.filter(group => !reassigned.has(group) && group !== continuation?.group)
    if (continuation) groups = groups.map(group => group === caption.group ? { ...group, ids: [...group.ids, ...continuation.group.ids] } : group)
    replaced.set(anchor, { ...anchor, bbox, clipBox, candidateIds: [...candidateIds], number, afterBlockId: null })
  }
  if (!replaced.size) return answer
  return {
    ...answer,
    textBlocks: groups,
    paragraphs: answer.paragraphs?.map(ids => ids.filter(id => !absorbedIds.has(id))).filter(ids => ids.length),
    captionFixes: answer.captionFixes?.filter(fix => !absorbedIds.has(fix.id)),
    regions: answer.regions.filter(region => !merged.has(region)).map(region => replaced.get(region) ?? region),
  }
}
