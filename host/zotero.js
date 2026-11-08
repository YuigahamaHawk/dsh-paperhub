// Zotero library sync.
//
// Web API (api.zotero.org, API key + numeric user id): full sync including PDF attachments.
// Local API (Zotero 7 desktop, http://127.0.0.1:23119): detection and metadata listing; attachment
// file download is attempted where the installed Zotero exposes it, otherwise the UI is told to
// use a Web API key for files.
import { ReaderError, nowMs, plainObject, truncateBytes } from './util.js'

const LOCAL_API = 'http://127.0.0.1:23119/api/users/0'
const WEB_API = 'https://api.zotero.org'
const MAX_SYNC_ITEMS = 300
const MAX_PDF_BYTES = 200 * 1024 * 1024

/** Fetch with a hard timeout and JSON decoding. */
async function fetchJson(url, { headers = {}, timeoutMs = 20000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new ReaderError('zotero-http', `Zotero returned HTTP ${response.status} for ${url.replace(WEB_API, 'api.zotero.org')}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** Fetch raw bytes with a size cap and timeout. */
async function fetchBytes(url, { headers = {}, timeoutMs = 120000, signal, maxBytes = MAX_PDF_BYTES } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new ReaderError('zotero-http', `Zotero file download returned HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) throw new ReaderError('too-large', 'attachment is too large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new ReaderError('too-large', 'attachment is too large')
    return bytes
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** Read creator names from a Zotero item's data. */
function creatorsOf(data) {
  const creators = Array.isArray(data?.creators) ? data.creators : []
  const names = creators
    .map((creator) => {
      const entry = plainObject(creator)
      if (typeof entry.name === 'string' && entry.name.trim() !== '') return entry.name.trim()
      const first = typeof entry.firstName === 'string' ? entry.firstName.trim() : ''
      const last = typeof entry.lastName === 'string' ? entry.lastName.trim() : ''
      return `${first} ${last}`.trim()
    })
    .filter((name) => name !== '')
  return names.slice(0, 8).join(', ')
}

/** Human title for a Zotero item. */
function titleOf(data) {
  const candidates = [data?.title, data?.bookTitle, data?.publicationTitle, data?.nameOfAct, data?.subject]
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 400)
  return typeof data?.key === 'string' ? `Zotero ${data.key}` : 'Zotero item'
}

export class ZoteroService {
  constructor({ store }) {
    this.store = store
    this.localCache = { at: 0, value: null }
  }

  async detectLocal(force = false) {
    const now = nowMs()
    if (!force && this.localCache.value !== null && now - this.localCache.at < 30000) return this.localCache.value
    let value = { available: false, error: 'not-running' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      timer.unref?.()
      try {
        const response = await fetch(`${LOCAL_API}/items?limit=1&format=json`, {
          headers: { 'Zotero-API-Version': '3' },
          signal: controller.signal,
        })
        value = response.ok ? { available: true } : { available: false, error: `HTTP ${response.status}` }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      value = { available: false, error: error?.name === 'AbortError' ? 'timeout' : truncateBytes(error?.message ?? String(error), 200) }
    }
    this.localCache = { at: now, value }
    return value
  }

  webConfig() {
    const settings = this.store.getSettings()
    const apiKey = settings.zotero.apiKey
    const userId = String(settings.zotero.userId ?? '').replace(/[^0-9]/g, '')
    return { configured: apiKey !== '' && userId !== '', apiKey, userId }
  }

  webHeaders(config) {
    return { 'Zotero-API-Key': config.apiKey, 'Zotero-API-Version': '3', Accept: 'application/json' }
  }

  async status() {
    const settings = this.store.getSettings()
    const local = await this.detectLocal()
    const web = this.webConfig()
    return {
      local,
      web: { configured: web.configured, userId: web.userId },
      settings: {
        enabled: settings.zotero.enabled,
        hasKey: settings.zotero.apiKey !== '',
        userId: web.userId,
        autoSync: settings.zotero.autoSync,
        lastSyncAt: settings.zotero.lastSyncAt,
      },
      docs: this.store.listDocs().filter((doc) => doc.source === 'zotero').length,
    }
  }

  async collections() {
    const web = this.webConfig()
    if (web.configured) {
      const raw = await fetchJson(`${WEB_API}/users/${web.userId}/collections?format=json&limit=100`, { headers: this.webHeaders(web) })
      return (Array.isArray(raw) ? raw : []).map((entry) => {
        const data = plainObject(plainObject(entry).data)
        return { key: String(plainObject(entry).key ?? ''), name: typeof data.name === 'string' ? data.name : 'Collection' }
      })
    }
    const local = await this.detectLocal()
    if (local.available) {
      const raw = await fetchJson(`${LOCAL_API}/collections?format=json&limit=100`, { headers: { 'Zotero-API-Version': '3' } })
      return (Array.isArray(raw) ? raw : []).map((entry) => {
        const data = plainObject(plainObject(entry).data)
        return { key: String(plainObject(entry).key ?? ''), name: typeof data.name === 'string' ? data.name : 'Collection' }
      })
    }
    return []
  }

  /** List PDF attachments for one item. */
  async attachmentsFor(itemKey, config) {
    const headers = this.webHeaders(config)
    const raw = await fetchJson(`${WEB_API}/users/${config.userId}/items/${itemKey}/children?format=json&limit=100`, { headers })
    const children = Array.isArray(raw) ? raw : []
    return children
      .map((entry) => plainObject(entry))
      .filter((entry) => {
        const data = plainObject(entry.data)
        return data.itemType === 'attachment' && (data.contentType === 'application/pdf' || (typeof data.filename === 'string' && data.filename.toLowerCase().endsWith('.pdf')))
      })
      .map((entry) => {
        const data = plainObject(entry.data)
        return { key: String(entry.key ?? ''), filename: typeof data.filename === 'string' ? data.filename : `${String(entry.key ?? 'attachment')}.pdf` }
      })
  }

  async downloadAttachment(itemKey, attachmentKey, config) {
    const url = `${WEB_API}/users/${config.userId}/items/${attachmentKey}/file`
    const bytes = await fetchBytes(url, { headers: this.webHeaders(config), maxBytes: MAX_PDF_BYTES })
    if (bytes.byteLength < 1000) throw new ReaderError('zotero-file', 'attachment download was empty')
    return { bytes, name: `${titleOfSafe(itemKey)}.pdf` }
  }

  /**
   * Sync the Zotero library into the reader.
   * Emits progress frames `{ phase, done, total, title? }` and returns a summary.
   */
  async sync({ collections = [], signal, emit = () => undefined } = {}) {
    const web = this.webConfig()
    if (!web.configured) {
      const local = await this.detectLocal(true)
      if (local.available) {
        const raw = await fetchJson(`${LOCAL_API}/items?format=json&limit=100`, { headers: { 'Zotero-API-Version': '3' } })
        const count = Array.isArray(raw) ? raw.length : 0
        throw new ReaderError(
          'zotero-key-required',
          `Local Zotero is running (${count}+ items visible), but Zotero's local API does not expose attachment files. Add a Zotero Web API key and user ID in Reader settings to sync PDFs.`,
        )
      }
      throw new ReaderError('zotero-not-configured', 'Set a Zotero API key and user ID, or start Zotero 7 on this computer.')
    }
    const headers = this.webHeaders(web)
    const wantedCollections = new Set((Array.isArray(collections) ? collections : []).filter((key) => typeof key === 'string' && key !== ''))
    emit({ phase: 'listing', done: 0, total: 0 })
    const items = []
    for (let start = 0; start < 2000; start += 100) {
      if (signal?.aborted) throw new ReaderError('aborted', 'sync aborted')
      const page = await fetchJson(`${WEB_API}/users/${web.userId}/items?format=json&limit=100&start=${start}`, { headers, timeoutMs: 30000, signal })
      const list = Array.isArray(page) ? page : []
      for (const entry of list) {
        const record = plainObject(entry)
        const data = plainObject(record.data)
        if (data.itemType === 'attachment' || data.itemType === 'note' || data.itemType === 'annotation') continue
        if (wantedCollections.size > 0) {
          const itemCollections = Array.isArray(data.collections) ? data.collections : []
          if (!itemCollections.some((key) => wantedCollections.has(key))) continue
        }
        items.push(record)
      }
      if (list.length < 100) break
    }
    emit({ phase: 'dedupe', done: 0, total: items.length })
    const candidates = []
    let skipped = 0
    for (const record of items) {
      const key = String(record.key ?? '')
      if (key === '' || this.store.findByZoteroKey(key) !== null) {
        skipped++
        continue
      }
      candidates.push(record)
      if (candidates.length >= MAX_SYNC_ITEMS) break
    }
    let added = 0
    let withoutPdf = 0
    let failed = 0
    for (let index = 0; index < candidates.length; index++) {
      if (signal?.aborted) throw new ReaderError('aborted', 'sync aborted')
      const record = candidates[index]
      const data = plainObject(record.data)
      const title = titleOf(data)
      emit({ phase: 'download', done: index, total: candidates.length, title })
      try {
        const attachments = await this.attachmentsFor(String(record.key ?? ''), web)
        if (attachments.length === 0) {
          withoutPdf++
          continue
        }
        const attachment = attachments[0]
        const download = await this.downloadAttachment(String(record.key ?? ''), attachment.key, web)
        const doc = await this.store.addDoc({
          storedPath: await this.writeTemp(download.bytes),
          name: attachment.filename,
          format: 'pdf',
          size: download.bytes.byteLength,
          source: 'zotero',
          zoteroKey: String(record.key ?? ''),
          thumbDataUrl: null,
          content: null,
          meta: {
            title,
            author: creatorsOf(data),
            tags: Array.isArray(data.tags) ? data.tags.map((tag) => (typeof tag?.tag === 'string' ? tag.tag : '')).filter((tag) => tag !== '') : [],
          },
        })
        if (doc !== null) added++
      } catch (error) {
        failed++
        this.store.appendDiagnostic('zotero-sync-item', { key: record.key, title, error: truncateBytes(error?.message ?? String(error), 500) })
      }
    }
    emit({ phase: 'done', done: candidates.length, total: candidates.length })
    await this.store.patchSettings({ zotero: { lastSyncAt: nowMs() } })
    return { added, skipped, withoutPdf, failed, total: items.length }
  }

  /** Write bytes into the reader temp area so store.addDoc can move them atomically. */
  async writeTemp(bytes) {
    const { writeBytesFile } = await import('./paths.js')
    const { newId } = await import('./util.js')
    const { join } = await import('node:path')
    const path = join(this.store.paths.tmp, `${newId(20)}.pdf`)
    await writeBytesFile(path, bytes)
    return path
  }
}

/** Fallback title helper for a Zotero item key. */
function titleOfSafe(key) {
  return typeof key === 'string' && key !== '' ? `zotero-${key}` : 'zotero-item'
}
