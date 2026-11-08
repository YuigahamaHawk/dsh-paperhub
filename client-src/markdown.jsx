// Minimal, dependency-free Markdown renderer for AI answers and summaries.
// Supports headings, paragraphs, ordered/unordered lists, fenced code, blockquotes, bold,
// italic, inline code and links — enough for chat and study notes, safe by construction.
import React from 'react'

const h = React.createElement

function renderInline(text, keyPrefix) {
  const nodes = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let match
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('**') && token.endsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)))
    else if (token.startsWith('`') && token.endsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)))
    else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch !== null && /^https?:\/\//i.test(linkMatch[2])) {
        nodes.push(h('a', { key, href: linkMatch[2], target: '_blank', rel: 'noreferrer noopener' }, linkMatch[1]))
      } else {
        nodes.push(linkMatch !== null ? linkMatch[1] : token)
      }
    } else if (token.startsWith('*') && token.endsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)))
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/** Render one Markdown string as React elements. Never injects raw HTML. */
export function Markdown({ text, className = '' }) {
  const source = String(text ?? '')
  if (source.trim() === '') return null
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let list = null
  let code = null
  let quote = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(h('p', { key: `p-${blocks.length}` }, ...renderInline(paragraph.join(' '), `p${blocks.length}`)))
      paragraph = []
    }
  }
  const flushList = () => {
    if (list !== null) {
      const Tag = list.ordered ? 'ol' : 'ul'
      blocks.push(h(Tag, { key: `l-${blocks.length}` }, ...list.items.map((item, index) => h('li', { key: index }, ...renderInline(item, `l${blocks.length}-${index}`)))))
      list = null
    }
  }
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push(h('blockquote', { key: `q-${blocks.length}` }, ...quote.map((line, index) => h('p', { key: index }, ...renderInline(line, `q${blocks.length}-${index}`)))))
      quote = []
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const fence = /^```/.test(line.trim())
    if (code !== null) {
      if (fence) {
        blocks.push(h('pre', { key: `c-${blocks.length}` }, h('code', null, code.join('\n'))))
        code = null
      } else {
        code.push(rawLine)
      }
      continue
    }
    if (fence) {
      flushParagraph()
      flushList()
      flushQuote()
      code = []
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      flushQuote()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      flushQuote()
      const level = heading[1].length
      blocks.push(h(`h${level}`, { key: `h-${blocks.length}` }, ...renderInline(heading[2], `h${blocks.length}`)))
      continue
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      flushParagraph()
      flushQuote()
      const isOrdered = ordered !== null
      if (list === null || list.ordered !== isOrdered) {
        flushList()
        list = { ordered: isOrdered, items: [] }
      }
      list.items.push(unordered !== null ? unordered[1] : ordered[1])
      continue
    }
    const quoted = /^>\s?(.*)$/.exec(line)
    if (quoted !== null) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line)
  }
  if (code !== null) blocks.push(h('pre', { key: `c-${blocks.length}` }, h('code', null, code.join('\n'))))
  flushParagraph()
  flushList()
  flushQuote()
  return h('div', { className: `dr-md ${className}` }, ...blocks)
}

/** Strip Markdown syntax to a plain-text preview. */
export function markdownToPlain(text, maxLength = 240) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~-]{1,3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}
