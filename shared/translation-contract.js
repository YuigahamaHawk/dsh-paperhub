import { mathTokenIssue } from './inline-math.js'
export const TRANSLATION_CACHE_VERSION = 2

// Bound a unit by sentence/phrase, rather than allowing the model to return a
// three-word heading as the translation of a whole page-long paragraph.
// Slicing is lossless: every source character belongs to exactly one unit.
export function splitTranslationText(text, limit = 480) {
  const source = String(text ?? '')
  if (source.length <= limit) return [source]
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source)].map(s => s.segment)
    : source.match(/[^.!?。！？]+(?:[.!?。！？]+\s*|$)/g) ?? [source]
  const chunks = []
  let current = ''
  for (let sentence of sentences) {
    if (current && current.length + sentence.length > limit) { chunks.push(current); current = '' }
    while (sentence.length > limit) {
      const left = sentence.slice(0, limit)
      const split = Math.max(left.lastIndexOf('; ') + 1, left.lastIndexOf(', ') + 1, left.lastIndexOf(' '))
      let at = split > limit / 2 ? split : limit
      for (const match of sentence.matchAll(/⟦DSHMATH_[A-Z]+⟧/g)) {
        if (match.index < at && at < match.index + match[0].length) at = match.index || match[0].length
      }
      if (at < sentence.length && /[\uD800-\uDBFF]/.test(sentence[at - 1]) && /[\uDC00-\uDFFF]/.test(sentence[at])) {
        at = at > 1 ? at - 1 : 2
      }
      chunks.push(sentence.slice(0, at))
      sentence = sentence.slice(at)
    }
    current += sentence
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [source]
}

function numericAnchors(text) {
  const normalized = String(text).normalize('NFKC').replace(/[−–]/g, '-').replace(/(\d),(?=\d{3}\b)/g, '$1')
  const scales = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, K: 1e3, M: 1e6, B: 1e9, T: 1e12, '千': 1e3, '万': 1e4, '亿': 1e8 }
  const values = []
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const tail = normalized.slice(match.index + match[0].length)
    const unit = tail.match(/^\s*(thousand\b|million\b|billion\b|trillion\b|[千万亿]|[KMBT](?![A-Za-z]))/)?.[1]
    values.push({ raw: String(Number(match[0])), scaled: String(Number(match[0]) * (scales[unit] ?? 1)), scale: unit ? scales[unit] : null })
  }
  return values
}

// This is a rejection gate for empty, grossly shortened or numerically
// incomplete output. It is deliberately not a claim of semantic equivalence.
export function translationIssue(source, value, lang = '') {
  const input = String(source ?? '').trim()
  if (!input) return null
  if (typeof value !== 'string' || !value.trim()) return 'The translation is empty.'
  const output = value.trim()
  const tokenIssue = mathTokenIssue(input, output)
  if (tokenIssue) return tokenIssue
  const words = input.match(/[A-Za-z]+/g)?.length ?? 0
  if (input.length > 120 && output.replace(/\s/g, '').length < Math.max(16, words * (/^(zh|ja|ko)/.test(lang) ? 0.8 : 1.2))) {
    return 'The translation is far shorter than the source and appears incomplete.'
  }
  const numbers = numericAnchors(output)
  const missing = numericAnchors(input).filter(value => !numbers.some(n =>
    n.scaled === value.scaled || n.raw === value.raw && (value.scale === null || n.scale === null || n.scale === value.scale))).map(n => n.raw)
  if (missing.length) return `The translation omitted source numbers: ${missing.slice(0, 12).join(', ')}. Keep every number, formula and citation.`
  return null
}
