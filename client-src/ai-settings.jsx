// AI model settings: the active DSH provider, translation and visual layout routes, custom
// OpenAI-compatible providers and the translation cache. API keys are only ever written through
// `actions.patchSettings` (persisted host-side) — never to any other client storage.
import React from 'react'
import { useApp } from './store.jsx'
import { Badge, Button, Divider, IconButton, Input, Row, Select, Textarea } from './ui.jsx'
import { IconCheck, IconInfo, IconPlus, IconRefresh, IconSpark, IconTrash, IconZap } from './icons.jsx'
import { formatBytes, LANGUAGE_LABELS } from './util.js'
import { decodeRoute, encodeRoute, modelRouteOptions, withCurrentRoute } from './model-routes.js'
import { DEFAULT_LIBRE_URL, LIBRETRANSLATE, MYMEMORY, normalizeLibreUrl } from '../shared/translation-engines.js'

const h = React.createElement

function LibreTranslateSettings({ t, translate, save }) {
  const savedUrl = translate?.libreUrl ?? DEFAULT_LIBRE_URL
  const [url, setUrl] = React.useState(savedUrl)
  const [key, setKey] = React.useState('')
  const normalized = normalizeLibreUrl(url)
  const hasKey = Boolean(translate?.libreKey)
  const endpointLabel = t('translation.libre.url', 'Server base URL')
  const keyLabel = t('translation.libre.key', 'API key (optional)')
  return <form className="dr-translation-engine" onSubmit={event => {
    event.preventDefault()
    if (!normalized) return
    save({ libreUrl: normalized, libreKey: key.trim() || (normalized === savedUrl ? translate?.libreKey ?? '' : '') })
    setUrl(normalized)
    setKey('')
  }}>
    <p className="dr-field-hint">{t('translation.libre.hint', 'Start your LibreTranslate instance first. A server on this computer keeps translation local.')}</p>
    <Row label={endpointLabel}><Input aria-label={endpointLabel} value={url} placeholder={DEFAULT_LIBRE_URL} onChange={event => setUrl(event.target.value)} aria-invalid={Boolean(url && !normalized)}/></Row>
    <Row label={keyLabel}><Input aria-label={keyLabel} type="password" value={key} placeholder={hasKey && normalized === savedUrl ? '••••••••' : ''} autoComplete="new-password" onChange={event => setKey(event.target.value)}/></Row>
    <div className="dr-translation-engine-actions">
      <Button type="submit" size="sm" disabled={!normalized || (normalized === savedUrl && !key.trim())}>{t('common.save', 'Save')}</Button>
      {hasKey && normalized === savedUrl ? <Button size="sm" variant="ghost" onClick={() => { setKey(''); save({ libreKey: '' }) }}>{t('translation.libre.removeKey', 'Remove key')}</Button> : null}
    </div>
  </form>
}

/** Provider draft (settings.ai.providers item with the model list kept as textarea text). */
function toDraft(provider) {
  return {
    id: typeof provider?.id === 'string' ? provider.id : '',
    name: typeof provider?.name === 'string' ? provider.name : '',
    baseURL: typeof provider?.baseURL === 'string' ? provider.baseURL : '',
    // The saved secret is never copied into editable state; a blank field means "keep the saved key".
    apiKey: '',
    hasKey: typeof provider?.apiKey === 'string' && provider.apiKey !== '',
    modelsText: Array.isArray(provider?.models) ? provider.models.join('\n') : '',
  }
}

function parseModels(text) {
  const seen = new Set()
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const model = line.trim()
    if (model === '' || seen.has(model)) continue
    seen.add(model)
    out.push(model.slice(0, 120))
    if (out.length >= 60) break
  }
  return out
}

function newProviderId() {
  return `custom-${Date.now().toString(36)}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Convert provider drafts into the persisted shape (blank keys keep the already-saved secret). */
function normalizeDrafts(list, savedApiKeyOf) {
  return (Array.isArray(list) ? list : []).map((draft) => ({
    id: draft.id,
    name: (draft.name ?? '').trim() || draft.id,
    kind: 'openai',
    baseURL: (draft.baseURL ?? '').trim().replace(/\/+$/, ''),
    apiKey: typeof draft.apiKey === 'string' && draft.apiKey !== '' ? draft.apiKey : savedApiKeyOf(draft.id),
    models: parseModels(draft.modelsText),
  }))
}

/**
 * Settings-dialog AI section: DSH provider status, model routes, custom providers and cache.
 * (`TranslationSettings` lives in translate.jsx and is rendered right after this section.)
 */
export function AiSettings() {
  const { api, t, state, actions } = useApp()
  const settings = state?.settings
  const providers = settings?.ai?.providers ?? []

  const [modelsInfo, setModelsInfo] = React.useState(null)
  const [modelsError, setModelsError] = React.useState(null)
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [drafts, setDrafts] = React.useState(() => providers.map(toDraft))
  const [testState, setTestState] = React.useState({})
  const [fetching, setFetching] = React.useState({})
  const [cache, setCache] = React.useState(null)
  const [cacheBusy, setCacheBusy] = React.useState(false)
  const draftsRef = React.useRef(drafts)
  draftsRef.current = drafts
  const settingsRef = React.useRef(settings)
  settingsRef.current = settings
  // Kept host-side: a blank API-key field means "keep the saved key for this provider".
  const savedApiKeyOf = (id) => {
    const list = settingsRef.current?.ai?.providers ?? []
    const provider = list.find((entry) => entry.id === id)
    return typeof provider?.apiKey === 'string' ? provider.apiKey : ''
  }

  const loadModels = React.useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const info = await api.rpc('ai.models')
      setModelsInfo(info ?? null)
    } catch (error) {
      setModelsError(error?.message ?? String(error))
    } finally {
      setModelsLoading(false)
    }
  }, [api])

  const loadCache = React.useCallback(async () => {
    try {
      const stats = await api.rpc('ai.cache.stats')
      setCache(stats ?? null)
    } catch {
      setCache(null)
    }
  }, [api])

  React.useEffect(() => {
    void loadModels()
    void loadCache()
  }, [loadCache, loadModels])

  // Keep drafts in step when providers are added/removed by another source (ids changed only).
  React.useEffect(() => {
    const remote = providers.map((provider) => provider.id).join('|')
    const local = drafts.map((draft) => draft.id).join('|')
    if (remote !== local) setDrafts(providers.map(toDraft))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  // ----- persistence -----------------------------------------------------------------
  const commitDrafts = React.useCallback(
    (nextDrafts) => {
      actions?.patchSettings?.({ ai: { providers: normalizeDrafts(nextDrafts, savedApiKeyOf) } })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions],
  )

  const commitCurrent = React.useCallback(() => {
    commitDrafts(draftsRef.current)
  }, [commitDrafts])

  const updateDraft = React.useCallback((id, patch) => {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)))
  }, [])

  const addProvider = React.useCallback(() => {
    const draft = { id: newProviderId(), name: t('settings.model.custom', 'Custom provider'), baseURL: '', apiKey: '', modelsText: '' }
    const next = [...draftsRef.current, draft]
    setDrafts(next)
    commitDrafts(next)
    setTestState((current) => ({ ...current, [draft.id]: null }))
  }, [commitDrafts, t])

  const removeProvider = React.useCallback(
    (id) => {
      const next = draftsRef.current.filter((draft) => draft.id !== id)
      setDrafts(next)
      // One combined patch: the app persists patches debounced, so two calls could drop the first.
      const patch = { ai: { providers: normalizeDrafts(next, savedApiKeyOf) } }
      const active = {}
      for (const task of ['chat', 'translate', 'vision']) {
        if (settings?.ai?.active?.[task]?.providerId === id) active[task] = { providerId: 'dsh', model: '' }
      }
      if (Object.keys(active).length > 0) patch.ai.active = active
      actions?.patchSettings?.(patch)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, settings],
  )

  // ----- provider actions ------------------------------------------------------------
  const fetchModels = React.useCallback(
    async (draft) => {
      setFetching((current) => ({ ...current, [draft.id]: true }))
      setTestState((current) => ({ ...current, [draft.id]: null }))
      try {
        const apiKey = typeof draft.apiKey === 'string' && draft.apiKey !== '' ? draft.apiKey : savedApiKeyOf(draft.id)
        const result = await api.rpc('ai.customModels', { baseURL: (draft.baseURL ?? '').trim(), apiKey })
        const models = Array.isArray(result?.models) ? result.models : []
        const next = draftsRef.current.map((entry) => (entry.id === draft.id ? { ...entry, modelsText: models.join('\n') } : entry))
        setDrafts(next)
        commitDrafts(next)
        setTestState((current) => ({
          ...current,
          [draft.id]: { status: models.length > 0 ? 'ok' : 'error', message: models.length > 0 ? t('settings.model.fetchOk', 'Fetched {count} models', { count: models.length }) : t('settings.model.fetchEmpty', 'The endpoint returned no models') },
        }))
      } catch (error) {
        setTestState((current) => ({ ...current, [draft.id]: { status: 'error', message: error?.message ?? String(error) } }))
      } finally {
        setFetching((current) => ({ ...current, [draft.id]: false }))
      }
    },
    [api, commitDrafts, t],
  )

  const testProvider = React.useCallback(
    async (draft) => {
      setTestState((current) => ({ ...current, [draft.id]: { status: 'testing', message: t('settings.model.testing', 'Testing…') } }))
      // Persist the draft first: the host resolves custom providers from settings.
      commitCurrent()
      try {
        await delay(320)
        const models = parseModels(draft.modelsText)
        const result = await api.rpc('ai.translate', {
          texts: ['hello'],
          targetLang: 'zh-CN',
          modelRef: { providerId: draft.id, model: models[0] ?? '' },
        })
        const translated = Array.isArray(result?.translations) && typeof result.translations[0] === 'string' ? result.translations[0] : ''
        setTestState((current) => ({
          ...current,
          [draft.id]: { status: 'ok', message: t('settings.model.testOk', 'Connection OK: “{text}”', { text: translated || 'hello' }) + (result?.model ? ` · ${result.model}` : '') },
        }))
      } catch (error) {
        setTestState((current) => ({ ...current, [draft.id]: { status: 'error', message: error?.message ?? String(error) } }))
      }
    },
    [api, commitCurrent, t],
  )

  // ----- model routes ----------------------------------------------------------------
  const dsh = modelsInfo?.dsh
  const configuredProviders = drafts.map(draft => ({
    id: draft.id, name: draft.name.trim(), models: parseModels(draft.modelsText),
  }))
  const translateRoute = encodeRoute(settings?.ai?.active?.translate)
  const visionRoute = encodeRoute(settings?.ai?.active?.vision)
  const translateOptions = withCurrentRoute(modelRouteOptions(t, dsh, configuredProviders, { forTranslation: true }), translateRoute)
  const visionOptions = withCurrentRoute(modelRouteOptions(t, dsh, configuredProviders, { forVision: true }), visionRoute)
  const translationProvider = settings?.ai?.active?.translate?.providerId
  const translateSettings = settings?.ai?.translate
  const saveTranslation = translate => actions?.patchSettings?.({ ai: { translate } }, { immediate: true })

  const pickRoute = (task, value) => {
    actions?.patchSettings?.({ ai: { active: { [task]: decodeRoute(value) } } }, { immediate: true })
  }

  // ----- cache -----------------------------------------------------------------------
  const clearCache = async () => {
    setCacheBusy(true)
    try {
      await api.rpc('ai.cache.clear')
      actions?.toast?.(t('settings.cache.cleared', 'AI cache cleared'), 'success')
      await loadCache()
    } catch (error) {
      actions?.toast?.(String(error?.message ?? error), 'error')
    } finally {
      setCacheBusy(false)
    }
  }

  // ----- render ----------------------------------------------------------------------
  const field = (label, control, hint) =>
    h(
      'div',
      { className: 'dr-field' },
      h('div', { className: 'dr-field-label' }, label),
      control,
      hint !== undefined ? h('div', { className: 'dr-field-hint' }, hint) : null,
    )

  const providerCards = drafts.map((draft) => {
    const status = testState[draft.id]
    const busyFetching = fetching[draft.id] === true
    const hasSavedKey = savedApiKeyOf(draft.id) !== ''
    return h(
      'div',
      { className: 'dr-provider-card', key: draft.id },
      h(
        'div',
        { className: 'dr-provider-head' },
        h('div', { className: 'dr-provider-name' }, (draft.name ?? '').trim() !== '' ? draft.name : t('settings.model.custom', 'Custom provider')),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 4 } },
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefresh, { size: 13 }), disabled: busyFetching, onClick: () => void fetchModels(draft) }, busyFetching ? t('common.loading', 'Loading…') : t('settings.model.fetchModels', 'Fetch models')),
          h(Button, { size: 'sm', variant: 'ghost', icon: h(IconZap, { size: 13 }), disabled: status?.status === 'testing', onClick: () => void testProvider(draft) }, t('settings.model.test', 'Test connection')),
          h(IconButton, { size: 'sm', icon: h(IconTrash, { size: 14 }), label: t('common.remove', 'Remove'), onClick: () => removeProvider(draft.id) }),
        ),
      ),
      h(
        'div',
        { className: 'dr-provider-grid' },
        field(t('settings.model.providerName', 'Name'), h(Input, { value: draft.name, placeholder: 'DeepSeek', onChange: (event) => updateDraft(draft.id, { name: event.target.value }), onBlur: commitCurrent })),
        field(t('settings.model.baseURL', 'Base URL'), h(Input, { value: draft.baseURL, placeholder: 'https://api.deepseek.com', spellCheck: false, onChange: (event) => updateDraft(draft.id, { baseURL: event.target.value }), onBlur: commitCurrent })),
      ),
      field(
        t('settings.model.apiKey', 'API key'),
        h(Input, {
          value: draft.apiKey ?? '',
          type: 'password',
          autoComplete: 'new-password',
          placeholder: hasSavedKey ? t('settings.model.apiKeySaved', 'Saved — type a new key to replace it') : 'sk-…',
          spellCheck: false,
          onChange: (event) => updateDraft(draft.id, { apiKey: event.target.value }),
          onBlur: commitCurrent,
        }),
        hasSavedKey
          ? t('settings.model.apiKeySavedHint', 'A key is already saved host-side. Leave this blank to keep it.')
          : t('settings.model.apiKeyHint', 'Stored on this machine by the reader host. Never sent anywhere except the provider endpoint.'),
      ),
      field(
        t('settings.model.models', 'Models (one per line)'),
        h(Textarea, { rows: 3, value: draft.modelsText, placeholder: 'deepseek-chat\ndeepseek-reasoner', spellCheck: false, onChange: (event) => updateDraft(draft.id, { modelsText: event.target.value }), onBlur: commitCurrent }),
      ),
      status !== null && status !== undefined
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                lineHeight: 1.5,
                overflowWrap: 'anywhere',
                color: status.status === 'error' ? 'var(--dsw-alias-state-error-primary)' : status.status === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            },
            status.status === 'ok' ? h(IconCheck, { size: 13 }) : h(IconInfo, { size: 13 }),
            h('span', null, status.message),
          )
        : null,
    )
  })

  return h(
    'div',
    null,
    h('div', { className: 'dr-settings-h' }, t('settings.section.ai', 'AI models')),
    h('p', { className: 'dr-settings-sub' }, t('settings.model.routesHint', 'Use the active provider in DSH or add an OpenAI-compatible provider below.')),
    // Current Harness provider
    h(
      'div',
      { className: 'dr-provider-card' },
      h(
        'div',
        { className: 'dr-provider-head', style: { marginBottom: 4 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { className: dsh?.available === true ? 'dr-dot is-ok' : 'dr-dot is-bad' }),
          h('div', { className: 'dr-provider-name' }, t('settings.model.default', 'DSH current model')),
          dsh?.available === true ? h(Badge, { tone: 'success' }, `${dsh.providerName || dsh.provider || ''}${dsh.model ? ` · ${dsh.model}` : ''}`) : h(Badge, { tone: 'warn' }, t('common.off', 'Off')),
        ),
        h(IconButton, { icon: h(IconRefresh, { size: 15 }), label: t('common.retry', 'Refresh'), onClick: () => void loadModels(), disabled: modelsLoading }),
      ),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, t('settings.model.defaultDesc', 'Uses the model provider currently selected in DSH. Usage is recorded by that provider.')),
      dsh?.available !== true ? h('div', { style: { fontSize: 12, marginTop: 6, color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.5 } }, t('settings.model.unavailable', 'Choose an available model in DSH Settings → Models.')) : null,
    ),
    modelsError !== null
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', margin: '8px 0' } }, h('span', null, modelsError), h(Button, { size: 'sm', variant: 'ghost', icon: h(IconRefresh, { size: 13 }), onClick: () => void loadModels() }, t('common.retry', 'Retry')))
      : null,
    // Routes
    h(Divider),
    h(Row, { label: t('settings.model.activeTranslate', 'Translation engine'), description: t('settings.model.routeTranslateDesc', 'Used for bilingual translation of the document.') }, h(Select, { value: translateRoute, onChange: (value) => pickRoute('translate', value), options: translateOptions, 'aria-label': t('settings.model.activeTranslate', 'Translation engine') })),
    translationProvider === MYMEMORY ? h('div', { className: 'dr-translation-engine' },
      h('p', { className: 'dr-field-hint' }, t('translation.mymemory.hint', 'No key required. MyMemory stores submitted text and allows 5,000 characters a day for anonymous use.')),
      h(Row, { label: t('translation.mymemory.source', 'Source language') }, h(Select, {
        'aria-label': t('translation.mymemory.source', 'Source language'),
        value: translateSettings?.myMemorySource ?? 'en',
        onChange: myMemorySource => saveTranslation({ myMemorySource }),
        options: [...Object.entries(LANGUAGE_LABELS), ['it', 'Italiano']].map(([value, label]) => ({ value, label })),
      })),
    ) : null,
    translationProvider === LIBRETRANSLATE ? h(LibreTranslateSettings, { t, translate: translateSettings, save: saveTranslation }) : null,
    h(Row, { label: t('settings.model.activeVision', 'Visual layout model'), description: t('settings.model.routeVisionDesc', 'Must accept images. Used to identify figures, tables, equations, algorithms and paragraph structure.') }, h(Select, { value: visionRoute, onChange: value => pickRoute('vision', value), options: visionOptions })),
    // Custom providers
    h(Divider, { label: t('settings.model.custom', 'Custom provider') }),
    drafts.length === 0 ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, margin: '2px 0 12px' } }, t('settings.model.noProviders', 'No custom providers yet. Add one to use an OpenAI-compatible endpoint with your own API key.')) : null,
    providerCards,
    h(Button, { icon: h(IconPlus, { size: 14 }), onClick: addProvider, style: { marginTop: 2 } }, t('settings.model.addProvider', 'Add provider')),
    // Cache
    h(Divider, { label: 'AI cache' }),
    h(
      Row,
      {
        label: t('settings.cache.size', 'Translation cache: {size} ({count} entries)', { size: formatBytes(cache?.bytes ?? 0), count: cache?.entries ?? 0 }),
        description: t('settings.model.cacheDesc', 'Cached translations are keyed by model, language and source passage.'),
      },
      h(
        Button,
        { size: 'sm', variant: 'danger', icon: h(IconTrash, { size: 13 }), disabled: cacheBusy || (cache?.entries ?? 0) === 0, onClick: () => void clearCache() },
        t('settings.cache.clear', 'Clear AI cache'),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 10, lineHeight: 1.5 } },
      h(IconSpark, { size: 13 }),
      h('span', null, t('settings.model.keyNotice', 'API keys are stored host-side under the reader data directory and are never written to browser storage.')),
    ),
  )
}
