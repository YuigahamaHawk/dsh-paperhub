const bodyReference = /^(?:\([a-z]\)\s*)?(?:(?:also|below|above)\b|(?:shows?|reports?|gives?|lists?|summari[sz]es?|compares?|illustrates?|presents?|depicts?|describes?|contains?|provides?|plots?|demonstrates?|details?|is|are|was|were)\b|(?:显示|展示|给出|列出|说明|所示|中可以)|[)\]])/iu
const mediaStart = /^(fig(?:ure)?\.?|table\.?|图|表|附图|附表)\s*([A-Z]?\d+(?:[.\-]\d+)*[a-z]?|[IVXLCDM]+|[〇零一二三四五六七八九十百]+)(?![a-z0-9])/iu
const normalized = value => String(value ?? '').normalize('NFKC').trim()

export const startsWithMediaLabel = value => mediaStart.test(normalized(value))
export const isPanelLabel = value => /^(?:\([a-z]\)|[a-z][.)])(?:\s+\S.{0,110})?$/iu.test(normalized(value))

export function captionLabel(value) {
  const text = normalized(value)
  const match = mediaStart.exec(text)
  if (!match) return null
  const rest = text.slice(match[0].length).trimStart()
  const separated = /^[.:：|｜–—]/u.test(rest)
  if (!separated && bodyReference.test(rest)) return null
  return { kind: /^(?:fig|附?图)/iu.test(match[1]) ? 'figure' : 'table', number: match[2], separated }
}
