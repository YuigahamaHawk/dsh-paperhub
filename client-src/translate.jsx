// Bilingual translation: an observable cache-first service, the reader top-bar controls and the
// settings section. Saved translations reopen without another model call.
//
// The service is created by ReaderShell and exposed as `useReader().translate`. Paragraphs read
// one block's entry through `get(blockId)` / `subscribe(fn)` (useSyncExternalStore compatible:
// `get` returns the same object reference until that block actually changes).
import React from 'react'
import { DEFAULT_SETTINGS, useApp, useReader } from './store.jsx'
import { Badge, Button, Divider, MenuItem, Popover, Row, SegmentedControl, Select, Slider, Switch } from './ui.jsx'
import { IconCheck, IconChevronDown, IconGlobe, IconRefresh, IconSpark, IconTranslate, IconZap, Spinner } from './icons.jsx'
import { LANGUAGE_LABELS, clamp, clsx } from './util.js'
import { translatableIndex } from '../shared/translation-blocks.js'
import { DEEPSEEK_ACCOUNT_ROUTE } from '../shared/model-ref.js'
import { TRANSLATION_ENGINES, translationEngineScope } from '../shared/translation-engines.js'

const h = React.createElement

const FALLBACK_AI = DEFAULT_SETTINGS.ai

function scopedTranslationRef(ref, scope) {
  const providerId = ref?.providerId ?? 'dsh'
  return Object.hasOwn(TRANSLATION_ENGINES, providerId) ? { providerId, model: '', scope } : { providerId, model: ref?.model ?? '' }
}

/** Frozen empty statistics snapshot (stable reference for `stats` before any request). */
const EMPTY_STATS = Object.freeze({
  done: 0,
  total: 0,
  loading: 0,
  errors: 0,
  queued: 0,
  cachedChars: 0,
  chars: 0,
  usageChars: 0,
  model: '',
})

function sameStats(left, right) {
  for (const key of Object.keys(EMPTY_STATS)) {
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * Cache-first bilingual translation queue.
 *
 * @param {object} options
 * @param {object} options.api      reader API with streaming translation
 * @param {object} options.settings host-mirrored settings
 * @param {string} [options.docId]  document id used for host stats
 * @param {Array}  [options.blocks] content blocks ({ id, text, kind })
 * @param {(stats: object) => void} [options.onStats] called with a stable statistics snapshot
 */
export function createTranslationService({ api, settings, docId, blocks, onStats, whenSettingsSaved } = {}) {
  const aiSettings = (settings && settings.ai) || FALLBACK_AI
  const translateSettings = aiSettings.translate || FALLBACK_AI.translate
  let batchSize = Math.max(1, Math.min(12, Number(translateSettings.batchSize) || 6))
  let concurrency = Math.max(1, Math.min(4, Number(translateSettings.concurrency) || 2))

  const blockIndex = translatableIndex(blocks)
  const blockIds = [...blockIndex.keys()]

  let enabled = false
  let auto = translateSettings.auto !== false
  let viewport = []
  let lang = typeof aiSettings.targetLang === 'string' && aiSettings.targetLang !== '' ? aiSettings.targetLang : FALLBACK_AI.targetLang
  let mode = translateSettings.mode === 'replace' ? 'replace' : 'bilingual'
  const initialRef = aiSettings.active?.translate
  let modelRef = scopedTranslationRef(initialRef, translationEngineScope(initialRef?.providerId, translateSettings))
  let disposed = false
  // Bumped when a new translation round starts (language change / clear): stale RPC results are dropped.
  let generation = 0

  /** blockId -> { status:'loading'|'done'|'error', text?, cached?, model?, error? } —stable refs. */
  const entries = new Map()
  const listeners = new Set()
  const queue = []
  const queued = new Set()
  const inFlight = new Set()
  const controllers = new Set()
  let activeBatches = 0
  let pumpTimer = 0
  const requested = new Map() // block ID → whether the request is automatic
  const forced = new Set()
  const isolated = new Set()
  const metrics = { usageChars: 0, cachedChars: 0, model: '' }
  // Compute the initial snapshot from the known blocks so `total` is correct before any request.
  let statsSnapshot = Object.freeze(computeStats())
  let notifyScheduled = false

  function computeStats() {
    let done = 0
    let loading = 0
    let errors = 0
    let cachedChars = 0
    let chars = 0
    for (const [id, entry] of entries) {
      const sourceLength = blockIndex.get(id)?.text?.length ?? 0
      if (entry.status === 'done') {
        done++
        chars += sourceLength
        if (entry.cached === true) cachedChars += sourceLength
      } else if (entry.status === 'loading') {
        loading++
      } else if (entry.status === 'error') {
        errors++
      }
    }
    return {
      done,
      total: blockIds.length,
      loading,
      errors,
      queued: queue.length,
      cachedChars,
      chars,
      usageChars: metrics.usageChars,
      model: metrics.model,
    }
  }

  function refresh() {
    const next = computeStats()
    if (!sameStats(statsSnapshot, next)) {
      statsSnapshot = Object.freeze(next)
      scheduleNotify()
    }
  }

  function notifyNow() {
    notifyScheduled = false
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* a broken subscriber must not break translation */
      }
    }
    try {
      onStats?.(statsSnapshot)
    } catch {
      /* optional observer */
    }
  }

  function scheduleNotify() {
    if (notifyScheduled || disposed) return
    notifyScheduled = true
    Promise.resolve().then(notifyNow)
  }

  function enqueue(id, automatic = false) {
    if (disposed || !blockIndex.has(id)) return
    const current = entries.get(id)
    if (current !== undefined && (current.status === 'done' || current.status === 'error')) return
    if (!automatic || !requested.has(id)) requested.set(id, automatic)
    if (inFlight.has(id) || queued.has(id)) return
    queue.push(id)
    queued.add(id)
  }

  function retainQueued(keep) {
    const pending = queue.filter(keep)
    queue.length = 0
    queued.clear()
    for (const id of pending) {
      queue.push(id)
      queued.add(id)
    }
  }

  function syncAutomatic() {
    if (enabled && auto) {
      for (const id of blockIds) enqueue(id, true)
      schedulePump()
    } else {
      for (const [id, automatic] of requested) if (automatic) requested.delete(id)
      retainQueued(id => requested.has(id))
    }
  }

  function setEnabled(next) {
    if (disposed || enabled === (next === true)) return
    enabled = next === true
    syncAutomatic()
    pulse()
  }

  function pump() {
    if (disposed) return
    while (activeBatches < concurrency && queue.length > 0) {
      // Send the current viewport together. Free request slots can handle the
      // rest without waiting for that batch to finish.
      const visible = viewport.filter(id => queued.has(id))
      const source = visible.length ? visible : queue
      const batch = []
      while (batch.length < batchSize && source.length > 0) {
        if (batch.length && isolated.has(source[0])) break
        const id = source.shift()
        if (source !== queue) queue.splice(queue.indexOf(id), 1)
        queued.delete(id)
        if (!blockIndex.has(id)) continue
        const current = entries.get(id)
        if (current !== undefined && (current.status === 'done' || current.status === 'loading')) continue
        batch.push(id)
        if (isolated.has(id)) break
      }
      if (batch.length === 0) {
        if (queue.length === 0) break
        continue
      }
      activeBatches++
      void runBatch(batch)
    }
    refresh()
  }

  function schedulePump() {
    if (disposed || pumpTimer !== 0) return
    // Let several IntersectionObserver callbacks accumulate before starting a batch; this avoids
    // paying a full model round-trip for a one-paragraph batch while scrolling.
    pumpTimer = setTimeout(() => {
      pumpTimer = 0
      pump()
    }, 40)
  }

  async function runBatch(ids) {
    const batchGeneration = generation
    const ref = modelRef
    const controller = new AbortController()
    controllers.add(controller)
    for (const id of ids) {
      inFlight.add(id)
      entries.set(id, {status:'loading'})
    }
    refresh()
    const texts = ids.map((id) => blockIndex.get(id)?.text ?? '')
    const isCurrent = () => !disposed && batchGeneration === generation
    const completed = new Set()
    const accept = (index, value, cached, model) => {
      const id = ids[index], source = texts[index]
      if (id === undefined || completed.has(index) || blockIndex.get(id)?.text !== source ||
          typeof value !== 'string' || (!value.trim() && source.trim())) return
      completed.add(index)
      forced.delete(id)
      isolated.delete(id)
      entries.set(id, {status:'done',text:value,source,cached:cached === true,model})
    }
    const onProgress = progress => {
      if (!isCurrent() || !Array.isArray(progress?.items)) return
      const model = typeof progress.model === 'string' ? progress.model : ''
      for (const item of progress.items) if (Number.isInteger(item?.index)) accept(item.index, item.text, item.cached, model)
      if (model) metrics.model = model
      refresh()
    }
    try {
      if (typeof api?.stream !== 'function' && typeof api?.rpc !== 'function') throw new Error('reader API is unavailable')
      if ('scope' in ref) await whenSettingsSaved?.()
      if (!isCurrent()) return
      const params = { texts, targetLang: lang, modelRef: ref, force: ids.some(id => forced.has(id)), ref: { docId } }
      const result = typeof api?.stream === 'function'
        ? await api.stream('ai.translate', params, {onProgress}, controller.signal)
        : await api.rpc('ai.translate', params, {signal:controller.signal})
      if (!isCurrent()) return
      const translations = Array.isArray(result?.translations) ? result.translations : []
      const cached = Array.isArray(result?.cached) ? result.cached : []
      const failures = Array.isArray(result?.errors) ? result.errors : []
      const model = typeof result?.model === 'string' ? result.model : ''
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], source = texts[index]
        if (completed.has(index) || blockIndex.get(id)?.text !== source) continue
        if (failures[index]) {
          entries.set(id, {status:'error',source,error:failures[index].message ?? String(failures[index]),code:failures[index].code})
        } else {
          accept(index, translations[index] ?? '', cached[index], model)
          if (!completed.has(index)) entries.set(id, {status:'error',source,error:'The translation was empty. Retry this paragraph.'})
        }
      }
      const usage = result?.usage
      if (usage !== null && typeof usage === 'object') {
        metrics.usageChars += Number(usage.chars) || 0
        metrics.cachedChars += Number(usage.cachedChars) || 0
      }
      if (model) metrics.model = model
    } catch (error) {
      if (!isCurrent()) return
      const message = error?.message ?? String(error)
      for (const [index, id] of ids.entries()) {
        if (completed.has(index) || blockIndex.get(id)?.text !== texts[index]) continue
        entries.set(id, {status:'error',source:texts[index],error:message,code:error?.code})
      }
    } finally {
      controllers.delete(controller)
      for (const id of ids) {
        inFlight.delete(id)
        if (requested.has(id) && blockIndex.has(id) && !entries.has(id)) enqueue(id, requested.get(id))
      }
      activeBatches = Math.max(0, activeBatches - 1)
      if (disposed) return
      refresh()
      pump()
    }
  }

  const service = {
    /** @returns {boolean} translation display is on for this reading session. */
    get enabled() {
      return enabled
    },
    /** Compatibility alias used by the DESIGN reader-shell contract. */
    get on() {
      return enabled
    },
    get lang() {
      return lang
    },
    get mode() {
      return mode
    },
    get docId() {
      return docId
    },
    /** Stable frozen statistics snapshot. */
    get stats() {
      return statsSnapshot
    },
    /** Every known translatable block id. */
    get blockIds() {
      return blockIds
    },
    /** Direct entry map (DESIGN contract); prefer `get(blockId)`. */
    get entries() {
      return entries
    },
    /** Translation entry for a block: stable reference until that block changes. */
    get(blockId) {
      return entries.get(blockId)
    },
    /** Unsent automatic work stays in the toolbar progress, avoiding a spinner in every paragraph. */
    autoPending(blockId) {
      return inFlight.has(blockId) || (queued.has(blockId) && requested.get(blockId) === false)
    },
    request(blockId) {
      enqueue(blockId)
      schedulePump()
    },
    setViewport(ids) {
      viewport = [...new Set(ids)]
    },
    setAutomatic(next) {
      if (disposed || auto === (next === true)) return
      auto = next === true
      syncAutomatic()
      pulse()
    },
    setScheduling(next) {
      if (disposed) return
      batchSize = Math.max(1, Math.min(12, Number(next?.batchSize) || 6))
      concurrency = Math.max(1, Math.min(4, Number(next?.concurrency) || 2))
      if (queue.length) schedulePump()
    },
    /** Queue every translatable block of the document (explicit "translate all" action). */
    requestAll() {
      for (const id of blockIds) enqueue(id)
      schedulePump()
    },
    /** Hydrate saved results in one local request, without generating missing translations. */
    async restoreCached() {
      if(disposed)return 0
      const round=generation,currentLang=lang,ref={...modelRef}
      if ('scope' in ref) await whenSettingsSaved?.()
      if (disposed || round !== generation) return 0
      const ids=blockIds.filter(id=>entries.get(id)?.status!=='done'&&!inFlight.has(id)&&!forced.has(id))
      let count=0
      for(let start=0;start<ids.length;start+=1000){
        const slice=ids.slice(start,start+1000),texts=slice.map(id=>blockIndex.get(id)?.text??'')
        const result=await api.rpc('ai.translationCache',{texts,targetLang:currentLang,modelRef:ref})
        if(disposed||generation!==round)return count
        for(const [index,id] of slice.entries()){
          const value=result?.translations?.[index]
          if(typeof value!=='string'||!value.trim()||blockIndex.get(id)?.text!==texts[index]||inFlight.has(id)||forced.has(id)||entries.get(id)?.status==='done')continue
          entries.set(id,{status:'done',source:texts[index],text:value,cached:true,model:result.model??''});count++
        }
        retainQueued(id => entries.get(id)?.status !== 'done')
        refresh()
      }
      return count
    },
    /**
     * Replace the content block list (e.g. when a document's content arrives after the service was
     * created). Clears per-block state and stats; the reader can then request visible blocks again.
     */
    setBlocks(nextBlocks) {
      if (disposed) return
      const previous = new Map(blockIndex)
      const nextIndex = translatableIndex(nextBlocks)
      blockIndex.clear()
      for (const [id, block] of nextIndex) blockIndex.set(id, block)
      blockIds.length = 0
      for (const id of nextIndex.keys()) blockIds.push(id)
      // Keep translations whose block id and source text did not change. AI formula/layout passes
      // replace the content object frequently; clearing everything here would re-bill the document.
      for (const [id, entry] of entries) {
        const before = previous.get(id)
        const after = nextIndex.get(id)
        if (before === undefined || after === undefined || before.text !== after.text) entries.delete(id)
      }
      retainQueued(id => nextIndex.has(id) && !entries.has(id))
      for (const id of requested.keys()) if (!nextIndex.has(id)) requested.delete(id)
      syncAutomatic()
      refresh()
      pulse()
    },
    /** Re-queue a failed (or previously translated) block. */
    retry(blockId) {
      if (disposed || !blockIndex.has(blockId)) return
      if (queued.has(blockId) || inFlight.has(blockId)) return
      const retranslate = entries.get(blockId)?.status === 'done'
      entries.delete(blockId)
      isolated.add(blockId)
      if (retranslate) forced.add(blockId)
      else forced.delete(blockId)
      refresh()
      enqueue(blockId)
      schedulePump()
    },
    setEnabled,
    toggle() {
      setEnabled(!enabled)
    },
    setLang(nextLang) {
      if (disposed || typeof nextLang !== 'string' || nextLang === '' || nextLang === lang) return
      lang = nextLang
      // Everything translated so far belongs to the previous language: drop it, then refresh the
      // blocks the reader actually asked for (host cache makes the re-run cheap).
      restartRequested()
    },
    setModelRef(next, scope) {
      const ref = scopedTranslationRef(next, scope)
      if (JSON.stringify(ref) === JSON.stringify(modelRef)) return
      modelRef = ref
      restartRequested()
    },
    setMode(nextMode) {
      const value = nextMode === 'replace' ? 'replace' : 'bilingual'
      if (disposed || value === mode) return
      mode = value
      pulse()
    },
    clear() {
      if (disposed) return
      generation += 1
      for (const controller of controllers) controller.abort()
      entries.clear()
      queue.length = 0
      queued.clear()
      requested.clear()
      forced.clear()
      isolated.clear()
      metrics.cachedChars = 0
      refresh()
      pulse()
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => undefined
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (pumpTimer !== 0) clearTimeout(pumpTimer)
      pumpTimer = 0
      generation += 1
      for (const controller of controllers) controller.abort()
      queue.length = 0
      queued.clear()
      inFlight.clear()
      requested.clear()
      listeners.clear()
      forced.clear()
      isolated.clear()
    },
    /** Notify subscribers when a non-entry state (enabled/lang/mode) changes. */
    pulse,
  }

  function restartRequested() {
    generation += 1
    for (const controller of controllers) controller.abort()
    entries.clear(); queue.length = 0; queued.clear(); forced.clear(); isolated.clear()
    metrics.cachedChars = 0
    refresh()
    // Keep in-flight ids owned by their old batch until its finally block.
    // That block requeues requested ids after discarding the stale response.
    for (const [id, automatic] of requested) enqueue(id, automatic)
    schedulePump(); pulse()
  }

  function pulse() {
    refresh()
    scheduleNotify()
  }

  return service
}

/** Subscribe a component to any service observable change (stats/enabled/lang/mode/entries). */
function useTranslationTick(service) {
  const [, bump] = React.useReducer((value) => value + 1, 0)
  React.useEffect(() => {
    if (service === null || service === undefined || typeof service.subscribe !== 'function') return undefined
    const unsubscribe = service.subscribe(() => bump())
    return () => {
      try {
        unsubscribe?.()
      } catch {
        /* disposed */
      }
    }
  }, [service])
}

/** Fetch the host language list once (falls back to the local table). */
function useLanguages(api) {
  const [languages, setLanguages] = React.useState(null)
  React.useEffect(() => {
    if (api === null || api === undefined || typeof api.rpc !== 'function') return undefined
    let cancelled = false
    api
      .rpc('ai.models')
      .then((info) => {
        if (cancelled) return
        if (info !== null && info !== undefined && Array.isArray(info.languages) && info.languages.length > 0) {
          setLanguages(info.languages.filter((item) => item !== null && typeof item?.id === 'string'))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])
  if (languages !== null && languages.length > 0) return languages
  return Object.keys(LANGUAGE_LABELS).map((id) => ({ id, name: LANGUAGE_LABELS[id] }))
}

function languageLabel(languages, id) {
  const hit = (languages ?? []).find((item) => item.id === id)
  if (hit !== undefined) return hit.name
  return LANGUAGE_LABELS[id] ?? id ?? ''
}

/** Close a popover on outside click / Escape. */
function useDismiss(ref, open, onClose) {
  React.useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const element = ref.current
      if (element !== null && element !== undefined && !element.contains(event.target)) onClose()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [ref, open, onClose])
}

/**
 * Compact reader top-bar translation controls: on/off (with progress), target language and display
 * mode in a popover, plus "translate the entire document".
 */
export function TranslateBar() {
  const reader = useReader()
  const { api, t, state, actions } = useApp()
  const service = reader.translate
  useTranslationTick(service)
  const languages = useLanguages(api)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef(null)
  const closeMenu = React.useCallback(() => setMenuOpen(false), [])
  useDismiss(menuRef, menuOpen, closeMenu)

  if (service === null || service === undefined) return null

  const settings = state?.settings ?? reader.settings ?? DEFAULT_SETTINGS
  const aiSettings = settings?.ai ?? FALLBACK_AI
  const stats = service.stats ?? EMPTY_STATS
  const currentLang = service.lang ?? aiSettings.targetLang ?? 'zh-CN'
  const currentMode = service.mode ?? aiSettings.translate?.mode ?? 'bilingual'
  const enabled = service.enabled === true

  const toggle = () => {
    try {
      service.toggle?.()
    } catch (error) {
      actions?.toast?.(String(error?.message ?? error), 'error')
    }
  }

  // The app debounces settings.set calls, so every patch carries the complete translation group:
  // two quick control changes can never drop each other.
  const patchTranslation = (overrides = {}) => {
    const nextTranslate = { ...(aiSettings.translate ?? FALLBACK_AI.translate), ...(overrides.translate ?? {}) }
    actions?.patchSettings?.({ ai: { targetLang: overrides.targetLang ?? currentLang, translate: nextTranslate } })
  }

  const pickLanguage = (id) => {
    setMenuOpen(false)
    if (id === currentLang) return
    try {
      service.setLang?.(id)
    } catch {
      /* stale service */
    }
    patchTranslation({ targetLang: id })
  }

  const pickMode = (next) => {
    try {
      service.setMode?.(next)
    } catch {
      /* stale service */
    }
    patchTranslation({ translate: { mode: next } })
  }

  const translateAll = () => {
    setMenuOpen(false)
    try {
      if (service.enabled !== true) service.setEnabled?.(true)
      service.requestAll?.()
    } catch (error) {
      actions?.toast?.(String(error?.message ?? error), 'error')
    }
  }

  const retryFailed = () => {
    setMenuOpen(false)
    const ids = []
    try {
      for (const [id, entry] of service.entries ?? []) {
        if (entry?.status === 'error') ids.push(id)
      }
      for (const id of ids) service.retry?.(id)
    } catch {
      /* stale service */
    }
  }

  const progressLabel = stats.total > 0 ? `${stats.done}/${stats.total}` : t('reader.translate', 'Translate')
  const toggleTitle = enabled ? t('reader.translation.off', 'Bilingual translation off') : t('reader.translation.on', 'Bilingual translation on')
  const cacheSaved = stats.cachedChars + stats.usageChars > 0 ? Math.round((stats.cachedChars / (stats.cachedChars + stats.usageChars)) * 100) : 0
  const usageTitle = `${progressLabel} · ${t('reader.translation.cachedChars', '{count} chars from cache', { count: stats.cachedChars })} · ${t('reader.translation.sent', '{count} chars sent', { count: stats.usageChars })}${cacheSaved > 0 ? ` · ${cacheSaved}% ${t('reader.translation.saved', 'saved')}` : ''}`
  const busy = stats.loading > 0 || stats.queued > 0

  return h(
    'div',
    { className: 'dr-trbar', style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
    h(
      Button,
      {
        size: 'sm',
        variant: enabled ? 'primary' : 'default',
        icon: busy ? h(Spinner, { size: 13 }) : h(IconTranslate, { size: 15 }),
        onClick: toggle,
        title: `${toggleTitle}\n${usageTitle}`,
        'aria-pressed': enabled,
        className: 'dr-trbar-toggle',
      },
      progressLabel,
    ),
    enabled && stats.errors > 0
      ? h(
          'button',
          {
            type: 'button',
            className: 'dr-chip',
            title: `${t('reader.translation.retry', 'Retry')} · ${stats.errors}`,
            onClick: retryFailed,
            style: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)', padding: '2px 7px' },
          },
          h(IconRefresh, { size: 12 }),
          h('span', null, String(stats.errors)),
        )
      : null,
    enabled && settings?.ai?.translate?.auto === false && stats.total > 0 && stats.done === 0 && stats.queued === 0 && stats.loading === 0
      ? h(
          Button,
          { size: 'sm', variant: 'ghost', icon: h(IconZap, { size: 14 }), onClick: translateAll, title: t('reader.translation.all', 'Translate the entire document') },
          t('reader.translation.allShort', 'All'),
        )
      : null,
    h(
      'div',
      { style: { position: 'relative' }, ref: menuRef },
      h(
        Button,
        {
          size: 'sm',
          variant: 'ghost',
          icon: h(IconGlobe, { size: 14 }),
          iconRight: h(IconChevronDown, { size: 12 }),
          onClick: () => setMenuOpen((open) => !open),
          title: t('settings.model.targetLang', 'Translation target language'),
          'aria-expanded': menuOpen,
        },
        languageLabel(languages, currentLang),
      ),
      h(
        Popover,
        { open: menuOpen, align: 'end', className: 'dr-trbar-menu' },
        h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', padding: '4px 9px 5px' } }, t('settings.model.targetLang', 'Target language')),
        h(
          'div',
          { style: { maxHeight: 236, overflowY: 'auto' } },
          languages.map((language) =>
            h(
              MenuItem,
              { key: language.id, onClick: () => pickLanguage(language.id) },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 7 } }, h('span', { style: { width: 14, display: 'inline-flex', justifyContent: 'center' } }, language.id === currentLang ? h(IconCheck, { size: 13 }) : null), language.name),
            ),
          ),
        ),
        h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '5px 3px' } }),
        h('div', { style: { padding: '2px 7px 6px' } }, h(SegmentedControl, { size: 'sm', value: currentMode, onChange: pickMode, options: [{ value: 'bilingual', label: t('reader.translation.mode.bilingual', 'Bilingual') }, { value: 'replace', label: t('reader.translation.mode.replace', 'Translated') }] })),
        h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '3px 3px 5px' } }),
        h(MenuItem, { icon: h(IconZap, { size: 14 }), onClick: translateAll, disabled: stats.total === 0 }, t('reader.translation.all', 'Translate the entire document')),
        stats.errors > 0 ? h(MenuItem, { icon: h(IconRefresh, { size: 14 }), onClick: retryFailed }, t('reader.translation.retryFailed', 'Retry failed passages ({count})', { count: stats.errors })) : null,
      ),
    ),
    enabled && stats.total > 0 && stats.done === stats.total && stats.errors === 0
      ? h(Badge, { tone: 'brand', className: 'dr-trbar-done' }, h(IconCheck, { size: 11 }))
      : null,
  )
}

/** The translation model route currently configured in settings (label only, keys stay host-side). */
function translateRouteLabel(t, settings, models) {
  const ref = settings?.ai?.active?.translate ?? FALLBACK_AI.active.translate
  const providerId = ref?.providerId ?? 'dsh'
  if (Object.hasOwn(TRANSLATION_ENGINES, providerId)) return TRANSLATION_ENGINES[providerId]
  if (providerId === DEEPSEEK_ACCOUNT_ROUTE) {
    const provider = t('settings.model.deepseekAccount', 'DeepSeek Account')
    return ref.model ? `${provider} · ${ref.model}` : provider
  }
  if (providerId === 'dsh' || providerId === '' || providerId === undefined) {
    const model = ref?.model || models?.dsh?.model || ''
    const provider = models?.dsh?.providerName || models?.dsh?.provider || t('settings.model.default', 'DSH current model')
    return model ? `${provider} · ${model}` : provider
  }
  const provider = (models?.custom ?? []).find((item) => item.id === providerId) ?? (settings?.ai?.providers ?? []).find((item) => item.id === providerId)
  if (provider === undefined) return providerId
  const model = ref?.model || provider.models?.[0] || ''
  return `${provider.name ?? providerId}${model !== '' ? ` · ${model}` : ''}`
}

/**
 * Settings-dialog section: target language, display mode, auto-translate, batch size/concurrency and
 * the active translation model route. Every change is persisted through `actions.patchSettings`.
 */
export function TranslationSettings() {
  const { api, t, state, actions } = useApp()
  const settings = state?.settings ?? DEFAULT_SETTINGS
  const aiSettings = settings?.ai ?? FALLBACK_AI
  const translateSettings = aiSettings.translate ?? FALLBACK_AI.translate
  const languages = useLanguages(api)
  const [models, setModels] = React.useState(null)

  React.useEffect(() => {
    if (api === null || api === undefined || typeof api.rpc !== 'function') return undefined
    let cancelled = false
    api
      .rpc('ai.models')
      .then((info) => {
        if (!cancelled) setModels(info ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  const currentLang = aiSettings.targetLang ?? 'zh-CN'
  const currentMode = translateSettings.mode === 'replace' ? 'replace' : 'bilingual'
  const batchSize = clamp(translateSettings.batchSize ?? 6, 1, 12)
  const concurrency = clamp(translateSettings.concurrency ?? 2, 1, 4)
  const auto = translateSettings.auto !== false
  const routeLabel = translateRouteLabel(t, settings, models)

  // The app debounces settings.set calls, so every patch carries the complete translation group:
  // two quick control changes can never drop each other.
  const patchTranslation = (overrides = {}) => {
    const nextTranslate = { mode: currentMode, auto, batchSize, concurrency, ...(overrides.translate ?? {}) }
    actions?.patchSettings?.({ ai: { targetLang: overrides.targetLang ?? currentLang, translate: nextTranslate } })
  }

  return h(
    'div',
    { className: 'dr-translation-settings' },
    h('div', { className: 'dr-settings-h', style: { fontSize: 14, margin: '4px 0 4px' } }, t('reader.translate', 'Translate')),
    h(Row, {
      label: t('settings.model.targetLang', 'Translation target language'),
      description: t('reader.translation.langDesc', 'Translate this document into the selected language.'),
      children: h(Select, { value: currentLang, onChange: (value) => patchTranslation({ targetLang: value }), options: languages.map((language) => ({ value: language.id, label: language.name })) }),
    }),
    h(Row, {
      label: t('settings.model.mode', 'Translation display'),
      children: h(Select, {
        value: currentMode,
        onChange: (value) => patchTranslation({ translate: { mode: value } }),
        options: [
          { value: 'bilingual', label: t('settings.model.mode.bilingual', 'Bilingual (original + translation)') },
          { value: 'replace', label: t('settings.model.mode.replace', 'Replace with translation') },
        ],
      }),
    }),
    h(Switch, {
      checked: auto,
      onChange: (value) => patchTranslation({ translate: { auto: value } }),
      label: t('reader.translation.auto', 'Translate the full document automatically'),
      description: t('reader.translation.autoDesc', 'When translation is on, visible passages go first and the rest are translated in the background.'),
    }),
    h(Divider),
    h(Row, {
      label: t('settings.model.batch', 'Translation batch size'),
      description: t('reader.translation.batchDesc', 'Passages sent to the model in one request.'),
      children: h('div', { style: { width: 200 } }, h(Slider, { min: 1, max: 12, step: 1, value: batchSize, display: String(batchSize), onChange: (value) => patchTranslation({ translate: { batchSize: clamp(value, 1, 12) } }) })),
    }),
    h(Row, {
      label: t('reader.translation.concurrency', 'Concurrent requests'),
      description: t('reader.translation.concurrencyDesc', 'How many translation requests may run at the same time.'),
      children: h('div', { style: { width: 200 } }, h(Slider, { min: 1, max: 4, step: 1, value: concurrency, display: String(concurrency), onChange: (value) => patchTranslation({ translate: { concurrency: clamp(value, 1, 4) } }) })),
    }),
    h(Row, {
      label: t('settings.model.activeTranslate', 'Translation model'),
      description: t('reader.translation.modelDesc', 'The model route used for translation; change it in the AI models section.'),
      children: h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', textAlign: 'right', overflowWrap: 'anywhere' } }, routeLabel),
    }),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, h(IconSpark, { size: 13 }), h('span', null, t('reader.translation.cachedHint', 'Translations are cached on disk —revisiting a passage never costs tokens twice.'))),
  )
}
