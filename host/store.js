// Persistent reader store: settings, library metadata, per-document content/annotations/aux,
// the translation cache, uploads and diagnostics. All AI output that a re-open would
// otherwise re-generate is persisted here, keyed by document and content hash.
import { copyFile, readFile, readdir, rename, stat, mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DEEPSEEK_ACCOUNT_ROUTE } from '../shared/model-ref.js'
import { DEFAULT_LIBRE_URL, normalizeLibreUrl, TRANSLATION_ENGINES } from '../shared/translation-engines.js'
import {
  appendJsonLine,
  ensureReaderDirs,
  readJsonFile,
  readerDataDir,
  readerPaths,
  removeFile,
  removeTree,
  writeBytesFile,
  writeJsonFile,
} from './paths.js'
import {
  byteLength,
  clampNumber,
  contentTypeFor,
  deepMerge,
  isPlainObject,
  newId,
  nowMs,
  plainObject,
  sha256,
  truncateBytes,
} from './util.js'

const LIBRARY_VERSION = 1

/** Default settings; deep-merged with whatever the user saved. */
export function defaultSettings() {
  return {
    appearance: {
      themeMode: 'system',
      paper: 'auto',
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.8,
      paragraphSpacing: 1.0,
      pageWidth: 1200,
      justify: true,
      hyphenate: false,
      showProgress: true,
      wideMode: true,
      layoutVersion: 2,
    },
    ai: {
      active: {
        chat: { providerId: 'dsh', model: '' },
        translate: { providerId: 'dsh', model: '' },
        vision: { providerId: 'dsh', model: '' },
      },
      targetLang: 'zh-CN',
      translate: { mode: 'bilingual', batchSize: 6, auto: true, concurrency: 2, myMemorySource: 'en', libreUrl: DEFAULT_LIBRE_URL, libreKey: '' },
      chat: { contextMode: 'doc', maxContextChars: 48000 },
      providers: [],
    },
    parser: { engine: 'auto', python: '', tier: 'standard' },
    zotero: { enabled: true, apiKey: '', userId: '', local: false, autoSync: false, lastSyncAt: undefined },
    ui: {
      lastDocId: undefined,
      openDocIds: [],
      libraryView: 'grid',
      sidebarOpen: true,
      aiOpen: false,
      activeLeftTab: 'toc',
      leftPanelWidth: 320,
      rightPanelWidth: 400,
      uiLang: 'auto',
    },
  }
}

const APPEARANCE_ENUMS = {
  themeMode: ['system', 'light', 'dark'],
  paper: ['auto', 'light', 'sepia', 'dark', 'green'],
  fontFamily: ['serif', 'sans', 'kai'],
}
const LEFT_TABS = ['toc', 'highlights', 'notes', 'search']

function normalizeProvider(raw, index) {
  const src = plainObject(raw)
  const id = typeof src.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(src.id) ? src.id : `custom-${index + 1}`
  const baseURL = typeof src.baseURL === 'string' ? src.baseURL.trim().replace(/\/+$/, '') : ''
  return {
    id,
    name: typeof src.name === 'string' && src.name.trim() !== '' ? src.name.trim().slice(0, 60) : id,
    kind: 'openai',
    baseURL,
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.slice(0, 400) : '',
    models: Array.isArray(src.models)
      ? [...new Set(src.models.filter((m) => typeof m === 'string' && m.trim() !== '').map((m) => m.trim().slice(0, 120)))].slice(0, 60)
      : [],
    apiProtocol: src.apiProtocol === 'anthropic' ? 'anthropic' : 'openai',
  }
}

/** Normalize settings, dropping unknown/invalid fields and clamping appearance values. */
export function normalizeSettings(raw) {
  const base = defaultSettings()
  const src = plainObject(raw)
  const appearanceIn = plainObject(src.appearance)
  const appearance = { ...base.appearance }
  for (const [key, values] of Object.entries(APPEARANCE_ENUMS)) {
    if (typeof appearanceIn[key] === 'string' && values.includes(appearanceIn[key])) appearance[key] = appearanceIn[key]
  }
  if (typeof appearanceIn.justify === 'boolean') appearance.justify = appearanceIn.justify
  if (typeof appearanceIn.hyphenate === 'boolean') appearance.hyphenate = appearanceIn.hyphenate
  if (typeof appearanceIn.showProgress === 'boolean') appearance.showProgress = appearanceIn.showProgress
  if (typeof appearanceIn.wideMode === 'boolean') appearance.wideMode = appearanceIn.wideMode
  appearance.fontSize = clampNumber(appearanceIn.fontSize, 13, 32, base.appearance.fontSize)
  appearance.lineHeight = clampNumber(appearanceIn.lineHeight, 1.2, 2.6, base.appearance.lineHeight)
  appearance.paragraphSpacing = clampNumber(appearanceIn.paragraphSpacing, 0.2, 2.5, base.appearance.paragraphSpacing)
  appearance.pageWidth = clampNumber(appearanceIn.pageWidth, 520, 1600, base.appearance.pageWidth)
  // One-time layout migration: the old default (760–920px centred column) left large empty side
  // margins. Existing profiles that never stored a layout version adopt the full-width layout once.
  const savedLayoutVersion = Number(appearanceIn.layoutVersion) || 0
  if (savedLayoutVersion < 2) {
    appearance.pageWidth = 1600
    appearance.wideMode = true
  }
  appearance.layoutVersion = 2

  const aiIn = plainObject(src.ai)
  const providerList = Array.isArray(aiIn.providers) ? aiIn.providers.slice(0, 20) : []
  const ai = {
    ...base.ai,
    providers: providerList.map(normalizeProvider),
  }
  const active = plainObject(aiIn.active)
  for (const task of ['chat', 'translate', 'vision']) {
    const ref = plainObject(active[task])
    const providerId = typeof ref.providerId === 'string' && ref.providerId !== '' ? ref.providerId : 'dsh'
    const model = typeof ref.model === 'string' ? ref.model.trim().slice(0, 120) : ''
    const engine = Object.hasOwn(TRANSLATION_ENGINES, providerId)
    const knownProvider = providerId === 'dsh' || providerId === DEEPSEEK_ACCOUNT_ROUTE || (task === 'translate' && engine) || ai.providers.some(p => p.id === providerId)
    ai.active[task] = { providerId: knownProvider ? providerId : 'dsh', model: engine ? '' : model }
  }
  if (typeof aiIn.targetLang === 'string' && aiIn.targetLang.length <= 20) ai.targetLang = aiIn.targetLang
  const translateIn = plainObject(aiIn.translate)
  ai.translate = {
    mode: translateIn.mode === 'replace' ? 'replace' : 'bilingual',
    batchSize: clampNumber(translateIn.batchSize, 1, 12, 6),
    auto: typeof translateIn.auto === 'boolean' ? translateIn.auto : true,
    concurrency: clampNumber(translateIn.concurrency, 1, 4, 2),
    myMemorySource: typeof translateIn.myMemorySource === 'string' && /^[a-z]{2,3}(?:-[a-z]{2,8})?$/i.test(translateIn.myMemorySource) ? translateIn.myMemorySource : base.ai.translate.myMemorySource,
    libreUrl: typeof translateIn.libreUrl === 'string' ? normalizeLibreUrl(translateIn.libreUrl) : base.ai.translate.libreUrl,
    libreKey: typeof translateIn.libreKey === 'string' ? translateIn.libreKey.trim().slice(0, 400) : '',
  }
  const chatIn = plainObject(aiIn.chat)
  ai.chat = {
    contextMode: ['doc', 'section', 'selection'].includes(chatIn.contextMode) ? chatIn.contextMode : 'doc',
    maxContextChars: clampNumber(chatIn.maxContextChars, 2000, 200000, 48000),
  }

  const zoteroIn = plainObject(src.zotero)
  const zotero = {
    enabled: typeof zoteroIn.enabled === 'boolean' ? zoteroIn.enabled : true,
    apiKey: typeof zoteroIn.apiKey === 'string' ? zoteroIn.apiKey.trim().slice(0, 200) : '',
    userId: typeof zoteroIn.userId === 'string' ? zoteroIn.userId.trim().slice(0, 40) : '',
    local: typeof zoteroIn.local === 'boolean' ? zoteroIn.local : false,
    autoSync: typeof zoteroIn.autoSync === 'boolean' ? zoteroIn.autoSync : false,
    lastSyncAt: typeof zoteroIn.lastSyncAt === 'number' ? zoteroIn.lastSyncAt : undefined,
  }

  const uiIn = plainObject(src.ui)
  const ui = { ...base.ui }
  if (typeof uiIn.lastDocId === 'string') ui.lastDocId = uiIn.lastDocId
  if (Array.isArray(uiIn.openDocIds)) ui.openDocIds = [...new Set(uiIn.openDocIds.filter(id=>typeof id==='string'&&id&&id.length<=100))].slice(0,32)
  if (uiIn.libraryView === 'list' || uiIn.libraryView === 'grid') ui.libraryView = uiIn.libraryView
  if (typeof uiIn.sidebarOpen === 'boolean') ui.sidebarOpen = uiIn.sidebarOpen
  if (typeof uiIn.aiOpen === 'boolean') ui.aiOpen = uiIn.aiOpen
  if (LEFT_TABS.includes(uiIn.activeLeftTab)) ui.activeLeftTab = uiIn.activeLeftTab
  if (uiIn.uiLang === 'en' || uiIn.uiLang === 'zh-CN' || uiIn.uiLang === 'auto') ui.uiLang = uiIn.uiLang
  ui.leftPanelWidth = clampNumber(uiIn.leftPanelWidth, 220, 560, base.ui.leftPanelWidth)
  ui.rightPanelWidth = clampNumber(uiIn.rightPanelWidth, 300, 640, base.ui.rightPanelWidth)

  const parserIn=plainObject(src.parser)
  const parser={engine:['auto','mineru','vision'].includes(parserIn.engine)?parserIn.engine:'auto',python:typeof parserIn.python==='string'?parserIn.python.trim().slice(0,1000):'',tier:['basic','standard'].includes(parserIn.tier)?parserIn.tier:'standard'}
  return { appearance, ai, zotero, ui, parser }
}

function normalizeDocMeta(raw) {
  const src = plainObject(raw)
  if (typeof src.id !== 'string' || src.id === '') return null
  const format = src.format === 'epub' ? 'epub' : 'pdf'
  const progress = plainObject(src.progress)
  return {
    id: src.id,
    format,
    title: typeof src.title === 'string' && src.title.trim() !== '' ? src.title.trim().slice(0, 400) : 'Untitled',
    author: typeof src.author === 'string' ? src.author.slice(0, 300) : '',
    size: clampNumber(src.size, 0, Number.MAX_SAFE_INTEGER, 0),
    addedAt: clampNumber(src.addedAt, 0, Number.MAX_SAFE_INTEGER, nowMs()),
    updatedAt: clampNumber(src.updatedAt, 0, Number.MAX_SAFE_INTEGER, nowMs()),
    lastOpenedAt: typeof src.lastOpenedAt === 'number' ? src.lastOpenedAt : undefined,
    pageCount: typeof src.pageCount === 'number' ? src.pageCount : undefined,
    chapterCount: typeof src.chapterCount === 'number' ? src.chapterCount : undefined,
    cover: src.cover === true,
    progress: {
      percent: clampNumber(progress.percent, 0, 1, 0),
      locator: typeof progress.locator === 'string' ? progress.locator.slice(0, 400) : undefined,
      label: typeof progress.label === 'string' ? progress.label.slice(0, 200) : undefined,
    },
    favorite: src.favorite === true,
    tags: Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string').slice(0, 30) : [],
    folderId: typeof src.folderId === 'string' && src.folderId !== '' ? src.folderId.slice(0, 64) : null,
    source: src.source === 'zotero' ? 'zotero' : 'local',
    zoteroKey: typeof src.zoteroKey === 'string' ? src.zoteroKey : undefined,
    contentVersion: typeof src.contentVersion === 'number' ? src.contentVersion : 0,
    stats: isPlainObject(src.stats)
      ? {
          words: clampNumber(src.stats.words, 0, Number.MAX_SAFE_INTEGER, 0),
          translatedChars: clampNumber(src.stats.translatedChars, 0, Number.MAX_SAFE_INTEGER, 0),
          askCount: clampNumber(src.stats.askCount, 0, Number.MAX_SAFE_INTEGER, 0),
          tokens: clampNumber(src.stats.tokens, 0, Number.MAX_SAFE_INTEGER, 0),
        }
      : undefined,
  }
}

function normalizeAnnotation(raw, docId) {
  const src = plainObject(raw)
  if (typeof src.id !== 'string' || src.id === '') return null
  const colors = ['yellow', 'green', 'blue', 'pink', 'purple']
  const color = colors.includes(src.color) ? src.color : 'yellow'
  const target = plainObject(src.target)
  let normalizedTarget = null
  if (target.kind === 'reflow' && typeof target.blockId === 'string') {
    const start = clampNumber(target.start, 0, 10_000_000, 0)
    const end = clampNumber(target.end, start, 10_000_000, start)
    if (end > start) normalizedTarget = { kind: 'reflow', blockId: target.blockId.slice(0, 200), start, end,
      ...(target.layer==='translation'?{layer:'translation',lang:typeof target.lang==='string'?target.lang.slice(0,30):''}:{}),
    }
  } else if (target.kind === 'pdf' && typeof target.page === 'number' && Array.isArray(target.rects)) {
    const rects = target.rects
      .slice(0, 60)
      .map((r) => {
        const rect = plainObject(r)
        return {
          x: clampNumber(rect.x, 0, 1, 0),
          y: clampNumber(rect.y, 0, 1, 0),
          w: clampNumber(rect.w, 0, 1, 0),
          h: clampNumber(rect.h, 0, 1, 0),
        }
      })
      .filter((r) => r.w > 0 && r.h > 0)
    if (rects.length > 0) normalizedTarget = { kind: 'pdf', page: Math.round(clampNumber(target.page, 0, 100000, 0)), rects }
  }
  if (normalizedTarget === null) return null
  const ts = nowMs()
  return {
    id: src.id.slice(0, 64),
    docId,
    color,
    text: truncateBytes(typeof src.text === 'string' ? src.text : '', 20000),
    note: truncateBytes(typeof src.note === 'string' ? src.note : '', 20000),
    createdAt: clampNumber(src.createdAt, 0, Number.MAX_SAFE_INTEGER, ts),
    updatedAt: clampNumber(src.updatedAt, 0, Number.MAX_SAFE_INTEGER, ts),
    target: normalizedTarget,
    style: src.style === 'underline' ? 'underline' : 'highlight',
  }
}

/** Normalize one folder record (one flat level; `parentId` reserved for future nesting). */
function normalizeFolder(raw) {
  const src = plainObject(raw)
  if (typeof src.id !== 'string' || src.id === '') return null
  const name = typeof src.name === 'string' ? src.name.trim().slice(0, 80) : ''
  if (name === '') return null
  return {
    id: src.id.slice(0, 64),
    name,
    parentId: typeof src.parentId === 'string' && src.parentId !== '' ? src.parentId.slice(0, 64) : null,
    createdAt: clampNumber(src.createdAt, 0, Number.MAX_SAFE_INTEGER, nowMs()),
  }
}

/** The reader's persistent state. One instance per host plugin activation. */
export class ReaderStore {
  constructor(dataDir = readerDataDir()) {
    this.paths = readerPaths(dataDir)
    this.dataDir = dataDir
    this.ready = false
    this.library = { version: LIBRARY_VERSION, docs: [], folders: [] }
    this.settings = defaultSettings()
    this.libraryLoaded = false
    this.settingsLoaded = false
    this.initializing = null
  }

  /** Load library + settings once; cleans stale temp uploads in the background. */
  async init() {
    if (this.ready) return this
    if (this.initializing !== null) return this.initializing
    this.initializing = (async () => {
      await ensureReaderDirs(this.paths)
      const [libraryRaw, settingsRaw] = await Promise.all([
        readJsonFile(this.paths.library, null),
        readJsonFile(this.paths.settings, null),
      ])
      const record = plainObject(libraryRaw)
      const docs = Array.isArray(record.docs) ? record.docs : []
      const rawFolders = Array.isArray(record.folders) ? record.folders : []
      const folders = rawFolders.map(normalizeFolder).filter((folder) => folder !== null)
      const folderIds = new Set(folders.map((folder) => folder.id))
      this.library = {
        version: LIBRARY_VERSION,
        docs: docs.map(normalizeDocMeta).filter((doc) => doc !== null),
        folders,
      }
      // Drop folder assignments whose folder disappeared (hand-edited files, interrupted writes).
      for (const doc of this.library.docs) if (doc.folderId !== null && !folderIds.has(doc.folderId)) doc.folderId = null
      this.settings = normalizeSettings(settingsRaw)
      this.libraryLoaded = true
      this.settingsLoaded = true
      this.ready = true
      this.cleanupTemp().catch(() => undefined)
      return this
    })()
    return this.initializing
  }

  async cleanupTemp() {
    try {
      const entries = await readdir(this.paths.tmp)
      const cutoff = nowMs() - 24 * 60 * 60 * 1000
      for (const name of entries) {
        const file = join(this.paths.tmp, name)
        try {
          const info = await stat(file)
          if (info.mtimeMs < cutoff) await removeFile(file)
        } catch {
          /* raced */
        }
      }
    } catch {
      /* nothing to clean */
    }
  }

  // ----- settings ------------------------------------------------------------------

  getSettings() {
    return this.settings
  }

  /** Deep-merge a settings patch, normalize, and persist. */
  async patchSettings(patch) {
    this.settings = normalizeSettings(deepMerge(this.settings, plainObject(patch)))
    await writeJsonFile(this.paths.settings, this.settings)
    return this.settings
  }

  // ----- library -------------------------------------------------------------------

  listDocs() {
    return [...this.library.docs].sort((a, b) => {
      const aTime = a.lastOpenedAt ?? a.updatedAt
      const bTime = b.lastOpenedAt ?? b.updatedAt
      return bTime - aTime
    })
  }

  getDoc(id) {
    return this.library.docs.find((doc) => doc.id === id) ?? null
  }

  findByZoteroKey(key) {
    return this.library.docs.find((doc) => doc.zoteroKey === key) ?? null
  }

  async persistLibrary() {
    await writeJsonFile(this.paths.library, this.library)
  }

  // ----- folders -------------------------------------------------------------------

  /** Every folder, oldest first. */
  listFolders() {
    return [...this.library.folders].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
  }

  getFolder(id) {
    return this.library.folders.find((folder) => folder.id === id) ?? null
  }

  /** Create a folder (idempotent for the same name); returns the folder. */
  async createFolder(name, parentId = null) {
    const clean = String(name ?? '').trim().slice(0, 80)
    if (clean === '') throw new Error('folder name is required')
    const parent = parentId === null || parentId === undefined || parentId === '' ? null : this.getFolder(String(parentId))
    if (parentId !== null && parentId !== undefined && parentId !== '' && parent === null) throw new Error(`folder ${parentId} not found`)
    const duplicate = this.library.folders.find((folder) => folder.name.toLowerCase() === clean.toLowerCase() && (folder.parentId ?? null) === (parent?.id ?? null))
    if (duplicate !== undefined) return duplicate
    const folder = { id: newId(12), name: clean, parentId: parent?.id ?? null, createdAt: nowMs() }
    this.library.folders.push(folder)
    await this.persistLibrary()
    return folder
  }

  async renameFolder(id, name) {
    const folder = this.getFolder(id)
    if (folder === null) throw new Error(`folder ${id} not found`)
    const clean = String(name ?? '').trim().slice(0, 80)
    if (clean === '') throw new Error('folder name is required')
    folder.name = clean
    await this.persistLibrary()
    return folder
  }

  /** Remove a folder; its documents move back to the library root. */
  async removeFolder(id) {
    const folder = this.getFolder(id)
    if (folder === null) throw new Error(`folder ${id} not found`)
    this.library.folders = this.library.folders.filter((entry) => entry.id !== id)
    let moved = 0
    for (const doc of this.library.docs) {
      if (doc.folderId === id) {
        doc.folderId = null
        doc.updatedAt = nowMs()
        moved++
      }
    }
    await this.persistLibrary()
    return { moved }
  }

  /** Move one document into a folder, or to the library root with `folderId = null`. */
  async moveDoc(docId, folderId) {
    const doc = this.getDoc(docId)
    if (doc === null) throw new Error(`document ${docId} not found`)
    const target = folderId === null || folderId === undefined || folderId === '' ? null : this.getFolder(String(folderId))
    if (folderId !== null && folderId !== undefined && folderId !== '' && target === null) throw new Error(`folder ${folderId} not found`)
    doc.folderId = target?.id ?? null
    doc.updatedAt = nowMs()
    await this.persistLibrary()
    return doc
  }

  /**
   * Register a stored original file as a library document.
   * @param {{ id?:string, storedPath:string, name:string, format:'pdf'|'epub', meta?:object,
   *           content?:object|null, thumbDataUrl?:string|null, source?:'local'|'zotero', zoteroKey?:string,
   *           size?:number }} input
   */
  async addDoc(input) {
    const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(input.id) ? input.id : newId(16)
    const format = input.format === 'epub' ? 'epub' : 'pdf'
    const meta = plainObject(input.meta)
    const docDir = this.paths.docDir(id)
    await mkdir(docDir, { recursive: true })
    const destination = this.paths.original(id, format)
    try {
      await rename(input.storedPath, destination)
    } catch {
      await copyFile(input.storedPath, destination)
      await removeFile(input.storedPath)
    }
    const info = await stat(destination).catch(() => null)
    // Derive structural counts from the client-produced content when the caller did not pass them,
    // so a freshly imported EPUB/PDF shows its chapter/page counts without re-opening the document.
    const storedContent = input.content !== undefined && input.content !== null ? plainObject(input.content) : null
    const derivedPageCount = typeof meta.pageCount === 'number' ? meta.pageCount : typeof storedContent?.pageCount === 'number' ? storedContent.pageCount : undefined
    const derivedChapterCount =
      typeof meta.chapterCount === 'number'
        ? meta.chapterCount
        : Array.isArray(storedContent?.toc)
          ? storedContent.toc.length
          : undefined
    const doc = normalizeDocMeta({
      id,
      format,
      title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : basename(input.name ?? `document.${format}`, extname(input.name ?? '')),
      author: meta.author,
      size: info?.size ?? input.size ?? 0,
      addedAt: nowMs(),
      updatedAt: nowMs(),
      lastOpenedAt: nowMs(),
      pageCount: derivedPageCount,
      chapterCount: derivedChapterCount,
      cover: false,
      progress: { percent: 0 },
      favorite: false,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      folderId: typeof input.folderId === 'string' && input.folderId !== '' ? input.folderId : null,
      source: input.source === 'zotero' ? 'zotero' : 'local',
      zoteroKey: input.zoteroKey,
      contentVersion: input.content === undefined || input.content === null ? 0 : 1,
      stats: {},
    })
    if (doc === null) throw new Error('failed to register document')
    if (input.content !== undefined && input.content !== null) {
      await writeJsonFile(this.paths.content(id), { version: 1, savedAt: nowMs(), content: input.content })
    }
    if (typeof input.thumbDataUrl === 'string' && input.thumbDataUrl.startsWith('data:image/')) {
      const thumb = await this.saveCoverFromDataUrl(id, input.thumbDataUrl)
      doc.cover = thumb
    }
    this.library.docs.push(doc)
    await this.persistLibrary()
    return doc
  }

  async saveCoverFromDataUrl(id, dataUrl) {
    try {
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return false
      const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
      if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return false
      await writeBytesFile(this.paths.thumb(id), bytes)
      return true
    } catch {
      return false
    }
  }

  async setCoverFromDataUrl(id, dataUrl) {
    const doc = this.getDoc(id)
    if (doc === null) return null
    doc.cover = await this.saveCoverFromDataUrl(id, dataUrl)
    doc.updatedAt = nowMs()
    await this.persistLibrary()
    return doc
  }

  /** Patch mutable document metadata (whitelisted fields only). */
  async updateDoc(id, patch) {
    const doc = this.getDoc(id)
    if (doc === null) throw new Error(`document ${id} not found`)
    const src = plainObject(patch)
    if (typeof src.title === 'string' && src.title.trim() !== '') doc.title = src.title.trim().slice(0, 400)
    if (typeof src.author === 'string') doc.author = src.author.slice(0, 300)
    if (Array.isArray(src.tags)) doc.tags = src.tags.filter((t) => typeof t === 'string').slice(0, 30)
    if (typeof src.favorite === 'boolean') doc.favorite = src.favorite
    if (src.folderId === null || typeof src.folderId === 'string') {
      const target = src.folderId === null ? null : this.getFolder(src.folderId)
      if (target !== null || src.folderId === null) doc.folderId = target?.id ?? null
    }
    if (typeof src.pageCount === 'number') doc.pageCount = src.pageCount
    if (typeof src.chapterCount === 'number') doc.chapterCount = src.chapterCount
    if (isPlainObject(src.progress)) {
      doc.progress = {
        percent: clampNumber(src.progress.percent, 0, 1, doc.progress.percent),
        locator: typeof src.progress.locator === 'string' ? src.progress.locator.slice(0, 400) : doc.progress.locator,
        label: typeof src.progress.label === 'string' ? src.progress.label.slice(0, 200) : doc.progress.label,
      }
    }
    if (isPlainObject(src.stats)) {
      doc.stats = {
        words: clampNumber(src.stats.words, 0, Number.MAX_SAFE_INTEGER, doc.stats?.words ?? 0),
        translatedChars: clampNumber(src.stats.translatedChars, 0, Number.MAX_SAFE_INTEGER, doc.stats?.translatedChars ?? 0),
        askCount: clampNumber(src.stats.askCount, 0, Number.MAX_SAFE_INTEGER, doc.stats?.askCount ?? 0),
        tokens: clampNumber(src.stats.tokens, 0, Number.MAX_SAFE_INTEGER, doc.stats?.tokens ?? 0),
      }
    }
    if (src.touch === true) doc.lastOpenedAt = nowMs()
    doc.updatedAt = nowMs()
    await this.persistLibrary()
    return doc
  }

  async removeDoc(id) {
    const index = this.library.docs.findIndex((doc) => doc.id === id)
    if (index < 0) throw new Error(`document ${id} not found`)
    this.library.docs.splice(index, 1)
    await this.persistLibrary()
    await removeTree(this.paths.docDir(id))
    return true
  }

  originalPath(id) {
    const doc = this.getDoc(id)
    if (doc === null) return null
    const path = this.paths.original(id, doc.format)
    return path
  }

  async getContent(id) {
    const doc = this.getDoc(id)
    if (doc === null) return null
    const raw = await readJsonFile(this.paths.content(id), null)
    const record = plainObject(raw)
    const content = plainObject(record.content)
    if (content === null || Object.keys(content).length === 0) return null
    return content
  }

  /**
   * Persist a client-produced content extraction; bumps contentVersion.
   *
   * The translation cache is intentionally kept: it is keyed by model + language + source-text
   * hash, so re-extraction (e.g. after an engine heuristic upgrade) reuses translations for
   * unchanged passages instead of spending the same tokens again.
   */
  async saveContent(id, content) {
    const doc = this.getDoc(id)
    if (doc === null) throw new Error(`document ${id} not found`)
    await writeJsonFile(this.paths.content(id), { version: 1, savedAt: nowMs(), content })
    doc.contentVersion = (doc.contentVersion ?? 0) + 1
    doc.updatedAt = nowMs()
    const meta = plainObject(content.meta)
    if (typeof meta.title === 'string' && meta.title.trim() !== '' && (doc.title === 'Untitled' || doc.title === '')) {
      doc.title = meta.title.trim().slice(0, 400)
    }
    if (typeof meta.author === 'string' && doc.author === '') doc.author = meta.author.slice(0, 300)
    if (typeof content.pageCount === 'number') doc.pageCount = content.pageCount
    if (Array.isArray(content.toc)) doc.chapterCount = content.toc.length
    if (content.thumbDataUrl !== undefined && typeof content.thumbDataUrl === 'string') {
      doc.cover = await this.saveCoverFromDataUrl(id, content.thumbDataUrl)
    }
    await this.persistLibrary()
    return doc
  }

  // ----- annotations ---------------------------------------------------------------

  async getInlineMath(id) {
    if (!this.getDoc(id)) throw new Error('document not found')
    return plainObject((await readJsonFile(join(this.paths.docDir(id), 'inline-math.json'), {})).blocks)
  }

  async setInlineMath(id, blockId, value) {
    if (!this.getDoc(id)) throw new Error('document not found')
    this.inlineWrites ??= new Map()
    const before = this.inlineWrites.get(id) ?? Promise.resolve()
    const operation = before.catch(() => {}).then(async () => {
      const blocks = await this.getInlineMath(id)
      blocks[blockId] = value
      await writeJsonFile(join(this.paths.docDir(id), 'inline-math.json'), { version: 1, blocks })
      return value
    })
    this.inlineWrites.set(id, operation)
    try { return await operation } finally { if (this.inlineWrites.get(id) === operation) this.inlineWrites.delete(id) }
  }

  /** Keep a one-generation backup of the current content before a destructive refinement. */
  async backupContent(id) {
    const doc = this.getDoc(id)
    if (doc === null) throw new Error(`document ${id} not found`)
    const raw = await readJsonFile(this.paths.content(id), null)
    if (raw === null) throw new Error('document has no parsed content to back up')
    await writeJsonFile(join(this.paths.docDir(id), 'content.backup.json'), raw)
    return true
  }

  /** Restore the pre-refinement content backup (used by "undo AI layout"). */
  async restoreContent(id) {
    const doc = this.getDoc(id)
    if (doc === null) throw new Error(`document ${id} not found`)
    const raw = await readJsonFile(join(this.paths.docDir(id), 'content.backup.json'), null)
    const content = plainObject(raw).content
    if (!isPlainObject(content)) throw new Error('no content backup exists for this document')
    await writeJsonFile(this.paths.content(id), { version: 1, savedAt: nowMs(), content })
    doc.contentVersion = (doc.contentVersion ?? 0) + 1
    doc.updatedAt = nowMs()
    if (typeof content.pageCount === 'number') doc.pageCount = content.pageCount
    if (Array.isArray(content.toc)) doc.chapterCount = content.toc.length
    await this.persistLibrary()
    return content
  }

  async getAnnotations(id) {
    const raw = await readJsonFile(this.paths.annotations(id), null)
    const list = Array.isArray(plainObject(raw).annotations) ? plainObject(raw).annotations : []
    return list.map((ann) => normalizeAnnotation(ann, id)).filter((ann) => ann !== null).slice(0, 5000)
  }

  async saveAnnotations(id, annotations) {
    const doc = this.getDoc(id)
    if (doc === null) throw new Error(`document ${id} not found`)
    const list = (Array.isArray(annotations) ? annotations : [])
      .map((ann) => normalizeAnnotation(ann, id))
      .filter((ann) => ann !== null)
      .slice(0, 5000)
    await writeJsonFile(this.paths.annotations(id), { version: 1, savedAt: nowMs(), annotations: list })
    doc.updatedAt = nowMs()
    await this.persistLibrary()
    return list
  }

  // ----- auxiliary AI output (summary / key points / chat history / stats) -----------

  async getAux(id) {
    const raw = await readJsonFile(this.paths.aux(id), null)
    const aux = plainObject(raw).aux
    return isPlainObject(aux) ? aux : {}
  }

  /** Merge auxiliary AI output; lists replace, objects merge, unknown keys are dropped at the cap. */
  async mergeAux(id, patch) {
    this.auxWrites ??= new Map()
    const previous = this.auxWrites.get(id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      if (this.getDoc(id) === null) throw new Error(`document ${id} not found`)
      const aux = await this.getAux(id)
      const src = plainObject(typeof patch === 'function' ? patch(aux) : patch)
      for (const [key, value] of Object.entries(src)) {
        if (!['summary', 'keypoints', 'chat', 'glossary', 'translationStats', 'lastModel'].includes(key)) continue
        if (key === 'chat') {
          if (Array.isArray(value)) {
            aux.chat = value.slice(-400).map(msg => {
              const m = plainObject(msg)
              return {
                id: typeof m.id === 'string' ? m.id : newId(10),
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: truncateBytes(typeof m.content === 'string' ? m.content : '', 200000),
                createdAt: typeof m.createdAt === 'number' ? m.createdAt : nowMs(),
                quote: typeof m.quote === 'string' ? truncateBytes(m.quote, 4000) : undefined,
                model: typeof m.model === 'string' ? m.model : undefined,
              }
            })
          }
        } else {
          aux[key] = value
        }
      }
      await writeJsonFile(this.paths.aux(id), { version: 1, savedAt: nowMs(), aux })
      return aux
    })
    this.auxWrites.set(id, write)
    try {
      return await write
    } finally {
      if (this.auxWrites.get(id) === write) this.auxWrites.delete(id)
    }
  }

  // ----- translation cache ---------------------------------------------------------

  translationCachePath(key) {
    const hash = sha256(key)
    return join(this.paths.translate, hash.slice(0, 2), `${hash}.json`)
  }

  async getCachedTranslation(key) {
    const raw = await readJsonFile(this.translationCachePath(key), null)
    const value = plainObject(raw).value
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }

  async setCachedTranslation(key, value, extra = {}) {
    await writeJsonFile(this.translationCachePath(key), {
      key: key.slice(0, 500),
      value,
      at: nowMs(),
      ...extra,
    })
  }

  async cacheStats() {
    let entries = 0
    let bytes = 0
    const walk = async (dir) => {
      let dirents
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory()) await walk(join(dir, dirent.name))
        else if (dirent.name.endsWith('.json')) {
          entries++
          try {
            bytes += (await stat(join(dir, dirent.name))).size
          } catch {
            /* raced */
          }
        }
      }
    }
    await walk(this.paths.translate)
    const translation = { entries, bytes }
    entries = 0
    bytes = 0
    await walk(this.paths.reflow)
    return { entries: translation.entries + entries, bytes: translation.bytes + bytes, translation, reflow: { entries, bytes } }
  }

  async clearTranslationCache() {
    await removeTree(this.paths.translate)
    await mkdir(this.paths.translate, { recursive: true })
    await removeTree(this.paths.reflow)
    await mkdir(this.paths.reflow, { recursive: true })
    return true
  }

  // ----- AI structure-refinement cache ---------------------------------------------

  reflowCachePath(key) {
    const hash = sha256(key)
    return join(this.paths.reflow, hash.slice(0, 2), `${hash}.json`)
  }

  /** Opaque versioned layout cache. Each owning AI operation validates its own schema. */
  async getCachedReflow(key) {
    const raw = await readJsonFile(this.reflowCachePath(key), null)
    const value = plainObject(raw).value
    if (!isPlainObject(value)) return null
    return value
  }

  async setCachedReflow(key, value) {
    await writeJsonFile(this.reflowCachePath(key), { key: key.slice(0, 500), value, at: nowMs() })
  }

  // ----- uploads -------------------------------------------------------------------

  /** Persist a raw upload into a temp file and return its token. */
  async saveUpload(name, format, bytes) {
    const id = newId(20)
    const ext = format === 'epub' ? 'epub' : 'pdf'
    const safeName = typeof name === 'string' ? basename(name).slice(0, 200) : `upload.${ext}`
    const path = join(this.paths.tmp, `${id}.${ext}`)
    await writeBytesFile(path, bytes)
    return { uploadId: id, path, name: safeName, format: ext, size: bytes.byteLength }
  }

  uploadPath(uploadId) {
    if (typeof uploadId !== 'string' || /^[a-z0-9]{10,40}$/i.test(uploadId) === false) return null
    return join(this.paths.tmp, `${uploadId}.pdf`)
  }

  async findUpload(uploadId) {
    if (typeof uploadId !== 'string' || /^[a-z0-9]{10,40}$/i.test(uploadId) === false) return null
    for (const ext of ['pdf', 'epub']) {
      const path = join(this.paths.tmp, `${uploadId}.${ext}`)
      try {
        const info = await stat(path)
        return { path, format: ext, size: info.size }
      } catch {
        /* try next */
      }
    }
    return null
  }

  // ----- diagnostics ---------------------------------------------------------------

  async appendDiagnostic(kind, payload) {
    const entry = { ts: nowMs(), kind: typeof kind === 'string' ? kind.slice(0, 80) : 'event', payload }
    await appendJsonLine(this.paths.diagnostics, entry)
    try {
      const info = await stat(this.paths.diagnostics)
      if (info.size > 2 * 1024 * 1024) {
        await rename(this.paths.diagnostics, `${this.paths.diagnostics}.old`)
      }
    } catch {
      /* raced */
    }
    return true
  }

  /** Recent diagnostics for the unauthenticated health endpoint (bounded, no secrets). */
  async diagnosticsTail(limit = 8) {
    try {
      const text = await readFile(this.paths.diagnostics, 'utf8')
      const lines = text.trim().split('\n').filter((line) => line.trim() !== '')
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { raw: line.slice(0, 500) }
          }
        })
    } catch {
      return []
    }
  }

  // ----- health --------------------------------------------------------------------

  async health() {
    const cache = await this.cacheStats()
    return {
      ok: true,
      version: '1.0.0',
      dataDir: this.dataDir,
      docs: this.library.docs.length,
      cache,
      pdfAssets: await this.pdfAssetVersion(),
      diagnostics: await this.diagnosticsTail(6),
    }
  }

  async pdfAssetVersion() {
    try {
      return (await readFile(join(this.dataDir, '..', 'reader-plugin-assets-version'), 'utf8')).trim()
    } catch {
      return null
    }
  }
}

/** Stable translation cache key: provider + model + target language + source text. */
export function translationCacheKey({ providerId, model, targetLang, text }) {
  return `${providerId}|${model}|${targetLang}|${sha256(String(text)).slice(0, 32)}`
}

/** Byte size helper used by stats. */
export { byteLength, contentTypeFor }
