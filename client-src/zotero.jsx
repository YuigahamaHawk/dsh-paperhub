// Zotero sync UI.
//
// `ZoteroDialog` is opened from the library header, while `ZoteroSettings` is the "Zotero" section
// of the reader settings dialog. Both share the status / credentials / sync building blocks below
// and talk to the host half through the authenticated RPC + stream transport (`api.rpc`,
// `api.stream`). Chrome styling comes from the shared dr-* classes in styles.js.
import React from 'react'
import { useApp } from './store.jsx'
import { Button, Divider, Input, Modal, ProgressBar, Row, Switch } from './ui.jsx'
import { IconCheck, IconCloud, IconRefresh, IconStop, Spinner } from './icons.jsx'
import { clsx, formatDate } from './util.js'

const EMPTY_CREDENTIALS = { apiKey: '', userId: '' }

const ACTIVE_CHIP_STYLE = {
  borderColor: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-brand-primary)',
  background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent)',
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

function credentialsOf(settingsZotero) {
  return { apiKey: stringOf(settingsZotero?.apiKey), userId: stringOf(settingsZotero?.userId) }
}

function statusWebConfigured(status) {
  return status !== null && typeof status === 'object' && status.web !== null && typeof status.web === 'object' && status.web.configured === true
}

function statusLocalAvailable(status) {
  return status !== null && typeof status === 'object' && status.local !== null && typeof status.local === 'object' && status.local.available === true
}

function lastSyncAtOf(status, settingsZotero) {
  const candidates = [status?.settings?.lastSyncAt, settingsZotero?.lastSyncAt]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
  }
  return 0
}

function detectErrorText(t, error) {
  if (error === null || error === undefined) return ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (message !== '') return t('zotero.detectFailed', 'Could not query Zotero: {message}', { message })
  return t('zotero.localMissing', 'Zotero local API not detected')
}

function syncErrorText(t, error) {
  if (error === null || error === undefined) return ''
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'zotero-key-required') {
    return t(
      'zotero.needKey',
      'Local Zotero is running, but its local API does not expose PDF files. Add a Zotero Web API key + user ID to sync PDFs.',
    )
  }
  if (code === 'zotero-not-configured') {
    return t('zotero.notConfigured', 'Set a Zotero API key and user ID, or start Zotero 7 on this computer.')
  }
  if (code === 'aborted') return t('zotero.syncCanceled', 'Sync canceled')
  const message = typeof error.message === 'string' ? error.message : ''
  if (message !== '') return t('zotero.syncFailed', 'Zotero sync failed: {message}', { message })
  return t('toast.error', 'Something went wrong')
}

function progressText(t, progress) {
  if (progress === null || progress === undefined) return t('zotero.syncing', 'Syncing…')
  const phase = typeof progress.phase === 'string' ? progress.phase : ''
  if (phase === 'listing') return t('zotero.progress.list', 'Listing Zotero items…')
  if (phase === 'dedupe') {
    const count = typeof progress.total === 'number' && progress.total > 0 ? progress.total : 0
    return t('zotero.progress.dedupe', 'Checking {count} items…', { count })
  }
  if (phase === 'download') {
    const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : 0
    if (total === 0) return t('zotero.syncing', 'Syncing…')
    const done = typeof progress.done === 'number' && progress.done > 0 ? progress.done : 0
    return t('zotero.progress.download', 'Downloading {done}/{total}: {title}', {
      done: Math.min(total, done + 1),
      total,
      title: typeof progress.title === 'string' ? progress.title : '',
    })
  }
  return t('zotero.syncing', 'Syncing…')
}

function resultText(t, result) {
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return t('zotero.result', 'Imported {added}, skipped {skipped}, without PDF {withoutPdf}, failed {failed}', {
    added: count(result?.added),
    skipped: count(result?.skipped),
    withoutPdf: count(result?.withoutPdf),
    failed: count(result?.failed),
  })
}

/** Detect the local Zotero app and the configured Web API whenever `active` becomes true. */
function useZoteroStatus(api, active) {
  const [value, setValue] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)

  const detect = React.useCallback(async () => {
    if (typeof api?.rpc !== 'function') return null
    setLoading(true)
    setError(null)
    try {
      const next = await api.rpc('zotero.status')
      const normalized = next !== null && typeof next === 'object' ? next : null
      setValue(normalized)
      return normalized
    } catch (failure) {
      setError(failure ?? new Error('zotero.status failed'))
      return null
    } finally {
      setLoading(false)
    }
  }, [api])

  React.useEffect(() => {
    if (active) detect()
  }, [active, detect])

  return { value, loading, error, detect }
}

/** Load the optional Zotero collection list for the sync scope picker. */
function useZoteroCollections(api, active) {
  const [collections, setCollections] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(async () => {
    if (typeof api?.rpc !== 'function') return
    setLoading(true)
    setError(null)
    try {
      const value = await api.rpc('zotero.collections')
      const list = Array.isArray(value?.collections) ? value.collections : []
      setCollections(list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && entry.key !== ''))
    } catch (failure) {
      setCollections([])
      setError(failure ?? new Error('zotero.collections failed'))
    } finally {
      setLoading(false)
    }
  }, [api])

  React.useEffect(() => {
    if (active) load()
  }, [active, load])

  return { collections, loading, error, reload: load }
}

/**
 * Credential draft with debounced persistence through `actions.patchSettings({ zotero })`.
 * The draft is re-synced from settings whenever it is not being edited, so late settings loads
 * and external edits are reflected without clobbering a field the user is typing into.
 */
function useZoteroCredentials({ actions, settingsZotero, active, onSaved }) {
  const [draft, setDraft] = React.useState(EMPTY_CREDENTIALS)
  const draftRef = React.useRef(EMPTY_CREDENTIALS)
  const timerRef = React.useRef(null)
  const dirtyRef = React.useRef(false)
  const actionsRef = React.useRef(actions)
  const onSavedRef = React.useRef(onSaved)
  actionsRef.current = actions
  onSavedRef.current = onSaved

  const flush = React.useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const current = draftRef.current
    callAction(actionsRef.current, 'patchSettings', {
      zotero: { apiKey: current.apiKey.trim(), userId: current.userId.trim() },
    })
    if (typeof onSavedRef.current === 'function') onSavedRef.current()
  }, [])

  React.useEffect(() => {
    if (!active || dirtyRef.current) return
    const next = credentialsOf(settingsZotero)
    if (next.apiKey === draftRef.current.apiKey.trim() && next.userId === draftRef.current.userId.trim()) return
    draftRef.current = next
    setDraft(next)
  }, [active, settingsZotero?.apiKey, settingsZotero?.userId])

  const updateDraft = React.useCallback(
    (patch) => {
      const next = { ...draftRef.current, ...patch }
      draftRef.current = next
      setDraft(next)
      dirtyRef.current = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        flush()
      }, 450)
    },
    [flush],
  )

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      flush()
    },
    [flush],
  )

  return { draft, updateDraft, flush }
}

/** Run a `zotero.sync` stream with progress frames, abort support and inline error state. */
function useZoteroSync({ api, onDone }) {
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const controllerRef = React.useRef(null)
  const errorRef = React.useRef(null)
  const mountedRef = React.useRef(true)
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const controller = controllerRef.current
      controllerRef.current = null
      if (controller !== null) {
        try {
          controller.abort()
        } catch {
          /* already aborted */
        }
      }
    }
  }, [])

  const start = React.useCallback(
    async (collectionKeys) => {
      if (typeof api?.stream !== 'function') return
      if (controllerRef.current !== null) return
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      controllerRef.current = controller
      errorRef.current = null
      setRunning(true)
      setError(null)
      setResult(null)
      setProgress({ phase: 'listing', done: 0, total: 0 })
      try {
        const summary = await api.stream(
          'zotero.sync',
          { collections: Array.isArray(collectionKeys) ? collectionKeys : [] },
          {
            onProgress: (frame) => {
              if (mountedRef.current) setProgress(frame !== null && typeof frame === 'object' ? frame : null)
            },
            onDone: (value) => {
              if (mountedRef.current) setResult(value !== null && typeof value === 'object' ? value : {})
            },
            onError: (failure) => {
              errorRef.current = failure ?? new Error('zotero.sync failed')
              if (mountedRef.current) setError(errorRef.current)
            },
          },
          controller !== null ? controller.signal : undefined,
        )
        if (errorRef.current === null) {
          if (mountedRef.current) setResult((previous) => previous ?? (summary !== null && typeof summary === 'object' ? summary : {}))
          onDoneRef.current?.(summary ?? null)
        }
      } catch (failure) {
        const aborted = controller?.signal?.aborted === true || failure?.code === 'aborted' || failure?.name === 'AbortError'
        if (!aborted) {
          if (errorRef.current === null) errorRef.current = failure ?? new Error('zotero.sync failed')
          if (mountedRef.current) setError(errorRef.current)
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
        if (mountedRef.current) {
          setRunning(false)
          setProgress(null)
        }
      }
    },
    [api],
  )

  const stop = React.useCallback(() => {
    const controller = controllerRef.current
    if (controller === null) return
    try {
      controller.abort()
    } catch {
      /* already aborted */
    }
  }, [])

  const reset = React.useCallback(() => {
    if (controllerRef.current !== null) return
    errorRef.current = null
    setProgress(null)
    setError(null)
    setResult(null)
  }, [])

  return { running, progress, error, result, start, stop, reset }
}

/** Web API key + numeric user ID fields. */
function CredentialsFields({ t, draft, onChange }) {
  return (
    <React.Fragment>
      <div className="dr-field">
        <div className="dr-field-label">{t('zotero.apiKey', 'API key')}</div>
        <Input
          type="password"
          value={draft.apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('zotero.apiKeyPlaceholder', 'Zotero API key')}
          aria-label={t('zotero.apiKey', 'API key')}
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </div>
      <div className="dr-field">
        <div className="dr-field-label">{t('zotero.userId', 'User ID')}</div>
        <Input
          value={draft.userId}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('zotero.userIdPlaceholder', 'Numeric user ID')}
          aria-label={t('zotero.userId', 'User ID')}
          onChange={(event) => onChange({ userId: event.target.value })}
        />
      </div>
    </React.Fragment>
  )
}

/** Local + Web API status rows with colored status dots. */
function StatusRows({ t, status, loading }) {
  const local = status !== null && typeof status === 'object' ? status.local : null
  const web = status !== null && typeof status === 'object' ? status.web : null
  const localAvailable = local !== null && typeof local === 'object' && local.available === true
  const webConfigured = web !== null && typeof web === 'object' && web.configured === true
  const docs = status !== null && typeof status === 'object' && typeof status.docs === 'number' ? status.docs : 0
  return (
    <div className="dr-zotero-status" aria-live="polite">
      <div className="dr-zotero-status-row" style={{ flexWrap: 'wrap' }}>
        <span className={clsx('dr-dot', loading ? '' : localAvailable ? 'is-ok' : 'is-bad')} />
        <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{t('zotero.mode.local', 'Local Zotero')}</span>
        <span style={{ marginLeft: 'auto' }}>
          {loading
            ? t('zotero.detecting', 'Detecting…')
            : localAvailable
              ? t('zotero.localRunning', 'Zotero is running locally')
              : t('zotero.localMissing', 'Zotero local API not detected')}
        </span>
      </div>
      <div className="dr-zotero-status-row" style={{ flexWrap: 'wrap' }}>
        <span className={clsx('dr-dot', loading ? '' : webConfigured ? 'is-ok' : 'is-warn')} />
        <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{t('zotero.mode.web', 'Web API')}</span>
        <span style={{ marginLeft: 'auto' }}>
          {loading
            ? t('zotero.detecting', 'Detecting…')
            : webConfigured
              ? t('zotero.webConfigured', 'Web API configured')
              : t('zotero.webMissing', 'Web API not configured')}
        </span>
      </div>
      {!loading && docs > 0 ? (
        <div className="dr-zotero-status-row">
          <IconCloud size={13} />
          <span>{t('zotero.syncedDocs', '{count} documents synced from Zotero', { count: docs })}</span>
        </div>
      ) : null}
    </div>
  )
}

/** Optional collection scope picker (chips). Empty selection means "all collections". */
function CollectionsField({ t, enabled, collections, loading, error, selected, onToggle, onClear, onReload }) {
  return (
    <div className="dr-field">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="dr-field-label">{t('zotero.collections', 'Collections (optional)')}</div>
        <Button
          size="sm"
          variant="ghost"
          icon={loading ? <Spinner size={13} /> : <IconRefresh size={13} />}
          disabled={!enabled || loading}
          onClick={onReload}
        >
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>
      {!enabled ? (
        <div className="dr-field-hint">
          {t('zotero.needCredentials', 'Add a Web API key and user ID (or start Zotero 7) to choose collections.')}
        </div>
      ) : loading ? (
        <div className="dr-zotero-status-row">
          <Spinner size={13} />
          <span>{t('common.loading', 'Loading…')}</span>
        </div>
      ) : error !== null && error !== undefined ? (
        <div className="dr-field-hint" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
          {detectErrorText(t, error)}
        </div>
      ) : collections.length === 0 ? (
        <div className="dr-field-hint">{t('zotero.noCollections', 'No collections found.')}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          <button
            type="button"
            className="dr-chip"
            style={selected.size === 0 ? ACTIVE_CHIP_STYLE : undefined}
            aria-pressed={selected.size === 0}
            onClick={onClear}
          >
            {t('zotero.collectionsAll', 'All collections')}
          </button>
          {collections.map((collection) => {
            const active = selected.has(collection.key)
            return (
              <button
                key={collection.key}
                type="button"
                className="dr-chip"
                style={active ? ACTIVE_CHIP_STYLE : undefined}
                aria-pressed={active}
                title={collection.name}
                onClick={() => onToggle(collection.key)}
              >
                {collection.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Inline progress / error / result strip shared by the dialog and the settings section. */
function SyncStatus({ t, running, progress, error, result }) {
  if (!running && progress === null && error === null && result === null) return null
  const total = progress !== null && typeof progress.total === 'number' && progress.total > 0 ? progress.total : 0
  const done = progress !== null && typeof progress.done === 'number' && progress.done > 0 ? progress.done : 0
  const showBar = running && progress !== null && progress.phase === 'download' && total > 0
  return (
    <div className="dr-zotero-progress" role="status" aria-live="polite">
      {running || progress !== null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={14} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {progressText(t, progress)}
          </span>
        </div>
      ) : null}
      {showBar ? <ProgressBar value={Math.min(1, done / total)} /> : null}
      {error !== null ? (
        <div style={{ color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.55 }}>{syncErrorText(t, error)}</div>
      ) : null}
      {result !== null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--dsw-alias-state-success-primary)' }}>
          <IconCheck size={14} />
          <span>{resultText(t, result)}</span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Zotero sync dialog. Explains the Web API key requirement, detects local Zotero, lets the user
 * narrow the sync to collections and streams progress while the host imports the PDFs.
 */
export function ZoteroDialog({ open = false, onClose, onSynced }) {
  const { api, t, state, actions } = useApp()
  const settingsZotero = state?.settings?.zotero ?? null
  const zoteroStatus = useZoteroStatus(api, open === true)
  const statusValue = zoteroStatus.value
  const webConfigured = statusWebConfigured(statusValue)
  const localAvailable = statusLocalAvailable(statusValue)
  const credentials = useZoteroCredentials({
    actions,
    settingsZotero,
    active: open === true,
    onSaved: () => zoteroStatus.detect(),
  })
  const collections = useZoteroCollections(api, open === true && (webConfigured || localAvailable))
  const [selected, setSelected] = React.useState(() => new Set())
  const [lastSyncedAt, setLastSyncedAt] = React.useState(0)

  const handleSyncDone = React.useCallback(
    (summary) => {
      setLastSyncedAt(Date.now())
      zoteroStatus.detect()
      if (typeof onSynced === 'function') onSynced(summary)
      else callAction(actions, 'refreshDocs')
      callAction(actions, 'toast', t('zotero.synced', 'Zotero sync finished'), 'success')
    },
    [zoteroStatus.detect, onSynced, actions, t],
  )
  const sync = useZoteroSync({ api, onDone: handleSyncDone })
  const lastSync = lastSyncedAt > 0 ? lastSyncedAt : lastSyncAtOf(statusValue, settingsZotero)

  React.useEffect(() => {
    if (open !== true) return
    setSelected(new Set())
    sync.reset()
  }, [open, sync.reset])

  const close = React.useCallback(() => {
    credentials.flush()
    if (typeof onClose === 'function') onClose()
    else callAction(actions, 'closeZotero')
  }, [credentials.flush, onClose, actions])

  const toggleCollection = (key) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Modal
      open={open === true}
      onClose={close}
      title={t('zotero.title', 'Zotero sync')}
      width={560}
      footer={
        <React.Fragment>
          <Button variant="ghost" onClick={close}>
            {t('common.close', 'Close')}
          </Button>
          {sync.running ? (
            <Button icon={<IconStop size={13} />} onClick={sync.stop}>
              {t('zotero.cancelSync', 'Cancel sync')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={sync.running ? <Spinner size={14} /> : <IconCloud size={15} />}
            disabled={sync.running}
            onClick={() => sync.start(Array.from(selected))}
          >
            {sync.running ? t('zotero.syncing', 'Syncing…') : t('zotero.sync', 'Sync now')}
          </Button>
        </React.Fragment>
      }
    >
      <div className="dr-field-hint" style={{ marginBottom: 14 }}>
        {t(
          'zotero.hint',
          'Create a key at zotero.org/settings/keys with library read access. The numeric user ID appears on the same page.',
        )}
      </div>
      <CredentialsFields t={t} draft={credentials.draft} onChange={credentials.updateDraft} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '2px 0 4px' }}>
        <div className="dr-field-label">{t('zotero.status', 'Status')}</div>
        <Button
          size="sm"
          variant="ghost"
          icon={zoteroStatus.loading ? <Spinner size={13} /> : <IconRefresh size={13} />}
          disabled={zoteroStatus.loading}
          onClick={() => zoteroStatus.detect()}
        >
          {zoteroStatus.loading ? t('zotero.detecting', 'Detecting…') : t('zotero.detect', 'Detect Zotero')}
        </Button>
      </div>
      <StatusRows t={t} status={statusValue} loading={zoteroStatus.loading} />
      {zoteroStatus.error !== null ? (
        <div className="dr-field-hint" style={{ color: 'var(--dsw-alias-state-error-primary)', margin: '2px 0 10px' }}>
          {detectErrorText(t, zoteroStatus.error)}
        </div>
      ) : null}
      {localAvailable && !webConfigured ? (
        <div className="dr-field-hint" style={{ color: 'var(--dsw-alias-state-warn-primary)', margin: '0 0 12px' }}>
          {t(
            'zotero.needKey',
            'Local Zotero is running, but its local API does not expose PDF files. Add a Zotero Web API key + user ID to sync PDFs.',
          )}
        </div>
      ) : null}
      <CollectionsField
        t={t}
        enabled={webConfigured || localAvailable}
        collections={collections.collections}
        loading={collections.loading}
        error={collections.error}
        selected={selected}
        onToggle={toggleCollection}
        onClear={() => setSelected(new Set())}
        onReload={collections.reload}
      />
      <SyncStatus t={t} running={sync.running} progress={sync.progress} error={sync.error} result={sync.result} />
      {lastSync > 0 ? (
        <div className="dr-field-hint" style={{ marginTop: 10 }}>
          {t('zotero.lastSync', 'Last sync: {time}', { time: formatDate(lastSync) })}
        </div>
      ) : null}
    </Modal>
  )
}

/**
 * "Zotero" section of the reader settings dialog: credentials, connection status, auto sync and a
 * manual sync button with inline progress.
 */
export function ZoteroSettings() {
  const { api, t, state, actions } = useApp()
  const settingsZotero = state?.settings?.zotero ?? null
  const zoteroStatus = useZoteroStatus(api, true)
  const statusValue = zoteroStatus.value
  const webConfigured = statusWebConfigured(statusValue)
  const localAvailable = statusLocalAvailable(statusValue)
  const credentials = useZoteroCredentials({
    actions,
    settingsZotero,
    active: true,
    onSaved: () => zoteroStatus.detect(),
  })
  const [lastSyncedAt, setLastSyncedAt] = React.useState(0)

  const handleSyncDone = React.useCallback(
    (summary) => {
      setLastSyncedAt(Date.now())
      zoteroStatus.detect()
      callAction(actions, 'refreshDocs')
      callAction(actions, 'toast', t('zotero.synced', 'Zotero sync finished'), 'success')
    },
    [zoteroStatus.detect, actions, t],
  )
  const sync = useZoteroSync({ api, onDone: handleSyncDone })
  const lastSync = lastSyncedAt > 0 ? lastSyncedAt : lastSyncAtOf(statusValue, settingsZotero)
  const autoSync = settingsZotero?.autoSync === true

  return (
    <div>
      <h2 className="dr-settings-h">{t('settings.section.zotero', 'Zotero')}</h2>
      <p className="dr-settings-sub">
        {t(
          'zotero.hint',
          'Create a key at zotero.org/settings/keys with library read access. The numeric user ID appears on the same page.',
        )}
      </p>
      <CredentialsFields t={t} draft={credentials.draft} onChange={credentials.updateDraft} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '2px 0 0' }}>
        <Button
          size="sm"
          variant="ghost"
          icon={zoteroStatus.loading ? <Spinner size={13} /> : <IconRefresh size={13} />}
          disabled={zoteroStatus.loading}
          onClick={() => zoteroStatus.detect()}
        >
          {zoteroStatus.loading ? t('zotero.detecting', 'Detecting…') : t('zotero.detect', 'Detect Zotero')}
        </Button>
        <span className="dr-field-hint" style={{ margin: 0 }}>
          {lastSync > 0
            ? t('zotero.lastSync', 'Last sync: {time}', { time: formatDate(lastSync) })
            : t('zotero.lastSyncNever', 'Never synced')}
        </span>
      </div>
      <StatusRows t={t} status={statusValue} loading={zoteroStatus.loading} />
      {zoteroStatus.error !== null ? (
        <div className="dr-field-hint" style={{ color: 'var(--dsw-alias-state-error-primary)', margin: '2px 0 10px' }}>
          {detectErrorText(t, zoteroStatus.error)}
        </div>
      ) : null}
      {localAvailable && !webConfigured ? (
        <div className="dr-field-hint" style={{ color: 'var(--dsw-alias-state-warn-primary)', margin: '0 0 12px' }}>
          {t(
            'zotero.needKey',
            'Local Zotero is running, but its local API does not expose PDF files. Add a Zotero Web API key + user ID to sync PDFs.',
          )}
        </div>
      ) : null}
      <SyncStatus t={t} running={sync.running} progress={sync.progress} error={sync.error} result={sync.result} />
      <Divider />
      <Switch
        checked={autoSync}
        onChange={(next) => callAction(actions, 'patchSettings', { zotero: { autoSync: next } })}
        label={t('zotero.autoSync', 'Auto sync')}
        description={t('zotero.autoSync.desc', 'Sync new Zotero items when the reader starts.')}
      />
      <Divider />
      <Row label={t('zotero.sync', 'Sync now')} description={t('zotero.syncDesc', 'Pull PDF attachments from your Zotero library into this reader.')}>
        {sync.running ? (
          <Button icon={<IconStop size={13} />} onClick={sync.stop}>
            {t('zotero.cancelSync', 'Cancel sync')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          icon={sync.running ? <Spinner size={14} /> : <IconCloud size={15} />}
          disabled={sync.running}
          onClick={() => sync.start([])}
        >
          {sync.running ? t('zotero.syncing', 'Syncing…') : t('zotero.sync', 'Sync now')}
        </Button>
      </Row>
    </div>
  )
}
