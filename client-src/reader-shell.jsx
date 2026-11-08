// Reader session: document chrome, left side panel (contents / focus / annotations / search),
// the reading surface, the bilingual translation session, highlights, selection actions and the
// right-side AI assistant. Content rendering is delegated to EpubContent / PdfView; this shell
// owns everything around them and exposes the reader context those modules consume.
import React from 'react'
import {MediaPanel, MediaPreview} from './media-browser.jsx'
import {createMediaImages} from './media-images.js'
import {buildMediaIndex} from '../shared/media-index.js'
import {findInBlocks} from '../shared/document-search.js'
import { useApp, useReader, readerStyleVars, useInterfaceDark, ReaderContext } from './store.jsx'
import { EpubContent } from './content-epub.jsx'
import { PdfView } from './pdf-view.jsx'
import { createTranslationService, TranslateBar } from './translate.jsx'
import { translationEngineScope } from '../shared/translation-engines.js'
import { outlineLevels } from './toc.js'
import { AiPanel } from './ai-panel.jsx'
import { HighlightLayer, SelectionToolbar } from './annotations.jsx'
import { AnnotationsPanel } from './annotations-panel.jsx'
import { Markdown } from './markdown.jsx'
import { useInlineMath, inlineTranslationBlocks } from './inline-math.jsx'
import { hasFailedVisualLayout } from './layout-pipeline.js'
import { sourceOffset, collectSourceSegments } from './source-anchors.js'
import { applyStructureRefinement } from './refine.js'
import {
  Button,
  IconButton,
  Input,
  Popover,
  MenuItem,
  SegmentedControl,
  Slider,
  Tabs,
  ProgressBar,
  Badge,
  EmptyState,
  LoadingBlock,
} from './ui.jsx'
import {
  IconArrowLeft,
  IconBook,
  IconChevronLeft,
  IconClose,
  IconDownload,
  IconEdit,
  IconHighlighter,
  IconList,
  IconNote,
  IconTrash,
  IconUnderline,
  IconGlobe,
  IconGrid,
  IconMore,
  IconPanelLeft,
  IconPanelRight,
  IconRefresh,
  IconSearch,
  IconSpark,
  IconTextSize,
  IconTranslate,
  Spinner,
} from './icons.jsx'
import { PAPER_THEMES, clamp, clsx, debounce, throttle, uid } from './util.js'

const h = React.createElement

const MAX_CONTEXT_CHARS = 48000

/** Reader view. */
export function ReaderShell({ doc, content, annotations, aux, loading, onExtract, addAnnotation, updateAnnotation, removeAnnotation, session }) {
  const { api, t, state, actions, diag } = useApp()
  const settings = state.settings
  const translationRef = settings.ai.active?.translate
  const translationScope = translationEngineScope(translationRef?.providerId, settings.ai.translate)
  const appearance = settings.appearance
  const interfaceDark = useInterfaceDark(settings)

  const [leftOpen, setLeftOpen] = React.useState(session?.ui.leftOpen ?? (window.innerWidth >= 900 && settings.ui?.sidebarOpen !== false))
  const [leftTab, setLeftTab] = React.useState(session?.ui.leftTab ?? settings.ui?.activeLeftTab ?? 'toc')
  const [aiOpen, setAiOpen] = React.useState(session?.ui.aiOpen ?? (window.innerWidth >= 900 && settings.ui?.aiOpen === true))
  const [leftWidth, setLeftWidth] = React.useState(clamp(Number(settings.ui?.leftPanelWidth) || 320, 220, 560))
  const [rightWidth, setRightWidth] = React.useState(clamp(Number(settings.ui?.rightPanelWidth) || 400, 300, 640))
  const readerFrameRef = React.useRef(null)
  const [viewportWidth, setViewportWidth] = React.useState(window.innerWidth)
  React.useLayoutEffect(() => {
    const frame = readerFrameRef.current
    if (!frame) return
    const measure = () => setViewportWidth(frame.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])
  // On 1080p-class screens the stored panel widths (from a 2K screen) leave too little room for
  // the article. Scale both panels down to a budget, preserving the user's relative preference.
  const maxPanels = Math.max(420, Math.round(viewportWidth * 0.58))
  let effectiveLeftWidth = leftOpen ? Math.min(leftWidth, Math.max(190, Math.round(viewportWidth * 0.19))) : leftWidth
  let effectiveRightWidth = aiOpen ? Math.min(rightWidth, Math.max(260, Math.round(viewportWidth * 0.26))) : rightWidth
  if (leftOpen && aiOpen && effectiveLeftWidth + effectiveRightWidth > maxPanels) {
    const scale = maxPanels / (effectiveLeftWidth + effectiveRightWidth)
    effectiveLeftWidth = Math.max(180, Math.round(effectiveLeftWidth * scale))
    effectiveRightWidth = Math.max(240, Math.round(effectiveRightWidth * scale))
  }
  const widthsRef = React.useRef({ left: leftWidth, right: rightWidth })
  widthsRef.current = { left: leftWidth, right: rightWidth }
  const [mode, setMode] = React.useState(session?.ui.mode ?? 'reflow')
  const [selection, setSelection] = React.useState(null)
  const [activeAnnId, setActiveAnnId] = React.useState(null)
  const [noteRequest,setNoteRequest]=React.useState(null)
  const [activeBlockId, setActiveBlockId] = React.useState(null)
  const [activeSection, setActiveSection] = React.useState(null)
  const [searchQuery, setSearchQuery] = React.useState(session?.ui.searchQuery ?? '')
  const searchInputRef=React.useRef(null)
  const [searchFocus,setSearchFocus]=React.useState(0)
  const [searchResults, setSearchResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [appearOpen, setAppearOpen] = React.useState(false)
  const [exportOpen, setExportOpen] = React.useState(false)
  const [mediaPreview,setMediaPreview]=React.useState(null)
  const [askSource, setAskSource] = React.useState(session?.ui.askSource ?? null)
  const [askRequest, setAskRequest] = React.useState(null)
  const [pageRequest, setPageRequest] = React.useState(null)
  const [reflowRequest,setReflowRequest]=React.useState(null)
  const [summaryGenerating, setSummaryGenerating] = React.useState(false)
  const [summaryError, setSummaryError] = React.useState(null)
  const summaryController=React.useRef(null)
  const cancelSummary=React.useCallback(()=>summaryController.current?.abort(),[])
  React.useEffect(()=>()=>{summaryController.current?.abort();summaryController.current=null},[doc?.id])
  const [aiReflowRunning, setAiReflowRunning] = React.useState(false)
  const [aiReflowProgress, setAiReflowProgress] = React.useState(null)
  const [percent, setPercent] = React.useState(session?.ui.percent ?? doc?.progress?.percent ?? 0)
  const [restored, setRestored] = React.useState(false)
  const [layoutVersion, setLayoutVersion] = React.useState(0)

  const scrollRootRef = React.useRef(null)
  const contentRootRef = React.useRef(null)
  const [scrollRoot, setScrollRoot] = React.useState(null)
  const [contentRoot, setContentRoot] = React.useState(null)
  const blockEls = React.useRef(new Map())
  const layoutListeners = React.useRef(new Set())
  const layoutNotifyQueued = React.useRef(false)
  const visibilityObserver = React.useRef(null)

  const interfaceStyle = React.useMemo(() => readerStyleVars(settings, interfaceDark), [settings, interfaceDark])

  const blocks = React.useMemo(() => {
    if (content === null || content === undefined) return []
    if (content.kind === 'epub' && Array.isArray(content.blocks)) return content.blocks
    if (Array.isArray(content.pages)) return content.pages.flatMap((page) => (Array.isArray(page.blocks) ? page.blocks : []))
    return []
  }, [content])

  const toc = React.useMemo(() => (Array.isArray(content?.toc) ? content.toc : []), [content])
  const media = React.useMemo(()=>buildMediaIndex(blocks),[blocks])
  const mediaImages = React.useMemo(() => doc?.id ? createMediaImages({ api, doc }) : null, [api, doc?.id, doc?.format])
  React.useEffect(() => () => mediaImages?.dispose(), [mediaImages])

  const chapters = React.useMemo(() => {
    const list = []
    for (const entry of toc) if (typeof entry?.blockId === 'string' && entry.blockId !== '') list.push(entry)
    return list
  }, [toc])

  // ----- block registry / layout notifications --------------------------------------
  const notifyLayoutSoon = React.useCallback(() => {
    if (layoutNotifyQueued.current) return
    layoutNotifyQueued.current = true
    requestAnimationFrame(() => {
      layoutNotifyQueued.current = false
      for (const listener of layoutListeners.current) {
        try {
          listener()
        } catch {
          /* listener errors must not break the reader */
        }
      }
    })
  }, [])

  const registerBlockEl = React.useCallback(
    (blockId, element) => {
      if (typeof blockId !== 'string' || blockId === '') return
      const observer = visibilityObserver.current
      if (element === null || element === undefined) {
        const existing = blockEls.current.get(blockId)
        if (existing !== undefined && observer !== null) {
          try {
            observer.unobserve(existing)
          } catch {
            /* already gone */
          }
        }
        blockEls.current.delete(blockId)
      } else {
        blockEls.current.set(blockId, element)
        if (observer !== null) {
          try {
            observer.observe(element)
          } catch {
            /* ignore */
          }
        }
      }
      notifyLayoutSoon()
    },
    [notifyLayoutSoon],
  )

  const getBlockEl = React.useCallback((blockId) => blockEls.current.get(blockId) ?? blockEls.current.get(blocks.find(block => block.sourceIds?.includes(blockId))?.id) ?? null, [blocks])
  const onLayoutChange = React.useCallback((listener) => {
    layoutListeners.current.add(listener)
    return () => layoutListeners.current.delete(listener)
  }, [])

  // ----- translation session --------------------------------------------------------
  const inlineMath = useInlineMath({ api, doc, content, settings, onLayout: notifyLayoutSoon, session })
  const translationBlocks = React.useMemo(() => inlineTranslationBlocks(blocks, inlineMath.entries), [blocks, inlineMath.entries])
  const translate = React.useMemo(() => {
    try {
      if(session?.translate) return session.translate
      const service=createTranslationService({
        api,
        settings,
        whenSettingsSaved: actions.whenSettingsSaved,
        docId: doc?.id,
        blocks: translationBlocks,
        onStats: stats => {
          if (session) session.reportTranslationStats?.(stats)
          else actions.setTranslateStats?.(stats, doc?.id)
        },
      })
      if(session) session.translate=service
      return service
    } catch (error) {
      diag?.recordError('translateService', error)
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id])

  React.useLayoutEffect(() => {
    if (!session || !translate) return
    const report = stats => actions.setTranslateStats(stats, doc?.id)
    session.reportTranslationStats = report
    report(translate.stats)
    return () => { if (session.reportTranslationStats === report) delete session.reportTranslationStats }
  }, [actions.setTranslateStats, doc?.id, session, translate])

  React.useEffect(() => {
    return () => {
      try {
        if(!session) translate?.dispose?.()
      } catch {
        /* already disposed */
      }
    }
  }, [translate])

  React.useLayoutEffect(() => {
    if (session) Object.assign(session.ui, { mode, searchQuery, leftTab, leftOpen, aiOpen, askSource })
  }, [session, mode, searchQuery, leftTab, leftOpen, aiOpen, askSource])
  React.useEffect(()=>{
    const onFind=event=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||String(event.key).toLowerCase()!=='f'||event.isComposing)return
      if(state.settingsOpen||event.target?.closest?.('[role="dialog"]'))return
      event.preventDefault();event.stopPropagation()
      setLeftOpen(true);setLeftTab('search');setSearchFocus(value=>value+1)
    }
    window.addEventListener('keydown',onFind,true)
    return()=>window.removeEventListener('keydown',onFind,true)
  },[state.settingsOpen])
  React.useEffect(()=>{if(leftOpen&&leftTab==='search'){searchInputRef.current?.focus();searchInputRef.current?.select()}},[leftOpen,leftTab,searchFocus])

  React.useEffect(() => {
    if (translate === null) return
    try {
      translate.setBlocks?.(translationBlocks)
      translate.restoreCached?.().catch(()=>undefined)
    } catch {
      /* stale service */
    }
  }, [translationBlocks, translate])

  React.useEffect(() => {
    if (translate === null) return
    try {
      translate.setLang?.(settings.ai.targetLang)
      translate.setMode?.(settings.ai.translate?.mode ?? 'bilingual')
      translate.setModelRef?.(translationRef, translationScope)
    } catch {
      /* service may be disposed */
    }
  }, [translate, settings.ai.targetLang, settings.ai.translate?.mode, translationRef?.providerId, translationRef?.model, translationScope])

  const translateEnabled = React.useSyncExternalStore(
    React.useCallback((callback) => (translate?.subscribe ? translate.subscribe(callback) : () => undefined), [translate]),
    React.useCallback(() => translate?.enabled === true, [translate]),
    React.useCallback(() => false, []),
  )

  // Report the current viewport independently of which blocks are queued.
  React.useEffect(() => {
    if (!scrollRoot || !translate || typeof IntersectionObserver !== 'function') return undefined
    const visible = new Set()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute?.('data-block-id')
          if (id == null || blockEls.current.get(id) !== entry.target) continue
          if (entry.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        for (const id of visible) if (!blockEls.current.has(id)) visible.delete(id)
        translate.setViewport([...visible])
      },
      { root: scrollRoot, threshold: 0.01 },
    )
    visibilityObserver.current = observer
    for (const element of blockEls.current.values()) {
      try {
        observer.observe(element)
      } catch {
        /* ignore */
      }
    }
    return () => {
      try {
        observer.disconnect()
      } catch {
        /* ignore */
      }
      if (visibilityObserver.current === observer) visibilityObserver.current = null
      translate.setViewport([])
    }
  }, [scrollRoot, translate])

  // ----- navigation helpers ---------------------------------------------------------
  const scrollToBlock = React.useCallback(
    (blockId, options = {}) => {
      const element = getBlockEl(blockId)
      const root = scrollRootRef.current
      if (element === null || root === null) return false
      const targetTop = Math.max(0,root.scrollTop+element.getBoundingClientRect().top-root.getBoundingClientRect().top-(options.offset??84))
      root.scrollTo({ top: targetTop, behavior: options.instant === true ? 'instant' : 'smooth' })
      element.classList.add('dr-flash')
      window.setTimeout(() => element.classList.remove('dr-flash'), 1300)
      return true
    },
    [getBlockEl],
  )

  const jumpTo = React.useCallback(
    (target) => {
      if (target === null || target === undefined) return
      if (typeof target.blockId === 'string' && target.blockId !== '') {
        setMode('reflow');setRestored(true)
        setReflowRequest({blockId:target.blockId,offset:84,nonce:Date.now()})
        return
      }
      if (typeof target.page === 'number') {
        setMode('original')
        setPageRequest({ page: target.page, nonce: Date.now() })
      }
    },
    [scrollToBlock],
  )

  React.useEffect(()=>{
    if(!reflowRequest)return
    let frame=0
    const attempt=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>scrollToBlock(reflowRequest.blockId,{instant:true,offset:reflowRequest.offset??84}))}
    const stop=()=>setReflowRequest(null)
    const unsubscribe=onLayoutChange(attempt),observer=new ResizeObserver(attempt)
    if(contentRootRef.current)observer.observe(contentRootRef.current)
    const root=scrollRootRef.current
    for(const name of ['wheel','touchstart','pointerdown'])root?.addEventListener(name,stop,{passive:true})
    const timeout=setTimeout(stop,8000);attempt()
    return()=>{unsubscribe();observer.disconnect();cancelAnimationFrame(frame);clearTimeout(timeout);for(const name of ['wheel','touchstart','pointerdown'])root?.removeEventListener(name,stop)}
  },[reflowRequest,scrollToBlock,onLayoutChange,contentRoot])

  const moveBy = React.useCallback((direction) => {
    const root = scrollRootRef.current
    if (root === null) return
    root.scrollBy({ top: direction * root.clientHeight * 0.85, behavior: 'smooth' })
  }, [])

  const focusAnn = React.useCallback(
    (id) => {
      const annotation = annotations.find((entry) => entry.id === id)
      if (annotation === undefined) return
      setActiveAnnId(id)
      if (annotation.target?.kind === 'pdf') {
        setMode('original')
        setPageRequest({ page: annotation.target.page, nonce: Date.now() })
      } else if (annotation.target?.kind === 'reflow') {
        jumpTo({blockId:annotation.target.blockId})
      }
    },
    [annotations, jumpTo],
  )

  React.useEffect(() => {
    setActiveAnnId(null)
  }, [doc?.id])

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented === true || event.isComposing === true || event.repeat === true) return
      const target = event.target
      if (target !== null && target !== undefined) {
        const tag = String(target.tagName ?? '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true) return
        try {
          if (typeof target.closest === 'function' && target.closest('.dr-modal, .dr-modal-backdrop, .dr-settings, .dr-drawer') !== null) return
        } catch {
          /* closest unavailable */
        }
      }
      const mod = event.ctrlKey === true || event.metaKey === true
      if (event.key === 'Escape' && activeAnnId !== null) {
        setActiveAnnId(null)
        return
      }
      if (mod && String(event.key).toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) actions.redoAnnotations()
        else actions.undoAnnotations()
        return
      }
      if (mod && String(event.key).toLowerCase() === 'y') {
        event.preventDefault()
        actions.redoAnnotations()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && typeof activeAnnId === 'string' && activeAnnId !== '') {
        event.preventDefault()
        actions.removeAnnotation(activeAnnId)
        setActiveAnnId(null)
        actions.toast(t('ann.deleted', 'Highlight deleted'), 'success')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actions, activeAnnId, t])

  // ----- selection ------------------------------------------------------------------
  const computeBlockOffset = React.useCallback(sourceOffset, [])

  const handleSelectionFromDom = React.useCallback(() => {
    if (mode === 'original') return
    const root = scrollRootRef.current
    if (root === null) return
    let sel = null
    try {
      sel = window.getSelection()
    } catch {
      sel = null
    }
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    let text = sel.toString().replace(/\s+/g, ' ').trim()
    if (text === '') {
      setSelection(null)
      return
    }
    const startNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer
    const blockElement = startNode?.closest?.('[data-block-id]')
    const blockId = blockElement?.getAttribute('data-block-id') ?? null
    const endNode = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer
    const endBlock = endNode?.closest?.('[data-block-id]')
    if (blockElement !== null && blockElement !== undefined && endBlock !== null && endBlock !== undefined && endBlock !== blockElement) {
      // Cross-paragraph selections cannot be anchored to one block without false highlights.
      setSelection(null)
      return
    }
    const translationRoot=startNode?.closest('[data-annotation-layer="translation"]')
    if(translationRoot!==endNode?.closest('[data-annotation-layer="translation"]')){setSelection(null);return}
    const anchorRoot=translationRoot??blockElement
    const start = anchorRoot ? computeBlockOffset(anchorRoot, range.startContainer, range.startOffset) : 0
    const end = anchorRoot ? computeBlockOffset(anchorRoot, range.endContainer, range.endOffset, 'end') : start + text.length
    if(anchorRoot?.querySelector('[data-math-source]'))text=collectSourceSegments(anchorRoot).text.slice(start,end)
    const rect = range.getBoundingClientRect()
    setSelection({
      text,
      blockId,
      start,
      end: Math.max(start + 1, end),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      kind: 'reflow',
      ...(translationRoot?{layer:'translation',lang:translate?.lang??''}:{}),
    })
    setActiveAnnId(null)
  }, [computeBlockOffset, mode,translate])

  const clearSelection = React.useCallback(() => {
    setSelection(null)
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
  }, [])

  const handleExternalSelect = React.useCallback((selectionInput) => {
    if (selectionInput === null || selectionInput === undefined) {
      setSelection(null)
      return
    }
    setSelection({ ...selectionInput, kind: selectionInput.kind ?? 'pdf' })
  }, [])

  // ----- context for AI -------------------------------------------------------------
  const buildContext = React.useCallback(
    (contextMode = 'doc') => {
      if (doc === null || doc === undefined) return { text: '', title: '', docId: null }
      if (contextMode === 'selection') return { text: selection?.text ?? '', title: doc.title, docId: doc.id }
      if (contextMode === 'section') {
        const activeIndex = chapters.findIndex((entry) => entry.id === activeSection?.id || entry.blockId === activeSection?.blockId)
        const startBlockId = activeIndex >= 0 ? chapters[activeIndex]?.blockId : null
        const startIndex = startBlockId !== null ? blocks.findIndex((block) => block.id === startBlockId) : 0
        const nextBlockId = activeIndex >= 0 ? chapters[activeIndex + 1]?.blockId : null
        const endIndex = nextBlockId !== undefined && nextBlockId !== null ? blocks.findIndex((block) => block.id === nextBlockId) : blocks.length
        const slice = blocks.slice(Math.max(0, startIndex), endIndex > 0 ? endIndex : blocks.length)
        const text = slice.map((block) => block.text ?? '').filter((value) => value !== '').join('\n\n')
        return { text: text.slice(0, MAX_CONTEXT_CHARS), title: doc.title, docId: doc.id }
      }
      const text = blocks.map((block) => block.text ?? '').filter((value) => value !== '').join('\n\n')
      return { text: text.slice(0, MAX_CONTEXT_CHARS), title: doc.title, docId: doc.id }
    },
    [activeSection, blocks, chapters, doc, selection],
  )

  const openAi = React.useCallback(() => {
    if (aiOpen) return
    setAiOpen(true)
    actions.patchSettings({ ui: { aiOpen: true } })
  }, [actions.patchSettings, aiOpen])

  const askAbout = React.useCallback((input, options = {}) => {
    let source = input
    if (typeof input === 'string') {
      const text = input.trim()
      if (!text) return
      source = {
        kind: 'text', id: uid('quote'), text, blockId: options.blockId,
        page: options.page ?? blocks.find(block => block.id === options.blockId)?.page,
      }
    }
    if (!source?.title && !source?.text) return
    setAskSource(source)
    setAskRequest({ id: uid('ask'), source, action: options.action })
    openAi()
  }, [blocks, openAi])

  const clearAskRequest = React.useCallback(() => setAskRequest(null), [])

  // ----- search ---------------------------------------------------------------------
  const runSearch = React.useCallback(async (query) => {
    const needle = String(query ?? '').trim()
    if (needle === '') {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const results=findInBlocks(blocks,needle,{entries:translate?.entries,translated:translateEnabled})
      setSearchResults(results)
    } finally {
      setSearching(false)
    }
  }, [blocks,translate,translateEnabled])

  const searchDebounced = React.useMemo(() => debounce((value) => runSearch(value), 220), [runSearch])
  React.useEffect(() => {
    searchDebounced(searchQuery)
    return () => searchDebounced.cancel?.()
  }, [searchQuery, searchDebounced,state.translateStats?.done])

  // ----- AI summary ------------------------------------------------------------------
  const generateSummary = React.useCallback(
    async (scope = 'doc') => {
      if (doc === null || doc === undefined || summaryController.current) return ''
      const controller=new AbortController();summaryController.current=controller
      setSummaryGenerating(true)
      setSummaryError(null)
      let text = ''
      try {
        if(scope==='studyMap'){
          const value=await api.stream('ai.studyMap',{docId:doc.id,language:settings.ai.targetLang,force:true},{},controller.signal)
          if(controller.signal.aborted)return ''
          actions.acceptDocAux?.(doc.id,{keypoints:value})
          return value
        }
        const context = buildContext(scope === 'section' ? 'section' : 'doc')
        if ((context.text ?? '').trim() === '') throw new Error(t('reader.extractFailed', 'Could not parse this document: {message}', { message: 'document text is empty' }))
        await api.stream(
          'ai.summarize',
          { docId: doc.id, title: doc.title, scope, text: context.text },
          {
            onDelta: (delta) => {
              text += delta
            },
            onDone: (value) => {
              if (typeof value?.text === 'string' && text.trim() === '') text = value.text
              if(!controller.signal.aborted)actions.saveDocAux({summary:text},doc.id)
            },
            onError: (error) => {
              if(!controller.signal.aborted)setSummaryError(error.message)
            },
          },controller.signal,
        )
        return text
      } catch (error) {
        if(controller.signal.aborted)return ''
        setSummaryError(error.message)
        actions.toast(t('ai.error', 'The model call failed: {message}', { message: error.message }), 'error')
        return ''
      } finally {
        if(summaryController.current===controller){summaryController.current=null;setSummaryGenerating(false)}
      }
    },
    [actions, api, buildContext, doc, settings.ai.targetLang, t],
  )

  /**
   * AI structure refinement for the deterministic PDF reflow: the model confirms/corrects heading
   * blocks, removes page furniture, and the corrected table of contents is persisted with the
   * document. Per-page results are cached host-side, so repeating this on the same extraction is
   * free. Paragraph text is never rewritten.
   */
  const runAiReflow = React.useCallback(async () => {
    if (doc === null || doc === undefined || doc.format !== 'pdf' || content === null || content === undefined || aiReflowRunning) return
    const pages = Array.isArray(content.pages) ? content.pages : []
    const payload = pages
      .map((page) => ({
        n: Number(page.n) || 0,
        blocks: (Array.isArray(page.blocks) ? page.blocks : []).map((block) => ({ id: block.id, kind: block.kind, text: block.text })),
      }))
      .filter((page) => page.blocks.length > 0)
    if (payload.length === 0) return
    const scrollRoot = scrollRootRef.current
    const savedScrollTop = scrollRoot?.scrollTop ?? 0
    const restoreScroll = () => {
      const root = scrollRootRef.current
      if (root === null) return
      try {
        root.scrollTop = Math.min(savedScrollTop, Math.max(0, root.scrollHeight - root.clientHeight))
      } catch {
        /* ignore */
      }
    }
    setAiReflowRunning(true)
    setAiReflowProgress({ done: 0, total: payload.length })
    const collected = []
    let lastPreviewAt = 0
    let result = null
    try {
      if (content.aiRefined !== true) await api.rpc('content.backup', { id: doc.id }).catch(() => undefined)
      await api.stream(
        'ai.reflow',
        { docId: doc.id, title: doc.title, pages: payload },
        {
          onProgress: (value) => {
            const suggestion = value?.suggestion
            if (suggestion !== null && suggestion !== undefined && typeof suggestion.n === 'number') {
              collected.push({ n: suggestion.n, headings: suggestion.headings, drop: suggestion.drop, explicit: suggestion.explicit === true })
              // Show the refined structure while later pages are still being classified.
              if (Date.now() - lastPreviewAt > 450) {
                lastPreviewAt = Date.now()
                const preview = applyStructureRefinement(content, { pages: collected })
                if (preview.changed > 0) {
                  actions.replaceContent?.(preview.content)
                  window.setTimeout(restoreScroll, 0)
                }
              }
            }
            setAiReflowProgress({ done: Number(value?.done) || 0, total: Number(value?.total) || payload.length })
          },
          onDone: (value) => {
            result = value
          },
        },
      )
      if (result === null || !Array.isArray(result.pages)) throw new Error('empty refinement result')
      const refined = applyStructureRefinement(content, result)
      if (refined.content === content) throw new Error('empty refinement result')
      const nextContent = refined.content
      await api.rpc('content.save', { id: doc.id, content: nextContent })
      actions.replaceContent?.(nextContent)
      window.setTimeout(restoreScroll, 0)
      window.setTimeout(restoreScroll, 260)
      actions.refreshDocs?.()
      actions.toast(
        t('reader.aiReflowDone', 'AI layout refined: {pages} pages, {cached} served from cache', {
          pages: Number(result.totalPages) || payload.length,
          cached: Number(result.cachedPages) || 0,
        }),
        'success',
      )
      if (refined.changed === 0) actions.toast(t('reader.aiReflowHint', 'Uses the model to correct headings and remove page furniture; results are cached, so re-running costs no tokens.'), 'info')
      diag?.report('ai-reflow', {
        docId: doc.id,
        pages: payload.length,
        changed: refined.changed,
        dropped: refined.dropCount,
        headings: refined.headingCount,
        cached: result.cachedPages ?? 0,
        previewPages: collected.length,
      })
    } catch (error) {
      actions.toast(t('reader.aiReflowFailed', 'AI layout refinement failed: {message}', { message: error?.message ?? String(error) }), 'error')
    } finally {
      setAiReflowRunning(false)
      setAiReflowProgress(null)
    }
  }, [actions, aiReflowRunning, api, content, diag, doc, t])

  /**
   * Drag a vertical splitter: left panel grows with the pointer, the AI panel grows the other way.
   * Widths live in settings so they survive document switches and restarts.
   */
  const beginResize = React.useCallback(
    (side) => (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = side === 'left' ? widthsRef.current.left : widthsRef.current.right
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX
        const next = side === 'left' ? clamp(startWidth + delta, 220, 560) : clamp(startWidth - delta, 300, 640)
        if (side === 'left') setLeftWidth(next)
        else setRightWidth(next)
        widthsRef.current = { ...widthsRef.current, [side]: next }
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        actions.patchSettings({ ui: side === 'left' ? { leftPanelWidth: Math.round(widthsRef.current.left) } : { rightPanelWidth: Math.round(widthsRef.current.right) } })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [actions],
  )

  // ----- scroll / progress / restore --------------------------------------------------
  const lastSectionRef = React.useRef(null)
  const reflowPosition = React.useCallback(root => {
    const rootTop = root.getBoundingClientRect().top
    let locator = null
    let blockOffset = 0
    for (const block of blocks) {
      const element = blockEls.current.get(block.id)
      if (!element) continue
      const top = element.getBoundingClientRect().top
      if (top - rootTop > 140) break
      locator = block.id
      blockOffset = rootTop - top
    }
    return { locator, blockOffset, scrollTop: root.scrollTop }
  }, [blocks])
  const savePositionOnExit = React.useRef(null)
  savePositionOnExit.current = () => {
    const root = scrollRootRef.current
    if (!session || !root || !restored) return
    const max = root.scrollHeight - root.clientHeight
    session.ui.percent = max > 0 ? clamp(root.scrollTop / max, 0, 1) : 0
    if (mode === 'reflow') Object.assign(session.ui, reflowPosition(root))
  }
  React.useLayoutEffect(() => () => savePositionOnExit.current?.(), [])

  const onScroll = React.useMemo(
    () =>
      throttle(() => {
        const root = scrollRootRef.current
        if (root === null || !restored) return
        const max = root.scrollHeight - root.clientHeight
        const rootTop=root.getBoundingClientRect().top
        const nextPercent = max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 0
        setPercent(nextPercent)
        // active section: last chapter whose block top is above the viewport threshold
        let currentSection = null
        let currentBlock = null
        for (const entry of chapters) {
          const element = blockEls.current.get(entry.blockId)
          if (element === undefined) continue
          if (element.getBoundingClientRect().top-rootTop <= 140) {
            currentSection = entry
            currentBlock = entry.blockId
          } else break
        }
        const position = mode === 'reflow' ? reflowPosition(root) : null
        currentBlock = position?.locator ?? currentBlock
        if (currentSection !== lastSectionRef.current) {
          lastSectionRef.current = currentSection
          setActiveSection(currentSection)
        }
        if (currentBlock !== null) setActiveBlockId(currentBlock)
        const label = currentSection?.title ?? (doc?.format === 'pdf' ? t('reader.page', 'Page {page} of {total}', { page: 1, total: content?.pageCount ?? '—' }) : '')
        if (session) {
          session.ui.percent = nextPercent
          if (position) Object.assign(session.ui, position)
        }
        actions.saveProgress?.(doc?.id,nextPercent, currentBlock ?? undefined, label)
      }, 160),
    [actions, chapters, content?.pageCount, doc?.id, doc?.format, mode, reflowPosition, restored, session, t],
  )

  React.useEffect(() => {
    const root = scrollRootRef.current
    if (root === null) return undefined
    const listener = () => onScroll()
    root.addEventListener('scroll', listener, { passive: true })
    return () => root.removeEventListener('scroll', listener)
  }, [scrollRoot, onScroll])

  React.useEffect(()=>{
    const root=scrollRootRef.current;if(!root||restored)return
    const takeControl=()=>setRestored(true)
    for(const name of ['pointerdown','wheel','touchstart'])root.addEventListener(name,takeControl,{passive:true})
    return()=>{for(const name of ['pointerdown','wheel','touchstart'])root.removeEventListener(name,takeControl)}
  },[scrollRoot,restored])

  React.useEffect(() => {
    if (restored || blocks.length === 0 || content === null) return undefined
    if (mode === 'original' && session?.ui.originalView) {
      setRestored(true)
      return undefined
    }
    const timer = window.setTimeout(() => {
      const root = scrollRootRef.current
      if (root === null) return
      const locator = session?.ui.locator === null ? null : session?.ui.locator ?? doc?.progress?.locator
      if (mode === 'reflow' && locator && blocks.some(block => block.id === locator || block.sourceIds?.includes(locator))) {
        setReflowRequest({blockId:locator,offset:session?.ui.blockOffset!==undefined?-session.ui.blockOffset:40,nonce:Date.now()});setRestored(true);return
      }
      if(session?.ui.mode===mode && typeof session?.ui.scrollTop==='number' && session.ui.scrollTop<=root.scrollHeight-root.clientHeight){
        root.scrollTo({ top: session.ui.scrollTop, behavior: 'instant' });setRestored(true);return
      }
      if (typeof locator === 'string' && locator !== '' && scrollToBlock(locator, { instant: true, offset: 40 })) {
        setRestored(true)
        return
      }
      const savedPercent = doc?.progress?.percent ?? 0
      if (savedPercent > 0.01) {
        root.scrollTop = savedPercent * Math.max(0, root.scrollHeight - root.clientHeight)
      }
      setRestored(true)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [blocks, content, doc?.progress?.locator, doc?.progress?.percent, mode, restored, scrollToBlock, session])

  // ----- layout toggles --------------------------------------------------------------
  const toggleLeftPanel = React.useCallback(() => {
    setLeftOpen(!leftOpen)
    actions.patchSettings({ ui: { sidebarOpen: !leftOpen } })
  }, [actions, leftOpen])

  const toggleAiPanel = React.useCallback(() => {
    setAiOpen(!aiOpen)
    actions.patchSettings({ ui: { aiOpen: !aiOpen } })
  }, [actions, aiOpen])

  const changeLeftTab = React.useCallback(
    (tab) => {
      setLeftTab(tab)
      actions.patchSettings({ ui: { activeLeftTab: tab } })
      if (leftOpen === false) {
        setLeftOpen(true)
        actions.patchSettings({ ui: { sidebarOpen: true } })
      }
    },
    [actions, leftOpen],
  )

  const openExportMenu = React.useCallback(() => setExportOpen(true), [])

  // ----- keyboard shortcuts ----------------------------------------------------------
  React.useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      const inField = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
      if (inField) return
      if ((event.metaKey || event.ctrlKey) && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        actions.patchSettings({ appearance: { fontSize: clamp((settings.appearance.fontSize ?? 18) + 1, 13, 32) } })
      } else if ((event.metaKey || event.ctrlKey) && event.key === '-') {
        event.preventDefault()
        actions.patchSettings({ appearance: { fontSize: clamp((settings.appearance.fontSize ?? 18) - 1, 13, 32) } })
      } else if (event.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, clearSelection, settings.appearance.fontSize])

  // ----- reader context --------------------------------------------------------------
  const readerValue = React.useMemo(
    () => ({
      doc,
      content,
      blocks,
      media,
      mediaImages,
      session,
      previewMedia:request=>{clearSelection();setMediaPreview(request)},
      toc,
      aux,
      settings,
      t,
      api,
      mode,
      setMode,
      progress: percent,
      activeBlockId,
      activeSection,
      summaryGenerating,
      cancelSummary,
      summaryError,
      selection,
      clearSelection,
      onSelect: handleExternalSelect,
      annotations,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      activeAnnId,
      activateAnnotation:setActiveAnnId,
      noteRequest,
      requestAnnotationNote:id=>setNoteRequest({id,nonce:Date.now()}),
      clearNoteRequest:()=>setNoteRequest(null),
      focusAnn,
      translate,
      inlineMath,
      translateEnabled,
      askAbout,
      askSource,
      selectAskSource: setAskSource,
      askRequest,
      clearAskRequest,
      jumpTo,
      scrollToBlock,
      moveBy,
      pageRequest,
      reflowRequest,
      requestPage: (page) => setPageRequest({ page, nonce: Date.now() }),
      registerBlockEl,
      getBlockEl,
      onLayoutChange,
      layoutVersion,
      scrollRoot,
      contentRoot,
      search: runSearch,
      searchQuery,
      setSearchQuery,
      searchResults,
      searching,
      openAi,
      openExportMenu,
      toggleLeftPanel,
      toggleAiPanel,
      buildContext,
      generateSummary,
    }),
    [
      activeAnnId,
      noteRequest,
      activeBlockId,
      activeSection,
      addAnnotation,
      annotations,
      api,
      askAbout,
      askSource,
      askRequest,
      aux,
      blocks,
      media,
      mediaImages,
      buildContext,
      clearAskRequest,
      clearSelection,
      content,
      contentRoot,
      doc,
      focusAnn,
      generateSummary,
      cancelSummary,
      getBlockEl,
      handleExternalSelect,
      jumpTo,
      layoutVersion,
      mode,
      moveBy,
      onLayoutChange,
      openAi,
      openExportMenu,
      pageRequest,
      reflowRequest,
      percent,
      registerBlockEl,
      removeAnnotation,
      runSearch,
      scrollRoot,
      scrollToBlock,
      searchQuery,
      searchResults,
      searching,
      selection,
      session,
      settings,
      summaryError,
      summaryGenerating,
      t,
      toc,
      toggleAiPanel,
      toggleLeftPanel,
      translate,
      inlineMath,
      translateEnabled,
      updateAnnotation,
    ],
  )

  const paperQuick = [
    { id: 'auto', label: t('reader.theme.system', 'Auto'), bg: interfaceDark ? PAPER_THEMES.dark.bg : PAPER_THEMES.light.bg },
    { id: 'light', label: t('reader.paper.light', 'Paper'), bg: PAPER_THEMES.light.bg },
    { id: 'sepia', label: t('reader.paper.sepia', 'Sepia'), bg: PAPER_THEMES.sepia.bg },
    { id: 'green', label: t('reader.paper.green', 'Green'), bg: PAPER_THEMES.green.bg },
    { id: 'dark', label: t('reader.paper.dark', 'Night'), bg: PAPER_THEMES.dark.bg },
  ]

  const leftTabs = [
    { id: 'toc', icon: h(IconList, { size: 15 }), title: t('reader.toc', 'Contents'), label: t('reader.tocShort', 'Contents') },
    { id: 'media', icon: h(IconGrid, { size: 15 }), title: t('media.tabTitle', 'Figures and tables'), label: t('media.tab', 'Figures') },
    { id: 'focus', icon: h(IconSpark, { size: 15 }), title: t('reader.focus', 'Key points'), label: t('reader.focusShort', 'Focus') },
    { id: 'highlights', icon: h(IconHighlighter, { size: 15 }), title: t('nav.highlights', 'Highlights'), label: t('nav.highlightsShort', 'Marks'), badge: annotations.length },
    { id: 'search', icon: h(IconSearch, { size: 15 }), title: t('nav.search', 'Search'), label: t('nav.searchShort', 'Find') },
  ]

  const widthPresets = [
    { value: 'narrow', label: t('reader.width.narrow', 'Narrow'), width: 760, wide: false },
    { value: 'medium', label: t('reader.width.medium', 'Medium'), width: 1000, wide: false },
    { value: 'wide', label: t('reader.width.wide', 'Wide'), width: 1300, wide: false },
    { value: 'full', label: t('reader.width.full', 'Full'), width: 1600, wide: true },
  ]
  const currentWidthPreset =
    appearance.wideMode === true
      ? 'full'
      : appearance.pageWidth <= 850
        ? 'narrow'
        : appearance.pageWidth <= 1100
          ? 'medium'
          : 'wide'
  const applyWidthPreset = (value) => {
    const preset = widthPresets.find((entry) => entry.value === value)
    if (preset === undefined) return
    actions.patchSettings({ appearance: { pageWidth: preset.width, wideMode: preset.wide } })
  }
  const activeAnnotation = activeAnnId === null ? null : annotations.find((entry) => entry.id === activeAnnId) ?? null
  const canRetryLayout = doc?.format === 'pdf' && !state.layoutProgress && hasFailedVisualLayout(content)
  const runInlineBatch = async () => {
    setExportOpen(false)
    if (inlineMath.batch) {
      inlineMath.cancelBatch()
      return
    }
    const result = await inlineMath.runBatch()
    if (!result) return
    if (result.error) actions.toast(result.error, 'error')
    else if (!result.total) actions.toast(t('inline.batchEmpty', 'No additional paragraphs with suspected formulas.'), 'info')
    else actions.toast(t('inline.batchDone', 'Inline typesetting finished. Completed {done}, failed {failed}.', { done: result.processed - result.failed, failed: result.failed }), result.failed ? 'error' : 'success')
  }

  return h(
    ReaderContext.Provider,
    { value: readerValue },
    h(
      'div',
      { className: 'dr-reader', style: interfaceStyle, ref: readerFrameRef },
      // ----- top bar -----------------------------------------------------------------
      h(
        'div',
        { className: 'dr-reader-top' },
        h(
          'div',
          { className: 'dr-reader-doc', title: doc?.title },
          h('div', { className: 'dr-reader-doc-title' }, doc?.title ?? t('common.untitled', 'Untitled')),
          h(
            'div',
            { className: 'dr-reader-doc-sub' },
            [doc?.author, activeSection?.title, doc?.format?.toUpperCase()].filter((value) => typeof value === 'string' && value !== '').join(' · '),
          ),
        ),
        h('div', { className: 'dr-header-spacer' }),
        doc?.format === 'pdf' && state.layoutProgress
          ? h(IconButton, {
              icon: state.layoutProgress ? h(Spinner, { size: 16 }) : h(IconSpark, { size: 17 }),
              label:
                state.layoutProgress ? (state.layoutProgress.stage==='local-parser'?t('parser.running','Local document parsing'):t('reader.visualRunning', 'AI visual layout')) + ` ${state.layoutProgress.done}/${state.layoutProgress.total}` : t('reader.visualRun', 'Rebuild AI visual layout (bypass layout cache)'),
              active: !!state.layoutProgress,
              onClick: () => state.layoutProgress ? actions.cancelLayout?.() : actions.rerunVisionLayout?.(),
            })
          : null,
        doc?.format === 'pdf' && state.layoutProgress
          ? h('span', { className: 'dr-ai-progress', role: 'status', title: state.layoutProgress.stage==='local-parser'?t('parser.running','Local document parsing'):t('reader.visualRunning', 'AI visual layout') }, state.layoutProgress.stage==='local-parser'?`${t('parser.running','Local structure parsing')} · ${state.layoutProgress.total} ${t('reader.visualPages','pages')}`:`${state.layoutProgress.stage === 'paragraphs' ? t('reader.visualParagraphs', 'Paragraphs') : t('reader.visualPages', 'Visual pages')} ${state.layoutProgress.done}/${state.layoutProgress.total}`)
          : null,
        doc?.format === 'pdf'
          ? h(SegmentedControl, {
              value: mode,
              onChange: (next) => {
                setMode(next)
                setRestored(true)
              },
              options: [
                { value: 'reflow', label: t('reader.reflow', 'Reflow'), icon: h(IconBook, { size: 13 }) },
                { value: 'original', label: t('reader.original', 'Original'), icon: h(IconList, { size: 13 }) },
              ],
            })
          : null,
        h(TranslateBar),
        inlineMath.batch ? h('span', { className: 'dr-ai-progress', role: 'status' }, t('inline.batchProgress', 'Inline typesetting {processed}/{total}', inlineMath.batch)) : null,
        h(
          'div',
          { style: { position: 'relative' } },
          h(
            IconButton,
            {
              icon: h(IconTextSize, { size: 17 }),
              label: t('reader.appearance', 'Appearance'),
              active: appearOpen,
              onClick: () => {
                setAppearOpen(!appearOpen)
                setExportOpen(false)
              },
            },
            null,
          ),
          h(
            Popover,
            { open: appearOpen, align: 'end' },
            h(
              'div',
              { style: { width: 270, padding: '4px 8px 8px' } },
              h('div', { style: { fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' } }, t('settings.paper', 'Reading paper')),
              h(
                'div',
                { className: 'dr-swatch-row', style: { marginBottom: 10 } },
                paperQuick.map((paper) =>
                  h(
                    'button',
                    {
                      key: paper.id,
                      type: 'button',
                      className: clsx('dr-swatch', appearance.paper === paper.id && 'is-active'),
                      style: { background: paper.bg, color: paper.id === 'dark' ? '#eee' : '#333', width: 46 },
                      onClick: () => actions.patchSettings({ appearance: { paper: paper.id } }),
                      title: paper.label,
                    },
                    paper.id === 'auto' ? 'A' : '',
                  ),
                ),
              ),
              h(Slider, {
                label: t('reader.fontSize', 'Font size'),
                display: `${appearance.fontSize}px`,
                min: 13,
                max: 30,
                step: 1,
                value: appearance.fontSize,
                onChange: (value) => actions.patchSettings({ appearance: { fontSize: value } }),
              }),
              h('div', { style: { height: 8 } }),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 } },
                h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t('reader.pageWidth', 'Page width')),
                h(SegmentedControl, {
                  size: 'sm',
                  value: currentWidthPreset,
                  onChange: applyWidthPreset,
                  options: widthPresets.map((preset) => ({ value: preset.value, label: preset.label })),
                }),
              ),
              h(Slider, {
                label: t('reader.lineHeight', 'Line height'),
                display: Number(appearance.lineHeight).toFixed(2),
                min: 1.2,
                max: 2.6,
                step: 0.05,
                value: appearance.lineHeight,
                onChange: (value) => actions.patchSettings({ appearance: { lineHeight: value } }),
              }),
              h('div', { style: { height: 8 } }),
              h(Slider, {
                label: t('reader.pageWidth', 'Page width'),
                display: `${appearance.pageWidth}px`,
                min: 520,
                max: 1600,
                step: 20,
                value: appearance.pageWidth,
                onChange: (value) => actions.patchSettings({ appearance: { pageWidth: value } }),
              }),
              h('div', { style: { height: 8 } }),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconMore, { size: 13 }), onClick: () => { setAppearOpen(false); actions.openSettings('appearance') } }, t('settings.section.appearance', 'Appearance')),
            ),
          ),
        ),
        h(
          'div',
          { style: { position: 'relative' } },
          h(IconButton, {
            icon: h(IconMore, { size: 18 }),
            label: t('common.more', 'More'),
            active: exportOpen,
            onClick: () => {
              setExportOpen(!exportOpen)
              setAppearOpen(false)
            },
          }),
          h(
            Popover,
            { open: exportOpen, align: 'end' },
            h(
              'div',
              { style: { width: 230 } },
              h(MenuItem, { icon: h(IconDownload, { size: 14 }), onClick: () => { setExportOpen(false); actions.exportDoc('notes') } }, t('reader.export.notes', 'Export reading notes (.md)')),
              h(MenuItem, { icon: h(IconSpark, { size: 14 }), onClick: () => { setExportOpen(false); actions.exportDoc('summary') } }, t('reader.export.summary', 'Export AI summary (.md)')),
              h(MenuItem, { icon: h(IconBook, { size: 14 }), onClick: () => { setExportOpen(false); actions.exportDoc('text', { translate, inlineEntries: inlineMath.entries }) } }, t('reader.export.text', 'Export document text (.md)')),
              h(MenuItem, { icon: h(IconDownload, { size: 14 }), onClick: () => { setExportOpen(false); actions.exportDoc('original') } }, t('reader.export.original', 'Download original file')),
              doc?.format === 'pdf'
                ? h(MenuItem, { icon: h(IconSpark, { size: 14 }), disabled: !!inlineMath.batch, onClick: () => { setExportOpen(false); actions.rerunVisionLayout?.() } }, t('reader.visualRun', 'Rebuild AI visual layout (bypass layout cache)'))
                : null,
              doc?.format === 'pdf'
                ? h(MenuItem, { icon: h(IconSpark, { size: 14 }), disabled: !inlineMath.batch && (!inlineMath.ready || inlineMath.busy > 0 || !!state.layoutProgress), onClick: runInlineBatch }, inlineMath.batch ? t('inline.batchCancel', 'Stop inline typesetting') : t('inline.batchAction', 'Refine inline math in document'))
                : null,
              canRetryLayout
                ? h(MenuItem, { icon: h(IconRefresh, { size: 14 }), disabled: !!inlineMath.batch, onClick: () => { setExportOpen(false); actions.retryVisionLayout?.() } }, t('reader.visualRetry', 'Retry layout'))
                : null,
            ),
          ),
        ),
        h(IconButton, { icon: h(IconPanelLeft, { size: 17 }), label: t('reader.leftPanel', 'Toggle side panel'), active: leftOpen, onClick: toggleLeftPanel }),
        h(IconButton, { icon: h(IconPanelRight, { size: 17 }), label: t('reader.aiPanel', 'Toggle AI assistant'), active: aiOpen, onClick: toggleAiPanel }),
      ),
      mediaPreview ? h(MediaPreview,{key:mediaPreview.blockId,request:mediaPreview,onClose:()=>setMediaPreview(null)}) : null,
      doc?.format === 'pdf' && !state.layoutProgress
        ? h('div', { className: clsx('dr-layout-status', content?.visionLayoutStatus === 'partial' && 'is-partial'), role: 'status', title: (content?.pages ?? []).some(page => page.vision?.request) ? t('reader.visualReceipt', 'Saved layout results are reused when reopening. Recorded route: {model}. Image requests during generation: {count}.', { model: content.visionLayoutModel ?? '', count: content.pages.reduce((sum, page) => sum + (page.vision?.request?.attempts ?? 0), 0) }) : undefined },
          content?.visionLayoutStatus === 'complete' ? `${content.parser?.engine==='mineru' && !content.pages?.some(page=>page.vision?.engine==='vision')?t('parser.complete','Local structure parsing complete'):t('reader.visualComplete', 'AI visual layout complete')} · ${content.visionLayoutPages}/${content.pageCount} ${t('reader.visualPages', 'Visual pages')} · ${content.visionLayoutModel ?? ''}` : content?.visionLayoutStatus === 'partial' ? t('reader.visualPartial', 'Some pages failed. Completed pages are saved. Use Retry layout in More.') : t('reader.visualPending', 'Preparing AI visual layout…'),
        ) : null,
      // ----- stage -------------------------------------------------------------------
      h(
        'div',
        { className: 'dr-reader-stage', 'data-compact': viewportWidth <= 900 ? 'true' : undefined, style: { '--dr-ai-width': `${effectiveRightWidth}px` } },
        leftOpen
          ? h(
              React.Fragment,
              null,
              h(
                'aside',
                { className: 'dr-leftpanel', style: { width: effectiveLeftWidth } },
                h('div', { className: 'dr-leftpanel-tabs' }, h(Tabs, { tabs: leftTabs, value: leftTab, onChange: changeLeftTab, variant: 'underline' })),
                h(
                  'div',
                  { className: 'dr-leftpanel-body' },
                  leftTab === 'toc'
                    ? h(TocPanel, { toc, format: content?.kind, activeSection, onJump: (entry) => jumpTo({ blockId: entry.blockId }), t })
                    : leftTab === 'media' ? h(MediaPanel)
                    : leftTab === 'focus' || leftTab === 'highlights'
                      ? h(AnnotationsPanel, { tab: leftTab })
                      : h(SearchPanel, { t, query: searchQuery, setQuery: setSearchQuery, results: searchResults, searching, onJump: (blockId) => jumpTo({ blockId }), toc, blocks, inputRef:searchInputRef }),
                ),
              ),
              h('div', {
                className: 'dr-panel-resizer',
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': t('reader.resizePanel', 'Resize side panel'),
                title: t('reader.resizePanel', 'Resize side panel'),
                onMouseDown: beginResize('left'),
                onDoubleClick: () => {
                  setLeftWidth(320)
                  actions.patchSettings({ ui: { leftPanelWidth: 320 } })
                },
              }),
            )
          : null,
        h(
          'div',
          { className: 'dr-reader-main' },
          h(
            'div',
            {
              className: 'dr-reader-scroll',
              ref: (element) => {
                scrollRootRef.current = element
                setScrollRoot(element)
              },
              onMouseUp: handleSelectionFromDom,
              onKeyUp: handleSelectionFromDom,
            },
            h(
              'div',
              {
                className: clsx('dr-reader-scroll-inner', appearance.wideMode === true && 'is-wide'),
                ref: (element) => {
                  contentRootRef.current = element
                  setContentRoot(element)
                },
              },
              loading === true || content === null
                ? h(
                    'div',
                    { className: 'dr-empty', style: { paddingTop: 90 } },
                    h(LoadingBlock, { label: loading === true ? t('reader.loading', 'Opening document…') : t('reader.loading', 'Preparing document…') }),
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        icon: h(IconRefresh, { size: 14 }),
                        onClick: () => onExtract?.(),
                        style: { marginTop: 8 },
                      },
                      t('common.retry', 'Retry'),
                    ),
                  )
                : doc?.format === 'epub'
                  ? h(EpubContent, { content })
                  : h(PdfView, { content, mode, pageRequest }),
              h(HighlightLayer),
            ),
          ),
          appearance.showProgress !== false
            ? h(
                'div',
                { className: 'dr-reader-progress', title: t('reader.progress', 'Reading progress') },
                h(ProgressBar, { value: percent, tone: 'brand' }),
                h('span', null, `${Math.round(percent * 100)}%`),
              )
            : null,
        ),
        aiOpen
          ? h(
              React.Fragment,
              null,
              h('div', {
                className: 'dr-panel-resizer',
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': t('reader.resizePanel', 'Resize side panel'),
                title: t('reader.resizePanel', 'Resize side panel'),
                onMouseDown: beginResize('right'),
                onDoubleClick: () => {
                  setRightWidth(400)
                  actions.patchSettings({ ui: { rightPanelWidth: 400 } })
                },
              }),
              h(AiPanel, {
                onClose: () => {
                  setAiOpen(false)
                  actions.patchSettings({ ui: { aiOpen: false } })
                },
              }),
            )
          : null,
      ),
      h(SelectionToolbar),
      activeAnnotation === null
        ? null
        : h(
            'div',
            { className: 'dr-ann-quickbar', onMouseDown: (event) => event.stopPropagation() },
            h('span', { className: 'dr-ann-quick-text', title: activeAnnotation.text ?? '' }, (activeAnnotation.text ?? t('ann.highlight', 'Highlight')).slice(0, 54)),
            ...[t('ann.yellow', 'Yellow'), t('ann.green', 'Green'), t('ann.blue', 'Blue'), t('ann.pink', 'Pink'), t('ann.purple', 'Purple')].map((label, index) =>
              h('button', {
                key: label,
                type: 'button',
                className: 'dr-sel-color',
                'data-color': ['yellow', 'green', 'blue', 'pink', 'purple'][index],
                title: label,
                'aria-label': label,
                onClick: () => actions.updateAnnotation(activeAnnotation.id, { color: ['yellow', 'green', 'blue', 'pink', 'purple'][index] }),
              }),
            ),
            h(IconButton, {
              icon: h(IconHighlighter, { size: 14 }),
              label: t('ann.highlight', 'Highlight'),
              size: 'sm',
              'aria-pressed': activeAnnotation.style !== 'underline',
              onClick: () => actions.updateAnnotation(activeAnnotation.id, { style: 'highlight' }),
            }),
            h(IconButton, {
              icon: h(IconUnderline, { size: 14 }),
              label: t('ann.underline', 'Underline'),
              size: 'sm',
              'aria-pressed': activeAnnotation.style === 'underline',
              onClick: () => actions.updateAnnotation(activeAnnotation.id, { style: 'underline' }),
            }),
            h(IconButton, {
              icon: h(IconNote, { size: 14 }),
              label: t('ann.addNote', 'Add note'),
              size: 'sm',
              onClick: () => {
                setNoteRequest({id:activeAnnotation.id,nonce:Date.now()})
              },
            }),
            h(IconButton, {
              icon: h(IconRefresh, { size: 14 }),
              label: t('ann.undo', 'Undo (Ctrl+Z)'),
              size: 'sm',
              onClick: () => actions.undoAnnotations(),
            }),
            h(IconButton, {
              icon: h(IconTrash, { size: 14 }),
              label: t('common.delete', 'Delete'),
              size: 'sm',
              onClick: () => {
                actions.removeAnnotation(activeAnnotation.id)
                setActiveAnnId(null)
                actions.toast(t('ann.deleted', 'Highlight deleted'), 'success')
              },
            }),
            h(IconButton, {
              icon: h(IconClose, { size: 14 }),
              label: t('common.close', 'Close'),
              size: 'sm',
              onClick: () => setActiveAnnId(null),
            }),
          ),
    ),
  )
}

// The reader context provider lives in store.jsx (ReaderContext); ReaderShell wraps its tree in it.

/** Table-of-contents panel. */
function TocPanel({ toc, format, activeSection, onJump, t }) {
  const levels = React.useMemo(() => outlineLevels(toc, format), [toc, format])
  if (toc.length === 0) {
    return h(EmptyState, { icon: h(IconList, { size: 22 }), title: t('reader.noToc', 'No table of contents'), body: '' })
  }
  return h(
    'nav',
    { className: 'dr-toc', 'aria-label': t('reader.toc', 'Contents') },
    toc.map((entry, index) => {
      const level = levels[index]
      const active = activeSection?.id != null ? activeSection.id === entry.id : Boolean(entry.blockId && activeSection?.blockId === entry.blockId)
      return h(
        'button',
        {
          key: entry.id ?? index,
          type: 'button',
          className: clsx('dr-toc-item', active && 'is-active'),
          style: { '--dr-toc-indent': ((level - 1) * 14) + 'px' },
          'data-toc-level': level,
          'aria-current': active ? 'location' : undefined,
          disabled: !entry.blockId,
          onClick: () => onJump(entry),
          title: entry.title,
        },
        h('span', { className: 'dr-toc-item-label' }, entry.title ?? ''),
      )
    }),
  )
}

/** Full-text search panel. */
function SearchPanel({ t, query, setQuery, results, searching, onJump, toc, blocks, inputRef }) {
  const [selected,setSelected]=React.useState(-1)
  React.useEffect(()=>setSelected(-1),[query])
  const blockLabels = React.useMemo(() => {
    const labels = new Map()
    for (const entry of toc) {
      if (typeof entry.blockId !== 'string') continue
      labels.set(entry.blockId, entry.title)
    }
    return labels
  }, [toc])
  const labelFor = React.useCallback(
    (blockId) => {
      if (blockLabels.has(blockId)) return blockLabels.get(blockId)
      const index = blocks.findIndex((block) => block.id === blockId)
      if (index >= 0) {
        for (let cursor = index; cursor >= 0; cursor--) {
          const found = blockLabels.get(blocks[cursor]?.id)
          if (found !== undefined) return found
        }
      }
      return ''
    },
    [blockLabels, blocks],
  )
  return h(
    'div',
    { style: { padding: '4px 4px' } },
    h(Input, {
      ref:inputRef,
      'aria-label':t('reader.search.placeholder','Search in document…'),
      value: query,
      onKeyDown:event=>{if(event.key==='Enter'&&results.length){event.preventDefault();const next=selected<0?(event.shiftKey?results.length-1:0):(selected+(event.shiftKey?-1:1)+results.length)%results.length;setSelected(next);onJump(results[next].blockId)}},
      onChange: (event) => setQuery(event.target.value),
      placeholder: t('reader.search.placeholder', 'Search in document…'),
      leadIcon: h(IconSearch, { size: 14 }),
    }),
    h(
      'div',
      { style: { fontSize: 11.5, color: 'var(--dr-paper-muted)', padding: '8px 4px 4px' } },
      searching ? t('common.loading', 'Loading…') : query.trim() === '' ? '' : results.length === 0 ? t('reader.search.noResults', 'No matches') : results.length>=80?t('reader.search.limited','First 80 matches; narrow your search.'):t('reader.search.results', '{count} matches', { count: results.length }),
    ),
    h(
      'div',
      null,
      results.map((result, index) =>
        h(
          'button',
          { key: `${result.blockId}-${index}`, type: 'button', className: 'dr-search-hit', 'aria-current':selected===index?'true':undefined, onClick: () => {setSelected(index);onJump(result.blockId)} },
          h('span', null, result.before, h('mark', null, result.match), result.after),
          h('span', { className: 'dr-search-hit-meta' }, (result.translated?t('reader.search.translation','Translation')+' · ':'')+(labelFor(result.blockId) || (result.page !== undefined ? `p.${result.page}` : ''))),
        ),
      ),
    ),
  )
}
