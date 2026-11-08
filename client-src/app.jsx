// The reader application root: host state loading, document import/opening, annotations and AI
// cache persistence, app chrome, toasts and modals. Mounted by the `main` panel registration.
import React from 'react'
import { AppContext, DEFAULT_SETTINGS, mergeSettings, readerStyleVars, useInterfaceDark } from './store.jsx'
import { LibraryView } from './library.jsx'
import { ReaderShell } from './reader-shell.jsx'
import { SettingsDialog } from './settings.jsx'
import { DocumentTabs } from './document-tabs.jsx'
import {SaveStatus} from './save-status.jsx'
import {ImportDialog} from './import-dialog.jsx'
import {prepareImportFiles,collectDroppedFiles,importPath,abortImport,IMPORT_LIMITS} from './import-sources.js'
import { normalizeTabs, closeTab } from '../shared/reader-tabs.js'
import {createPendingSaves} from '../shared/pending-saves.js'
import { ToastHost, Button } from './ui.jsx'
import { IconLibrary, IconSettings, IconReading, IconSpark, IconArrowLeft, IconBook } from './icons.jsx'
import { extractEpub } from './epub.js'
import { importPdf, PDF_ENGINE_VERSION } from './pdf-engine.js'
import { applyLayoutPlan, buildLayoutWindows, LAYOUT_PLAN_VERSION } from './layout-plan.js'
import { applyVisionLayout, VISION_LAYOUT_VERSION } from './vision-layout.js'
import { renderVisionPages } from './vision-render.js'
import { runVisualLayout, hasCurrentVisualLayout, hasFailedVisualLayout } from './layout-pipeline.js'
import { applyFormulaLatex } from './layout.js'
import { exportAllNotes, exportNotes, exportOriginal, exportSummary, exportText } from './export.js'
import { debounce, downloadFile, uid } from './util.js'

const h = React.createElement
const CONNECTED=Object.freeze({status:'connected',revision:0})

/** PDF.js asset URLs for the bundled legacy ESM build served by the host half. */
function pdfAssets(api) {
  return {
    moduleUrl: api.assetUrl('pdf/pdf.mjs'),
    workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
    cMapUrl: api.assetUrl('pdf/cmaps/'),
    standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
  }
}

const MATH_HINT_RE = /[=≈≤≥±×÷^_∑∫√∞]|[\u0370-\u03ff]/u

/** Formula fragments worth one AI reconstruction call (real formula blocks first, then math text). */
function formulaCandidates(content) {
  const pages = Array.isArray(content?.pages) ? content.pages : []
  const formulas = []
  const hinted = []
  for (const page of pages) {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      const text = String(block.text ?? '').trim()
      if (text === '' || text.length < 2 || text.length > 700) continue
      if (block.kind === 'formula') {
        const promptText = block.text.includes('\n')
          ? `Reconstruct every display equation from these fragments; they are in reading order and a fraction may be split across lines. Use \\frac where implied.\n${text}`
          : text
        formulas.push({ id: block.id, text: promptText })
      } else if (text.length <= 320 && (block.kind === 'paragraph' || block.kind === 'list') && MATH_HINT_RE.test(text)) hinted.push({ id: block.id, text })
    }
  }
  return [...formulas, ...hinted].slice(0, 16)
}

/** This belongs to the plugin slot, whose view can unmount during DSH navigation. */
export function createReaderWorkspace() {
  return {
    activeDocId: null, openDocIds: null, readers: new Map(), progress: new Map(), library: {}, auxWrites: new Map(),
    extractions: new Map(), visionRuns: new Map(), layoutProgress: new Map(),
  }
}

/** Root component of the main-panel reader. */
export function ReaderApp({ api, t, diag, ctx, workspace: sharedWorkspace }) {
  const [workspace] = React.useState(() => sharedWorkspace ?? createReaderWorkspace())
  const [state, setState] = React.useState(() => ({
    ready: false,
    initError: null,
    docs: [],
    folders: [],
    doc: null,
    content: null,
    annotations: [],
    aux: {},
    settings: DEFAULT_SETTINGS,
    view: workspace.activeDocId ? 'reader' : 'library',
    openingDocId: workspace.activeDocId,
    openDocIds: [],
    settingsOpen: workspace.settingsOpen ?? false,
    settingsSection: workspace.settingsSection ?? 'appearance',
    zoteroOpen: false,
    docLoading: Boolean(workspace.activeDocId),
    importing: null,
    importOpen:false,
    importTarget:null,
    importResult:null,
    translateStats: null,
    toasts: [],
    localeRev: 0,
    layoutProgress: null,
  }))
  const stateRef = React.useRef(state)
  stateRef.current = state
  const applyReaderPatch = React.useCallback((id, patch) => {
    setState(current => current.view === 'reader' && current.doc?.id === id ? { ...current, ...patch } : current)
  }, [])
  React.useLayoutEffect(() => {
    workspace.applyReaderPatch = applyReaderPatch
    return () => { if (workspace.applyReaderPatch === applyReaderPatch) delete workspace.applyReaderPatch }
  }, [workspace, applyReaderPatch])
  React.useLayoutEffect(() => {
    workspace.settingsOpen = state.settingsOpen
    workspace.settingsSection = state.settingsSection
  }, [workspace, state.settingsOpen, state.settingsSection])
  const connection=React.useSyncExternalStore(api.subscribeConnection??(()=>()=>{}),api.getConnection??(()=>CONNECTED),()=>CONNECTED)
  const annotationSaves=React.useMemo(()=>{
    if(!api.annotationSaves){
      let storage;try{storage=window.localStorage}catch{}
      api.annotationSaves=createPendingSaves({save:(id,annotations)=>api.rpc('annotations.save',{id,annotations}),storage,onError:error=>diag?.recordError('annotations.save',error)})
    }
    return api.annotationSaves
  },[api,diag])
  React.useSyncExternalStore(annotationSaves.subscribe,annotationSaves.getSnapshot,()=>0)
  React.useEffect(()=>{if(connection.status==='connected')annotationSaves.flush()},[connection.status,connection.revision,annotationSaves])
  const annotationHistory = React.useRef({ past: [], future: [] })
  const annotationHistories=React.useRef(new Map())
  const layoutRuns = React.useRef(new Set())
  const visionRuns = workspace.visionRuns
  const openSequence = React.useRef(0)
  const readerSessions = workspace.readers
  const progressByDoc = workspace.progress
  const flushPending = React.useRef(() => undefined)
  const layoutProgressByDoc = workspace.layoutProgress
  const sessionFor = id => {
    if (!readerSessions.has(id)) readerSessions.set(id, { ui: {}, translate: null })
    return readerSessions.get(id)
  }
  React.useEffect(() => () => {
    openSequence.current++
    flushPending.current()
    if (!sharedWorkspace) for (const session of readerSessions.values()) session.translate?.dispose()
  }, [readerSessions, sharedWorkspace])
  const autoTranslate = state.settings.ai.translate?.auto !== false
  const translationBatchSize = state.settings.ai.translate?.batchSize
  const translationConcurrency = state.settings.ai.translate?.concurrency
  React.useEffect(() => {
    for (const {translate} of readerSessions.values()) {
      translate?.setAutomatic(autoTranslate)
      translate?.setScheduling?.({batchSize:translationBatchSize,concurrency:translationConcurrency})
    }
  }, [autoTranslate, translationBatchSize, translationConcurrency, readerSessions])

  // ----- toasts ---------------------------------------------------------------------
  const dismissToast = React.useCallback((id) => {
    setState((current) => ({ ...current, toasts: current.toasts.filter((toast) => toast.id !== id) }))
  }, [])
  const toast = React.useCallback(
    (message, kind = 'info') => {
      if (message === undefined || message === null || message === '') return
      if(kind==='error'&&/无法连接阅读器后端|Failed to fetch/i.test(String(message)))return
      const id = uid('toast')
      setState((current) => ({ ...current, toasts: [...current.toasts.slice(-3), { id, message: String(message), kind }] }))
      setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 3600)
    },
    [dismissToast],
  )

  // ----- settings -------------------------------------------------------------------
  const settingsSaveTimer = React.useRef(null)
  const whenSettingsSaved = React.useCallback(() => workspace.settingsWrite, [workspace])
  const settingsPending = React.useRef({})
  const settingsRevision=React.useRef(0)
  const patchSettings = React.useCallback(
    (patch,options={}) => {
      setState((current) => ({ ...current, settings: mergeSettings(current.settings, patch) }))
      settingsPending.current = mergeSettings(settingsPending.current, patch)
      if (settingsSaveTimer.current !== null) clearTimeout(settingsSaveTimer.current)
      const revision=++settingsRevision.current
      const save=() => {
        settingsSaveTimer.current = null
        const pending = settingsPending.current
        settingsPending.current = {}
        const write = Promise.resolve(workspace.settingsWrite).then(() => api.rpc('settings.set', { patch: pending }))
        workspace.settingsWrite = write.catch(() => undefined)
        write
          .then(({ settings }) => {if(revision===settingsRevision.current)setState((current) => ({ ...current, settings: mergeSettings(settings, settingsPending.current) }))})
          .catch((error) => toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error'))
      }
      if(options.immediate)save();else settingsSaveTimer.current=setTimeout(save,220)
    },
    [api, t, toast, workspace],
  )
  const saveOpenTabs = React.useCallback(ids => {
    workspace.openDocIds = ids
    patchSettings({ ui: { openDocIds: ids } }, { immediate: true })
  }, [patchSettings, workspace])

  // ----- library --------------------------------------------------------------------
  const refreshDocs = React.useCallback(async () => {
    try {
      const { docs, folders } = await api.rpc('library.list')
      setState((current) => ({ ...current, docs: docs ?? [], folders: folders ?? current.folders }))
      return docs ?? []
    } catch (error) {
      toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
      return []
    }
  }, [api, t, toast])
  const connectionRevision=React.useRef(0)
  React.useEffect(()=>{
    if(connection.revision>connectionRevision.current){
      connectionRevision.current=connection.revision
      refreshDocs().then(docs=>annotationSaves.recover(docs.map(doc=>doc.id)))
      if(stateRef.current.initError)api.rpc('settings.get').then(({settings})=>setState(current=>({...current,initError:null,settings:mergeSettings(settings,settingsPending.current)}))).catch(()=>undefined)
    }
  },[connection.revision,refreshDocs,annotationSaves,api])

  // ----- folders --------------------------------------------------------------------
  const loadFolders = React.useCallback(async () => {
    try {
      const { folders } = await api.rpc('folders.list')
      setState((current) => ({ ...current, folders: folders ?? [] }))
      return folders ?? []
    } catch {
      return []
    }
  }, [api])

  const foldersCreate = React.useCallback(
    async (name) => {
      try {
        const { folder, folders } = await api.rpc('folders.create', { name })
        setState((current) => ({ ...current, folders: folders ?? current.folders }))
        toast(t('library.folderCreated', 'Folder “{name}” created', { name: folder?.name ?? name }), 'success')
        return folder
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
        return null
      }
    },
    [api, t, toast],
  )

  const foldersRename = React.useCallback(
    async (id, name) => {
      try {
        const { folders } = await api.rpc('folders.rename', { id, name })
        setState((current) => ({ ...current, folders: folders ?? current.folders }))
        return true
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
        return false
      }
    },
    [api, t, toast],
  )

  const foldersRemove = React.useCallback(
    async (id) => {
      try {
        const { folders, docs: nextDocs } = await api.rpc('folders.remove', { id })
        setState((current) => ({
          ...current,
          folders: folders ?? current.folders,
          docs: Array.isArray(nextDocs) ? nextDocs : current.docs.map((doc) => (doc.folderId === id ? { ...doc, folderId: null } : doc)),
        }))
        toast(t('library.folderDeleted', 'Folder deleted; its documents returned to the library root'), 'success')
        return true
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
        return false
      }
    },
    [api, t, toast],
  )

  const moveDoc = React.useCallback(
    async (docId, folderId) => {
      try {
        const { doc, folders } = await api.rpc('folders.moveDoc', { docId, folderId: folderId ?? null })
        setState((current) => ({
          ...current,
          folders: folders ?? current.folders,
          docs: current.docs.map((entry) => (entry.id === docId ? { ...entry, ...(doc ?? {}) } : entry)),
          doc: current.doc?.id === docId ? { ...current.doc, ...(doc ?? {}) } : current.doc,
        }))
        toast(t('library.folderMoved', 'Document moved'), 'success')
        return true
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
        return false
      }
    },
    [api, t, toast],
  )

  /** Replace the in-memory parsed content (used by AI structure refinement / re-extraction). */
  const replaceContent = React.useCallback((content) => {
    setState((current) => ({ ...current, content }))
  }, [])

  const patchDocLocal = React.useCallback((doc) => {
    if (doc === null || doc === undefined) return
    setState((current) => ({
      ...current,
      doc: current.doc?.id === doc.id ? { ...current.doc, ...doc } : current.doc,
      docs: current.docs.map((entry) => (entry.id === doc.id ? { ...entry, ...doc } : entry)),
    }))
  }, [])

  const saveDocPatch = React.useCallback(
    async (patch) => {
      const doc = stateRef.current.doc
      if (doc === null) return null
      try {
        const { doc: saved } = await api.rpc('library.update', { id: doc.id, patch })
        patchDocLocal(saved)
        return saved
      } catch {
        return null
      }
    },
    [api, patchDocLocal],
  )

  const persistProgress = React.useMemo(
    () =>
      debounce((id, progress) => {
        api.rpc('library.update', { id, patch: { progress } }).catch(() => undefined)
      }, 600),
    [api, patchDocLocal],
  )
  const saveProgress = React.useCallback((id, percent, locator, label) => {
    if (!id) return
    const progress={percent, locator, label}
    progressByDoc.set(id,progress)
    patchDocLocal({id,progress})
    persistProgress(id,progress)
  }, [persistProgress,patchDocLocal,progressByDoc])

  /**
   * Automatic AI formula pass: one model call reconstructs all display equations as LaTeX, which
   * the reader renders as native MathML. A single cached call keeps token cost small and fast.
   */
  const enhanceFormulas = React.useCallback(
    async (doc, content, options = {}) => {
      if (doc === null || doc === undefined || doc.format !== 'pdf' || content === null || typeof content !== 'object') return
      if (content.aiMathAt && options.force !== true) return
      if (Number(content.engineVersion ?? 0) < PDF_ENGINE_VERSION) return
      const items = formulaCandidates(content)
      if (items.length === 0) return
      const runKey = `${doc.id}:${content.engineVersion}:${items.map((item) => item.id).join(',')}`
      if (layoutRuns.current.has(runKey)) return
      layoutRuns.current.add(runKey)
      diag?.report?.('ai-formulas-start', { docId: doc.id, items: items.length })
      try {
        let result = null
        await api.stream('ai.formulas', { docId: doc.id, title: doc.title, items }, { onDone: (value) => { result = value } })
        if (result === null) throw new Error('empty AI formula result')
        const formulas = Array.isArray(result.formulas) ? [...result.formulas] : []
        const missing = items.filter((item) => !formulas.some((formula) => formula.id === item.id && typeof formula.latex === 'string' && formula.latex.trim() !== ''))
        if (missing.length > 0) {
          // A single empty model answer used to leave some equations as images while the rest were
          // MathML. Retry only the missing fragments with a distinctly worded prompt.
          let retry = null
          const retryItems = missing.map((item) => ({
            id: item.id,
            text: `Second pass. Reconstruct the complete display equation as LaTeX. Return strict JSON {"latex":"..."}.\n${item.text}`,
          }))
          await api
            .stream('ai.formulas', { docId: doc.id, title: doc.title, items: retryItems }, { onDone: (value) => { retry = value } })
            .catch(() => undefined)
          if (retry !== null && Array.isArray(retry.formulas)) formulas.push(...retry.formulas)
        }
        const applied = applyFormulaLatex(content, { ...result, formulas })
        if (applied.formulaCount === 0) {
          const marked = { ...content, aiMathAt: Date.now(), aiMathModel: result.model ?? null, aiMathCount: 0 }
          await api.rpc('content.save', { id: doc.id, content: marked }).catch(() => undefined)
          setState((current) => (current.doc?.id === doc.id ? { ...current, content: marked } : current))
          diag?.report?.('ai-formulas-applied', { docId: doc.id, formulas: 0, cached: result.cached === true })
          return
        }
        const nextContent = { ...applied.content, aiMathCount: applied.formulaCount }
        const saved = await api.rpc('content.save', { id: doc.id, content: nextContent })
        setState((current) => (current.doc?.id === doc.id ? { ...current, content: nextContent } : current))
        if (saved?.doc) patchDocLocal(saved.doc)
        diag?.report?.('ai-formulas-applied', { docId: doc.id, formulas: applied.formulaCount, model: result.model ?? null, cached: result.cached === true, retried: missing.length })
        toast(t('reader.aiMathDone', 'AI reconstructed {count} formulas', { count: applied.formulaCount }), 'success')
      } catch (error) {
        diag?.report?.('ai-formulas-failed', { docId: doc.id, message: String(error?.message ?? error).slice(0, 240) })
      } finally {
        layoutRuns.current.delete(runKey)
      }
    },
    [api, diag, patchDocLocal, t, toast],
  )

  const planLayout = React.useCallback(
    async (doc, content, options = {}) => {
      if (doc === null || doc === undefined || doc.format !== 'pdf' || content === null || typeof content !== 'object') return
      const planned = content.layoutPlanAt !== undefined && content.layoutPlanVersion === LAYOUT_PLAN_VERSION
      if (planned && options.force !== true) return
      if (Number(content.engineVersion ?? 0) < PDF_ENGINE_VERSION) return
      const windows = buildLayoutWindows(content)
      if (windows.length === 0) return
      const runKey = `layout-plan:${doc.id}:${content.engineVersion}`
      if (layoutRuns.current.has(runKey)) return
      layoutRuns.current.add(runKey)
      diag?.report?.('ai-layout-plan-start', { docId: doc.id, windows: windows.length, force: options.force === true })
      try {
        let result = null
        await api.stream('ai.layoutPlan', { docId: doc.id, title: doc.title, windows, force: options.force === true }, { onDone: (value) => { result = value } })
        if (result === null) throw new Error('empty AI layout plan')
        const applied = applyLayoutPlan(content, result)
        const modelGroups = (Array.isArray(result.windows) ? result.windows : []).reduce((sum, window) => sum + (Array.isArray(window?.groups) ? window.groups.length : 0), 0)
        const nextContent = {
          ...applied.content,
          layoutPlanAt: Date.now(),
          layoutPlanVersion: LAYOUT_PLAN_VERSION,
          layoutPlanModel: result.model ?? null,
          layoutPlanGroups: applied.merged,
          layoutPlanModelGroups: modelGroups,
        }
        const saved = await api.rpc('content.save', { id: doc.id, content: nextContent })
        setState((current) => (current.doc?.id === doc.id ? { ...current, content: nextContent } : current))
        if (saved?.doc) patchDocLocal(saved.doc)
        diag?.report?.('ai-layout-plan-applied', { docId: doc.id, merged: applied.merged, captions: applied.captions, windows: applied.windows, modelGroups, cached: Number(result.cachedWindows) || 0 })
        if (applied.merged > 0) toast(t('reader.aiLayoutPlanDone', 'AI grouped {count} paragraphs', { count: applied.merged }), 'success')
        else toast(t('reader.aiLayoutPlanNoChange', 'AI structure pass finished; no cross-page paragraph needed merging.'), 'info')
      } catch (error) {
        diag?.report?.('ai-layout-plan-failed', { docId: doc.id, message: String(error?.message ?? error).slice(0, 240) })
      } finally {
        layoutRuns.current.delete(runKey)
      }
    },
    [api, diag, patchDocLocal, t, toast],
  )

  const visionLayout = React.useCallback(
    async (doc, content, options = {}) => {
      if (doc === null || doc === undefined || doc.format !== 'pdf' || content === null || typeof content !== 'object') return
      const already = hasCurrentVisualLayout(content)
      if (workspace.applyReaderPatch !== applyReaderPatch || workspace.activeDocId !== doc.id || stateRef.current.doc?.id !== doc.id) return
      if (already && options.force !== true) return content
      if (Number(content.engineVersion ?? 0) < PDF_ENGINE_VERSION) return
      if (visionRuns.has(doc.id)) return
      const controller = new AbortController()
      visionRuns.set(doc.id, controller)
      diag?.report?.('ai-vision-start', { docId: doc.id, force: options.force === true })
      try {
        const result = await runVisualLayout({ api, doc, content, force: options.force === true, retryFailed: options.retryFailed === true, signal: controller.signal,
          onProgress: progress => {
            const next = { ...progress, docId: doc.id }
            layoutProgressByDoc.set(doc.id, next)
            workspace.applyReaderPatch?.(doc.id, { layoutProgress: next })
          },
          onContent: content => workspace.applyReaderPatch?.(doc.id, { content }),
        })
        diag?.report?.('ai-vision-applied', { docId: doc.id, complete: result.complete, errors: result.errors, regions: result.regions, cachedPages: result.cachedPages, model: result.model })
        toast(result.complete ? result.content.parser?.engine==='mineru'?t('parser.complete','Local structure parsing complete'):t('reader.visualComplete', 'AI visual layout complete') : t('reader.visualPartial', 'Some pages failed. Completed pages are saved; retry to continue.'), result.complete ? 'success' : 'error')
        return result.content
      } catch (error) {
        const message = String(error?.message ?? error)
        diag?.report?.('ai-vision-failed', { docId: doc.id, code: error?.code, message: message.slice(0, 240) })
        if (!controller.signal.aborted) toast(t('parser.error.' + error?.code, message), 'error')
      } finally {
        visionRuns.delete(doc.id)
        layoutProgressByDoc.delete(doc.id)
        workspace.applyReaderPatch?.(doc.id, { layoutProgress: null })
      }
    },
    [api, applyReaderPatch, diag, layoutProgressByDoc, t, toast, visionRuns, workspace],
  )

  const extractContent = React.useCallback(
    async (doc, reason = 'open') => {
      if (!doc) return null
      if (reason === 'open') workspace.applyReaderPatch?.(doc.id, { docLoading: true })
      let job = workspace.extractions.get(doc.id)
      if (!job) {
        job = (async () => {
          const startedAt = Date.now()
          diag?.report?.('extract-start', { docId: doc.id, reason, format: doc.format })
          const response = await fetch(api.fileUrl(doc.id, 'original'))
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const arrayBuffer = await response.arrayBuffer()
          diag?.report?.('extract-fetched', { docId: doc.id, bytes: arrayBuffer.byteLength, ms: Date.now() - startedAt })
          const onProgress = (progress) => {
            if (!progress?.total) return
            diag?.report?.('extract-progress', { docId: doc.id, done: progress.done, total: progress.total, ms: Date.now() - startedAt })
          }
          const parsed =
            doc.format === 'epub'
              ? await extractEpub(arrayBuffer, { onProgress })
              : await importPdf(arrayBuffer, { assets: pdfAssets(api), onProgress })
          const content = doc.format === 'epub' ? { kind: 'epub', version: 1, meta: parsed.meta, toc: parsed.toc, blocks: parsed.blocks } : parsed.content
          const blockCount = Array.isArray(content.blocks) ? content.blocks.length : (content.pages ?? []).reduce((sum, page) => sum + (page.blocks?.length ?? 0), 0)
          diag?.report?.('extract-parsed', { docId: doc.id, ms: Date.now() - startedAt, blocks: blockCount, engineVersion: content.engineVersion })
          const { doc: saved = doc } = await api.rpc('content.save', { id: doc.id, content })
          diag?.report?.('extract-done', { docId: doc.id, ms: Date.now() - startedAt, blocks: blockCount, engineVersion: content.engineVersion })
          return { content, saved }
        })()
        workspace.extractions.set(doc.id, job)
      }
      try {
        const { content, saved } = await job
        workspace.applyReaderPatch?.(doc.id, { content, docLoading: false })
        if (workspace.applyReaderPatch !== applyReaderPatch) return content
        patchDocLocal(saved)
        if (doc.format === 'pdf') {
          window.setTimeout(() => { visionLayout(doc, content).catch(() => undefined) }, 1200)
        }
        return content
      } catch (error) {
        workspace.applyReaderPatch?.(doc.id, { docLoading: false })
        if (workspace.applyReaderPatch === applyReaderPatch && workspace.activeDocId === doc.id) {
          diag?.report?.('extract-failed', { docId: doc.id, message: String(error?.message ?? error).slice(0, 300) })
          diag?.recordError('extract', error)
          toast(t('reader.extractFailed', 'Could not parse this document: {message}', { message: error.message }), 'error')
        }
        return null
      } finally {
        if (workspace.extractions.get(doc.id) === job) workspace.extractions.delete(doc.id)
      }
    },
    [api, applyReaderPatch, diag, patchDocLocal, visionLayout, t, toast, workspace],
  )

  const openDoc = React.useCallback(
    async (id, options={}) => {
      if (stateRef.current.doc?.id===id && stateRef.current.view==='reader') return
      if (!options.resume && stateRef.current.openingDocId === id) return
      flushPending.current()
      const sequence = ++openSequence.current
      const ids=normalizeTabs([...(options.tabs??stateRef.current.openDocIds),id])
      if(!ids.includes(id)){toast(t('tabs.limit','Close a document before opening another tab.'),'info');return}
      workspace.activeDocId = id
      setState((current) => ({
        ...current, openDocIds: ids, view: 'reader', openingDocId: id, docLoading: true,
        doc: null, content: null, aux: {}, annotations: [], translateStats: null,
        layoutProgress: layoutProgressByDoc.get(id) ?? null,
      }))
      if (!options.resume) saveOpenTabs(ids)
      try {
        const [{ doc, content }, annotationsResult, auxResult] = await Promise.all([
          api.rpc('library.get', { id }),
          annotationSaves.flush(id).then(()=>api.rpc('annotations.list', { id })).catch(() => ({ annotations: [] })),
          Promise.resolve(workspace.auxWrites.get(id)).then(() => api.rpc('aux.get', { id })).catch(() => ({ aux: {} })),
        ])
        if (sequence !== openSequence.current) return
        if (doc === null || doc === undefined) throw new Error('document not found')
        if (progressByDoc.has(id)) doc.progress = progressByDoc.get(id)
        setState((current) => ({
          ...current,
          doc,
          content,
          annotations: annotationSaves.peek(id) ?? annotationsResult?.annotations ?? [],
          aux: auxResult?.aux ?? {},
          docLoading: false,
          openingDocId: null,
          view: 'reader',
          layoutProgress: layoutProgressByDoc.get(id) ?? null,
        }))
        // Returning to a previously opened view only reloads its saved document.
        if (options.resume && content !== null) return
        patchSettings({ ui: { lastDocId: id } })
        patchDocLocal({ id, lastOpenedAt: Date.now() })
        api.rpc('library.update', { id, patch: { touch: true } }).catch(() => undefined)
        if (content === null) {
          await extractContent(doc, 'open')
        } else if (doc.format === 'pdf' && Number(content.engineVersion ?? 0) < PDF_ENGINE_VERSION) {
          // Background re-extraction after a layout-heuristic upgrade; no model tokens involved.
          extractContent(doc, 'refresh').catch(() => undefined)
        } else if (doc.format === 'pdf') {
          if (!hasCurrentVisualLayout(content) && !hasFailedVisualLayout(content)) {
            // Render image pages after the first paint instead of blocking document open.
            window.setTimeout(() => { visionLayout(doc, content).catch(() => undefined) }, 900)
          }
        }
      } catch (error) {
        if (sequence !== openSequence.current) return
        workspace.activeDocId = null
        setState((current) => ({ ...current, view: 'library', openingDocId: null, docLoading: false }))
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
      }
    },
    [api, annotationSaves, extractContent, layoutProgressByDoc, patchDocLocal, patchSettings, progressByDoc, saveOpenTabs, visionLayout, t, toast, workspace],
  )

  const closeDoc = React.useCallback(() => {
    flushPending.current()
    openSequence.current++
    workspace.activeDocId = null
    setState((current) => ({ ...current, view: 'library', openingDocId: null, docLoading: false, translateStats: null }))
    refreshDocs()
  }, [refreshDocs, workspace])

  const closeDocumentTab = React.useCallback(id => {
    flushPending.current()
    const current = stateRef.current
    const { tabs, nextId } = closeTab(current.openDocIds, id, workspace.activeDocId)
    readerSessions.get(id)?.translate?.dispose()
    readerSessions.delete(id)
    annotationHistories.current.delete(id)
    visionRuns.get(id)?.abort()
    setState(value=>({...value,openDocIds:tabs}))
    saveOpenTabs(tabs)
    if (workspace.activeDocId === id) {
      openSequence.current++
      workspace.activeDocId = null
      setState(value => ({ ...value, doc: null, content: null, annotations: [], aux: {}, view: 'library', openingDocId: null, docLoading: false, translateStats: null }))
      if (nextId) openDoc(nextId, { tabs })
    }
  }, [openDoc, readerSessions, saveOpenTabs, visionRuns, workspace])

  const removeDoc = React.useCallback(
    async (id) => {
      try {
        await api.rpc('library.remove', { id })
        readerSessions.get(id)?.translate?.dispose()
        readerSessions.delete(id)
        progressByDoc.delete(id)
        saveOpenTabs(stateRef.current.openDocIds.filter(value => value !== id))
        const wasActive = workspace.activeDocId === id
        if (wasActive) {
          openSequence.current++
          workspace.activeDocId = null
        }
        setState((current) => ({
          ...current,
          docs: current.docs.filter((doc) => doc.id !== id),
          openDocIds:current.openDocIds.filter(value=>value!==id),
          doc: current.doc?.id === id ? null : current.doc,
          view: wasActive ? 'library' : current.view,
          openingDocId: wasActive ? null : current.openingDocId,
          docLoading: wasActive ? false : current.docLoading,
          content: current.doc?.id === id ? null : current.content,
        }))
        toast(t('toast.removed', 'Removed from library'), 'success')
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
      }
    },
    [api, progressByDoc, readerSessions, saveOpenTabs, t, toast, workspace],
  )

  const toggleFavorite = React.useCallback(
    async (id) => {
      const doc = stateRef.current.docs.find((entry) => entry.id === id)
      if (doc === undefined) return
      const favorite = doc.favorite !== true
      setState((current) => ({
        ...current,
        docs: current.docs.map((entry) => (entry.id === id ? { ...entry, favorite } : entry)),
        doc: current.doc?.id === id ? { ...current.doc, favorite } : current.doc,
      }))
      try {
        await api.rpc('library.update', { id, patch: { favorite } })
      } catch {
        /* optimistic */
      }
    },
    [api],
  )

  // ----- import ---------------------------------------------------------------------
  const importBusy=React.useRef(false)
  const importController=React.useRef(null)
  const cancelImport=React.useCallback(()=>{
    importController.current?.abort()
    setState(current=>({...current,importing:current.importing?{...current.importing,phase:'cancelling'}:null}))
  },[])
  const importFiles = React.useCallback(
    async (files, options={}) => {
      if(importBusy.current){toast(t('import.busy','An import is already running. Wait or cancel it first.'),'info');return}
      importBusy.current=true
      const controller=new AbortController(),signal=controller.signal,result={imported:[],errors:[],skipped:[],duplicates:[],cancelled:false,total:0}
      importController.current=controller
      setState(current=>({...current,importOpen:true,importTarget:options.folderId??null,importResult:null,importing:{name:'',phase:'preparing',progress:0,done:0,total:0}}))
      const fingerprints=new Set()
      try {
        const urls=Array.from(options.urls??[]).map(value=>String(value).trim()).filter(Boolean)
        if(urls.length>IMPORT_LIMITS.urls)throw new Error('单批最多拉取 20 个网址')
        const plan=await prepareImportFiles(files,{signal})
        result.errors.push(...plan.errors);result.skipped.push(...plan.skipped)
        const accepted=[...plan.files,...urls.map(url=>({name:url,url,relativePath:url}))]
        result.total=accepted.length
        if(!accepted.length&&!result.errors.length)result.errors.push({name:'',message:t('import.noFiles','No PDF or EPUB files found.')})
        for (const [index,file] of accepted.entries()) {
          abortImport(signal)
          let name=file.name,format=/\.epub$/i.test(name)?'epub':'pdf',staged=null,fingerprint=null
          const publish=(phase,progress=0)=>setState(current=>({...current,importing:{name:importPath(file),phase,progress,done:index,total:accepted.length,imported:result.imported.length,failed:result.errors.length}}))
          try {
          publish(file.url?'fetching':'parsing')
          if(file.size>IMPORT_LIMITS.fileBytes)throw new Error('单篇文献最大 100 MB')
          let arrayBuffer
          if(file.url){
            staged=await api.rpc('import.fetchUrl',{url:file.url},{signal})
            name=staged.name;format=staged.format
            arrayBuffer=await api.readUpload(staged.uploadId,signal)
          } else arrayBuffer=await file.arrayBuffer()
          abortImport(signal)
          if(arrayBuffer.byteLength>IMPORT_LIMITS.fileBytes)throw new Error('单篇文献最大 100 MB')
          if(globalThis.crypto?.subtle){
            const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',arrayBuffer)),byte=>byte.toString(16).padStart(2,'0')).join('')
            if(fingerprints.has(digest)){result.duplicates.push(importPath(file));continue}
            fingerprint=digest
          }
          publish('parsing')
          const onProgress = (progress) => {
            if (!signal.aborted&&progress?.total)publish('parsing',progress.done/Math.max(1,progress.total))
          }
          const parsed =
            format === 'epub'
              ? await extractEpub(arrayBuffer, { onProgress })
              : await importPdf(arrayBuffer, { assets: pdfAssets(api), onProgress })
          abortImport(signal);publish('uploading',0.8)
          const upload = staged??await api.upload(new Blob([arrayBuffer], { type: format === 'epub' ? 'application/epub+zip' : 'application/pdf' }), format, name)
          abortImport(signal);publish('saving',0.95)
          const content = format === 'epub' ? { kind: 'epub', version: 1, meta: parsed.meta, toc: parsed.toc, blocks: parsed.blocks } : parsed.content
          const { doc } = await api.rpc('upload.commit', {
            uploadId: upload.uploadId,
            folderId:options.folderId??null,
            meta: {
              ...parsed.meta,
              filename: name,
              title: staged?.title||((parsed.meta?.title??'').trim()!==''?parsed.meta.title:name.replace(/\.[^.]+$/,'')),
            },
            content,
            thumbDataUrl: parsed.thumbDataUrl ?? null,
          })
          if(fingerprint)fingerprints.add(fingerprint)
          result.imported.push({name:importPath(file),title:doc.title,id:doc.id})
          setState(current=>({...current,docs:[...current.docs.filter(item=>item.id!==doc.id),doc]}))
          diag?.report('import', { name, format, ok: true, docId: doc?.id })
        } catch (error) {
          if(signal.aborted||error.name==='AbortError'||error.code==='aborted'){result.cancelled=true;break}
          result.errors.push({name:importPath(file),message:String(error.message??error)})
          diag?.recordError('import', error)
        }
        }
      } catch(error) {
        if(signal.aborted||error.name==='AbortError')result.cancelled=true
        else result.errors.push({name:'',message:String(error.message??error)})
      } finally {
        importBusy.current=false;importController.current=null
        setState(current=>({...current,importing:null,importResult:result}))
        await refreshDocs()
      }
      return result
    },
    [api, diag, refreshDocs, t, toast],
  )
  const importDrop=React.useCallback((transfer,options={})=>{
    const collected=collectDroppedFiles(transfer)
    return collected.then(files=>importFiles(files,options)).catch(error=>toast(error.message,'error'))
  },[importFiles,toast])

  // ----- annotations ----------------------------------------------------------------
  const persistAnnotations = React.useMemo(()=>Object.assign((id,annotations)=>annotationSaves.set(id,annotations),{flush:()=>annotationSaves.flush()}),[annotationSaves])
  flushPending.current=()=>{persistProgress.flush?.();persistAnnotations.flush?.()}

  const setAnnotations = React.useCallback(
    (updater, options = {}) => {
      const current = stateRef.current
      const next = typeof updater === 'function' ? updater(current.annotations) : updater
      if (next === current.annotations) return
      if (options.record !== false && current.doc !== null) {
        const history = annotationHistory.current
        history.past.push({ before: current.annotations, after: next })
        if (history.past.length > 80) history.past.shift()
        history.future = []
      }
      if (current.doc !== null) persistAnnotations(current.doc.id, next)
      setState((state) => (state.annotations === current.annotations ? { ...state, annotations: next } : state))
    },
    [persistAnnotations],
  )

  const undoAnnotations = React.useCallback(() => {
    const history = annotationHistory.current
    const entry = history.past.pop()
    if (entry === undefined) {
      toast(t('ann.undoEmpty', 'Nothing to undo'), 'info')
      return false
    }
    history.future.push(entry)
    setAnnotations(entry.before, { record: false })
    persistAnnotations.flush?.()
    toast(t('ann.undone', 'Annotation change undone'), 'success')
    return true
  }, [setAnnotations, t, toast, persistAnnotations])

  const redoAnnotations = React.useCallback(() => {
    const history = annotationHistory.current
    const entry = history.future.pop()
    if (entry === undefined) return false
    history.past.push(entry)
    setAnnotations(entry.after, { record: false })
    persistAnnotations.flush?.()
    toast(t('ann.redone', 'Annotation change restored'), 'success')
    return true
  }, [setAnnotations, t, toast, persistAnnotations])

  React.useEffect(() => {
    if(!annotationHistories.current.has(state.doc?.id))annotationHistories.current.set(state.doc?.id,{past:[],future:[]})
    annotationHistory.current=annotationHistories.current.get(state.doc?.id)
  }, [state.doc?.id])

  React.useEffect(() => {
    const flush = () => persistAnnotations.flush?.()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [persistAnnotations])

  const addAnnotation = React.useCallback(
    (input) => {
      const doc = stateRef.current.doc
      if (doc === null || input === null || input === undefined) return null
      const timestamp = Date.now()
      const annotation = {
        id: uid('ann'),
        docId: doc.id,
        color: input.color ?? 'yellow',
        style: input.style === 'underline' ? 'underline' : 'highlight',
        text: String(input.text ?? ''),
        note: String(input.note ?? ''),
        createdAt: timestamp,
        updatedAt: timestamp,
        target: input.target,
      }
      setAnnotations((current) => [...current, annotation])
      return annotation
    },
    [setAnnotations],
  )

  const updateAnnotation = React.useCallback(
    (id, patch) => {
      setAnnotations((current) => current.map((annotation) => (annotation.id === id ? { ...annotation, ...patch, updatedAt: Date.now() } : annotation)))
    },
    [setAnnotations],
  )

  const removeAnnotation = React.useCallback(
    (id) => {
      setAnnotations((current) => current.filter((annotation) => annotation.id !== id))
    },
    [setAnnotations],
  )

  // ----- AI output cache -------------------------------------------------------------
  const writeDocAux = React.useCallback((id, method, params) => {
    const previous = workspace.auxWrites.get(id) ?? Promise.resolve()
    const write = previous.then(() => api.rpc(method, { id, ...params }))
      .catch(error => { diag?.recordError(method, error) })
    workspace.auxWrites.set(id, write)
    void write.then(() => {
      if (workspace.auxWrites.get(id) === write) workspace.auxWrites.delete(id)
    })
    return write
  }, [api, diag, workspace])

  const saveDocAux = React.useCallback(
    (patch, docId=stateRef.current.doc?.id) => {
      if (!docId) return
      setState((current) => current.doc?.id===docId?({ ...current, aux: { ...current.aux, ...patch } }):current)
      return writeDocAux(docId, 'aux.set', { patch })
    },
    [writeDocAux],
  )

  const appendChat = React.useCallback(
    (message, docId = stateRef.current.doc?.id) => {
      if (!docId) return
      setState(current => {
        if (current.doc?.id !== docId) return current
        const chat = Array.isArray(current.aux.chat) ? current.aux.chat : []
        return { ...current, aux: { ...current.aux, chat: [...chat, message].slice(-400) } }
      })
      return writeDocAux(docId, 'aux.appendChat', { message })
    },
    [writeDocAux],
  )
  const setTranslateStats = React.useCallback((translateStats, docId) => {
    setState(current => current.doc?.id === docId && current.view === 'reader' && current.translateStats !== translateStats
      ? { ...current, translateStats } : current)
  }, [])

  // ----- export ---------------------------------------------------------------------
  const exportDoc = React.useCallback(
    async (kind, { translate, inlineEntries } = {}) => {
      const { doc, content, annotations, aux } = stateRef.current
      if (doc === null) return
      try {
        if (kind === 'notes') exportNotes({ doc, annotations, aux, t })
        else if (kind === 'summary') exportSummary({ doc, aux })
        else if (kind === 'text') {
          if (translate?.enabled) await translate.restoreCached?.().catch(() => undefined)
          exportText({ doc, content, translate, inlineEntries })
        }
        else if (kind === 'original') await exportOriginal({ api, doc })
        else if (kind === 'all-notes') {
          const count = await exportAllNotes({ api, docs: stateRef.current.docs, t })
          toast(t('settings.data.exportAll.done', 'All notes exported', { count }), 'success')
          return
        }
        toast(t('toast.exported', 'File exported'), 'success')
      } catch (error) {
        toast(`${t('toast.error', 'Something went wrong')}: ${error.message}`, 'error')
      }
    },
    [api, t, toast],
  )

  // ----- drag & drop import anywhere -------------------------------------------------
  const [dragging, setDragging] = React.useState(false)
  const dragDepth = React.useRef(0)
  const onDragEnter = React.useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [])
  const onDragOver = React.useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])
  const onDragLeave = React.useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])
  const onDrop = React.useCallback(
    (event) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      importDrop(event.dataTransfer)
    },
    [importDrop],
  )

  // ----- init + host events ---------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [settingsResult, libraryResult] = await Promise.all([
          Promise.resolve(workspace.settingsWrite).then(() => api.rpc('settings.get')),
          api.rpc('library.list'),
        ])
        if (cancelled) return
        const docs = libraryResult?.docs ?? []
        const ids = docs.map(doc => doc.id)
        const openDocIds = normalizeTabs(workspace.openDocIds ?? settingsResult?.settings?.ui?.openDocIds, ids)
        const resumeId = ids.includes(workspace.activeDocId) ? workspace.activeDocId : null
        workspace.openDocIds = openDocIds
        workspace.activeDocId = resumeId
        annotationSaves.recover(ids)
        setState((current) => ({
          ...current,
          ready: true,
          settings: settingsResult?.settings ?? DEFAULT_SETTINGS,
          docs,
          openDocIds,
          view: resumeId ? 'reader' : 'library',
          openingDocId: resumeId,
          docLoading: Boolean(resumeId),
          folders: libraryResult?.folders ?? [],
        }))
        if (resumeId) void openDoc(resumeId, { tabs: openDocIds, resume: true })
        diag?.report('client-ready', { locale: t.locale, docs: docs.length, settings: { paper: settingsResult?.settings?.appearance?.paper } })
      } catch (error) {
        if (cancelled) return
        diag?.recordError('init', error)
        setState((current) => ({ ...current, ready: true, initError: error.message, view: 'library', openingDocId: null, docLoading: false }))
      }
    })()
    const disposers = []
    try {
      if (ctx?.on) disposers.push(ctx.on('locale/change', () => setState((current) => ({ ...current, localeRev: current.localeRev + 1 }))))
      if (ctx?.on) disposers.push(ctx.on('theme/change', () => setState((current) => ({ ...current, localeRev: current.localeRev + 1 }))))
    } catch {
      /* events unavailable */
    }
    return () => {
      cancelled = true
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  }, [annotationSaves, api, ctx, diag, openDoc, t, workspace])

  const interfaceDark = useInterfaceDark(state.settings)
  const styleVars = React.useMemo(() => readerStyleVars(state.settings, interfaceDark), [state.settings, interfaceDark])

  // Live diagnostics breadcrumb: proves the panel component actually rendered in this page.
  React.useEffect(() => {
    if (diag === null || diag === undefined) return
    diag.state.mount.mounted = true
    diag.state.mount.renders += 1
    diag.state.mount.lastRenderAt = Date.now()
    diag.report('panel-mounted', { view: 'library', locale: t.locale })
  }, [diag, t])

  // Reader-local UI language (independent of the DSH host locale): applied before every render.
  if (typeof t?.setLocaleOverride === 'function') t.setLocaleOverride(state.settings?.ui?.uiLang ?? 'auto')

  const actions = React.useMemo(
    () => ({
      openDoc,
      closeDoc,
      setView: (view) => setState((current) => ({ ...current, view })),
      patchSettings,
      whenSettingsSaved,
      toast,
      dismissToast,
      importFiles,
      importDrop,
      cancelImport,
      openImport:folderId=>setState(current=>({...current,importOpen:true,importTarget:folderId??null,importResult:current.importing?current.importResult:null})),
      closeImport:()=>setState(current=>({...current,importOpen:false})),
      clearImportResult:()=>setState(current=>({...current,importResult:null})),
      removeDoc,
      toggleFavorite,
      refreshDocs,
      saveDocPatch,
      saveProgress,
      openSettings: (section) =>
        setState((current) => ({ ...current, settingsOpen: true, settingsSection: section ?? current.settingsSection })),
      closeSettings: () => setState((current) => ({ ...current, settingsOpen: false })),
      openZotero: () => setState((current) => ({ ...current, zoteroOpen: true })),
      closeZotero: () => setState((current) => ({ ...current, zoteroOpen: false })),
      saveDocAux,
      acceptDocAux:(id,patch)=>setState(current=>current.doc?.id===id?{...current,aux:{...current.aux,...patch}}:current),
      appendChat,
      exportDoc,
      extractContent,
      rebuildFormulas: () => {
        const current = stateRef.current
        if (current.doc !== null && current.doc !== undefined && current.content !== null) {
          enhanceFormulas(current.doc, current.content, { force: true }).catch(() => undefined)
        }
      },
      rerunLayoutPlan: () => {
        const current = stateRef.current
        if (current.doc !== null && current.doc !== undefined && current.content !== null) {
          visionLayout(current.doc, current.content, { force: true }).catch(() => undefined)
        }
      },
      rerunVisionLayout: () => {
        const current = stateRef.current
        if (current.doc !== null && current.doc !== undefined && current.content !== null) {
          visionLayout(current.doc, current.content, { force: true }).catch(() => undefined)
        }
      },
      retryVisionLayout: () => {
        const current = stateRef.current
        if (current.doc && hasFailedVisualLayout(current.content)) {
          visionLayout(current.doc, current.content, { retryFailed: true }).catch(() => undefined)
        }
      },
      cancelLayout: () => { visionRuns.get(stateRef.current.doc?.id)?.abort() },
      loadFolders,
      foldersCreate,
      foldersRename,
      foldersRemove,
      moveDoc,
      replaceContent,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      undoAnnotations,
      redoAnnotations,
      setTranslateStats,
      setImporting: (importing) => setState((current) => ({ ...current, importing })),
    }),
    [
      appendChat,
      closeDoc,
      dismissToast,
      enhanceFormulas,
      exportDoc,
      extractContent,
      planLayout,
      visionLayout,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      undoAnnotations,
      redoAnnotations,
      foldersCreate,
      foldersRemove,
      foldersRename,
      importFiles,
      importDrop,
      cancelImport,
      loadFolders,
      moveDoc,
      openDoc,
      patchSettings,
      whenSettingsSaved,
      refreshDocs,
      removeDoc,
      replaceContent,
      saveDocAux,
      setTranslateStats,
      saveDocPatch,
      saveProgress,
      toast,
      toggleFavorite,
      visionRuns,
    ],
  )

  const context = React.useMemo(
    () => ({ api, t, state, actions, diag, ctx }),
    [actions, api, ctx, diag, state, t],
  )

  const header = state.view === 'settings' ? { title: t('settings.title', 'Reader settings'), icon: h(IconSettings, { size: 17 }) } : { title: t('library.title', 'My library'), icon: h(IconLibrary, { size: 17 }) }

  return h(
    AppContext.Provider,
    { value: context },
    h(
      'div',
      {
        className: 'dr-root',
        style: styleVars,
        'data-dr-dark': interfaceDark ? 'true' : 'false',
        onDragEnter,
        onDragOver,
        onDragLeave,
        onDrop,
        onDropCapture: event => { if(Array.from(event.dataTransfer?.types??[]).includes('Files')) { dragDepth.current=0;setDragging(false) } },
      },
      h(DocumentTabs,{docs:state.docs,ids:state.openDocIds,activeId:state.view==='reader'?(state.doc?.id??state.openingDocId):null,onLibrary:closeDoc,onOpen:openDoc,onClose:closeDocumentTab,onReorder:ids=>{setState(current=>({...current,openDocIds:ids}));saveOpenTabs(ids)},onSettings:()=>actions.openSettings('appearance'),status:h(SaveStatus,{connection,pending:annotationSaves.size>0,failed:annotationSaves.hasErrors,durable:annotationSaves.allDurable,onRetry:()=>api.reconnect?.().then(()=>annotationSaves.flush()).catch(()=>undefined),t}),t}),
      h(
        'div',
        { className: 'dr-body' },
        state.view === 'library'
          ? h(LibraryView, { onOpen: openDoc, session: workspace.library })
          : state.view === 'reader'
            ? h(ReaderShell, {
                key:state.doc?.id??'loading',
                session: state.doc ? sessionFor(state.doc.id) : undefined,
                doc: state.doc,
                content: state.content,
                annotations: state.annotations,
                aux: state.aux,
                loading: state.docLoading,
                onExtract: () => extractContent(stateRef.current.doc),
                addAnnotation,
                updateAnnotation,
                removeAnnotation,
              })
            : h(
                'div',
                { className: 'dr-settings' },
                h(
                  'div',
                  { className: 'dr-settings-inner', style: { display: 'block' } },
                  h(
                    'div',
                    { className: 'dr-settings-content', style: { margin: '0 auto' } },
                    h('div', { className: 'dr-settings-h' }, t('settings.title', 'Reader settings')),
                    h('p', { className: 'dr-settings-sub' }, t('settings.about', 'Reader settings')),
                    h(Button, { variant: 'primary', onClick: () => actions.openSettings('appearance') }, t('common.open', 'Open')),
                    h(Button, { variant: 'ghost', onClick: closeDoc }, t('common.back', 'Back')),
                  ),
                ),
              ),
      ),
      dragging ? h('div', { className: 'dr-drop-overlay', style: { position: 'absolute', inset: 12 } }, h(IconBook, { size: 30 }), h('span', null, t('library.dropHint', 'Drop PDF or EPUB files anywhere to import'))) : null,
      h(SettingsDialog, {
        open: state.settingsOpen,
        section: state.settingsSection,
        onSection: (settingsSection) => setState((current) => ({ ...current, settingsSection })),
        onClose: actions.closeSettings,
      }),
      h(ImportDialog,{open:state.importOpen,onClose:actions.closeImport}),
      h(ToastHost, { toasts: state.toasts, onDismiss: dismissToast }),
    ),
  )
}

