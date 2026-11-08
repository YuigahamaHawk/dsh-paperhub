// EPUB reading surface.
//
// The parser (epub.js) has already produced sanitized `Block[]`; this component only renders them
// through the shared `ParagraphBlock` so translation / highlighting / selection behave exactly like
// reflowed PDF text. ReaderShell owns the scroll container and computes the active TOC section
// from the registered block elements, so no observer is needed here.
//
// Anchors: every heading block gets a stable DOM anchor id (`blk-<blockId>`) on a tiny wrapper so
// external jumps (`#blk-e3_12`) and in-app TOC navigation share the same target. Heading elements
// are also forwarded to `reader.registerBlockEl` (ParagraphBlock already registers itself; this is
// the idempotent safety net the reader-shell contract expects from content modules).

import React from 'react'
import { useReader } from './store.jsx'
import { ParagraphBlock } from './paragraph.jsx'

const h = React.createElement

/** Only a few wrapping tweaks are needed; everything else uses the shared stylesheet. */
const EPUB_CONTENT_CSS = `
.dr-epub-heading{display:block;scroll-margin-top:64px}
.dr-epub-heading>.dr-block-heading{margin-top:1.5em}
.dr-reader-content>.dr-epub-heading:first-child>.dr-block-heading{margin-top:0}
`

/** One heading anchor wrapper; keeps the heading's DOM shape intact for translation slots. */
function HeadingBlock({ block, registerBlockEl }) {
  const headingRef = React.useCallback(
    (element) => {
      if (element === null || element === undefined) return
      if (typeof registerBlockEl !== 'function') return
      let target = null
      try {
        target = typeof element.querySelector === 'function' ? element.querySelector('[data-block-id]') : null
      } catch {
        target = null
      }
      try {
        registerBlockEl(block.id, target ?? element)
      } catch {
        /* registration must never break rendering */
      }
    },
    [block.id, registerBlockEl],
  )
  return h(
    'div',
    {
      className: 'dr-epub-heading',
      id: block.id === '' ? undefined : `blk-${block.id}`,
      'data-epub-heading': block.id,
      ref: headingRef,
    },
    h(ParagraphBlock, { block }),
  )
}

/** Render parsed EPUB content (blocks in document order). */
export function EpubContent({ content }) {
  const reader = useReader()
  const blocks = React.useMemo(() => {
    if (content !== null && content !== undefined && Array.isArray(content.blocks)) return content.blocks
    if (Array.isArray(reader.blocks)) return reader.blocks
    return []
  }, [content, reader.blocks])
  const registerBlockEl = reader.registerBlockEl
  const hasToc = Array.isArray(content?.toc) && content.toc.length > 0

  return h(
    React.Fragment,
    null,
    h('style', { key: 'epub-content-style' }, EPUB_CONTENT_CSS),
    h(
      'div',
      {
        className: 'dr-reader-content',
        'data-epub-content': hasToc ? 'toc' : 'flat',
      },
      blocks.map((block, index) => {
        if (block === null || block === undefined || typeof block !== 'object') return null
        const blockId = typeof block.id === 'string' ? block.id : ''
        const key = blockId !== '' ? blockId : `epub-block-${index}`
        if (block.kind === 'heading') {
          return h(HeadingBlock, { key, block, registerBlockEl })
        }
        return h(ParagraphBlock, { key, block })
      }),
    ),
  )
}
