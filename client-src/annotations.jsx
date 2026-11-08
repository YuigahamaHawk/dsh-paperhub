// Selection toolbar + reflow highlight overlay.
//
// <SelectionToolbar> is rendered by ReaderShell over the reading stage: it appears whenever
// `useReader().selection` is set and lets the reader highlight, annotate, copy, translate or ask
// about the selected passage. <HighlightLayer> is the absolute overlay inside the scroll content:
// it re-derives viewport-independent rects for every reflow annotation from the registered block
// elements (range.getClientRects()) and paints `.dr-highlight-rect` boxes.
//
// Everything here is defensive: a missing selection, annotation list, registry or AI service must
// never throw — the reader keeps working with a subset of features.
import React from 'react'
import { useReader, useToast } from './store.jsx'
import { Button, IconButton, Textarea } from './ui.jsx'
import { IconCopy, IconHighlighter, IconNote, IconSpark, IconTranslate, IconUnderline } from './icons.jsx'
import { clamp, clsx, copyText } from './util.js'
import { collectSourceSegments, sourcePoint } from './source-anchors.js'

/** Highlight palette, in toolbar order. */
export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple']

const COLOR_LABELS = {
  yellow: ['ann.yellow', 'Yellow'],
  green: ['ann.green', 'Green'],
  blue: ['ann.blue', 'Blue'],
  pink: ['ann.pink', 'Pink'],
  purple: ['ann.purple', 'Purple'],
}

const STYLES = {
  colorRow: { display: 'flex', alignItems: 'center', gap: 6 },
  pickedDot: { outline: '2px solid var(--dsw-alias-brand-primary)', outlineOffset: 1 },
}

/** `t` may be the fallback reader's identity function; keep every call safe. */
function translate(t, key, fallback) {
  if (typeof t === 'function') return t(key, fallback)
  return typeof fallback === 'string' ? fallback : key
}

/** Map a ReaderShell selection onto an Ann.target, or null when it cannot be anchored. */
export function annotationTarget(selection) {
  if (selection === null || selection === undefined || typeof selection !== 'object') return null
  const text = typeof selection.text === 'string' ? selection.text : ''
  if (typeof selection.blockId === 'string' && selection.blockId !== '') {
    const parsedStart = Number(selection.start)
    const start = Number.isFinite(parsedStart) ? Math.max(0, Math.trunc(parsedStart)) : 0
    const parsedEnd = Number(selection.end)
    const end = Number.isFinite(parsedEnd) ? Math.max(start, Math.trunc(parsedEnd)) : start + text.length
    return { kind: 'reflow', blockId: selection.blockId, start, end,...(selection.layer==='translation'?{layer:'translation',lang:selection.lang??''}:{}) }
  }
  const page = Number(selection.page)
  if (Number.isFinite(page) && page > 0) {
    const sourceRects = Array.isArray(selection.rects) ? selection.rects : []
    const rects = []
    for (const rect of sourceRects) {
      if (rect === null || typeof rect !== 'object') continue
      const x = Number(rect.x)
      const y = Number(rect.y)
      const w = Number(rect.w)
      const h = Number(rect.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
      rects.push({ x, y, w, h })
    }
    return { kind: 'pdf', page: Math.trunc(page), rects }
  }
  return null
}

/** Create an annotation for a selection through the reader session (exported helper). */
export function createAnnotation(reader, selection, options = {}) {
  if (reader === null || typeof reader !== 'object') return null
  const target = annotationTarget(selection)
  if (target === null) return null
  try {
    if (typeof reader.addAnnotation !== 'function') return null
    return reader.addAnnotation({
      color: ANNOTATION_COLORS.includes(options.color) ? options.color : 'yellow',
      style: options.style === 'underline' ? 'underline' : 'highlight',
      text: typeof options.text === 'string' ? options.text : typeof selection.text === 'string' ? selection.text : '',
      target,
      note: typeof options.note === 'string' ? options.note : '',
    })
  } catch {
    return null
  }
}

/** Find an annotation that already covers this selection (same anchor), if any. */
export function findExistingAnnotation(list, target, containing=false) {
  if (!Array.isArray(list) || target === null) return null
  for (const annotation of list) {
    if (annotation === null || typeof annotation !== 'object') continue
    const existing = annotation.target
    if (existing === null || typeof existing !== 'object' || existing.kind !== target.kind) continue
    if (target.kind === 'reflow') {
      if (existing.blockId !== target.blockId) continue
      if((existing.layer??'original')!==(target.layer??'original')||existing.layer==='translation'&&existing.lang!==target.lang)continue
      if(Number(existing.start)===target.start&&Number(existing.end)===target.end)return annotation
      if(containing&&Number(existing.start)<=target.start&&Number(existing.end)>=target.end)return annotation
    } else {
      if (Number(existing.page) !== target.page) continue
      const existingRects = Array.isArray(existing.rects) ? existing.rects : []
      const targetRects = Array.isArray(target.rects) ? target.rects : []
      if (existingRects.length === 0 || targetRects.length === 0) continue
      const left = existingRects[0]
      const right = targetRects[0]
      if (left === null || right === null || left === undefined || right === undefined) continue
      if (Math.abs(Number(left.x) - Number(right.x)) <= 0.01 && Math.abs(Number(left.y) - Number(right.y)) <= 0.01) return annotation
    }
  }
  return null
}

/** Viewport size, tracked so fixed-position overlays re-clamp on resize. */
function useViewportSize() {
  const read = () => {
    if (typeof window === 'undefined') return { width: 1024, height: 768 }
    return {
      width: Number(window.innerWidth) || 1024,
      height: Number(window.innerHeight) || 768,
    }
  }
  const [size, setSize] = React.useState(read)
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setSize(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/** Place a fixed panel next to a selection rect, clamped inside the viewport. */
function placeNear(rect, width, height, viewport, prefer = 'above') {
  const pad = 8
  const vw = Math.max(320, Number(viewport?.width) || 1024)
  const vh = Math.max(240, Number(viewport?.height) || 768)
  const safeWidth = Math.max(120, Math.min(Number(width) || 200, vw - pad * 2))
  const safeHeight = Math.max(32, Math.min(Number(height) || 36, vh - pad * 2))
  let left = vw / 2 - safeWidth / 2
  let top = vh / 3
  if (rect !== null && rect !== undefined && typeof rect === 'object') {
    const rawLeft = Number(rect.left)
    const rawTop = Number(rect.top)
    if (Number.isFinite(rawLeft) && Number.isFinite(rawTop)) {
      const rectWidth = Number.isFinite(Number(rect.width)) ? Number(rect.width) : 0
      const rectHeight = Number.isFinite(Number(rect.height)) ? Number(rect.height) : 0
      left = rawLeft + rectWidth / 2 - safeWidth / 2
      if (prefer === 'below') {
        top = rawTop + rectHeight + 10
        if (top + safeHeight > vh - pad) top = rawTop - safeHeight - 10
      } else {
        top = rawTop - safeHeight - 8
        if (top < pad) top = rawTop + rectHeight + 10
        if (top + safeHeight > vh - pad) top = Math.max(pad, rawTop - safeHeight - 8)
      }
    }
  }
  return {
    left: Math.round(clamp(left, pad, Math.max(pad, vw - safeWidth - pad))),
    top: Math.round(clamp(top, pad, Math.max(pad, vh - safeHeight - pad))),
  }
}

/** Floating toolbar for the active text selection. */
export function SelectionToolbar() {
  const reader = useReader() ?? {}
  const { toast } = useToast()
  const t = reader.t
  const selection = reader.selection !== null && reader.selection !== undefined && typeof reader.selection === 'object' ? reader.selection : null
  const viewport = useViewportSize()
  const barRef = React.useRef(null)
  const noteRef = React.useRef(null)
  const readerRef = React.useRef(reader)
  readerRef.current = reader
  const [barSize, setBarSize] = React.useState({ width: 264, height: 38 })
  const [noteSize, setNoteSize] = React.useState({ width: 300, height: 232 })
  const [noteOpen, setNoteOpen] = React.useState(false)
  const [noteText, setNoteText] = React.useState('')
  const [noteColor, setNoteColor] = React.useState('yellow')
  const [pickStyle, setPickStyle] = React.useState('highlight')
  const [noteStyle, setNoteStyle] = React.useState('highlight')
  const [pendingId, setPendingId] = React.useState(null)
  const [editorSelection,setEditorSelection]=React.useState(null)

  const selectionKey =
    selection === null
      ? ''
      : [selection.blockId ?? '', selection.start ?? '', selection.end ?? '', selection.page ?? '', selection.text ?? ''].join('|')

  // A new selection always starts with a clean note editor.
  React.useEffect(() => {
    setNoteOpen(false)
    setNoteText('')
    setNoteColor('yellow')
    setNoteStyle('highlight')
    setPickStyle('highlight')
    setPendingId(null)
    setEditorSelection(null)
  }, [selectionKey])

  React.useEffect(()=>{
    const request=reader.noteRequest
    if(!request?.id)return
    const ann=reader.annotations?.find(entry=>entry.id===request.id)
    if(!ann)return
    const target=ann.target??{},element=target.kind==='reflow'?resolveBlockEl(reader,target.blockId):null
    const rect=request.rect??element?.getBoundingClientRect?.()??{left:viewport.width/2,top:viewport.height/3,width:0,height:0}
    setEditorSelection({...target,blockId:target.blockId,text:ann.text,rect})
    setPendingId(ann.id);setNoteText(ann.note??'');setNoteColor(ann.color??'yellow');setNoteStyle(ann.style??'highlight');setNoteOpen(true)
  },[reader.noteRequest?.nonce])

  // Measure the real toolbar/editor size once mounted so clamping is exact.
  React.useLayoutEffect(() => {
    const bar = barRef.current
    if (bar === null) return
    const width = bar.offsetWidth || 264
    const height = bar.offsetHeight || 38
    setBarSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
  }, [selectionKey])

  React.useLayoutEffect(() => {
    const editor = noteRef.current
    if (editor === null) return
    const width = editor.offsetWidth || 300
    const height = editor.offsetHeight || 232
    setNoteSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    editor.querySelector('textarea')?.focus({preventScroll:true})
  }, [noteOpen, selectionKey])

  const dismiss = React.useCallback(() => {
    setNoteOpen(false)
    setNoteText('')
    setPendingId(null)
    setEditorSelection(null)
    readerRef.current?.clearNoteRequest?.()
    try {
      readerRef.current?.clearSelection?.()
    } catch {
      /* selection owner unavailable */
    }
  }, [])

  // Dismiss on Escape, outside mousedown, or scroll.
  React.useEffect(() => {
    if (selection === null&&editorSelection===null) return undefined
    const onMouseDown = (event) => {
      const target = event.target
      if (barRef.current !== null && barRef.current.contains(target)) return
      if (noteRef.current !== null && noteRef.current.contains(target)) return
      dismiss()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      dismiss()
    }
    const onScroll = (event) => {
      // Ignore scrolling inside our own floating panels (e.g. a long note textarea).
      const target = event?.target
      if (noteRef.current !== null && typeof Node !== 'undefined' && target instanceof Node && noteRef.current.contains(target)) return
      if (barRef.current !== null && typeof Node !== 'undefined' && target instanceof Node && barRef.current.contains(target)) return
      dismiss()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [selection, editorSelection, dismiss])

  const applyColor = (color, style = pickStyle) => {
    if (selection === null) return
    const target = annotationTarget(selection)
    if (target === null) return
    try {
      const existing = findExistingAnnotation(readerRef.current?.annotations, target)
      if (existing !== null && typeof reader.updateAnnotation === 'function') {
        reader.updateAnnotation(existing.id, { color, style })
      } else if (typeof reader.addAnnotation === 'function') {
        reader.addAnnotation({ color, style, text: typeof selection.text === 'string' ? selection.text : '', target, note: '' })
      } else {
        return
      }
    } catch {
      toast(translate(t, 'toast.error', 'Something went wrong'), 'error')
      return
    }
    dismiss()
  }

  const openNote = () => {
    if (selection === null) return
    const target = annotationTarget(selection)
    const existing = target === null ? null : findExistingAnnotation(readerRef.current?.annotations, target,true)
    if (existing !== null) {
      setPendingId(typeof existing.id === 'string' ? existing.id : null)
      setNoteText(typeof existing.note === 'string' ? existing.note : '')
      setNoteColor(ANNOTATION_COLORS.includes(existing.color) ? existing.color : 'yellow')
      setNoteStyle(existing.style === 'underline' ? 'underline' : 'highlight')
    } else {
      setPendingId(null)
      setNoteText('')
      setNoteColor('yellow')
      setNoteStyle('highlight')
    }
    setNoteOpen(true)
  }

  const saveNote = () => {
    const currentSelection=editorSelection??selection
    if (currentSelection === null) return
    const target = annotationTarget(currentSelection)
    if (target === null) {
      dismiss()
      return
    }
    const note = noteText.trim()
    try {
      if (pendingId !== null && typeof reader.updateAnnotation === 'function') {
        reader.updateAnnotation(pendingId, { note, color: noteColor, style: noteStyle })
      } else if (typeof reader.addAnnotation === 'function') {
        reader.addAnnotation({ color: noteColor, style: noteStyle, text: typeof currentSelection.text === 'string' ? currentSelection.text : '', target, note })
      } else {
        return
      }
      toast(translate(t, 'ann.noteUpdated', 'Annotation updated'), 'success')
    } catch {
      toast(translate(t, 'toast.error', 'Something went wrong'), 'error')
    }
    dismiss()
  }

  const onCopy = () => {
    const text = typeof selection?.text === 'string' ? selection.text : ''
    copyText(text)
      .then((ok) => toast(ok ? translate(t, 'toast.copied', 'Copied to clipboard') : translate(t, 'toast.error', 'Something went wrong'), ok ? 'success' : 'error'))
      .catch(() => undefined)
  }

  const fallbackToClipboard = () => {
    const text = typeof selection?.text === 'string' ? selection.text : ''
    copyText(text)
      .then((ok) => toast(ok ? translate(t, 'toast.copied', 'Copied to clipboard') : translate(t, 'toast.error', 'Something went wrong'), ok ? 'success' : 'error'))
      .catch(() => undefined)
  }

  const onTranslate = () => {
    const text = typeof selection?.text === 'string' ? selection.text : ''
    if (text.trim() === '') return
    if (typeof reader.askAbout === 'function') {
      try {
        reader.askAbout(text, { action: 'translate', blockId: selection.blockId, page: selection.page })
        dismiss()
        return
      } catch {
        /* no AI panel available — copy instead */
      }
    }
    fallbackToClipboard()
  }

  const onAsk = () => {
    const text = typeof selection?.text === 'string' ? selection.text : ''
    if (text.trim() === '') return
    if (typeof reader.askAbout === 'function') {
      try {
        reader.askAbout(text, { blockId: selection.blockId, page: selection.page })
        dismiss()
        return
      } catch {
        /* fall through */
      }
    }
    try {
      if (typeof reader.openAi === 'function') {
        reader.openAi()
        dismiss()
        return
      }
    } catch {
      /* fall through */
    }
    fallbackToClipboard()
  }

  const onToolbarKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const bar = barRef.current
    if (bar === null) return
    const buttons = Array.from(bar.querySelectorAll('button')).filter((button) => button.disabled !== true)
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
    buttons[next].focus()
  }

  const hasText = selection !== null && typeof selection.text === 'string' && selection.text.trim() !== ''
  if ((!selection&&!editorSelection) || (!hasText && !noteOpen)) return null

  const anchor=editorSelection??selection
  const barPosition = placeNear(anchor?.rect, barSize.width, barSize.height, viewport, 'above')
  const noteWidth = Math.min(300, Math.max(220, viewport.width - 16))
  const notePosition = placeNear(anchor?.rect, noteWidth, noteSize.height, viewport, 'below')

  return (
    <React.Fragment>
      {!noteOpen && hasText ? (
        <div
          ref={barRef}
          className="dr-selection-toolbar"
          role="toolbar"
          aria-label={translate(t, 'ann.title', 'Annotations')}
          aria-orientation="horizontal"
          style={{ left: barPosition.left, top: barPosition.top }}
          onMouseDown={(event) => {event.preventDefault();event.stopPropagation()}}
          onKeyDown={onToolbarKeyDown}
        >
          <IconButton
            icon={<IconUnderline size={15} />}
            label={translate(t, 'ann.underline', 'Underline')}
            size="sm"
            aria-pressed={pickStyle === 'underline'}
            style={pickStyle === 'underline' ? STYLES.pickedDot : undefined}
            onClick={() => { setPickStyle('underline'); applyColor('yellow', 'underline') }}
          />
          <span className="dr-sel-divider" aria-hidden="true" />
          {ANNOTATION_COLORS.map((color) => {
            const labels = COLOR_LABELS[color]
            const label = translate(t, labels[0], labels[1])
            return <button key={color} type="button" className="dr-sel-color" data-color={color} title={label} aria-label={label} onClick={() => applyColor(color)} />
          })}
          <span className="dr-sel-divider" aria-hidden="true" />
          <IconButton icon={<IconNote size={15} />} label={translate(t, 'ann.addNote', 'Add note')} size="sm" onClick={openNote} />
          <IconButton icon={<IconCopy size={15} />} label={translate(t, 'ann.copy', 'Copy text')} size="sm" onClick={onCopy} />
          <IconButton icon={<IconTranslate size={15} />} label={translate(t, 'ann.translate', 'Translate')} size="sm" onClick={onTranslate} />
          <IconButton icon={<IconSpark size={15} />} label={translate(t, 'ann.ask', 'Ask AI')} size="sm" onClick={onAsk} />
        </div>
      ) : null}
      {noteOpen ? (
        <div
          ref={noteRef}
          className="dr-note-editor"
          role="dialog"
          aria-label={pendingId===null?translate(t,'ann.addNote','Add note'):translate(t,'ann.editNote','Edit note')}
          style={{ left: notePosition.left, top: notePosition.top, width: noteWidth }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="dr-note-editor-title">{pendingId === null ? translate(t, 'ann.addNote', 'Add note') : translate(t, 'ann.editNote', 'Edit note')}</div>
          <div style={STYLES.colorRow}>
            <IconButton
              icon={<IconHighlighter size={14} />}
              label={translate(t, 'ann.highlight', 'Highlight')}
              size="sm"
              aria-pressed={noteStyle === 'highlight'}
              style={noteStyle === 'highlight' ? STYLES.pickedDot : undefined}
              onClick={() => setNoteStyle('highlight')}
            />
            <IconButton
              icon={<IconUnderline size={14} />}
              label={translate(t, 'ann.underline', 'Underline')}
              size="sm"
              aria-pressed={noteStyle === 'underline'}
              style={noteStyle === 'underline' ? STYLES.pickedDot : undefined}
              onClick={() => setNoteStyle('underline')}
            />
            {ANNOTATION_COLORS.map((color) => {
              const labels = COLOR_LABELS[color]
              const label = translate(t, labels[0], labels[1])
              return (
                <button
                  key={color}
                  type="button"
                  className="dr-sel-color"
                  data-color={color}
                  title={label}
                  aria-label={label}
                  aria-pressed={noteColor === color}
                  style={noteColor === color ? STYLES.pickedDot : undefined}
                  onClick={() => setNoteColor(color)}
                />
              )
            })}
          </div>
          <Textarea
            value={noteText}
            rows={4}
            placeholder={translate(t, 'ann.notePlaceholder', 'Write a note…')}
            onChange={(event) => setNoteText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                saveNote()
              }
            }}
          />
          <div className="dr-note-editor-actions">
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {translate(t, 'common.cancel', 'Cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={saveNote}>
              {translate(t, 'common.save', 'Save')}
            </Button>
          </div>
        </div>
      ) : null}
    </React.Fragment>
  )
}

// ---------------------------------------------------------------------------------------------
// Highlight overlay
// ---------------------------------------------------------------------------------------------

const RECT_PRECISION = 10

function roundRect(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * RECT_PRECISION) / RECT_PRECISION
}

function escapeSelectorValue(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

/** Resolve a block element through the reader registry, with a DOM fallback. */
function resolveBlockEl(reader, blockId) {
  if (typeof blockId !== 'string' || blockId === '') return null
  try {
    if (typeof reader.getBlockEl === 'function') {
      const registered = reader.getBlockEl(blockId)
      if (registered !== null && registered !== undefined && typeof registered.getBoundingClientRect === 'function' && registered.isConnected !== false) {
        return registered
      }
    }
  } catch {
    /* registry unavailable */
  }
  const root = reader.contentRoot
  const selector = `[data-block-id="${escapeSelectorValue(blockId)}"]`
  if (root !== null && root !== undefined && typeof root.querySelector === 'function') {
    try {
      const found = root.querySelector(selector)
      if (found !== null) return found
    } catch {
      /* invalid selector */
    }
  }
  if (typeof document !== 'undefined') {
    try {
      return document.querySelector(selector)
    } catch {
      return null
    }
  }
  return null
}

/** Concatenate the visible text nodes of a block, skipping translation/overlay slots. */
function collectTextSegments(rootEl) {
  return collectSourceSegments(rootEl)
}

/** Map an absolute offset in the collected text back to a (text node, offset) point. */
function pointAtOffset(segments, offset) {
  return sourcePoint(segments, offset)
}

/** Collapse whitespace runs to single spaces, keeping a map back to original text offsets. */
function whitespaceNormalized(text) {
  let normalized = ''
  const map = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) {
      let end = index
      while (end < text.length && /\s/.test(text[end])) end++
      normalized += ' '
      map.push(index)
      index = end
    } else {
      normalized += char
      map.push(index)
      index++
    }
  }
  return { normalized, map }
}

function pickNearest(candidates, wantedStart) {
  if (candidates.length === 0) return null
  const desired = Number.isFinite(wantedStart) ? wantedStart : 0
  let best = candidates[0]
  for (const candidate of candidates) {
    if (Math.abs(candidate.start - desired) < Math.abs(best.start - desired)) best = candidate
  }
  return best
}

/**
 * Locate `quote` inside the rendered block text, preferring the occurrence nearest the annotation
 * offset. ReaderShell normalises selection whitespace, so a whitespace-insensitive pass follows
 * the exact one; the caller falls back to raw offsets when neither matches.
 */
function findQuoteMatch(text, quote, wantedStart) {
  if (quote === '' || text === '') return null
  const exact = []
  let from = 0
  while (exact.length < 64) {
    const index = text.indexOf(quote, from)
    if (index === -1) break
    exact.push({ start: index, length: quote.length })
    from = index + Math.max(1, quote.length)
  }
  if (exact.length > 0) return pickNearest(exact, wantedStart)

  const collapsed = quote.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  const { normalized, map } = whitespaceNormalized(text)
  if (normalized === '' || map.length === 0) return null
  const loose = []
  let cursor = 0
  while (loose.length < 64) {
    const index = normalized.indexOf(collapsed, cursor)
    if (index === -1) break
    const start = map[index]
    const lastIndex = index + collapsed.length - 1
    const end = lastIndex >= 0 && lastIndex < map.length ? map[lastIndex] + 1 : text.length
    loose.push({ start, length: Math.max(1, end - start) })
    cursor = index + Math.max(1, collapsed.length)
  }
  return pickNearest(loose, wantedStart)
}

/**
 * Build a DOM Range for one reflow annotation inside its block element.
 * Prefers the occurrence of `ann.text` nearest `ann.target.start`, falls back to raw offsets.
 */
function annotationRange(blockEl, annotation) {
  const root=annotation.target?.layer==='translation'?blockEl.querySelector('[data-annotation-layer="translation"]'):blockEl
  if(!root)return null
  const { segments, text } = collectTextSegments(root)
  if (segments.length === 0 || text === '') return null
  const target = annotation.target !== null && typeof annotation.target === 'object' ? annotation.target : {}
  const quote = typeof annotation.text === 'string' ? annotation.text : ''
  const wantedStart = Number(target.start)
  let start = -1
  let length = 0

  if (quote !== '') {
    const match = findQuoteMatch(text, quote, wantedStart)
    if (match !== null) {
      start = match.start
      length = match.length
    }
  }

  if(start<0&&annotation.target?.layer==='translation'&&quote)return null
  if (start < 0) {
    const rawStart = Number.isFinite(wantedStart) ? Math.max(0, Math.trunc(wantedStart)) : 0
    const rawEnd = Number.isFinite(Number(target.end)) ? Math.max(rawStart, Math.trunc(Number(target.end))) : rawStart + Math.max(1, quote.length)
    if (rawStart >= text.length) return null
    start = rawStart
    length = Math.min(text.length, rawEnd) - rawStart
    if (length <= 0) return null
  }

  const end = Math.min(text.length, start + Math.max(1, length))
  const startPoint = pointAtOffset(segments, start)
  const endPoint = sourcePoint(segments, end, 'end')
  if (startPoint === null || endPoint === null) return null
  try {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  } catch {
    return null
  }
}

/** Paint annotation rects for the reflow content currently in the DOM. */
export function HighlightLayer() {
  const reader = useReader() ?? {}
  const layerRef = React.useRef(null)
  const readerRef = React.useRef(reader)
  readerRef.current = reader
  const signatureRef = React.useRef('')
  const rafRef = React.useRef(0)
  const [rects, setRects] = React.useState([])
  const annotations = Array.isArray(reader.annotations) ? reader.annotations : []
  const scrollRoot = reader.scrollRoot ?? null
  const contentRoot = reader.contentRoot ?? null
  const layoutVersion = reader.layoutVersion
  const appearance = reader.settings !== null && reader.settings !== undefined ? reader.settings.appearance : null
  const appearanceKey =
    appearance !== null && appearance !== undefined && typeof appearance === 'object'
      ? [appearance.fontFamily, appearance.fontSize, appearance.lineHeight, appearance.paragraphSpacing, appearance.pageWidth, appearance.justify, appearance.hyphenate].join('|')
      : ''

  const measure = React.useCallback(() => {
    const layerEl = layerRef.current
    if (layerEl === null || typeof document === 'undefined') return
    const current = readerRef.current ?? {}
    const list = Array.isArray(current.annotations) ? current.annotations : []
    const originEl = current.contentRoot ?? layerEl.parentElement ?? null
    if (originEl === null || originEl === undefined) return
    let originLeft = 0
    let originTop = 0
    try {
      const originRect = typeof originEl.getBoundingClientRect === 'function' ? originEl.getBoundingClientRect() : null
      const layerRect = layerEl.getBoundingClientRect()
      const useOrigin = originRect !== null && (originRect.width > 0 || originRect.height > 0)
      originLeft = useOrigin ? originRect.left : layerRect.left
      originTop = useOrigin ? originRect.top : layerRect.top
    } catch {
      return
    }

    const next = []
    for (const annotation of list) {
      if (annotation === null || typeof annotation !== 'object') continue
      const target = annotation.target
      if (target === null || typeof target !== 'object' || target.kind !== 'reflow') continue
      if(target.layer==='translation'&&target.lang!==current.translate?.lang)continue
      const blockEl = resolveBlockEl(current, target.blockId)
      if (blockEl === null) continue
      const range = annotationRange(blockEl, annotation)
      if (range === null) continue
      const parts = []
      try {
        const clientRects = range.getClientRects()
        if (clientRects !== null && clientRects.length > 0) {
          for (let index = 0; index < clientRects.length; index++) parts.push(clientRects[index])
        } else {
          parts.push(range.getBoundingClientRect())
        }
      } catch {
        continue
      }
      let index = 0
      for (const rect of parts) {
        if (rect === null || rect === undefined) continue
        const width = Number(rect.width) || 0
        const height = Number(rect.height) || 0
        if (width < 0.6 || height < 0.6) continue
        next.push({
          key: `${annotation.id ?? 'ann'}-${index++}`,
          id: typeof annotation.id === 'string' ? annotation.id : '',
          color: ANNOTATION_COLORS.includes(annotation.color) ? annotation.color : 'yellow',
          style: annotation.style === 'underline' ? 'underline' : 'highlight',
          label: (typeof annotation.text === 'string' ? annotation.text : '').slice(0, 160),
          rect: {
            left: roundRect(Number(rect.left) - originLeft),
            top: roundRect(Number(rect.top) - originTop),
            width: roundRect(width),
            height: roundRect(height),
          },
        })
      }
    }

    const signature = next.map((entry) => `${entry.id}:${entry.color}:${entry.style}:${entry.rect.left},${entry.rect.top},${entry.rect.width},${entry.rect.height}`).join(';')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    setRects(next)
  }, [])

  // Coalesce every geometry trigger into one animation frame.
  const schedule = React.useCallback(() => {
    if (typeof window === 'undefined') return
    if (rafRef.current !== 0) return
    if (typeof window.requestAnimationFrame !== 'function') {
      measure()
      return
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      measure()
    })
  }, [measure])

  // Re-measure after render whenever the document, annotations, layout or scroll container changes.
  React.useLayoutEffect(() => {
    measure()
  }, [measure, annotations, contentRoot, layoutVersion, appearanceKey])

  // ReaderShell reports block registration / layout changes; subscribe for the component's life.
  React.useEffect(() => {
    const current = readerRef.current
    if (current === null || typeof current !== 'object' || typeof current.onLayoutChange !== 'function') return undefined
    let unsubscribe = null
    try {
      unsubscribe = current.onLayoutChange(schedule)
    } catch {
      return undefined
    }
    return () => {
      try {
        if (typeof unsubscribe === 'function') unsubscribe()
      } catch {
        /* already disposed */
      }
    }
  }, [schedule])

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const scrollEl = scrollRoot
    if (scrollEl !== null && scrollEl !== undefined && typeof scrollEl.addEventListener === 'function') {
      scrollEl.addEventListener('scroll', schedule, { passive: true })
    }
    window.addEventListener('resize', schedule)
    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(schedule)
      const targets = [contentRoot, layerRef.current]
      for (const target of targets) {
        if (target === null || target === undefined) continue
        try {
          observer.observe(target)
        } catch {
          /* not observable */
        }
      }
    }
    const onLoad = () => schedule()
    document.addEventListener('load', onLoad, true)
    const timers = [setTimeout(schedule, 80), setTimeout(schedule, 300), setTimeout(schedule, 1200)]
    let cancelled = false
    try {
      const fonts = document.fonts
      if (fonts !== null && fonts !== undefined && fonts.ready !== null && typeof fonts.ready?.then === 'function') {
        fonts.ready.then(() => {
          if (!cancelled) schedule()
        }).catch(() => undefined)
      }
    } catch {
      /* font loading API unavailable */
    }
    schedule()
    return () => {
      cancelled = true
      if (rafRef.current !== 0 && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      if (scrollEl !== null && scrollEl !== undefined && typeof scrollEl.removeEventListener === 'function') {
        scrollEl.removeEventListener('scroll', schedule)
      }
      window.removeEventListener('resize', schedule)
      if (observer !== null) observer.disconnect()
      document.removeEventListener('load', onLoad, true)
      for (const timer of timers) clearTimeout(timer)
    }
  }, [schedule, scrollRoot, contentRoot])

  React.useEffect(()=>{
    if(!scrollRoot)return
    let down=null
    const start=event=>{down={x:event.clientX,y:event.clientY}}
    const click=event=>{
      if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>4||!window.getSelection()?.isCollapsed)return
      const origin=layerRef.current?.getBoundingClientRect();if(!origin)return
      const hit=[...rects].reverse().find(entry=>event.clientX>=origin.left+entry.rect.left&&event.clientX<=origin.left+entry.rect.left+entry.rect.width&&event.clientY>=origin.top+entry.rect.top&&event.clientY<=origin.top+entry.rect.top+entry.rect.height)
      readerRef.current.activateAnnotation?.(hit?.id??null)
    }
    scrollRoot.addEventListener('pointerdown',start);scrollRoot.addEventListener('click',click)
    return()=>{scrollRoot.removeEventListener('pointerdown',start);scrollRoot.removeEventListener('click',click)}
  },[scrollRoot,rects])

  return (
    <div ref={layerRef} className="dr-highlight-layer">
      {rects.map((entry) => (
        <div
          key={entry.key}
          className={clsx('dr-highlight-rect', reader.activeAnnId === entry.id && 'is-active')}
          data-color={entry.color}
          data-style={entry.style}
          data-ann-id={entry.id}
          aria-hidden="true"
          style={{
            left: `${entry.rect.left}px`,
            top: `${entry.rect.top}px`,
            width: `${entry.rect.width}px`,
            height: `${entry.rect.height}px`,
          }}
        />
      ))}
    </div>
  )
}
