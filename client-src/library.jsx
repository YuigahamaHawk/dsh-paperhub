// Library home: the user-facing entry point of the reader plugin. A responsive grid (or compact
// list) of documents with covers, reading progress and quick actions; import via button or drop;
// client-side search and sort; plus the Zotero sync dialog.
//
// App state contract: `state.docs` (DocMeta[]), `state.settings.ui.libraryView`, `state.importing`
// ({ name, phase, progress } | null) and `state.zoteroOpen`. Persistence goes through the app
// actions only. Chrome styling comes from the shared dr-* classes in styles.js.
import React from 'react'
import { useApp } from './store.jsx'
import { Badge, Button, EmptyState, IconButton, Input, LoadingBlock, Modal, ProgressBar, SegmentedControl, Select } from './ui.jsx'
import { CoverArt, IconBook, IconCloud, IconClose, IconEdit, IconFolder, IconGlobe, IconGrid, IconLibrary, IconList, IconPlus, IconSearch, IconStar, IconTrash, IconUpload, Spinner } from './icons.jsx'
import { formatBytes, formatPercent } from './util.js'
import { ZoteroDialog } from './zotero.jsx'

const SORT_KEYS = ['recent', 'added', 'title', 'progress']
const DOCUMENT_DRAG='application/x-dsh-reader-document'
function startDocumentDrag(event,doc){
  if(event.target.closest('button')){event.preventDefault();return}
  event.dataTransfer.setData(DOCUMENT_DRAG,doc.id)
  event.dataTransfer.setData('text/plain',doc.title??doc.id)
  event.dataTransfer.effectAllowed='move'
}

const SORT_FALLBACKS = {
  recent: 'Recently read',
  added: 'Recently added',
  title: 'Title',
  progress: 'Progress',
}

/** Call an app action defensively: the actions object is owned by the app shell, not by this UI. */
function callAction(actions, name, ...args) {
  const fn = actions?.[name]
  if (typeof fn !== 'function') return undefined
  try {
    const output = fn(...args)
    if (output !== null && typeof output === 'object' && typeof output.catch === 'function') output.catch(() => undefined)
    return output
  } catch {
    return undefined
  }
}

function stringOf(value) {
  return typeof value === 'string' ? value : ''
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function docTitle(doc, t) {
  const title = stringOf(doc?.title).trim()
  return title !== '' ? title : t('common.untitled', 'Untitled')
}

function docFormat(doc) {
  return doc?.format === 'epub' ? 'epub' : 'pdf'
}

/** Folder id of a document ('' means the library root). */
function docFolderId(doc) {
  return typeof doc?.folderId === 'string' && doc.folderId !== '' ? doc.folderId : ''
}

/** Reading progress as a 0..1 ratio; tolerates 0..100 data and partial docs. */
function docPercent(doc) {
  const raw = Number(doc?.progress?.percent)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(1, raw > 1 ? raw / 100 : raw)
}

function docAuthor(doc) {
  return stringOf(doc?.author).trim()
}

function docSize(doc) {
  return Math.max(0, numberOr(doc?.size, 0))
}

function matchesQuery(doc, query) {
  if (query === '') return true
  const parts = [doc?.title, doc?.author]
  if (Array.isArray(doc?.tags)) {
    for (const tag of doc.tags) parts.push(tag)
  }
  return parts
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function sortDocs(docs, sort) {
  const list = docs.slice()
  if (sort === 'title') {
    list.sort((a, b) => stringOf(a?.title).localeCompare(stringOf(b?.title), undefined, { numeric: true, sensitivity: 'base' }))
    return list
  }
  if (sort === 'progress') {
    list.sort((a, b) => docPercent(b) - docPercent(a))
    return list
  }
  if (sort === 'added') {
    list.sort((a, b) => numberOr(b?.addedAt, 0) - numberOr(a?.addedAt, 0))
    return list
  }
  list.sort((a, b) => {
    const aRecent = numberOr(a?.lastOpenedAt, numberOr(a?.updatedAt, numberOr(a?.addedAt, 0)))
    const bRecent = numberOr(b?.lastOpenedAt, numberOr(b?.updatedAt, numberOr(b?.addedAt, 0)))
    if (aRecent !== bRecent) return bRecent - aRecent
    return numberOr(b?.addedAt, 0) - numberOr(a?.addedAt, 0)
  })
  return list
}

function importPhaseText(t, importing) {
  const name = stringOf(importing?.name)
  const phase = stringOf(importing?.phase)
  if (phase === 'upload' || phase === 'uploading') return t('library.uploading', 'Uploading {name}…', { name })
  if (phase === 'parse' || phase === 'parsing') return t('library.parsing', 'Parsing {name}…', { name })
  if (phase === 'save' || phase === 'saving') return t('library.saving', 'Saving {name}…', { name })
  return t('library.importing', 'Importing {name}', { name })
}

/**
 * Cover: the host-served thumbnail when one exists, otherwise the deterministic gradient monogram.
 * Falls back to the monogram if the thumbnail fails to load (missing/partial docs never break the UI).
 */
function DocCover({ api, doc, format, title }) {
  const [failed, setFailed] = React.useState(false)
  const connection=React.useSyncExternalStore(api.subscribeConnection??(()=>()=>{}),api.getConnection??(()=>null),()=>null)
  const docId = stringOf(doc?.id)
  const hasCover = doc?.cover === true && docId !== '' && typeof api?.fileUrl === 'function'

  React.useEffect(() => {
    setFailed(false)
  }, [docId, doc?.cover, connection?.revision])

  if (hasCover && !failed) {
    return (
      <img
        src={api.fileUrl(docId, 'thumb')}
        alt=""
        loading="lazy"
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={() => setFailed(true)}
      />
    )
  }
  return <CoverArt title={title} format={format} />
}

/** One document card in grid view. Whole card opens the document; hover actions are one click. */
function DocCard({ api, doc, t, onOpen, onFavorite, onRemove, onMove, folderName }) {
  const title = docTitle(doc, t)
  const format = docFormat(doc)
  const percent = docPercent(doc)
  const favorite = doc?.favorite === true
  const author = docAuthor(doc)
  const size = docSize(doc)
  const baseMeta = author !== '' ? author : size > 0 ? formatBytes(size) : ''
  const meta = folderName !== undefined && folderName !== '' ? `${folderName} · ${baseMeta}` : baseMeta
  const finished = percent >= 1
  const [actionsVisible, setActionsVisible] = React.useState(false)

  const activate = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen(doc)
    }
  }

  const action = (handler) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  return (
    <div
      className="dr-card"
      role="button"
      tabIndex={0}
      aria-label={title}
      data-doc-id={stringOf(doc?.id)}
      draggable
      onDragStart={event=>startDocumentDrag(event,doc)}
      onClick={() => onOpen(doc)}
      onKeyDown={activate}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActionsVisible(false)
      }}
    >
      <div className="dr-card-cover">
        <DocCover api={api} doc={doc} format={format} title={title} />
        <span className="dr-card-format">
          <Badge tone={format === 'epub' ? 'success' : 'brand'}>{format.toUpperCase()}</Badge>
        </span>
        <div className="dr-card-actions" style={actionsVisible ? { opacity: 1, transform: 'none' } : undefined}>
          <IconButton icon={<IconBook size={14} />} label={t('common.open', 'Open')} onClick={action(() => onOpen(doc))} />
          <IconButton
            icon={<IconStar size={14} style={favorite ? { fill: 'currentColor' } : undefined} />}
            label={t('library.favorite', 'Favorite')}
            active={favorite}
            onClick={action(() => onFavorite(doc))}
          />
          <IconButton icon={<IconFolder size={14} />} label={t('library.moveTo', 'Move to folder')} onClick={action(() => onMove?.(doc))} />
          <IconButton icon={<IconTrash size={14} />} label={t('common.remove', 'Remove')} onClick={action(() => onRemove(doc))} />
        </div>
      </div>
      <div className="dr-card-body">
        <div className="dr-card-title" title={title}>
          {title}
        </div>
        <div className="dr-card-author" title={meta}>
          {meta}
        </div>
        <div className="dr-card-foot">
          {finished ? (
            <Badge tone="success">{t('library.read', 'Finished')}</Badge>
          ) : percent > 0 ? (
            <React.Fragment>
              <ProgressBar value={percent} />
              <span className="dr-card-progress-label" title={stringOf(doc?.progress?.label)}>
                {t('library.progress', '{percent} read', { percent: formatPercent(percent) })}
              </span>
            </React.Fragment>
          ) : (
            <span className="dr-card-progress-label">{t('library.unread', 'Unread')}</span>
          )}
          {favorite ? (
            <span className="dr-card-star" title={t('library.favorite', 'Favorite')} aria-hidden="true">
              <IconStar size={13} style={{ fill: 'currentColor' }} />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** One compact row in list view. */
function ListRow({ api, doc, t, onOpen, onFavorite, onRemove, onMove, folderName }) {
  const title = docTitle(doc, t)
  const format = docFormat(doc)
  const percent = docPercent(doc)
  const favorite = doc?.favorite === true
  const author = docAuthor(doc)
  const size = docSize(doc)
  const meta = [format.toUpperCase(), folderName !== undefined && folderName !== '' ? folderName : '', author, size > 0 ? formatBytes(size) : '']
    .filter((part) => part !== '')
    .join(' · ')

  const activate = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen(doc)
    }
  }

  const action = (handler) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  return (
    <div
      className="dr-listrow"
      role="button"
      tabIndex={0}
      aria-label={title}
      data-doc-id={stringOf(doc?.id)}
      draggable
      onDragStart={event=>startDocumentDrag(event,doc)}
      onClick={() => onOpen(doc)}
      onKeyDown={activate}
    >
      <div className="dr-listrow-cover">
        <DocCover api={api} doc={doc} format={format} title={title} />
      </div>
      <div className="dr-listrow-main">
        <div className="dr-listrow-title" title={title}>
          {title}
        </div>
        <div className="dr-listrow-meta">{meta}</div>
      </div>
      <div className="dr-listrow-progress">
        <span style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          <ProgressBar value={percent} />
        </span>
        <span className="dr-card-progress-label">
          {percent > 0 ? t('library.progress', '{percent} read', { percent: formatPercent(percent) }) : t('library.unread', 'Unread')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
        <IconButton
          icon={<IconStar size={14} style={favorite ? { fill: 'currentColor' } : undefined} />}
          label={t('library.favorite', 'Favorite')}
          active={favorite}
          onClick={action(() => onFavorite(doc))}
        />
        <IconButton icon={<IconFolder size={14} />} label={t('library.moveTo', 'Move to folder')} onClick={action(() => onMove?.(doc))} />
        <IconButton icon={<IconTrash size={14} />} label={t('common.remove', 'Remove')} onClick={action(() => onRemove(doc))} />
      </div>
    </div>
  )
}

/**
 * `<LibraryView onOpen={docId => ...} />` — the plugin home screen. Reads everything from the app
 * context; the only external contract is `onOpen(docId)` (falls back to `actions.openDoc`).
 */
export function LibraryView({ onOpen, session } = {}) {
  const { api, t, state, actions } = useApp()
  const connection=React.useSyncExternalStore(api.subscribeConnection??(()=>()=>{}),api.getConnection??(()=>null),()=>null)
  const rawDocs = state?.docs
  const docs = React.useMemo(() => (Array.isArray(rawDocs) ? rawDocs.filter((doc) => doc !== null && typeof doc === 'object') : []), [rawDocs])

  const [query, setQuery] = React.useState(session?.query ?? '')
  const [sort, setSort] = React.useState(session?.sort ?? 'recent')
  const [pendingRemove, setPendingRemove] = React.useState(null)
  const [folderFilter, setFolderFilter] = React.useState(session?.folderFilter ?? 'all')
  const [folderModal, setFolderModal] = React.useState(null)
  const [folderDraftName, setFolderDraftName] = React.useState('')
  const [pendingFolderRemove, setPendingFolderRemove] = React.useState(null)
  const [pendingMove, setPendingMove] = React.useState(null)
  const [moveTarget, setMoveTarget] = React.useState('')
  const [dropTarget,setDropTarget]=React.useState(null)
  const librarySearchRef=React.useRef(null)
  const scrollRef = React.useRef(null)
  const scrollRestored = React.useRef(false)
  React.useEffect(()=>{
    const find=event=>{
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&String(event.key).toLowerCase()==='f'&&!state.settingsOpen&&!event.target?.closest?.('[role="dialog"]')){
        event.preventDefault();event.stopPropagation();librarySearchRef.current?.focus();librarySearchRef.current?.select()
      }
    }
    window.addEventListener('keydown',find,true);return()=>window.removeEventListener('keydown',find,true)
  },[state.settingsOpen])

  // Display mode lives in settings (state.view is the app route, not the library layout).
  const view = state?.settings?.ui?.libraryView === 'list' ? 'list' : 'grid'
  const importing = state?.importing !== null && typeof state?.importing === 'object' ? state.importing : null
  const ready = state?.ready !== false && !(docs.length===0&&connection&&connection.status!=='connected')

  const normalizedQuery = query.trim().toLowerCase()
  const folders = React.useMemo(
    () => (Array.isArray(state?.folders) ? state.folders.filter((folder) => folder !== null && typeof folder === 'object' && typeof folder.id === 'string') : []),
    [state?.folders],
  )
  const folderById = React.useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const currentFolderId = folderById.get(folderFilter)?.id ?? null
  React.useLayoutEffect(() => {
    if (session) Object.assign(session, { query, sort, folderFilter })
  }, [session, query, sort, folderFilter])
  React.useLayoutEffect(() => {
    if (!ready || !session || !scrollRef.current || scrollRestored.current) return
    scrollRef.current.scrollTop = session.scrollTop ?? 0
    scrollRestored.current = true
  }, [ready, session])
  const folderCounts = React.useMemo(() => {
    const perFolder = new Map()
    let unfiled = 0
    for (const doc of docs) {
      const folderId = docFolderId(doc)
      if (folderId === '') unfiled++
      else perFolder.set(folderId, (perFolder.get(folderId) ?? 0) + 1)
    }
    return { perFolder, unfiled, all: docs.length }
  }, [docs])
  const scopedDocs = React.useMemo(() => {
    if (folderFilter === 'all') return docs
    if (folderFilter === 'unfiled') return docs.filter((doc) => docFolderId(doc) === '')
    return docs.filter((doc) => docFolderId(doc) === folderFilter)
  }, [docs, folderFilter])
  const visibleDocs = React.useMemo(() => sortDocs(scopedDocs.filter((doc) => matchesQuery(doc, normalizedQuery)), sort), [scopedDocs, normalizedQuery, sort])
  const folderNameFor = React.useCallback((doc) => folderById.get(docFolderId(doc))?.name ?? '', [folderById])
  const dropHandlers=folderId=>({
    'data-drop-folder':folderId||'unfiled',
    onDragOver:event=>{
      const types=Array.from(event.dataTransfer?.types??[])
      if(!types.includes(DOCUMENT_DRAG)&&!types.includes('Files'))return
      event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=types.includes(DOCUMENT_DRAG)?'move':'copy';setDropTarget(folderId)
    },
    onDragLeave:event=>{if(!event.currentTarget.contains(event.relatedTarget))setDropTarget(null)},
    onDrop:event=>{
      const id=event.dataTransfer.getData(DOCUMENT_DRAG),files=Array.from(event.dataTransfer.files??[])
      if(!id&&!files.length&&!event.dataTransfer.items?.length)return
      event.preventDefault();event.stopPropagation();setDropTarget(null)
      if(id){const doc=docs.find(doc=>doc.id===id);if(doc&&docFolderId(doc)!==folderId)callAction(actions,'moveDoc',id,folderId||null)}
      else callAction(actions,'importDrop',event.dataTransfer,{folderId:folderId||null})
    },
  })

  // ----- folder actions ------------------------------------------------------------
  const openFolderCreate = () => {
    setFolderDraftName('')
    setFolderModal({ mode: 'create' })
  }
  const openFolderRename = (folder) => {
    setFolderDraftName(stringOf(folder?.name))
    setFolderModal({ mode: 'rename', folder })
  }
  const submitFolder = () => {
    const name = folderDraftName.trim()
    if (name === '') return
    if (folderModal?.mode === 'rename' && folderModal.folder !== undefined && folderModal.folder !== null) {
      callAction(actions, 'foldersRename', stringOf(folderModal.folder.id), name)
    } else {
      callAction(actions, 'foldersCreate', name)
    }
    setFolderModal(null)
    setFolderDraftName('')
  }
  const confirmFolderRemove = () => {
    const folder = pendingFolderRemove
    setPendingFolderRemove(null)
    if (folder === null || folder === undefined) return
    callAction(actions, 'foldersRemove', stringOf(folder.id))
    if (folderFilter === folder.id) setFolderFilter('all')
  }
  const openMove = (doc) => {
    setPendingMove(doc)
    setMoveTarget(docFolderId(doc))
  }
  const submitMove = () => {
    const doc = pendingMove
    if (doc === null || doc === undefined) return
    callAction(actions, 'moveDoc', stringOf(doc.id), moveTarget === '' ? null : moveTarget)
    setPendingMove(null)
    setMoveTarget('')
  }


  const openDocument = React.useCallback(
    (docOrId) => {
      const id = typeof docOrId === 'string' ? docOrId : stringOf(docOrId?.id)
      if (id === '') return
      if (typeof onOpen === 'function') onOpen(id)
      else callAction(actions, 'openDoc', id)
    },
    [onOpen, actions],
  )

  const toggleFavorite = React.useCallback(
    (doc) => {
      const id = stringOf(doc?.id)
      if (id !== '') callAction(actions, 'toggleFavorite', id)
    },
    [actions],
  )

  const removeDoc = React.useCallback(
    (doc) => {
      const id = stringOf(doc?.id)
      if (id !== '') callAction(actions, 'removeDoc', id)
    },
    [actions],
  )

  const changeView = React.useCallback(
    (next) => {
      if (next !== 'grid' && next !== 'list') return
      callAction(actions, 'patchSettings', { ui: { libraryView: next } })
    },
    [actions],
  )

  const pickFiles = () => {
    callAction(actions, 'openImport', currentFolderId)
  }

  const dropFiles = (event) => {
    if (!currentFolderId || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    callAction(actions, 'importDrop', event.dataTransfer, { folderId: currentFolderId })
  }

  const confirmRemove = () => {
    const doc = pendingRemove
    setPendingRemove(null)
    if (doc !== null) removeDoc(doc)
  }

  const sortOptions = SORT_KEYS.map((value) => ({ value, label: t(`library.sort.${value}`, SORT_FALLBACKS[value]) }))
  const pendingTitle = pendingRemove !== null ? docTitle(pendingRemove, t) : ''

  return (
    <div className="dr-library">
      <div className="dr-folder-bar" role="tablist" aria-label={t('library.folders', 'Folders')}>
        <button type="button" className={`dr-folder-chip ${folderFilter === 'all' ? 'is-active' : ''}`} onClick={() => setFolderFilter('all')}>
          <IconLibrary size={14} />
          <span>{t('library.allDocs', 'All documents')}</span>
          <span className="dr-folder-count">{folderCounts.all}</span>
        </button>
        <button type="button" {...dropHandlers('')} className={`dr-folder-chip ${folderFilter === 'unfiled' ? 'is-active' : ''} ${dropTarget===''?'is-drop-target':''}`} onClick={() => setFolderFilter('unfiled')}>
          <IconBook size={14} />
          <span>{t('library.unfiled', 'Unfiled')}</span>
          <span className="dr-folder-count">{folderCounts.unfiled}</span>
        </button>
        {folders.map((folder) => (
          <span key={folder.id} className={`dr-folder-chip-wrap ${folderFilter === folder.id ? 'is-active' : ''}`}>
            <button type="button" {...dropHandlers(folder.id)} className={`dr-folder-chip ${folderFilter === folder.id ? 'is-active' : ''} ${dropTarget===folder.id?'is-drop-target':''}`} onClick={() => setFolderFilter(folder.id)} title={t('library.dropToFolder','Drop documents here to move them')+' · '+folder.name}>
              <IconFolder size={14} />
              <span className="dr-folder-name">{folder.name}</span>
              <span className="dr-folder-count">{folderCounts.perFolder.get(folder.id) ?? 0}</span>
            </button>
            {folderFilter === folder.id ? (
              <span className="dr-folder-tools">
                <IconButton size="sm" icon={<IconEdit size={13} />} label={t('library.renameFolder', 'Rename folder')} onClick={() => openFolderRename(folder)} />
                <IconButton size="sm" icon={<IconTrash size={13} />} label={t('library.deleteFolder', 'Delete folder')} onClick={() => setPendingFolderRemove(folder)} />
              </span>
            ) : null}
          </span>
        ))}
        <span style={{ flex: 1, minWidth: 8 }} />
        <Button size="sm" variant="ghost" icon={<IconPlus size={14} />} onClick={openFolderCreate}>
          {t('library.newFolder', 'New folder')}
        </Button>
      </div>
      <div className="dr-lib-scroll" ref={scrollRef} onDrop={dropFiles} onScroll={event => {
        if (session) session.scrollTop = event.currentTarget.scrollTop
      }}>
        <div className="dr-lib-head">
          <div style={{ minWidth: 0 }}>
            <div className="dr-lib-title">
              <span>{t('library.title', 'My library')}</span>
              {docs.length > 0 ? <Badge>{docs.length}</Badge> : null}
            </div>
            <div className="dr-lib-sub">{t('library.subtitle', 'PDF & EPUB · AI-typeset, annotate, translate')}</div>
          </div>
          <div className="dr-lib-actions">
            <Button variant="primary" icon={<IconUpload size={15} />} onClick={pickFiles}>
              {t('library.import', 'Import')}
            </Button>
            <Button icon={<IconCloud size={15} />} onClick={() => callAction(actions, 'openZotero')}>
              {t('library.zotero', 'Zotero sync')}
            </Button>
            <SegmentedControl
              value={view}
              onChange={changeView}
              options={[
                { value: 'grid', icon: <IconGrid size={14} />, label: t('library.grid', 'Grid'), title: t('library.grid', 'Grid') },
                { value: 'list', icon: <IconList size={14} />, label: t('library.list', 'List'), title: t('library.list', 'List') },
              ]}
            />
          </div>
        </div>

        <div className="dr-lib-toolbar">
          <Input
            ref={librarySearchRef}
            leadIcon={<IconSearch size={15} />}
            placeholder={t('library.searchPlaceholder', 'Search title, author or tag…')}
            aria-label={t('common.search', 'Search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                event.stopPropagation()
                setQuery('')
              }
            }}
            trailing={
              query !== '' ? (
                <IconButton icon={<IconClose size={13} />} label={t('library.clearSearch', 'Clear search')} onClick={() => setQuery('')} />
              ) : undefined
            }
          />
          <span className="dr-lib-toolbar-spacer" />
          {docs.length > 0 ? (
            <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
              {t('library.count', '{count} documents', { count: visibleDocs.length })}
            </span>
          ) : null}
          <Select value={sort} onChange={setSort} options={sortOptions} aria-label={t('library.sortBy', 'Sort by')} />
        </div>

        {!ready ? (
          <LoadingBlock label={t('common.loading', 'Loading…')} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<IconLibrary size={30} />}
            title={t('library.empty.title', 'Your library is empty')}
            body={t('library.empty.body', 'Import a PDF or EPUB, or sync your Zotero library to start reading.')}
            action={
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Button variant="primary" icon={<IconUpload size={15} />} onClick={pickFiles}>
                    {t('library.empty.cta', 'Import documents')}
                  </Button>
                  <Button icon={<IconCloud size={15} />} onClick={() => callAction(actions, 'openZotero')}>
                    {t('library.zotero', 'Zotero sync')}
                  </Button>
                </div>
                <div className="dr-field-hint">{t('library.dropShort', 'or drop PDF / EPUB files anywhere in this window')}</div>
              </div>
            }
          />
        ) : scopedDocs.length === 0 ? (
          <EmptyState
            icon={<IconFolder size={28} />}
            title={t('library.folderEmpty.title', 'This folder is empty')}
            body={t('library.folderEmpty.body', 'Move documents into this folder with the folder button on a card, or pick another folder above.')}
            action={<Button onClick={() => setFolderFilter('all')}>{t('library.allDocs', 'All documents')}</Button>}
          />
        ) : visibleDocs.length === 0 ? (
          <EmptyState
            icon={<IconSearch size={28} />}
            title={t('library.noMatch.title', 'No matching documents')}
            body={t('library.noMatch.body', 'Nothing matches “{query}”. Try a different keyword.', { query: query.trim() })}
            action={<Button onClick={() => setQuery('')}>{t('library.clearSearch', 'Clear search')}</Button>}
          />
        ) : view === 'list' ? (
          <div className="dr-lib-list">
            {visibleDocs.map((doc, index) => (
              <ListRow
                key={stringOf(doc?.id) !== '' ? doc.id : `doc-${index}`}
                api={api}
                doc={doc}
                t={t}
                folderName={folderNameFor(doc)}
                onOpen={openDocument}
                onFavorite={toggleFavorite}
                onRemove={setPendingRemove}
                onMove={openMove}
              />
            ))}
          </div>
        ) : (
          <div className="dr-lib-grid">
            {visibleDocs.map((doc, index) => (
              <DocCard
                key={stringOf(doc?.id) !== '' ? doc.id : `doc-${index}`}
                api={api}
                doc={doc}
                t={t}
                folderName={folderNameFor(doc)}
                onOpen={openDocument}
                onFavorite={toggleFavorite}
                onRemove={setPendingRemove}
                onMove={openMove}
              />
            ))}
          </div>
        )}

        {importing !== null ? (
          <div className="dr-import-status" role="status" aria-live="polite">
            <Spinner size={15} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{importPhaseText(t, importing)}</div>
              {typeof importing.progress === 'number' && Number.isFinite(importing.progress) ? (
                <ProgressBar value={Math.min(1, Math.max(0, importing.progress))} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <Modal
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        title={t('common.remove', 'Remove')}
        width={440}
        footer={
          <React.Fragment>
            <Button variant="ghost" onClick={() => setPendingRemove(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove}>
              {t('common.remove', 'Remove')}
            </Button>
          </React.Fragment>
        }
      >
        <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>
          {t(
            'library.removeConfirm',
            'Remove “{title}” and its notes from the library? The original file will be deleted.',
            { title: pendingTitle },
          )}
        </div>
      </Modal>

      <Modal
        open={folderModal !== null}
        onClose={() => setFolderModal(null)}
        title={folderModal?.mode === 'rename' ? t('library.renameFolder', 'Rename folder') : t('library.newFolder', 'New folder')}
        width={440}
        footer={
          <React.Fragment>
            <Button variant="ghost" onClick={() => setFolderModal(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={submitFolder} disabled={folderDraftName.trim() === ''}>
              {t('common.save', 'Save')}
            </Button>
          </React.Fragment>
        }
      >
        <div className="dr-field">
          <div className="dr-field-label">{t('library.folderName', 'Folder name')}</div>
          <Input
            autoFocus
            value={folderDraftName}
            placeholder={t('library.folderName', 'Folder name')}
            onChange={(event) => setFolderDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitFolder()
            }}
          />
        </div>
      </Modal>

      <Modal
        open={pendingFolderRemove !== null}
        onClose={() => setPendingFolderRemove(null)}
        title={t('library.deleteFolder', 'Delete folder')}
        width={440}
        footer={
          <React.Fragment>
            <Button variant="ghost" onClick={() => setPendingFolderRemove(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmFolderRemove}>
              {t('common.delete', 'Delete')}
            </Button>
          </React.Fragment>
        }
      >
        <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>
          {t('library.deleteFolderConfirm', 'Delete folder “{name}”? Documents inside move back to the library root; files are not deleted.', {
            name: stringOf(pendingFolderRemove?.name),
          })}
        </div>
      </Modal>

      <Modal
        open={pendingMove !== null}
        onClose={() => setPendingMove(null)}
        title={t('library.moveTo', 'Move to folder')}
        width={460}
        footer={
          <React.Fragment>
            <Button variant="ghost" onClick={() => setPendingMove(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={submitMove}>
              {t('common.confirm', 'Confirm')}
            </Button>
          </React.Fragment>
        }
      >
        <div className="dr-field">
          <div className="dr-field-label">{t('library.folder', 'Folder')}</div>
          <Select
            value={moveTarget}
            onChange={setMoveTarget}
            options={[{ value: '', label: t('library.unfiled', 'Unfiled') }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]}
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconPlus size={13} />}
          onClick={() => {
            setPendingMove(null)
            openFolderCreate()
          }}
        >
          {t('library.newFolder', 'New folder')}
        </Button>
      </Modal>

      <ZoteroDialog
        open={state?.zoteroOpen === true}
        onClose={actions?.closeZotero}
        onSynced={actions?.refreshDocs}
      />
    </div>
  )
}
