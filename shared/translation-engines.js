export const MYMEMORY = 'translation:mymemory'
export const LIBRETRANSLATE = 'translation:libretranslate'
export const TRANSLATION_ENGINES = Object.freeze({ [MYMEMORY]: 'MyMemory', [LIBRETRANSLATE]: 'LibreTranslate' })
export const DEFAULT_LIBRE_URL = 'http://127.0.0.1:5000'

export function normalizeLibreUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) return ''
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function translationEngineScope(providerId, settings) {
  if (providerId === MYMEMORY) return settings?.myMemorySource || 'en'
  if (providerId === LIBRETRANSLATE) return settings?.libreUrl ?? DEFAULT_LIBRE_URL
  return ''
}
