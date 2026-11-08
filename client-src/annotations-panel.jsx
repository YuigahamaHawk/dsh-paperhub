// Left-sidebar panels for everything annotation related:
//   highlights — every highlight/annotation grouped by colour (click focuses it in the text)
//   notes      — annotations carrying a note, with inline editing
//   focus      — source-grounded classified reading cards in StudyMapPanel
//
// The panel is pure UI over the reader session (`useReader()`) and app state (`useApp()`); it never
// writes to the DOM outside its own subtree and every optional member is guarded.
import React from 'react'
import {StudyMapPanel} from './study-map.jsx'
import { useApp, useReader } from './store.jsx'
import { Badge, Button, IconButton, Textarea } from './ui.jsx'
import { IconCheck, IconClose, IconDownload, IconEdit, IconTrash } from './icons.jsx'
import { clsx, formatRelative } from './util.js'

const PANEL_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple']

const COLOR_HEX = {
  yellow: '#f2c94c',
  green: '#6fcf97',
  blue: '#56a8f5',
  pink: '#f28ab2',
  purple: '#a58bf0',
}

const COLOR_LABELS = {
  yellow: ['ann.yellow', 'Yellow'],
  green: ['ann.green', 'Green'],
  blue: ['ann.blue', 'Blue'],
  pink: ['ann.pink', 'Pink'],
  purple: ['ann.purple', 'Purple'],
}

const STYLES = {
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '9px 9px 4px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--dr-paper-muted)',
  },
  groupDot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
  groupCount: { marginLeft: 'auto', opacity: 0.75, fontWeight: 500, letterSpacing: 0 },
  metaRow: { display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto' },
  actionRow: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 2 },
  inlineForm: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 },
  pad: { padding: '6px 9px 8px' },
  headerActions: { display: 'flex', alignItems: 'center', gap: 2, flex: 'none' },
  dangerIcon: { color: 'var(--dsw-alias-state-error-primary)' },
  focusError: { marginTop: 6, fontSize: 11.5, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
}

function translate(t, key, fallback) {
  if (typeof t === 'function') return t(key, fallback)
  return typeof fallback === 'string' ? fallback : key
}

function listAnnotations(reader) {
  if (reader === null || reader === undefined) return []
  const list = reader.annotations
  if (!Array.isArray(list)) return []
  const out = []
  for (const annotation of list) {
    if (annotation !== null && annotation !== undefined && typeof annotation === 'object') out.push(annotation)
  }
  return out
}

function textOf(annotation) {
  return typeof annotation?.text === 'string' ? annotation.text : ''
}

function noteOf(annotation) {
  return typeof annotation?.note === 'string' ? annotation.note : ''
}

function colorOf(annotation) {
  return PANEL_COLORS.includes(annotation?.color) ? annotation.color : 'yellow'
}

function timeOf(annotation) {
  const stamp = Number(annotation?.updatedAt ?? annotation?.createdAt)
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  return formatRelative(stamp)
}

function pageOf(annotation) {
  const page = Number(annotation?.target?.page)
  return Number.isFinite(page) && page > 0 ? Math.trunc(page) : null
}

function isActivationKey(event) {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

function orderAnnotations(annotations) {
  return [...annotations].sort((a, b) => {
    const left = Number(a?.createdAt) || 0
    const right = Number(b?.createdAt) || 0
    return left - right
  })
}

function groupByColor(annotations) {
  const grouped = { yellow: [], green: [], blue: [], pink: [], purple: [] }
  for (const annotation of annotations) {
    const color = colorOf(annotation)
    if (Array.isArray(grouped[color])) grouped[color].push(annotation)
  }
  return grouped
}

/** Sidebar annotations panel for the 'highlights' | 'notes' | 'focus' tabs. */
export function AnnotationsPanel({ tab }) {
  const app = useApp()
  const reader = useReader() ?? {}
  const t = reader.t ?? app?.t
  const toast = typeof app?.actions?.toast === 'function' ? app.actions.toast : null

  const annotations = React.useMemo(() => orderAnnotations(listAnnotations(reader)), [reader.annotations])
  const notesOnly = React.useMemo(() => annotations.filter((annotation) => noteOf(annotation).trim() !== ''), [annotations])
  const activeTab = tab === 'notes' ? 'notes' : tab === 'focus' ? 'focus' : 'highlights'
  const activeAnnId = typeof reader.activeAnnId === 'string' ? reader.activeAnnId : null

  const [editingId, setEditingId] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [confirmId, setConfirmId] = React.useState(null)

  // Switching tabs always drops transient editing state.
  React.useEffect(() => {
    setEditingId(null)
    setDraft('')
    setConfirmId(null)
  }, [activeTab])

  // Drop a pending delete confirmation when that annotation disappears.
  React.useEffect(() => {
    if (confirmId === null) return
    if (!annotations.some((annotation) => annotation.id === confirmId)) setConfirmId(null)
  }, [annotations, confirmId])

  const focus = (id) => {
    if (typeof id !== 'string' || id === '') return
    try {
      if (typeof reader.focusAnn === 'function') reader.focusAnn(id)
    } catch {
      /* reader session gone */
    }
  }

  const deleteAnnotation = (id) => {
    if (typeof id !== 'string' || id === '') return
    try {
      if (typeof reader.removeAnnotation === 'function') reader.removeAnnotation(id)
    } catch {
      if (toast !== null) toast(translate(t, 'toast.error', 'Something went wrong'), 'error')
    }
    setConfirmId(null)
  }

  const startEdit = (annotation) => {
    if (annotation === null || typeof annotation !== 'object') return
    setEditingId(typeof annotation.id === 'string' ? annotation.id : null)
    setDraft(noteOf(annotation))
    setConfirmId(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
  }

  const saveEdit = () => {
    if (editingId === null) return
    try {
      if (typeof reader.updateAnnotation === 'function') reader.updateAnnotation(editingId, { note: draft.trim() })
      if (toast !== null) toast(translate(t, 'ann.noteSaved', 'Note saved'), 'success')
    } catch {
      if (toast !== null) toast(translate(t, 'toast.error', 'Something went wrong'), 'error')
    }
    setEditingId(null)
    setDraft('')
  }

  const exportNotes = () => {
    try {
      if (typeof reader.openExportMenu === 'function') {
        reader.openExportMenu('notes')
        return
      }
      if (typeof app?.actions?.exportDoc === 'function') {
        app.actions.exportDoc('notes')
        return
      }
      if (toast !== null) toast(translate(t, 'common.export', 'Export'), 'info')
    } catch {
      /* export unavailable */
    }
  }

  const renderMeta = (annotation, withEdit) => {
    const time = timeOf(annotation)
    const page = pageOf(annotation)
    const confirming = confirmId === annotation.id
    return (
      <div className="dr-ann-meta">
        {time !== '' ? <span>{time}</span> : null}
        {page !== null ? <span>{`P${page}`}</span> : null}
        <span style={STYLES.metaRow}>
          {withEdit === true ? (
            <IconButton
              icon={<IconEdit size={13} />}
              label={translate(t, 'ann.editNote', 'Edit note')}
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                if(reader.requestAnnotationNote)reader.requestAnnotationNote(annotation.id);else startEdit(annotation)
              }}
            />
          ) : null}
          {confirming ? (
            <React.Fragment>
              <IconButton
                icon={<IconCheck size={13} />}
                label={translate(t, 'common.confirm', 'Confirm')}
                size="sm"
                onClick={(event) => {
                  event.stopPropagation()
                  deleteAnnotation(annotation.id)
                }}
              />
              <IconButton
                icon={<IconClose size={13} />}
                label={translate(t, 'common.cancel', 'Cancel')}
                size="sm"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmId(null)
                }}
              />
            </React.Fragment>
          ) : (
            <IconButton
              icon={<IconTrash size={13} />}
              label={translate(t, 'common.delete', 'Delete')}
              size="sm"
              style={STYLES.dangerIcon}
              onClick={(event) => {
                event.stopPropagation()
                setConfirmId(annotation.id)
              }}
            />
          )}
        </span>
      </div>
    )
  }

  const renderItem = (annotation, withEdit) => {
    const note = noteOf(annotation).trim()
    return (
      <div
        key={annotation.id}
        className={clsx('dr-ann-item', activeAnnId !== null && activeAnnId === annotation.id && 'is-active')}
        data-color={colorOf(annotation)}
        role="button"
        tabIndex={0}
        onClick={() => focus(annotation.id)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (!isActivationKey(event)) return
          event.preventDefault()
          focus(annotation.id)
        }}
      >
        <div className="dr-ann-quote">{textOf(annotation)}</div>
        {note !== '' ? <div className="dr-ann-note">{note}</div> : null}
        {renderMeta(annotation, true)}
      </div>
    )
  }

  const renderEmpty = (message) => <div className="dr-side-empty">{message}</div>

  let title = translate(t, 'nav.highlights', 'Highlights')
  let count = annotations.length
  let body = null

  if(activeTab==='focus')return <StudyMapPanel/>

  if (activeTab === 'highlights') {
    const grouped = groupByColor(annotations)
    body =
      annotations.length === 0 ? (
        renderEmpty(translate(t, 'ann.empty', 'Highlights and notes will appear here.'))
      ) : (
        <div className="dr-ann-list">
          {PANEL_COLORS.map((color) => {
            const items = grouped[color]
            if (!Array.isArray(items) || items.length === 0) return null
            const labels = COLOR_LABELS[color]
            return (
              <div key={color}>
                <div style={STYLES.groupHead}>
                  <span style={{ ...STYLES.groupDot, background: COLOR_HEX[color] }} aria-hidden="true" />
                  <span>{translate(t, labels[0], labels[1])}</span>
                  <span style={STYLES.groupCount}>{items.length}</span>
                </div>
                {items.map((annotation) => renderItem(annotation, false))}
              </div>
            )
          })}
        </div>
      )
  } else if (activeTab === 'notes') {
    title = translate(t, 'nav.notes', 'Notes')
    count = notesOnly.length
    body =
      notesOnly.length === 0 ? (
        renderEmpty(translate(t, 'reader.notes.empty', 'Select text to highlight or add a note.'))
      ) : (
        <div className="dr-ann-list">
          {notesOnly.map((annotation) =>
            editingId !== null && editingId === annotation.id ? (
              <div key={annotation.id} className="dr-ann-item" data-color={colorOf(annotation)} style={{ cursor: 'default' }}>
                <div className="dr-ann-quote">{textOf(annotation)}</div>
                <div style={STYLES.inlineForm}>
                  <Textarea
                    value={draft}
                    rows={4}
                    autoFocus
                    placeholder={translate(t, 'ann.notePlaceholder', 'Write a note…')}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault()
                        saveEdit()
                      } else if (event.key === 'Escape') {
                        event.stopPropagation()
                        cancelEdit()
                      }
                    }}
                  />
                  <div style={STYLES.actionRow}>
                    <Button size="sm" variant="ghost" onClick={cancelEdit}>
                      {translate(t, 'common.cancel', 'Cancel')}
                    </Button>
                    <Button size="sm" variant="primary" onClick={saveEdit}>
                      {translate(t, 'common.save', 'Save')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              renderItem(annotation, true)
            ),
          )}
        </div>
      )
  }

  return (
    <div className="dr-ann-panel">
      <div className="dr-side-section-head">
        <span className="dr-side-section-title">{title}</span>
        <span style={STYLES.headerActions}>
          <Badge tone="neutral">{count}</Badge>
          <IconButton icon={<IconDownload size={14} />} label={translate(t, 'ann.export', 'Export notes')} size="sm" onClick={exportNotes} />
        </span>
      </div>
      {body}
    </div>
  )
}
