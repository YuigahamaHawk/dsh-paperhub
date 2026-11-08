// One reflow reading block. Shared by the EPUB and reflowed-PDF views so translation,
// highlighting and selection behave identically for both formats.
import React from 'react'
import { useReader } from './store.jsx'
import { Spinner, IconRefresh } from './icons.jsx'
import { clsx } from './util.js'
import { InlineMathText, InlineTranslation, InlineMathTools } from './inline-math.jsx'
import { protectInlineMath } from '../shared/inline-math.js'

const h = React.createElement

/** Subscribe to one block's translation entry (stable reference from the translation service). */
function useTranslationEntry(service, blockId) {
  const subscribe = React.useCallback(
    (callback) => {
      if (service === null || service === undefined || typeof service.subscribe !== 'function') return () => undefined
      return service.subscribe(callback)
    },
    [service],
  )
  const getSnapshot = React.useCallback(() => {
    if (service === null || service === undefined || typeof service.get !== 'function') return undefined
    return service.get(blockId)
  }, [service, blockId])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' }

/** Render one reading block with its translation slot. */
export function ParagraphBlock({ block, className }) {
  const reader = useReader()
  const { t, translate, settings } = reader
  const elementRef = React.useRef(null)
  const blockId = block?.id ?? ''
  const entry = useTranslationEntry(translate, blockId)
  const mathRecord = block ? reader.inlineMath?.record(block) : null

  React.useEffect(() => {
    const element = elementRef.current
    if (element === null || blockId === '') return undefined
    reader.registerBlockEl?.(blockId, element)
    return () => reader.registerBlockEl?.(blockId, null)
  }, [blockId, reader])

  if (block === null || block === undefined) return null
  const translateEnabled = translate !== null && translate !== undefined && translate.enabled === true
  const displayMode = settings?.ai?.translate?.mode ?? 'bilingual'
  const expectedSource = mathRecord?.maths ? protectInlineMath(mathRecord) : block.text
  const translationText = entry?.status === 'done' && (!entry.source || entry.source === expectedSource) ? entry.text : ''
  const replaceOriginal = translateEnabled && displayMode === 'replace' && translationText !== ''
  const showTranslation = translateEnabled && displayMode !== 'replace'

  const inlineHtml = typeof block.html === 'string' && block.html.trim() !== '' ? block.html : null
  const textNode = mathRecord?.maths ? h(InlineMathText, { segments: mathRecord.segments, sourceAnchors: true }) : block.text ?? ''

  let content
  if (block.kind === 'image' && typeof block.image === 'string' && block.image !== '') {
    content = h('div', { className: 'dr-block-image' }, h('button', {type:'button',className:'dr-media-open','aria-label':t('media.enlarge','Enlarge figure'),title:t('media.enlarge','Enlarge figure'),onClick:()=>reader.previewMedia?.({blockId,src:block.image})}, h('img', { src: block.image, alt: block.alt ?? '', loading: 'lazy' })))
  } else if (block.kind === 'code') {
    content = h('pre', { className: 'dr-block-code' }, h('code', null, block.text ?? ''))
  } else if (block.kind === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.level) || 2))
    const Tag = HEADING_TAGS[level]
    content = h(
      'div',
      { className: 'dr-block-heading' },
      inlineHtml !== null ? h(Tag, { dangerouslySetInnerHTML: { __html: inlineHtml } }) : h(Tag, null, block.text ?? ''),
    )
  } else if (replaceOriginal) {
    content = h('div', { className: 'dr-block-text dr-block-translation', 'data-annotation-layer':'translation' }, h(InlineTranslation, { text: translationText, record: mathRecord }))
  } else if (block.kind === 'list' && inlineHtml !== null) {
    content = h('div', { className: 'dr-block-list', dangerouslySetInnerHTML: { __html: inlineHtml } })
  } else if (inlineHtml !== null) {
    content = h('div', { className: 'dr-block-text', dangerouslySetInnerHTML: { __html: inlineHtml } })
  } else {
    content = h('div', { className: 'dr-block-text' }, textNode)
  }

  const blockClass = clsx(
    'dr-block',
    reader.inlineMath?.available(block) && 'dr-block-inline-actions',
    block.kind === 'heading' && 'dr-block-heading-wrap',
    block.kind === 'quote' && 'dr-block-quote',
    block.kind === 'caption' && 'dr-block-caption',
    block.kind === 'footnote' && 'dr-block-footnote',
    className,
  )

  let translationSlot = null
  if (showTranslation) {
    if (entry?.status === 'loading' || (entry === undefined && translate.autoPending?.(blockId) === true)) {
      translationSlot = h('div', { className: 'dr-block-translation is-loading' }, h(Spinner, { size: 12 }), t('reader.translating', 'Translating…'))
    } else if (entry?.status === 'error') {
      translationSlot = h(
        'div',
        { className: 'dr-block-translation is-error', title: entry.error, onClick: () => translate.retry?.(blockId), role: 'button', tabIndex: 0,
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); translate.retry?.(blockId) } } },
        `${t('reader.translation.failed', 'Translation failed: {message}', { message: entry.error ?? t('common.error', 'Unknown error') })} · ${t('reader.translation.retry', 'Retry')}`,
      )
    } else if (translationText !== '') {
      translationSlot = h(
        'div',
        { className: 'dr-block-translation' },
        h('span',{'data-annotation-layer':'translation'},h(InlineTranslation, { text: translationText, record: mathRecord })),
        entry?.cached === true ? h('span', { className: 'dr-tr-cached' }, t('reader.translation.cached', 'cached')) : null,
        h('button', { type: 'button', className: 'dr-tr-retry', title: t('reader.translation.retranslate', 'Retranslate this paragraph'), 'aria-label': t('reader.translation.retranslate', 'Retranslate this paragraph'), onClick: () => translate.retry?.(blockId) }, h(IconRefresh, { size: 12 })),
      )
    } else if (entry?.status === 'done') {
      translationSlot = null
    }
  }

  return h(
    'div',
    { className: blockClass, 'data-block-id': blockId, 'data-kind': block.kind ?? 'paragraph', ref: elementRef },
    content,
    translationSlot,
    h(InlineMathTools, { block, service: reader.inlineMath, t }),
  )
}
