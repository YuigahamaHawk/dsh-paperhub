import katex from 'katex'
import { mathMLCore } from './math-alphabet.js'

export const INLINE_MATH_VERSION = 1
export const MATH_TOKEN_RE = /⟦DSHMATH_[A-Z]+⟧/g

export function inlineTokenTotal(request) {
  const usages = request?.usages
  if (!Array.isArray(usages) || !usages.length || usages.some(u => !Number.isFinite(u?.totalTokens))) return null
  return usages.reduce((n, usage) => n + usage.totalTokens, 0)
}

const canonical = text => String(text).normalize('NFKC').replace(/\s/g, '')

function formulaSegments(formulas, source) {
  if (!Array.isArray(formulas) || formulas.length > 150) throw new Error('Return a formulas array')
  let searchable = '', offset = 0
  const starts = [], ends = []
  for (const char of source) {
    for (const unit of canonical(char)) {
      searchable += unit
      for (let i = 0; i < unit.length; i++) { starts.push(offset); ends.push(offset + char.length) }
    }
    offset += char.length
  }
  const groups = []
  for (const formula of formulas) {
    if (typeof formula?.source !== 'string' || !formula.source.trim()) throw new Error('Every formula needs a source substring copied from the extracted paragraph')
    const query = canonical(formula.source), candidates = []
    if (!query) throw new Error('Empty formula source')
    if (/^(?:i\.e\.|e\.g\.|etc\.)/i.test(query)) throw new Error('Keep prose abbreviations such as i.e., e.g. and etc. outside mathematical formulas')
    for (let at = searchable.indexOf(query); at >= 0; at = searchable.indexOf(query, at + 1)) {
      const start = starts[at], end = ends[at + query.length - 1]
      if (canonical(source.slice(start, end)) !== query) continue
      const before = source.slice(0, start), after = source.slice(end)
      if (formula.before && !canonical(before).endsWith(canonical(formula.before))) continue
      if (formula.after && !canonical(after).startsWith(canonical(formula.after))) continue
      if (/^[\p{L}\p{N}]+$/u.test(query) && (/\p{L}$/u.test(before) || /^\p{L}/u.test(after))) continue
      candidates.push({ start, end })
      if (candidates.length > 128) throw new Error(`Too many matches for ${JSON.stringify(formula.source)}; provide more unique source context`)
    }
    if (!candidates.length) throw new Error(`Cannot locate formula source ${JSON.stringify(formula.source)}: 0 matches. Copy source and before/after context from the extracted paragraph.`)
    groups.push({ formula, candidates })
  }
  // A repeated variable can be disambiguated by later, uniquely anchored formulas.
  // Accept exactly one ordered non-overlapping assignment for the whole paragraph.
  let states = [{ end: 0, count: 1, path: [] }]
  for (const group of groups) {
    const next = []
    for (const candidate of group.candidates) {
      const preceding = states.filter(state => state.end <= candidate.start)
      if (!preceding.length) continue
      next.push({ end: candidate.end, count: Math.min(2, preceding.reduce((n, s) => n + s.count, 0)), path: [...preceding[0].path, candidate] })
    }
    states = next
  }
  const count = Math.min(2, states.reduce((n, state) => n + state.count, 0))
  if (count !== 1) throw new Error(`Cannot uniquely align formulas in reading order: ${count} matches${count === 2 ? ' or more' : ''}. Provide longer exact before/after contexts; overlapping or out-of-order replacements are not allowed.`)
  const path = states.find(state => state.count === 1).path
  const segments = []; let cursor = 0
  for (const [index, { start, end }] of path.entries()) {
    const formula = groups[index].formula
    if (start > cursor) segments.push({ type: 'text', text: source.slice(cursor, start) })
    segments.push({ type: 'math', source: source.slice(start, end), latex: formula.latex, confidence: formula.confidence })
    cursor = end
  }
  if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) })
  return segments
}

function alignWhitespace(segments, source) {
  const raw = segments.map(s => s?.type === 'text' ? s.text ?? '' : s?.source ?? '').join('')
  if (raw === source || raw.replace(/\s/g, '') !== source.replace(/\s/g, '')) return segments
  // A model may normalize a space around punctuation. Locate math by the exact
  // non-whitespace character stream, then rebuild ALL prose from the original.
  // No words, symbols or original whitespace are changed or supplied by the model.
  const positions = []
  for (let i = 0; i < source.length; i++) if (!/\s/.test(source[i])) positions.push(i)
  const result = []; let chars = 0, cursor = 0
  for (const segment of segments) {
    const value = segment?.type === 'text' ? segment.text ?? '' : segment?.source ?? ''
    const length = value.replace(/\s/g, '').length
    if (segment?.type === 'math' && length) {
      const start = positions[chars], end = positions[chars + length - 1] + 1
      if (start > cursor) result.push({ type: 'text', text: source.slice(cursor, start) })
      result.push({ ...segment, source: source.slice(start, end) }); cursor = end
    }
    chars += length
  }
  if (cursor < source.length) result.push({ type: 'text', text: source.slice(cursor) })
  return result
}

export function inlineMathMarkup(latex) {
  const source = String(latex ?? '').trim()
  if (!source || source.length > 2000 || /\\(?:html\w*|href|url|includegraphics|def|gdef|newcommand|require)\b/.test(source)) throw new Error('Unsupported inline formula')
  // Native MathML needs no font downloads. Never share mutable macro definitions.
  return mathMLCore(katex.renderToString(source, { output: 'mathml', displayMode: false, throwOnError: true,
    trust: false, strict: 'ignore', maxSize: 4, maxExpand: 1000, macros: {} })
    .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, ''))
}

export function validateInlineMath(value, source, {sourceAlignedParser=false}={}) {
  if (Array.isArray(value?.formulas)) value = { segments: formulaSegments(value.formulas, source) }
  if (!value || !Array.isArray(value.segments) || value.segments.length > 300) throw new Error('Return a segments array')
  if (!value.segments.every(s => s?.type === 'text' && typeof s.text === 'string' || s?.type === 'math' && typeof s.source === 'string' && s.source.trim() && typeof s.latex === 'string')) throw new Error('Use only valid text and math segments')
  let restored = '', maths = 0
  const segments = alignWhitespace(value.segments, source).map(segment => {
    if (segment?.type === 'text' && typeof segment.text === 'string') {
      restored += segment.text
      return { type: 'text', text: segment.text }
    }
    if (segment?.type !== 'math' || typeof segment.source !== 'string' || !segment.source || typeof segment.latex !== 'string') throw new Error('Each math segment needs its exact source and LaTeX')
    const latex = segment.latex.trim().replace(/^\$+|\$+$/g, '')
    inlineMathMarkup(latex)
    const confidence = Number(segment.confidence)
    if (sourceAlignedParser ? segment.alignment!=='unique-prose-context' : !Number.isFinite(confidence) || confidence < 0.8 || confidence > 1) throw new Error('A formula is not confidently readable; leave uncertain text unchanged')
    const numbers = [...segment.source.normalize('NFKC').matchAll(/\d+(?:\.\d+)?/g)].map(m => m[0])
    if (numbers.some(n => !latex.includes(n))) throw new Error('A formula omitted a visible source number')
    restored += segment.source; maths++
    return { type: 'math', source: segment.source, latex, ...(sourceAlignedParser?{alignment:'unique-prose-context'}:{confidence}) }
  })
  if (restored !== source) {
    let at = 0
    while (at < source.length && source[at] === restored[at]) at++
    throw new Error(`Reproduce the source EXACTLY. First mismatch at offset ${at}: expected ${JSON.stringify(source.slice(Math.max(0, at - 24), at + 36))}, received ${JSON.stringify(restored.slice(Math.max(0, at - 24), at + 36))}. Return only formulas with exact source fragments; the program preserves all prose.`)
  }
  return { version: INLINE_MATH_VERSION, source, segments, maths }
}

function tokenAt(index) {
  let suffix = ''
  do { suffix = String.fromCharCode(65 + index % 26) + suffix; index = Math.floor(index / 26) - 1 } while (index >= 0)
  return `⟦DSHMATH_${suffix}⟧`
}

export function protectInlineMath(record) {
  let index = 0
  return record.segments.map(s => s.type === 'math' ? tokenAt(index++) : s.text).join('')
}

export function translatedMathSegments(text, record) {
  const maths = record.segments.filter(s => s.type === 'math')
  const byToken = new Map(maths.map((s, i) => [tokenAt(i), s]))
  const parts = []; let cursor = 0
  for (const match of String(text).matchAll(MATH_TOKEN_RE)) {
    if (!byToken.has(match[0])) return null
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) })
    parts.push(byToken.get(match[0])); cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
  return parts
}

export function mathTokenIssue(source, translation) {
  const a = [...String(source).matchAll(MATH_TOKEN_RE)].map(m => m[0]).sort()
  const b = [...String(translation).matchAll(MATH_TOKEN_RE)].map(m => m[0]).sort()
  return JSON.stringify(a) === JSON.stringify(b) ? null : 'Preserve EVERY ⟦DSHMATH_…⟧ token exactly once as supplied; do not translate, alter, duplicate or omit formula tokens.'
}

const paragraphKinds = new Set(['paragraph', 'caption', 'quote', 'footnote', 'list'])
const mathSignal = /[=≠≈≡≤≥∈∉∑∏∫√∞∂∇±×÷↦↔→←ℝℤℕ²³⁰-⁹₀-₉]|\\(?:frac|sum|int|sqrt|mathbb)\b|\b[A-Za-z][_^][A-Za-z0-9{]|\b(?:let|denote)\s+[A-Za-zα-ωΑ-Ω](?:\s+[A-Za-zα-ω0-9]{1,2})?\s+(?:be|denote|represent)/iu

export function isInlineMathParagraph(block) {
  return paragraphKinds.has(block?.kind) && typeof block.text === 'string' && !!block.text.trim() && !block.html
}

export function inlineMathBatchBlocks(content, entries) {
  return (content?.pages ?? []).flatMap(page => page.blocks ?? []).filter(block => {
    if (!isInlineMathParagraph(block) || block.text.length > 12000 || !mathSignal.test(block.text.replace(/https?:\/\/\S+/gi, ''))) return false
    if (block.parserInlineMath?.source === block.text || entries?.[block.id]?.record?.source === block.text || entries?.[block.id]?.pending) return false
    const rects = paragraphSourceRects(content, block)
    return rects.length > 0 && rects.length <= 4
  })
}

/** Original text runs provide the source location, including merged cross-page paragraphs. */
export function paragraphSourceRects(content, block) {
  const ids = new Set([block.id, ...(block.sourceIds ?? [])])
  const pages = []
  for (const page of content?.pages ?? []) {
    const runs = (page.sourceBlocks ?? page.visionSourceBlocks ?? page.blocks ?? []).filter(b => ids.has(b.id))
    const rects = runs.flatMap(b => b.sourceRects?.length ? b.sourceRects : [b.sourceRect ?? b.rect]).filter(Boolean)
    if (!rects.length) continue
    const x = Math.max(0, Math.min(...rects.map(r => r.x)) - 0.012)
    const y = Math.max(0, Math.min(...rects.map(r => r.y)) - 0.009)
    const right = Math.min(1, Math.max(...rects.map(r => r.x + r.w)) + 0.012)
    const bottom = Math.min(1, Math.max(...rects.map(r => r.y + r.h)) + 0.009)
    if (right > x && bottom > y) pages.push({ page: page.n, rect: { x, y, w: right - x, h: bottom - y } })
  }
  return pages
}
