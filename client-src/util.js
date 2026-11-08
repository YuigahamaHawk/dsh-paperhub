// Small browser helpers shared by every reader module.

/** Join class names, ignoring falsy values. */
export function clsx(...values) {
  const out = []
  for (const value of values) {
    if (value === undefined || value === null || value === false || value === '') continue
    if (Array.isArray(value)) out.push(clsx(...value))
    else out.push(String(value))
  }
  return out.join(' ')
}

/** Human readable byte size. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

/** Short local date/time. */
export function formatDate(ms) {
  if (typeof ms !== 'number' || ms <= 0) return ''
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

/** Relative time in the active locale. */
export function formatRelative(ms) {
  if (typeof ms !== 'number' || ms <= 0) return ''
  const diff = Date.now() - ms
  const minute = 60000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDate(ms)
}

/** Clamp helper. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

/** Unique-enough id for local UI state. */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Debounce a function. */
export function debounce(fn, delay = 250) {
  let timer = null
  let lastArgs = null
  const wrapped = (...args) => {
    lastArgs = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const current = lastArgs
      lastArgs = null
      fn(...current)
    }, delay)
  }
  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastArgs = null
  }
  wrapped.flush = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    const current = lastArgs
    lastArgs = null
    if (current !== null) fn(...current)
  }
  return wrapped
}

/** Throttle a function to one call per interval (trailing call included). */
export function throttle(fn, interval = 100) {
  let last = 0
  let timer = null
  let lastArgs = null
  return (...args) => {
    lastArgs = args
    const now = Date.now()
    const wait = interval - (now - last)
    if (wait <= 0) {
      last = now
      fn(...args)
      return
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        if (lastArgs !== null) fn(...lastArgs)
        lastArgs = null
      }, wait)
    }
  }
}

/** Wait for a frame (layout settled) before measuring. */
export function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

/** Escape text for safe HTML interpolation. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/** Download a blob or string as a file. */
export function downloadFile(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** Copy text and report success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Sentence-ish split used for translation batching of very long paragraphs. */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?。！？；;])\s+/u)
    .filter((part) => part.trim() !== '')
}

/** Count words (CJK-aware estimate for reading stats). */
export function countWords(text) {
  const source = String(text)
  const cjk = (source.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (source.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length
  return cjk + latin
}

/** Format a percentage. */
export function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`
}

/** Pick a stable hash of a string (32-bit FNV-1a) for DOM ids. */
export function hashText(text) {
  let hash = 0x811c9dc5
  const source = String(text)
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Safe JSON parse with fallback. */
export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Language display names. */
export const LANGUAGE_LABELS = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
  pt: 'Português',
  ar: 'العربية',
}

/** Paper themes for the reading surface. */
export const PAPER_THEMES = {
  light: { bg: '#ffffff', fg: '#24292f', muted: '#6e7781', border: '#e6e8eb', surface: '#f6f8fa' },
  sepia: { bg: '#f6efe2', fg: '#3b3226', muted: '#8a7a63', border: '#e5d9c4', surface: '#efe5d2' },
  green: { bg: '#eaf3ec', fg: '#22352a', muted: '#5f7a68', border: '#d3e4d8', surface: '#dfece2' },
  dark: { bg: '#1b1d21', fg: '#d6d9de', muted: '#8a9099', border: '#2c3036', surface: '#23262b' },
}
