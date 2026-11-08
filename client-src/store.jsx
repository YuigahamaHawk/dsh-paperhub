// Reader UI state plumbing: the app context, settings defaults, theme variables and the
// reader-session context that content modules consume.
import React from 'react'
import { PAPER_THEMES, clamp } from './util.js'
import { DEFAULT_LIBRE_URL } from '../shared/translation-engines.js'

/** Client mirror of the host's default settings (used before `settings.get` resolves). */
export const DEFAULT_SETTINGS = {
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
    active: { chat: { providerId: 'dsh', model: '' }, translate: { providerId: 'dsh', model: '' }, vision: { providerId: 'dsh', model: '' } },
    targetLang: 'zh-CN',
    translate: { mode: 'bilingual', batchSize: 6, auto: true, concurrency: 2, myMemorySource: 'en', libreUrl: DEFAULT_LIBRE_URL, libreKey: '' },
    chat: { contextMode: 'doc', maxContextChars: 48000 },
    providers: [],
  },
  parser: {engine:'auto',python:'',tier:'standard'},
  zotero: { enabled: true, apiKey: '', userId: '', local: false, autoSync: false },
  ui: { lastDocId: undefined, openDocIds: [], libraryView: 'grid', sidebarOpen: true, aiOpen: false, activeLeftTab: 'toc', leftPanelWidth: 320, rightPanelWidth: 400, uiLang: 'auto' },
}

/** Deep-merge a settings patch onto the current settings (client side, optimistic). */
export function mergeSettings(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = base?.[key]
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current) ? mergeSettings(current, value) : value
  }
  return out
}

export const AppContext = React.createContext(null)
export const ReaderContext = React.createContext(null)

/** Full app handle: `{ api, t, state, actions }`. */
export function useApp() {
  const context = React.useContext(AppContext)
  if (context === null) throw new Error('Reader: useApp() outside <AppProvider>')
  return context
}

/** `[settings, patchSettings]`. */
export function useSettings() {
  const { state, actions } = useApp()
  return [state.settings, actions.patchSettings]
}

/** Toast helpers (`{ toast, dismiss, toasts }`). */
export function useToast() {
  const { state, actions } = useApp()
  return { toast: actions.toast, dismiss: actions.dismissToast, toasts: state.toasts }
}

const FALLBACK_READER = {
  doc: null,
  content: null,
  blocks: [],
  toc: [],
  settings: DEFAULT_SETTINGS,
  annotations: [],
  activeAnnId: null,
  mode: 'reflow',
  translate: null,
  aiOpen: false,
  leftOpen: true,
  addAnnotation: () => null,
  updateAnnotation: () => undefined,
  removeAnnotation: () => undefined,
  focusAnn: () => undefined,
  onSelect: () => undefined,
  askAbout: () => undefined,
  jumpTo: () => undefined,
  registerBlockEl: () => undefined,
  search: async () => [],
  searchQuery: '',
  setSearchQuery: () => undefined,
  scrollToBlock: () => undefined,
  moveBy: () => undefined,
  openExportMenu: () => undefined,
  openAi: () => undefined,
  toggleLeftPanel: () => undefined,
  toggleAiPanel: () => undefined,
  t: (key) => key,
  api: null,
}

/** Reader-session handle provided by <ReaderShell>; safe fallback outside a reader. */
export function useReader() {
  return React.useContext(ReaderContext) ?? FALLBACK_READER
}

/** Track the OS color scheme (`prefers-color-scheme`). */
export function usePrefersDark() {
  const [dark, setDark] = React.useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch {
      return false
    }
  })
  React.useEffect(() => {
    let media
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return undefined
    }
    const onChange = (event) => setDark(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  return dark
}

/** Resolve the effective dark/light interface state from settings + OS. */
export function useInterfaceDark(settings) {
  const prefersDark = usePrefersDark()
  const mode = settings?.appearance?.themeMode ?? 'system'
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return prefersDark
}

/** Resolve the effective reading paper palette. */
export function resolvePaper(settings, interfaceDark) {
  const requested = settings?.appearance?.paper ?? 'auto'
  const paper = requested === 'auto' ? (interfaceDark ? 'dark' : 'light') : requested
  return PAPER_THEMES[paper] ?? PAPER_THEMES.light
}

/** CSS variables for the reading surface + typography, applied on the reader root. */
export function readerStyleVars(settings, interfaceDark) {
  const appearance = settings?.appearance ?? DEFAULT_SETTINGS.appearance
  const paper = resolvePaper(settings, interfaceDark)
  const fontFamilies = {
    serif: 'Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif',
    sans: '-apple-system, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif',
    kai: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif CJK SC", serif',
  }
  return {
    '--dr-paper-bg': paper.bg,
    '--dr-paper-fg': paper.fg,
    '--dr-paper-muted': paper.muted,
    '--dr-paper-border': paper.border,
    '--dr-paper-surface': paper.surface,
    '--dr-font-family': fontFamilies[appearance.fontFamily] ?? fontFamilies.serif,
    '--dr-font-size': `${clamp(appearance.fontSize, 13, 32)}px`,
    '--dr-line-height': String(clamp(appearance.lineHeight, 1.2, 2.6)),
    '--dr-paragraph-spacing': `${clamp(appearance.paragraphSpacing, 0.2, 2.5)}em`,
    '--dr-page-width': `${clamp(appearance.pageWidth, 520, 1600)}px`,
    '--dr-justify': appearance.justify ? 'justify' : 'start',
    '--dr-hyphenate': appearance.hyphenate ? 'auto' : 'manual',
  }
}
