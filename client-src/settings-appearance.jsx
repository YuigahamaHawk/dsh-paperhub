// Appearance & typography settings section for the reader settings dialog.
//
// Controls are optimistic (local draft) and persisted through `useSettings()[1]`; slider gestures
// are debounced so dragging does not spam the host with `settings.set` calls. The preview block is
// painted with the app-level `--dr-*` CSS variables, so it always matches the real reading surface.
import React from 'react'
import { DEFAULT_SETTINGS, resolvePaper, useApp, useInterfaceDark, useSettings } from './store.jsx'
import { PAPER_THEMES, clamp, clsx, debounce } from './util.js'
import { SegmentedControl, Select, Slider, Switch } from './ui.jsx'
import { IconAuto, IconMoon, IconSun } from './icons.jsx'

const APPEARANCE_KEYS = [
  'themeMode',
  'paper',
  'fontFamily',
  'fontSize',
  'lineHeight',
  'paragraphSpacing',
  'pageWidth',
  'justify',
  'hyphenate',
  'showProgress',
]

/** Slider gesture debounce — keeps host writes to one per gesture (the app debounces again). */
const PERSIST_DELAY = 250

const FONT_STACKS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, "Segoe UI", Roboto, sans-serif',
  kai: '"Kaiti SC", KaiTi, STKaiti, serif',
}

const STYLES = {
  preview: {
    border: '1px solid var(--dr-paper-border)',
    borderRadius: 10,
    background: 'var(--dr-paper-bg)',
    color: 'var(--dr-paper-fg)',
    padding: '14px 16px',
    overflow: 'hidden',
  },
  previewParagraph: {
    margin: 0,
    fontFamily: 'var(--dr-font-family)',
    fontSize: 'var(--dr-font-size)',
    lineHeight: 'var(--dr-line-height)',
    textAlign: 'var(--dr-justify)',
    hyphens: 'var(--dr-hyphenate)',
    overflowWrap: 'break-word',
  },
  previewMeta: {
    marginTop: 9,
    fontSize: 11,
    letterSpacing: '.02em',
    color: 'var(--dr-paper-muted)',
  },
  autoSwatchLabel: { fontSize: 10, fontWeight: 600, lineHeight: 1, borderRadius: 4, padding: '2px 4px' },
}

function translate(t, key, fallback) {
  if (typeof t === 'function') return t(key, fallback)
  return typeof fallback === 'string' ? fallback : key
}

function numberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/** Interface theme (system / light / dark) + reading paper + typography controls. */
export function AppearanceSettings() {
  const [settings, patchSettings] = useSettings()
  const app = useApp()
  const t = app?.t
  const interfaceDark = useInterfaceDark(settings)

  const appearance = settings !== null && settings !== undefined && settings.appearance !== null && typeof settings?.appearance === 'object' ? settings.appearance : DEFAULT_SETTINGS.appearance
  const [draft, setDraft] = React.useState(() => {
    const initial = {}
    for (const key of APPEARANCE_KEYS) {
      initial[key] = appearance?.[key] !== undefined ? appearance[key] : DEFAULT_SETTINGS.appearance[key]
    }
    return initial
  })

  // Merge external settings changes (other panels, host response) into the local draft.
  React.useEffect(() => {
    setDraft((previous) => {
      let next = previous
      let changed = false
      for (const key of APPEARANCE_KEYS) {
        const value = appearance?.[key]
        if (value === undefined || previous[key] === value) continue
        if (!changed) {
          next = { ...previous }
          changed = true
        }
        next[key] = value
      }
      return changed ? next : previous
    })
  }, [appearance])

  // Persist plumbing. `changedRef` keeps the union of fields touched during this mount: every
  // patch sent to the app carries the complete set, so the app's own write coalescing can never
  // drop an earlier control change on the host.
  const patchRef = React.useRef(patchSettings)
  patchRef.current = patchSettings
  const changedRef = React.useRef({})
  const pendingRef = React.useRef(null)
  const writerRef = React.useRef(null)

  // Keep the persistence union aligned with settings written elsewhere (shortcuts, other panels).
  React.useEffect(() => {
    if (appearance === null || appearance === undefined || typeof appearance !== 'object') return
    for (const key of APPEARANCE_KEYS) {
      if (appearance[key] !== undefined) changedRef.current[key] = appearance[key]
    }
  }, [appearance])

  if (writerRef.current === null) {
    writerRef.current = debounce(() => {
      const merged = pendingRef.current
      pendingRef.current = null
      if (merged === null) return
      const commit = patchRef.current
      if (typeof commit !== 'function') return
      try {
        commit({ appearance: merged })
      } catch {
        /* settings owner gone */
      }
    }, PERSIST_DELAY)
  }

  // Flush a slider gesture that was still pending when the dialog closes.
  React.useEffect(() => {
    const writer = writerRef.current
    return () => {
      const merged = pendingRef.current
      pendingRef.current = null
      if (writer !== null && writer !== undefined && typeof writer.cancel === 'function') writer.cancel()
      if (merged === null) return
      const commit = patchRef.current
      if (typeof commit !== 'function') return
      try {
        commit({ appearance: merged })
      } catch {
        /* unmounting */
      }
    }
  }, [])

  const update = React.useCallback((patch, immediate) => {
    if (patch === null || typeof patch !== 'object') return
    setDraft((previous) => ({ ...previous, ...patch }))
    Object.assign(changedRef.current, patch)
    const merged = { ...changedRef.current }
    const commit = patchRef.current
    if (immediate === true) {
      pendingRef.current = null
      const writer = writerRef.current
      if (writer !== null && writer !== undefined && typeof writer.cancel === 'function') writer.cancel()
      if (typeof commit !== 'function') return
      try {
        commit({ appearance: merged })
      } catch {
        /* ignore */
      }
      return
    }
    pendingRef.current = merged
    const writer = writerRef.current
    if (writer !== null && writer !== undefined && typeof writer === 'function') writer()
  }, [])

  const themeMode = draft.themeMode === 'dark' || draft.themeMode === 'light' ? draft.themeMode : 'system'
  const paper = typeof draft.paper === 'string' ? draft.paper : 'auto'
  const fontFamily = draft.fontFamily === 'sans' || draft.fontFamily === 'kai' ? draft.fontFamily : 'serif'
  const fontSize = clamp(numberOr(draft.fontSize, DEFAULT_SETTINGS.appearance.fontSize), 13, 32)
  const lineHeight = clamp(numberOr(draft.lineHeight, DEFAULT_SETTINGS.appearance.lineHeight), 1.2, 2.6)
  const paragraphSpacing = clamp(numberOr(draft.paragraphSpacing, DEFAULT_SETTINGS.appearance.paragraphSpacing), 0.2, 2.5)
  const pageWidth = clamp(numberOr(draft.pageWidth, DEFAULT_SETTINGS.appearance.pageWidth), 520, 1100)
  const justify = draft.justify === true
  const hyphenate = draft.hyphenate === true
  const showProgress = draft.showProgress !== false

  const autoPalette = resolvePaper({ appearance: { ...draft, paper: 'auto' } }, interfaceDark)

  const themeOptions = [
    { value: 'system', label: translate(t, 'reader.theme.system', 'System'), icon: <IconAuto size={14} /> },
    { value: 'light', label: translate(t, 'reader.theme.light', 'Light'), icon: <IconSun size={14} /> },
    { value: 'dark', label: translate(t, 'reader.theme.dark', 'Dark'), icon: <IconMoon size={14} /> },
  ]

  const paperOptions = [
    { value: 'auto', label: translate(t, 'reader.paper.auto', 'Auto') },
    { value: 'light', label: translate(t, 'reader.paper.light', 'Paper') },
    { value: 'sepia', label: translate(t, 'reader.paper.sepia', 'Sepia') },
    { value: 'green', label: translate(t, 'reader.paper.green', 'Green') },
    { value: 'dark', label: translate(t, 'reader.paper.dark', 'Night') },
  ]

  const fontOptions = [
    { value: 'serif', label: translate(t, 'reader.font.serif', 'Serif'), title: 'Georgia' },
    { value: 'sans', label: translate(t, 'reader.font.sans', 'Sans'), title: 'Segoe UI' },
    { value: 'kai', label: translate(t, 'reader.font.kai', 'Kai'), title: 'Kaiti' },
  ].map((option) => ({
    value: option.value,
    title: option.title,
    label: <span style={{ fontFamily: FONT_STACKS[option.value] }}>{option.label}</span>,
  }))

  return (
    <div className="dr-appearance">
      <div className="dr-field"><div className="dr-field-label">{translate(t,'reader.language','Interface language')}</div><Select aria-label={translate(t,'reader.language','Interface language')} value={settings.ui?.uiLang??'auto'} onChange={uiLang=>patchSettings({ui:{uiLang}})} options={[{value:'auto',label:translate(t,'settings.language.auto','Follow DSH')},{value:'zh-CN',label:'中文'},{value:'en',label:'English'}]}/></div>
      <div className="dr-settings-h">{translate(t, 'settings.section.appearance', 'Appearance')}</div>
      <p className="dr-settings-sub">
        {translate(
          t,
          'settings.appearance.hint',
          'Interface theme, reading paper, typography and layout. Changes apply live to the reading surface.',
        )}
      </p>

      <div className="dr-field">
        <div className="dr-field-label">{translate(t, 'settings.themeMode', 'Interface theme')}</div>
        <SegmentedControl value={themeMode} options={themeOptions} onChange={(value) => update({ themeMode: value }, true)} />
      </div>

      <div className="dr-field">
        <div className="dr-field-label">{translate(t, 'settings.paper', 'Reading paper')}</div>
        <div className="dr-swatch-row" role="group" aria-label={translate(t, 'settings.paper', 'Reading paper')}>
          {paperOptions.map((option) => {
            const active = paper === option.value
            const palette = option.value === 'auto' ? null : PAPER_THEMES[option.value] ?? PAPER_THEMES.light
            const background =
              palette !== null ? palette.bg : `linear-gradient(135deg, ${PAPER_THEMES.light.bg} 50%, ${PAPER_THEMES.dark.bg} 50%)`
            const foreground = palette !== null ? palette.fg : autoPalette.fg
            return (
              <button
                key={option.value}
                type="button"
                className={clsx('dr-swatch', active && 'is-active')}
                style={{ background, color: foreground }}
                title={option.label}
                aria-label={option.label}
                aria-pressed={active}
                onClick={() => update({ paper: option.value }, true)}
              >
                {option.value === 'auto' ? (
                  <span style={{ ...STYLES.autoSwatchLabel, background: autoPalette.bg, color: autoPalette.fg }}>A</span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="dr-field">
        <div className="dr-field-label">{translate(t, 'reader.fontFamily', 'Font')}</div>
        <SegmentedControl value={fontFamily} options={fontOptions} onChange={(value) => update({ fontFamily: value }, true)} />
      </div>

      <div className="dr-field">
        <Slider
          value={fontSize}
          min={13}
          max={32}
          step={1}
          label={translate(t, 'reader.fontSize', 'Font size')}
          display={`${Math.round(fontSize)}px`}
          onChange={(value) => update({ fontSize: clamp(Math.round(Number(value) || DEFAULT_SETTINGS.appearance.fontSize), 13, 32) })}
        />
      </div>

      <div className="dr-field">
        <Slider
          value={lineHeight}
          min={1.2}
          max={2.6}
          step={0.05}
          label={translate(t, 'reader.lineHeight', 'Line height')}
          display={lineHeight.toFixed(2)}
          onChange={(value) => update({ lineHeight: clamp(Number(value) || DEFAULT_SETTINGS.appearance.lineHeight, 1.2, 2.6) })}
        />
      </div>

      <div className="dr-field">
        <Slider
          value={paragraphSpacing}
          min={0.2}
          max={2.5}
          step={0.05}
          label={translate(t, 'reader.paragraphSpacing', 'Paragraph spacing')}
          display={`${paragraphSpacing.toFixed(2)}em`}
          onChange={(value) => update({ paragraphSpacing: clamp(Number(value) || DEFAULT_SETTINGS.appearance.paragraphSpacing, 0.2, 2.5) })}
        />
      </div>

      <div className="dr-field">
        <Slider
          value={pageWidth}
          min={520}
          max={1100}
          step={10}
          label={translate(t, 'reader.pageWidth', 'Page width')}
          display={`${Math.round(pageWidth)}px`}
          onChange={(value) => update({ pageWidth: clamp(Math.round(Number(value) || DEFAULT_SETTINGS.appearance.pageWidth), 520, 1100) })}
        />
      </div>

      <div className="dr-divider" />

      <div className="dr-field">
        <Switch checked={justify} label={translate(t, 'reader.justify', 'Justified text')} onChange={(checked) => update({ justify: checked === true }, true)} />
        <Switch checked={hyphenate} label={translate(t, 'reader.hyphenate', 'Hyphenation')} onChange={(checked) => update({ hyphenate: checked === true }, true)} />
        <Switch checked={showProgress} label={translate(t, 'reader.progress', 'Reading progress')} onChange={(checked) => update({ showProgress: checked === true }, true)} />
      </div>

      <div className="dr-divider" />

      <div className="dr-field">
        <div className="dr-field-label">{translate(t, 'settings.preview', 'Preview')}</div>
        <div style={STYLES.preview}>
          <p style={STYLES.previewParagraph}>
            {translate(
              t,
              'settings.preview.sample',
              'The craft of reading is the craft of attention: typography gives language a durable visual form. 字体是文字的呼吸，行距是阅读的节奏。',
            )}
          </p>
          <div style={STYLES.previewMeta}>{`${Math.round(fontSize)}px · ${lineHeight.toFixed(2)} · ${paragraphSpacing.toFixed(2)}em · ${Math.round(pageWidth)}px`}</div>
        </div>
      </div>
    </div>
  )
}
