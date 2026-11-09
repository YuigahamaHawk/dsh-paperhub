// Reader settings dialog: one section list, composed from feature-owned panels.
import React from 'react'
import {ParserSettings} from './parser-settings.jsx'
import { useApp } from './store.jsx'
import { Modal, Button, Row, Divider, LoadingBlock, ProgressBar } from './ui.jsx'
import {
  IconTextSize,
  IconSpark,
  IconCloud,
  IconFolder,
  IconInfo,
  IconDownload,
  IconTrash,
} from './icons.jsx'
import { AppearanceSettings } from './settings-appearance.jsx'
import { AiSettings } from './ai-settings.jsx'
import { TranslationSettings } from './translate.jsx'
import { ZoteroSettings } from './zotero.jsx'
import { exportAllNotes } from './export.js'
import { formatBytes } from './util.js'

const h = React.createElement

function AboutSection() {
  const { t } = useApp()
  return h(
    'div',
    null,
    h('div', { className: 'dr-settings-h' }, t('settings.section.about', 'About')),
    h('p', { className: 'dr-settings-sub' }, t('settings.about', 'dsh-paperhub brings bilingual reading, AI Q&A, annotations and Zotero sync to DeepSeek Harness.')),
    h(Divider),
    h(
      'div',
      { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8 } },
      h('div', null, 'PDF rendering: ', h('code', null, 'pdf.js')),
      h('div', null, 'AI: ', h('code', null, 'DSH model provider'), ' / OpenAI-compatible providers'),
      h('div', null, 'Shortcuts: ', h('code', null, 'Ctrl/Cmd + ='), ' / ', h('code', null, 'Ctrl/Cmd + -'), ' font size · ', h('code', null, 'Esc'), ' clear selection'),
    ),
    h(Divider),
    h(Row, { label: t('settings.data.docs', 'Documents: {count}', { count: 0 }), description: 'dsh-paperhub' }, null),
  )
}

function DataSection() {
  const { api, t, state, actions } = useApp()
  const [cache, setCache] = React.useState(null)
  const [ping, setPing] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [openingDirectory, setOpeningDirectory] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const [cacheStats, pingResult] = await Promise.all([api.rpc('ai.cache.stats'), api.rpc('ping')])
      setCache(cacheStats)
      setPing(pingResult)
    } catch (error) {
      actions.toast(String(error?.message ?? error), 'error')
    }
  }, [actions, api])

  React.useEffect(() => {
    load()
  }, [load])

  const libraryBytes = React.useMemo(() => (state.docs ?? []).reduce((sum, doc) => sum + (Number(doc.size) || 0), 0), [state.docs])

  const openDirectory = async () => {
    setOpeningDirectory(true)
    try {
      await api.rpc('library.openDirectory')
    } catch (error) {
      actions.toast(t('settings.data.openFailed', 'Could not open the library folder: {message}', { message: error?.message ?? String(error) }), 'error')
    } finally {
      setOpeningDirectory(false)
    }
  }

  return h(
    'div',
    null,
    h('div', { className: 'dr-settings-h' }, t('settings.section.data', 'Data & storage')),
    h('p', { className: 'dr-settings-sub' }, '所有文档、批注与 AI 产出（翻译、摘要、问答历史）都保存在本地数据目录，重新打开文档不会重复消耗 token。'),
    h(Divider, { label: 'Library' }),
    h(Row, { label: t('settings.data.docs', 'Documents: {count}', { count: state.docs.length }), description: ping?.dataDir ?? '' },
      h(Button, {
        size: 'sm', variant: 'ghost', icon: h(IconFolder, { size: 14 }), onClick: openDirectory,
        disabled: !ping?.canOpenDataDirectory || openingDirectory,
        title: t(ping?.canOpenDataDirectory ? 'settings.data.openDirectory' : 'settings.data.openUnavailable'),
      }, t('common.open', 'Open'))),
    h(Row, { label: t('settings.data.usage', 'Library size: {size}', { size: formatBytes(libraryBytes) }) }, null),
    h(Divider, { label: 'AI cache' }),
    h(
      Row,
      {
        label: t('settings.cache.size', 'Translation cache: {size} ({count} entries)', { size: formatBytes(cache?.bytes ?? 0), count: cache?.entries ?? 0 }),
        description: 'Translation cache is keyed by model, language and source paragraph.',
      },
      h(
        Button,
        {
          size: 'sm',
          variant: 'danger',
          disabled: busy || (cache?.entries ?? 0) === 0,
          onClick: async () => {
            setBusy(true)
            try {
              await api.rpc('ai.cache.clear')
              actions.toast(t('settings.cache.cleared', 'AI cache cleared'), 'success')
              await load()
            } catch (error) {
              actions.toast(String(error?.message ?? error), 'error')
            } finally {
              setBusy(false)
            }
          },
        },
        t('settings.cache.clear', 'Clear AI cache'),
      ),
    ),
    h(Row, { label: t('settings.data.exportAll', 'Export all notes'), description: '汇总所有文档的摘要与批注为 Markdown 文件。' }, h(Button, { size: 'sm', icon: h(IconDownload, { size: 14 }), onClick: () => actions.exportDoc('all-notes') }, t('common.export', 'Export'))),
    h(Divider, { label: 'Storage' }),
    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7, wordBreak: 'break-all' } }, ping?.dataDir ?? '—'),
  )
}

const SECTIONS = [
  { id: 'appearance', labelKey: 'settings.section.appearance', fallback: 'Appearance', Icon: IconTextSize },
  { id: 'ai', labelKey: 'settings.section.ai', fallback: 'AI models', Icon: IconSpark },
  { id: 'parser', labelKey: 'parser.engine', fallback: 'Document parser', Icon: IconFolder },
  { id: 'zotero', labelKey: 'settings.section.zotero', fallback: 'Zotero', Icon: IconCloud },
  { id: 'data', labelKey: 'settings.section.data', fallback: 'Data & storage', Icon: IconFolder },
  { id: 'about', labelKey: 'settings.section.about', fallback: 'About', Icon: IconInfo },
]

/** Settings modal. */
export function SettingsDialog({ open, section, onSection, onClose }) {
  const { t } = useApp()
  if (!open) return null
  return h(
    Modal,
    {
      open,
      onClose,
      title: t('settings.title', 'Reader settings'),
      width: 900,
      className: 'dr-settings-dialog',
      bodyClassName: 'dr-settings-dialog-body',
      footer: h(Button, { variant: 'primary', onClick: onClose }, t('common.close', 'Close')),
    },
    h(
      'div',
      { className: 'dr-settings-inner' },
      h(
        'div',
        { className: 'dr-settings-nav' },
        SECTIONS.map((entry) =>
          h(
            'button',
            { key: entry.id, type: 'button', className: `dr-settings-navitem ${section === entry.id ? 'is-active' : ''}`, onClick: () => onSection(entry.id) },
            h(entry.Icon, { size: 15 }),
            h('span', null, t(entry.labelKey, entry.fallback)),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dr-settings-content', key: section },
        section === 'appearance'
          ? h(AppearanceSettings)
          : section === 'ai'
            ? h('div', null, h(AiSettings), h(Divider), h(TranslationSettings))
            : section === 'parser'
              ? h(ParserSettings)
            : section === 'zotero'
              ? h(ZoteroSettings)
              : section === 'data'
                ? h(DataSection)
                : h(AboutSection),
      ),
    ),
  )
}
