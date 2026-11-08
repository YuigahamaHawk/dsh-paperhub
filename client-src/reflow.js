// Pure reflow helpers for PDF text extraction.
//
// No DOM and no pdf.js imports on purpose: this module must stay Node-testable. The pipeline is
//
//   pdf.js text items  ->  groupTextItems()  ->  Line[]  ->  mergeLinesToParagraphs()
//   ->  classifyBlock()  ->  Block objects
//
// detectRepeatedMargins() runs over all pages *before* paragraph merging so running
// headers/footers (and bare page numbers) never leak into the reading text.

/* ------------------------------------------------------------------ */
/* character classes                                                   */
/* ------------------------------------------------------------------ */

/** CJK / full-width characters join without an inserted space. */
const CJK_CHAR_RE = /[\u1100-\u11ff\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uffef]/

/** A line ending in one of these reads as "sentence finished". */
const TERMINAL_RE = /[.!?。！？…‥;；:：]["'”’」』)）\]】》]?$/

/** Hyphen glyphs that may have been inserted by line breaking. */
const HYPHEN_END_RE = /[-\u2010\u2011]$/

/** Bullet / numbered-list markers (ASCII and CJK). */
const LIST_MARKER_RE = /^(?:[•·◦▪‣∙●○◾◽■□▪▲△◆◇]|[-–—*](?=\s)|\d{1,3}[.)、]\s|[（(]\d{1,3}[)）]\s|[a-zA-Z][.)]\s|[a-zA-Z]）)/

/** Font names that indicate a monospace / code face. */
const CODE_FONT_RE = /mono|courier|consol|menlo|monaco|code|typewriter|fixed/i

/** Bold-ish font names (weak heading hint only). */
const BOLD_FONT_RE = /bold|black|heavy|semibold|demibold/i

/** Blockquote markers detectable from plain text. */
const QUOTE_MARK_RE = /^[>›»〉]\s*/

/** Numbered heading patterns: 1 / 1.2 / 第X章 / Chapter 3 / 一、 ... */
const NUMBERED_HEADING_RE =
  /^(?:第[一二三四五六七八九十百千零〇两]+[章节篇部卷回讲课]|[一二三四五六七八九十百千]+[、.．]|[（(][一二三四五六七八九十百千]+[)）]|\d{1,3}(?:\.\d{1,3}){0,3}[、.．]?\s+|(?:chapter|section|part|appendix|附录)\s+[\divxlc一二三四五六七八九十]+)/i

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Arithmetic median of a numeric list (0 for an empty list). */
export function median(values) {
  const numbers = (Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isFinite(value) && value > 0)
  if (numbers.length === 0) return 0
  numbers.sort((a, b) => a - b)
  const middle = numbers.length >> 1
  return numbers.length % 2 === 0 ? (numbers[middle - 1] + numbers[middle]) / 2 : numbers[middle]
}

/** True when `char` is a CJK/full-width character. */
export function isCjkChar(char) {
  return typeof char === 'string' && char !== '' && CJK_CHAR_RE.test(char)
}

/** Collapse runs of whitespace and trim; keeps newlines out of block text. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Join two hard-wrapped line texts.
 * De-hyphenates English line breaks, avoids a space between two CJK characters and
 * keeps closing punctuation attached to the preceding word.
 */
export function joinLineTexts(previous, next) {
  const left = typeof previous === 'string' ? previous : ''
  const right = typeof next === 'string' ? next : ''
  const leftEnd = left.replace(/\s+$/, '')
  const rightStart = right.replace(/^\s+/, '')
  if (leftEnd === '') return rightStart
  if (rightStart === '') return leftEnd
  if (HYPHEN_END_RE.test(leftEnd)) {
    const first = rightStart.charAt(0)
    // Only de-hyphenate when the next chunk continues a lowercase word.
    if (/[a-zà-öø-ÿ]/.test(first)) return `${leftEnd.slice(0, -1)}${rightStart}`
  }
  const lastChar = leftEnd.charAt(leftEnd.length - 1)
  const firstChar = rightStart.charAt(0)
  if (isCjkChar(lastChar) || isCjkChar(firstChar)) return `${leftEnd}${rightStart}`
  if (/[(\[\u201c\u2018\u300c\u300e\u300a\u3008]$/.test(lastChar)) return `${leftEnd}${rightStart}`
  if (/^[)\]\u201d\u2019\u300d\u300f\u300b\u3009,.;:!?。，、；：！？]/.test(rightStart)) return `${leftEnd}${rightStart}`
  return `${leftEnd} ${rightStart}`
}

/* ------------------------------------------------------------------ */
/* 1. text items -> lines                                              */
/* ------------------------------------------------------------------ */

/**
 * Group pdf.js `getTextContent().items` into visual lines.
 *
 * Items are consumed in document order (which is reading order for virtually all
 * generated PDFs and, unlike a pure y-sort, keeps two-column layouts intact).
 * A new line starts when the baseline moves vertically by more than ~half an em.
 *
 * @param {Array<{str:string, transform:number[], width?:number, height?:number, fontName?:string, hasEOL?:boolean}>} items
 * @param {{ yTolerance?: number, pageWidth?: number }} [opts]
 * @returns {Array<{text:string, x:number, y:number, width:number, height:number, fontSize:number, fontName:string, charCount:number}>}
 */
export function groupTextItems(items, opts = {}) {
  const yTolerance = Number(opts.yTolerance) > 0 ? Number(opts.yTolerance) : 0.55
  const prepared = []
  let order = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    // Marked-content markers have no `str`; they carry no text.
    if (typeof item.str !== 'string') continue
    const transform = Array.isArray(item.transform) ? item.transform : null
    if (transform === null || transform.length < 6) continue
    const x = Number(transform[4]) || 0
    const y = Number(transform[5]) || 0
    const fontHeight = Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0)
    const itemHeight = Number(item.height) || 0
    const fontSize = Math.max(1, fontHeight || itemHeight || 1)
    prepared.push({
      str: item.str,
      x,
      y,
      width: Math.max(0, Number(item.width) || 0),
      height: itemHeight,
      fontSize,
      fontName: typeof item.fontName === 'string' ? item.fontName : '',
      hasEOL: item.hasEOL === true,
      sourceRect: item.sourceRect,
      order: order++,
    })
  }
  const lines = []
  let current = null
  const flush = () => {
    if (current === null) return
    const line = finalizeLine(current)
    if (line !== null && line.text !== '') lines.push(line)
    current = null
  }
  for (const item of prepared) {
    if (item.str === '') {
      if (item.hasEOL) flush()
      continue
    }
    if (current === null) {
      current = { y: item.y, fontSize: item.fontSize, items: [item] }
      continue
    }
    const tolerance = Math.max(1.2, Math.min(current.fontSize, item.fontSize) * yTolerance)
    if (Math.abs(item.y - current.y) <= tolerance) {
      current.items.push(item)
      current.fontSize = Math.max(current.fontSize, item.fontSize)
    } else {
      flush()
      current = { y: item.y, fontSize: item.fontSize, items: [item] }
    }
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

/** Turn one group of same-baseline items into a line descriptor (internal). */
function finalizeLine(group) {
  const items = group.items.slice().sort((a, b) => a.x - b.x || a.order - b.order)
  let text = ''
  let previous = null
  let minX = Infinity
  let maxRight = -Infinity
  let weightedFont = 0
  let weightedY = 0
  let weight = 0
  let fontName = ''
  let fontNameWeight = -1
  for (const item of items) {
    const raw = item.str.replace(/\u00a0/g, ' ')
    const chars = raw.replace(/\s+/g, '').length
    minX = Math.min(minX, item.x)
    maxRight = Math.max(maxRight, item.x + item.width)
    if (chars > 0) {
      weightedFont += item.fontSize * chars
      weightedY += item.y * chars
      weight += chars
    }
    if (item.fontName !== '' && chars >= fontNameWeight) {
      fontName = item.fontName
      fontNameWeight = chars
    }
    if (raw.trim() === '') {
      // Keep explicit spaces, but drop pure whitespace items at line edges.
      if (text !== '') previous = item
      continue
    }
    if (text === '') {
      text = raw.replace(/^\s+/, '')
    } else {
      const fontSize = Math.max(previous?.fontSize ?? 0, item.fontSize)
      const gap = previous === null ? 0 : item.x - (previous.x + previous.width)
      let separator = ''
      const lastChar = text.charAt(text.length - 1)
      const firstChar = raw.charAt(0)
      const previousHadTrailingSpace = previous !== null && /\s$/.test(previous.str)
      const currentHasLeadingSpace = /^\s/.test(raw)
      if (isCjkChar(lastChar) || isCjkChar(firstChar)) {
        // CJK: only honour explicit wide gaps, never inject a space otherwise.
        separator = gap > fontSize * 2.2 ? ' ' : ''
      } else if (gap > Math.max(1.2, fontSize * 0.24)) {
        separator = ' '
      } else if ((previousHadTrailingSpace || currentHasLeadingSpace) && !'([（“‘「『《〈'.includes(lastChar)) {
        // A word boundary can be encoded as whitespace inside one of the two items even when the
        // geometric gap is tiny (bold/italic runs); never glue words together in that case.
        separator = ' '
      }
      text += separator + raw.replace(/^\s+/, '')
    }
    previous = item
  }
  const cleaned = normalizeText(text)
  if (cleaned === '' || !Number.isFinite(minX)) return null
  return {
    text: cleaned,
    x: minX,
    y: weight > 0 ? weightedY / weight : group.y,
    width: Math.max(1, maxRight - minX),
    height: Math.max(group.fontSize, 1),
    fontSize: weight > 0 ? weightedFont / weight : group.fontSize,
    fontName,
    charCount: cleaned.length,
    sourceRects: items.filter(item => item.str.trim() !== '' && item.sourceRect).map(item => item.sourceRect),
    sourceItems: items.filter(item => item.str.trim() !== '').map(item => ({ text: item.str, x: item.x, y: item.y, fontSize: item.fontSize, sourceRect: item.sourceRect })),
  }
}

/* ------------------------------------------------------------------ */
/* 2. lines -> paragraphs                                              */
/* ------------------------------------------------------------------ */

/**
 * Merge hard-wrapped lines into paragraphs.
 *
 * Breaks on: large vertical gap, first-line indentation, font-size change, upward
 * jumps (new column/page) and terminal punctuation on a short precedent line.
 * Continuation lines are de-hyphenated and CJK joined without spaces.
 *
 * @param {Array<{text:string, x:number, y:number, width?:number, fontSize?:number}>} lines
 * @param {{ pageWidth?:number, medianFontSize?:number, typicalGap?:number, indent?:number }} [opts]
 * @returns {Array<{text:string, x:number, y:number, fontSize:number, fontName:string, lines:Array}>}
 */
export function mergeLinesToParagraphs(lines, opts = {}) {
  const list = (Array.isArray(lines) ? lines : []).filter((line) => line !== null && typeof line === 'object' && typeof line.text === 'string' && line.text.trim() !== '')
  if (list.length === 0) return []
  const medianFontSize = Number(opts.medianFontSize) > 0 ? Number(opts.medianFontSize) : median(list.map((line) => line.fontSize)) || 12
  const pageWidth = Number(opts.pageWidth) > 0 ? Number(opts.pageWidth) : Math.max(...list.map((line) => (Number(line.x) || 0) + (Number(line.width) || 0)), 600)
  let typicalGap = Number(opts.typicalGap) > 0 ? Number(opts.typicalGap) : 0
  if (typicalGap === 0) {
    const gaps = []
    for (let index = 1; index < list.length; index++) {
      const gap = (Number(list[index - 1].y) || 0) - (Number(list[index].y) || 0)
      const fontSize = Math.max(Number(list[index - 1].fontSize) || medianFontSize, Number(list[index].fontSize) || medianFontSize)
      if (gap > fontSize * 0.5 && gap < fontSize * 3) gaps.push(gap)
    }
    typicalGap = median(gaps) || medianFontSize * 1.35
  }
  const indentThreshold = Number(opts.indent) > 0 ? Number(opts.indent) : Math.max(3, medianFontSize * 0.9)
  const paragraphs = []
  let current = { lines: [], text: '', x: 0, y: 0, fontSize: medianFontSize, fontName: '' }
  const startParagraph = (line) => {
    current = { lines: [line], text: line.text, x: Number(line.x) || 0, y: Number(line.y) || 0, fontSize: Number(line.fontSize) || medianFontSize, fontName: line.fontName ?? '' }
  }
  const commitParagraph = () => {
    if (current.lines.length === 0) return
    const text = normalizeText(current.text)
    if (text !== '') {
      paragraphs.push({ text, x: current.x, y: current.y, fontSize: current.fontSize, fontName: current.fontName, lines: current.lines })
    }
  }
  for (const line of list) {
    if (current.lines.length === 0) {
      startParagraph(line)
      continue
    }
    if (shouldBreakParagraph(current.lines[current.lines.length - 1], line, { medianFontSize, pageWidth, typicalGap, indentThreshold })) {
      commitParagraph()
      startParagraph(line)
      continue
    }
    current.lines.push(line)
    current.text = joinLineTexts(current.text, line.text)
    if (Number(line.fontSize) > current.fontSize) current.fontSize = Number(line.fontSize)
  }
  commitParagraph()
  return paragraphs
}

/** Decide whether `line` starts a new paragraph after `previous` (internal). */
function shouldBreakParagraph(previous, line, context) {
  const previousY = Number(previous.y) || 0
  const lineY = Number(line.y) || 0
  const gap = previousY - lineY
  const fontSize = Math.max(Number(previous.fontSize) || context.medianFontSize, Number(line.fontSize) || context.medianFontSize)
  // Reading order moved upwards: new column, new block or new page.
  if (gap < -fontSize * 0.2) return true
  // Same line / no vertical progress: do not glue duplicates together.
  if (gap <= fontSize * 0.15) return true
  if (gap > Math.max(fontSize * 1.55, context.typicalGap * 1.55)) return true
  // Font-size change (headings, captions, footnotes).
  const previousSize = Number(previous.fontSize) || context.medianFontSize
  const lineSize = Number(line.fontSize) || context.medianFontSize
  if (Math.abs(lineSize - previousSize) > context.medianFontSize * 0.16) return true
  if (lineSize > context.medianFontSize * 1.25 && lineSize > previousSize * 1.06) return true
  const previousText = typeof previous.text === 'string' ? previous.text : ''
  // A section heading must end the paragraph even when font sizes match the body text.
  if (looksLikeSectionHeading(previousText)) return true
  const previousWidth = Number(previous.width) || previousText.length * fontSize * 0.5
  const endsSentence = TERMINAL_RE.test(previousText.replace(/\s+$/, ''))
  // First-line indentation opens a new paragraph only after a finished sentence, so a
  // hanging-indent continuation (indented wrapped lines) is not split apart.
  const indent = (Number(line.x) || 0) - (Number(previous.x) || 0)
  if (endsSentence && indent > context.indentThreshold && indent < context.pageWidth * 0.4) return true
  // A short line that ends a sentence closes the paragraph; longer wrapped lines continue.
  if (endsSentence && (previousWidth < context.pageWidth * 0.62 || gap > context.typicalGap * 1.18)) return true
  if (LIST_MARKER_RE.test(line.text) && !LIST_MARKER_RE.test(previousText)) return true
  if (QUOTE_MARK_RE.test(line.text) && !QUOTE_MARK_RE.test(previousText)) return true
  return false
}

/* ------------------------------------------------------------------ */
/* 3. repeated running headers / footers                               */
/* ------------------------------------------------------------------ */

/** Normalise margin text for repetition checks: digits become `#` so page numbers match. */
export function normalizeMarginText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, '')
    .slice(0, 120)
}

/**
 * True when a line sits in the top / bottom margin band of its page.
 * When `pageHeight` is unknown the caller is expected to pass explicit line indices
 * instead (see detectRepeatedMargins, which falls back to first/last lines).
 */
export function isMarginLine(line, pageHeight, opts = {}) {
  const height = Number(pageHeight) || 0
  if (line === null || typeof line !== 'object' || height <= 0) return false
  const ratio = (Number(line.y) || 0) / height
  const topRatio = Number(opts.topRatio) > 0 ? Number(opts.topRatio) : MARGIN_TOP_RATIO
  const bottomRatio = Number(opts.bottomRatio) > 0 ? Number(opts.bottomRatio) : MARGIN_BOTTOM_RATIO
  return ratio <= topRatio || ratio >= bottomRatio
}

const MARGIN_TOP_RATIO = 0.13
const MARGIN_BOTTOM_RATIO = 0.87

/**
 * Find running header/footer texts that repeat across pages.
 *
 * @param {Array<{lines:Array<{text:string, y?:number}>, pageHeight?:number, height?:number}>} pages
 * @param {{ topRatio?:number, bottomRatio?:number, minPages?:number, minCoverage?:number }} [opts]
 * @returns {Set<string>} normalised margin texts safe to drop
 */
export function detectRepeatedMargins(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : []
  if (list.length < 2) return new Set()
  const topRatio = Number(opts.topRatio) > 0 ? Number(opts.topRatio) : MARGIN_TOP_RATIO
  const bottomRatio = Number(opts.bottomRatio) > 0 ? Number(opts.bottomRatio) : MARGIN_BOTTOM_RATIO
  const counts = new Map()
  for (const page of list) {
    const lines = Array.isArray(page) ? page : Array.isArray(page?.lines) ? page.lines : []
    const height = Number(page?.pageHeight ?? page?.height) || 0
    const candidates = []
    if (height > 0) {
      for (const line of lines) {
        if (line !== null && typeof line === 'object' && typeof line.text === 'string' && isMarginLine(line, height, { topRatio, bottomRatio })) candidates.push(line)
      }
    } else {
      // No geometry: treat first and last two lines as margin candidates.
      const head = lines.slice(0, 2)
      const tail = lines.slice(-2)
      for (const line of [...head, ...tail]) if (line !== null && typeof line === 'object' && typeof line.text === 'string') candidates.push(line)
    }
    const seen = new Set()
    for (const line of candidates) {
      const key = normalizeMarginText(line.text)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  // A running header must appear on at least half of the pages (and at least twice) before
  // it is treated as furniture. Keeping the absolute floor low enough matters for short PDFs
  // where a running header is present on only a couple of pages.
  const coverage = Number(opts.minCoverage) > 0 ? Number(opts.minCoverage) : 0.5
  const configuredMin = Number(opts.minPages) > 0 ? Number(opts.minPages) : 0
  const minimum = Math.max(2, configuredMin, Math.ceil(list.length * coverage))
  const repeated = new Set()
  for (const [key, count] of counts) if (count >= minimum && count >= 2) repeated.add(key)
  return repeated
}

/** Drop repeated margin lines from one page's line list. */
export function stripRepeatedMargins(lines, pageHeight, repeated, opts = {}) {
  const list = Array.isArray(lines) ? lines : []
  if (!(repeated instanceof Set) || repeated.size === 0) return list.slice()
  const topRatio = Number(opts.topRatio) > 0 ? Number(opts.topRatio) : MARGIN_TOP_RATIO
  const bottomRatio = Number(opts.bottomRatio) > 0 ? Number(opts.bottomRatio) : MARGIN_BOTTOM_RATIO
  return list.filter((line) => {
    if (line === null || typeof line !== 'object') return false
    if (!isMarginLine(line, pageHeight, { topRatio, bottomRatio })) return true
    return !repeated.has(normalizeMarginText(line.text))
  })
}

/* ------------------------------------------------------------------ */
/* 4. block classification                                             */
/* ------------------------------------------------------------------ */

/** Heading level guess from font-size ratio (1 = largest). Capped at 3: reading UI has 3 useful levels. */
function headingLevelFromRatio(ratio) {
  if (ratio >= 1.7) return 1
  if (ratio >= 1.35) return 2
  if (ratio >= 1.12) return 3
  return null
}

/** Heading level guess from a numbered-section pattern. */
function headingLevelFromNumbering(text) {
  if (/^第[一二三四五六七八九十百千零〇两]+[篇部卷]/i.test(text)) return 1
  if (/^第[一二三四五六七八九十百千零〇两]+[章节回讲课]/.test(text)) return 2
  if (/^(?:part|appendix|附录)\s/i.test(text)) return 1
  if (/^(?:chapter|section)\s/i.test(text)) return 2
  const match = /^(\d{1,3}(?:\.\d{1,3}){0,3})(?:\s|[、.．])/.exec(text)
  if (match !== null) {
    const depth = match[1].split('.').filter((part) => part !== '').length
    return Math.min(3, Math.max(1, depth))
  }
  if (/^[一二三四五六七八九十百千]+[、.．]/.test(text)) return 2
  return null
}

/** Lines that look like page furniture / arXiv stamps / bare page numbers, never reading blocks. */
const ARTIFACT_LINE_RES = [
  /^arxiv:\d{4}\.\d{4,5}v\d+\b/i,
  /^preprint\.?\s/i,
  /^\s*(?:page\s*)?\d{1,4}\s*(?:\/\s*\d{1,4})?\s*$/i,
  /^\s*(?:doi|https?:\/\/|www\.)\S+\s*$/i,
  /^\s*©\s*\d{4}/,
  /^\s*(?:under review|accepted|published)\b.{0,80}$/i,
  /^\s*(?:figure|table|fig\.|tab\.)\s*\d+[.:]?\s*$/i,
  /^\s*(?:\u00a9|\u00ae)\s*\S{0,40}$/,
  /^\s*[*†‡§¶∗·•+]{1,4}\s*$/u,
  /^\s*\d{1,2}\s*$/u,
]

/** Section-title shapes that must end the preceding line's paragraph immediately. */
const SECTION_LIKE_RE =
  /^(?:\d{1,3}(?:\.\d{1,3}){0,3}\s*[A-Z\u00c0-\u00dd\u4e00-\u9fff]|(?:chapter|section|part|appendix|references|bibliography|acknowledg(?:e)?ments|附录|参考文献|致谢)\b|第[一二三四五六七八九十百千]+[章节篇部卷])/iu

/**
 * True when one line reads as a section heading. Used to force a paragraph break after it even
 * when the PDF uses the same font size for headings and body text (no terminal punctuation on the
 * heading line otherwise lets `shouldBreakParagraph` merge the first body line into the heading).
 */
export function looksLikeSectionHeading(text) {
  const value = normalizeText(text)
  if (value === '' || value.length > 200) return false
  if (isArtifactLine(value)) return false
  if (TERMINAL_RE.test(value) && value.length > 80) return false
  return SECTION_LIKE_RE.test(value)
}

/**
 * True when a short paragraph is really a display equation. Fragmented text extraction makes
 * formulas unreadable in reflow mode, so the reader crops such regions from the page instead.
 */
export function looksLikeDisplayEquation(text, lineCount = 1) {
  const value = normalizeText(text)
  if (value.length < 2 || value.length > 280 || lineCount > 3) return false
  const letters = (value.match(/\p{L}/gu) ?? []).length
  const math = (value.match(/[\u0370-\u03ff\u2200-\u22ff\u2a00-\u2aff\u{1D400}-\u{1D7FF}=<>≤≥±×÷∞∑∏∫√≈≠^_/]/gu) ?? []).length
  const words = value.split(/\s+/).filter((word) => word !== '').length
  if (math < 2) return false
  // Chart tick labels such as "× × ×" or "Decode (tok/s) × ×" are not equations.
  if (!/[=<>≤≥≈≠]/u.test(value) && !/[\u0370-\u03ff]/u.test(value)) return false
  const density = math / Math.max(6, letters + math)
  return (density >= 0.16 && words <= 28) || (math >= 3 && words <= 8)
}

/** Math/alphanumeric symbols that appear in equations, not in headings (unicode ranges need the u flag). */
const MATH_SYMBOL_RE = /[\u{1D400}-\u{1D7FF}\u{2200}-\u{22FF}\u{2A00}-\u{2AFF}\u{27C0}-\u{27EF}\u{2980}-\u{29FF}]/u

/** True when a line is page furniture rather than a reading line. */
export function isArtifactLine(text) {
  const value = normalizeText(text)
  if (value === '') return true
  return ARTIFACT_LINE_RES.some((pattern) => pattern.test(value))
}

/** Remove page-furniture lines from one page's line list. */
export function dropArtifactLines(lines) {
  const list = Array.isArray(lines) ? lines : []
  return list.filter((line) => line !== null && typeof line === 'object' && !isArtifactLine(line.text))
}

/** True when the text has enough real word content to be a heading (not an equation fragment). */
function hasWordContent(text) {
  const words = text.match(/[A-Za-z\u00c0-\u00ff\u4e00-\u9fff]{2,}/g) ?? []
  const letters = words.join('')
  if (letters.length < 3) return false
  if (MATH_SYMBOL_RE.test(text)) return false
  // Equation fragments like "b1.(6)", "1by dividing each column..." lack normal word spacing.
  if (text.length < 8 && !/^[A-Z\u4e00-\u9fff]/.test(text)) return false
  return true
}

/** Repair a missing space after a section number, e.g. "1Introduction" -> "1 Introduction". */
export function repairHeadingSpacing(text) {
  return normalizeText(text)
    .replace(/^(\d{1,3}(?:\.\d{1,3}){0,3})(?=[A-Z\u00c0-\u00dd])/u, '$1 ')
    .replace(/^(\d{1,3}(?:\.\d{1,3}){0,3})(?=[\u4e00-\u9fff])/u, '$1 ')
}


/**
 * Classify one merged paragraph into a Block kind.
 *
 * Heuristics (deliberately conservative): monospace font -> code, font-size ratio or
 * numbering pattern -> heading with level, bullet/number marker -> list, quote marker
 * -> quote, otherwise paragraph.
 *
 * @param {{text?:string, fontSize?:number, medianFontSize?:number, pageWidth?:number,
 *          fontName?:string, lineCount?:number, prevKind?:string}} [input]
 * @returns {{kind:string, level?:number, text:string}}
 */
export function classifyBlock(input = {}) {
  const text = normalizeText(input.text)
  if (text === '') return { kind: 'paragraph', text }
  const fontSize = Number(input.fontSize) || 0
  const medianFontSize = Number(input.medianFontSize) || fontSize || 1
  const ratio = fontSize > 0 ? fontSize / medianFontSize : 1
  const fontName = typeof input.fontName === 'string' ? input.fontName : ''
  const lineCount = Number(input.lineCount) > 0 ? Number(input.lineCount) : 1
  const pageWidth = Number(input.pageWidth) || 0

  if (CODE_FONT_RE.test(fontName) && text.length >= 8) return { kind: 'code', text }
  if (isArtifactLine(text)) return { kind: 'artifact', text }

  const sentenceBreak = /[.!?。！？]\s+[a-z\u4e00-\u9fff]/.test(text)
  const headingCandidate = !sentenceBreak && text.length <= 160 && lineCount <= 2 && !/[,，、;；]$/.test(text) && hasWordContent(text)
  const numberedLike = /^\d{1,3}(?:\.\d{1,3}){0,3}[A-Z\u00c0-\u00dd\u4e00-\u9fff]/u.test(text)
  const numbered = headingCandidate && (NUMBERED_HEADING_RE.test(text) || numberedLike) && text.length <= 160
  let level = null
  if (numbered && ratio < 1.5) {
    // Section numbering carries more structure information than a small font difference.
    level = headingLevelFromNumbering(repairHeadingSpacing(text))
  }
  if (level === null) level = headingLevelFromRatio(ratio)
  if (level === null && numbered) level = headingLevelFromNumbering(repairHeadingSpacing(text))
  if (level === null && headingCandidate && BOLD_FONT_RE.test(fontName) && ratio >= 1.06 && text.length <= 90) level = 3
  if (level !== null && headingCandidate && !TERMINAL_RE.test(text)) {
    return { kind: 'heading', level: Math.min(3, Math.max(1, level)), text: repairHeadingSpacing(text) }
  }
  if (LIST_MARKER_RE.test(text)) return { kind: 'list', text }
  if (QUOTE_MARK_RE.test(text)) return { kind: 'quote', text: normalizeText(text.replace(QUOTE_MARK_RE, '')) }
  // Indented, short, quoted-style paragraph with no sentence ending: likely a pull quote.
  if (pageWidth > 0 && lineCount === 1 && text.length <= 160 && /^[“"「『]/.test(text) && /[”"」』]$/.test(text)) return { kind: 'quote', text }
  return { kind: 'paragraph', text }
}

/** Resolve the heading level for a single line (used for mid-page title detection). */
export function detectHeadingLevel(line, medianFontSize) {
  const text = normalizeText(line?.text)
  const base = Number(medianFontSize) || Number(line?.fontSize) || 1
  const ratio = (Number(line?.fontSize) || base) / base
  if (isArtifactLine(text) || !hasWordContent(text)) return null
  const level = headingLevelFromRatio(ratio)
  if (level !== null && text.length <= 220 && !TERMINAL_RE.test(text)) return level
  if ((NUMBERED_HEADING_RE.test(text) || /^\d{1,3}(?:\.\d{1,3}){0,3}[A-Z\u00c0-\u00dd\u4e00-\u9fff]/u.test(text)) && text.length <= 160 && !TERMINAL_RE.test(text)) {
    return headingLevelFromNumbering(repairHeadingSpacing(text))
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 5. plain text + page lookup                                         */
/* ------------------------------------------------------------------ */

/** Concatenate reading blocks into plain text (for search, AI context and export). */
export function blocksToPlainText(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const parts = []
  for (const block of list) {
    if (block === null || typeof block !== 'object') continue
    const text = normalizeText(typeof block.text === 'string' ? block.text : '')
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * First block id of a PDF page.
 *
 * Accepts either `[{ n, blocks }]` page records or a flat `Block[]` list with `page`
 * numbers. Returns `null` when the page holds no text blocks.
 */
export function findBlockIdForPage(pages, page) {
  const target = Number(page)
  if (!Number.isFinite(target) || target <= 0) return null
  if (!Array.isArray(pages)) {
    if (pages !== null && typeof pages === 'object' && Array.isArray(pages.pages)) return findBlockIdForPage(pages.pages, target)
    return null
  }
  for (const entry of pages) {
    if (entry === null || typeof entry !== 'object') continue
    if (Array.isArray(entry.blocks)) {
      if (Number(entry.n) !== target) continue
      for (const block of entry.blocks) {
        if (block !== null && typeof block === 'object' && typeof block.id === 'string' && block.id !== '') return block.id
      }
      return null
    }
    if (typeof entry.page === 'number' && Number(entry.page) === target && typeof entry.id === 'string' && entry.id !== '') return entry.id
  }
  return null
}

/**
 * First block id at or near a page: walks backward then forward so outline items that
 * land on an image-only / empty page still get a usable jump target.
 */
export function findNearestBlockId(pages, page) {
  const target = Number(page)
  if (!Number.isFinite(target) || target <= 0) return null
  const list = Array.isArray(pages) ? pages : Array.isArray(pages?.pages) ? pages.pages : []
  const exact = findBlockIdForPage(list, target)
  if (exact !== null) return exact
  const numbers = []
  for (const entry of list) {
    const n = Array.isArray(entry?.blocks) ? Number(entry.n) : typeof entry?.page === 'number' ? Number(entry.page) : NaN
    if (Number.isFinite(n)) numbers.push(n)
  }
  numbers.sort((a, b) => a - b)
  const before = numbers.filter((n) => n < target).reverse()
  const after = numbers.filter((n) => n > target)
  for (const n of [...before, ...after]) {
    const id = findBlockIdForPage(list, n)
    if (id !== null) return id
  }
  return null
}
