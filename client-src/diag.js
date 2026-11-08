// Client-side diagnostics: captures render/runtime errors and can run a live self-test
// (RPC, authenticated routes, pdf.js assets, DecompressionStream, real EPUB/PDF parsing) that is
// reported to the host's diagnostics log and exposed through the ReaderDiag client inspect provider.
import React from 'react'
import { ReaderApp } from './app.jsx'
import { extractEpub } from './epub.js'
import { importPdf, openPdfUrl, renderPdfPage } from './pdf-engine.js'
import { renderVisionPages } from './vision-render.js'
import { SELF_TEST_EPUB_BASE64, SELF_TEST_PDF_BASE64 } from './test-assets.js'

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false }
const ANY_OUTPUT = { type: 'object' }

/** Decode base64 into an exact-size Uint8Array (fixtures are tiny). */
function base64Bytes(value) {
  const binary = atob(String(value ?? ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Resolve after `ms` (bounded test helper). */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Create the diagnostics collector for one client activation. */
export function createDiag({ api, t, version = '1.0.0' }) {
  const state = {
    activatedAt: Date.now(),
    version,
    errors: [],
    selfTest: null,
    renderTest: null,
    mount: { mounted: false, panelRegistered: false, mainRegistered: false, lastRenderAt: 0, renders: 0 },
    nav: { panelIds: [] },
  }

  function recordError(source, error) {
    if (state.errors.length >= 40) return
    state.errors.push({
      at: Date.now(),
      source,
      message: String(error?.message ?? error).slice(0, 800),
      stack: typeof error?.stack === 'string' ? error.stack.slice(0, 1600) : undefined,
    })
  }

  /** Install global error capture; returns a disposer. */
  function install() {
    const onError = (event) => recordError('window.error', event?.error ?? event?.message)
    const onRejection = (event) => recordError('unhandledrejection', event?.reason)
    try {
      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
    } catch {
      /* non-browser environment */
    }
    return () => {
      try {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
      } catch {
        /* ignore */
      }
    }
  }

  async function step(name, fn) {
    const started = Date.now()
    try {
      const value = await fn()
      return { name, ok: true, ms: Date.now() - started, value }
    } catch (error) {
      return { name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 500) }
    }
  }

  /** Run every live smoke test; the result is cached and reported to the host. */
  async function runSelfTest() {
    const steps = []
    steps.push(
      await step('rpc.ping', async () => {
        const value = await api.rpc('ping')
        return { version: value.version, docs: value.docs, modelAvailable: value.model?.available, model: value.model?.model }
      }),
    )
    steps.push(
      await step('rpc.settings', async () => {
        const value = await api.rpc('settings.get')
        return { hasSettings: value.settings !== undefined, paper: value.settings?.appearance?.paper, targetLang: value.settings?.ai?.targetLang }
      }),
    )
    steps.push(
      await step('rpc.library', async () => {
        const value = await api.rpc('library.list')
        return { docs: Array.isArray(value.docs) ? value.docs.length : -1 }
      }),
    )
    steps.push(
      await step('rpc.aiModels', async () => {
        const value = await api.rpc('ai.models')
        return { dshAvailable: value.dsh?.available === true, custom: Array.isArray(value.custom) ? value.custom.length : 0 }
      }),
    )
    steps.push(
      await step('assets.pdf.mjs', async () => {
        const response = await fetch(api.assetUrl('pdf/pdf.mjs'), { method: 'HEAD' })
        return { status: response.status, type: response.headers.get('content-type'), length: response.headers.get('content-length') }
      }),
    )
    steps.push(
      await step('assets.pdf.worker', async () => {
        const response = await fetch(api.assetUrl('pdf/pdf.worker.mjs'), { method: 'HEAD' })
        return { status: response.status, length: response.headers.get('content-length') }
      }),
    )
    steps.push(
      await step('decompressionStream', async () => {
        if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') throw new Error('CompressionStream/DecompressionStream missing')
        const raw = new TextEncoder().encode('reader self test payload '.repeat(20))
        const compressed = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()
        const restored = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
        if (restored.byteLength !== raw.byteLength) throw new Error('roundtrip length mismatch')
        return { bytes: restored.byteLength }
      }),
    )
    steps.push(
      await step('raw.health', async () => {
        const response = await fetch(new URL('/dsh-reader/health', window.location.origin).toString())
        const payload = await response.json()
        return { status: response.status, ok: payload.ok, pdfjs: payload.pdfjs, docs: payload.documentCount ?? -1 }
      }),
    )
    // Real parser smoke tests: a tiny embedded EPUB + a tiny real PDF exercise the exact code
    // paths users hit on import (ZIP inflate + OPF/spine parsing; pdf.js module + text extraction).
    steps.push(
      await step('epub.extract', async () => {
        const bytes = base64Bytes(SELF_TEST_EPUB_BASE64)
        const parsed = await extractEpub(bytes.buffer)
        const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : []
        const firstText = blocks.map((block) => block.text ?? '').join(' ').slice(0, 120)
        if (blocks.length === 0) throw new Error('EPUB parser returned no blocks')
        if (!/self-test/i.test(firstText)) throw new Error('EPUB parser did not extract the expected text')
        return { title: parsed.meta?.title, toc: Array.isArray(parsed.toc) ? parsed.toc.length : 0, blocks: blocks.length }
      }),
    )
    steps.push(
      await step('pdf.import', async () => {
        const bytes = base64Bytes(SELF_TEST_PDF_BASE64)
        const assets = {
          moduleUrl: api.assetUrl('pdf/pdf.mjs'),
          workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
          cMapUrl: api.assetUrl('pdf/cmaps/'),
          standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
        }
        const parsed = await importPdf(bytes.buffer, { assets })
        const pages = Array.isArray(parsed.content?.pages) ? parsed.content.pages : []
        const text = pages.flatMap((page) => page.blocks ?? []).map((block) => block.text ?? '').join(' ')
        const blockCount = pages.reduce((sum, page) => sum + (page.blocks?.length ?? 0), 0)
        if (pages.length !== 1) throw new Error(`PDF importer returned ${pages.length} pages`)
        if (!/Hello/i.test(text)) throw new Error('PDF text extraction did not find the expected sentence')
        return {
          pageCount: parsed.content?.pageCount,
          blocks: blockCount,
          thumb: typeof parsed.thumbDataUrl === 'string' && parsed.thumbDataUrl.startsWith('data:image'),
        }
      }),
    )
    const result = { at: Date.now(), steps, ok: steps.every((entry) => entry.ok) }
    state.selfTest = result
    try {
      await api.report('self-test', {
        ok: result.ok,
        failed: steps.filter((entry) => entry.ok !== true).map((entry) => `${entry.name}: ${entry.error}`),
        ping: steps.find((entry) => entry.name === 'rpc.ping')?.value,
        pdfAsset: steps.find((entry) => entry.name === 'assets.pdf.mjs')?.value,
        health: steps.find((entry) => entry.name === 'raw.health')?.value,
        epub: steps.find((entry) => entry.name === 'epub.extract')?.value ?? steps.find((entry) => entry.name === 'epub.extract')?.error,
        pdf: steps.find((entry) => entry.name === 'pdf.import')?.value ?? steps.find((entry) => entry.name === 'pdf.import')?.error,
        locale: t?.locale,
      })
    } catch {
      /* reporting failure is itself diagnostic-only */
    }
    return result
  }

  /** Public snapshot used by the ReaderDiag inspect provider. */
  function snapshot() {
    return {
      activatedAt: state.activatedAt,
      uptimeMs: Date.now() - state.activatedAt,
      version,
      locale: t?.locale ?? 'en',
      mount: state.mount,
      errors: state.errors.slice(-10),
      selfTest: state.selfTest,
      renderTest: state.renderTest ?? null,
      location: typeof window !== 'undefined' ? window.location.href : null,
      viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio } : null,
    }
  }

  const READ_ONLY_METHODS = new Set(['ping', 'library.list', 'folders.list', 'ai.models', 'ai.cache.stats', 'zotero.status'])

  /** Environment facts for the live page (scheme, boot payload keys, transport hooks). */
  function envSnapshot() {
    let boot = null
    let transport = null
    try {
      const rawBoot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
      if (rawBoot !== null && typeof rawBoot === 'object') {
        boot = {
          keys: Object.keys(rawBoot),
          release: rawBoot.release ?? null,
          base: rawBoot.base ?? rawBoot.baseUrl ?? rawBoot.origin ?? null,
          streamBaseUrl: rawBoot.streamBaseUrl ?? rawBoot.transport?.streamBaseUrl ?? null,
          apiPath: rawBoot.apiPath ?? null,
          entries: Array.isArray(rawBoot.entries) ? rawBoot.entries.map((entry) => entry.id ?? entry.name ?? String(entry)).slice(0, 80) : null,
        }
      }
      const rawTransport = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : undefined
      if (rawTransport !== null && typeof rawTransport === 'object') {
        transport = { keys: Object.keys(rawTransport), streamBaseUrl: rawTransport.streamBaseUrl ?? null }
      }
    } catch (error) {
      boot = { error: String(error?.message ?? error) }
    }
    return {
      href: typeof window !== 'undefined' ? window.location.href : null,
      origin: typeof window !== 'undefined' ? window.location.origin : null,
      protocol: typeof window !== 'undefined' ? window.location.protocol : null,
      baseURI: typeof document !== 'undefined' ? document.baseURI : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      boot,
      transport,
      assetPdfUrl: api.assetUrl('pdf/pdf.mjs'),
      healthUrl: typeof window !== 'undefined' ? new URL('/dsh-reader/health', window.location.origin).toString() : null,
    }
  }

  /** Fetch a list of URLs from the page and report the raw response facts. */
  async function fetchProbe(input) {
    const urls = Array.isArray(input?.urls) ? input.urls.filter((url) => typeof url === 'string').slice(0, 20) : []
    const method = input?.method === 'HEAD' ? 'HEAD' : 'GET'
    const results = []
    for (const url of urls) {
      const started = Date.now()
      try {
        const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store' })
        let bodyPrefix = null
        if (method === 'GET') bodyPrefix = String(await response.text()).slice(0, 200)
        results.push({
          url,
          status: response.status,
          ok: response.ok,
          type: response.headers.get('content-type'),
          length: response.headers.get('content-length'),
          ms: Date.now() - started,
          bodyPrefix,
        })
      } catch (error) {
        results.push({ url, error: String(error?.message ?? error), ms: Date.now() - started })
      }
    }
    return { method, results }
  }

  /** Try a real dynamic import of one URL from this page. */
  async function importProbe(input) {
    const url = typeof input?.url === 'string' ? input.url : ''
    if (url === '') return { ok: false, error: 'url is required' }
    try {
      const dynamicImport = new Function('u', 'return import(u)')
      const module = await dynamicImport(url)
      return { ok: true, url, keys: Object.keys(module).slice(0, 40) }
    } catch (error) {
      return { ok: false, url, error: String(error?.message ?? error) }
    }
  }

  /**
   * Full end-to-end plumbing test inside the live page: upload 閳?commit 閳?library 閳?content 閳?   * annotations 閳?aux 閳?authenticated file route, plus (optionally) one real AI chat and a
   * cache-checked translation. Temporary documents are removed at the end.
   */
  async function endToEnd(input) {
    const includeAi = input?.includeAi !== false
    const results = []
    const started = Date.now()
    const run = async (name, fn) => {
      const stepStarted = Date.now()
      try {
        const value = await fn()
        results.push({ name, ok: true, ms: Date.now() - stepStarted, value })
        return value
      } catch (error) {
        results.push({ name, ok: false, ms: Date.now() - stepStarted, error: String(error?.message ?? error) })
        return null
      }
    }
    let pdfDoc = null
    let epubDoc = null
    try {
      const pdfUpload = await run('upload.pdf', async () => {
        const bytes = base64Bytes(SELF_TEST_PDF_BASE64)
        const uploaded = await api.upload(new Blob([bytes], { type: 'application/pdf' }), 'pdf', 'self-test.pdf')
        if (uploaded?.uploadId === undefined) throw new Error('upload returned no uploadId')
        return uploaded
      })
      if (pdfUpload !== null) {
        pdfDoc = await run('library.commit.pdf', async () => {
          const { doc } = await api.rpc('upload.commit', {
            uploadId: pdfUpload.uploadId,
            meta: { title: 'E2E Self Test PDF', author: 'DSH Reader', filename: 'self-test.pdf' },
            content: { kind: 'pdf', version: 1, pageCount: 1, pages: [{ n: 1, blocks: [{ id: 'p1b0', kind: 'paragraph', text: 'Hello from DSH Reader self-test.', page: 1 }] }] },
          })
          return doc
        })
      }
      if (pdfDoc !== null) {
        await run('library.get.pdf', async () => {
          const { doc, content } = await api.rpc('library.get', { id: pdfDoc.id })
          if (doc?.title !== 'E2E Self Test PDF') throw new Error('stored title mismatch')
          if (content?.pageCount !== 1) throw new Error('stored content mismatch')
          return content.kind
        })
        await run('library.update.progress', async () => {
          const { doc } = await api.rpc('library.update', { id: pdfDoc.id, patch: { progress: { percent: 0.42, locator: 'p1b0', label: 'page 1' } } })
          if (Math.abs((doc?.progress?.percent ?? 0) - 0.42) > 0.001) throw new Error('progress not persisted')
          return doc.progress.percent
        })
        await run('file.fetch.original', async () => {
          const response = await fetch(api.fileUrl(pdfDoc.id, 'original'))
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const bytes = await response.arrayBuffer()
          if (bytes.byteLength < 100) throw new Error('original file is empty')
          return bytes.byteLength
        })
      }
      const epubUpload = await run('upload.epub', async () => {
        const bytes = base64Bytes(SELF_TEST_EPUB_BASE64)
        const parsed = await extractEpub(bytes.buffer)
        const uploaded = await api.upload(new Blob([bytes], { type: 'application/epub+zip' }), 'epub', 'self-test.epub')
        return { uploadId: uploaded.uploadId, parsed }
      })
      if (epubUpload !== null) {
        epubDoc = await run('library.commit.epub', async () => {
          const content = { kind: 'epub', version: 1, meta: epubUpload.parsed.meta, toc: epubUpload.parsed.toc, blocks: epubUpload.parsed.blocks }
          const { doc } = await api.rpc('upload.commit', {
            uploadId: epubUpload.uploadId,
            meta: { title: epubUpload.parsed.meta?.title ?? 'E2E EPUB', author: epubUpload.parsed.meta?.author ?? '' },
            content,
          })
          return doc
        })
      }
      if (epubDoc !== null) {
        await run('content.save.roundtrip', async () => {
          const { doc } = await api.rpc('library.get', { id: epubDoc.id })
          if ((doc?.chapterCount ?? 0) < 1) throw new Error('toc not persisted with content')
          return { chapters: doc.chapterCount, contentVersion: doc.contentVersion }
        })
        await run('annotations.roundtrip', async () => {
          const annotation = {
            id: 'e2e-ann-1',
            color: 'yellow',
            text: 'first paragraph',
            note: 'e2e note',
            target: { kind: 'reflow', blockId: 'e0_0', start: 0, end: 15 },
          }
          await api.rpc('annotations.save', { id: epubDoc.id, annotations: [annotation] })
          const { annotations } = await api.rpc('annotations.list', { id: epubDoc.id })
          if (annotations.length !== 1 || annotations[0].note !== 'e2e note') throw new Error('annotation roundtrip mismatch')
          return annotations.length
        })
        await run('aux.roundtrip', async () => {
          await api.rpc('aux.set', { id: epubDoc.id, patch: { summary: 'e2e summary', chat: [{ role: 'user', content: 'e2e question' }] } })
          const { aux } = await api.rpc('aux.get', { id: epubDoc.id })
          if (aux.summary !== 'e2e summary') throw new Error('aux roundtrip mismatch')
          return { summary: aux.summary, chat: Array.isArray(aux.chat) ? aux.chat.length : 0 }
        })
        await run('folders.roundtrip', async () => {
          const created = await api.rpc('folders.create', { name: 'E2E Folder' })
          const folder = created?.folder
          if (!folder?.id) throw new Error('folder.create returned no folder')
          await api.rpc('folders.moveDoc', { docId: epubDoc.id, folderId: folder.id })
          const listed = await api.rpc('library.list')
          const entry = (listed.docs ?? []).find((doc) => doc.id === epubDoc.id)
          if (entry?.folderId !== folder.id) throw new Error('folder assignment not persisted')
          if (!(listed.folders ?? []).some((candidate) => candidate.id === folder.id)) throw new Error('folder missing from library list')
          const renamed = await api.rpc('folders.rename', { id: folder.id, name: 'E2E Renamed' })
          if (renamed?.folder?.name !== 'E2E Renamed') throw new Error('folder rename failed')
          const removed = await api.rpc('folders.remove', { id: folder.id })
          const after = (removed.docs ?? []).find((doc) => doc.id === epubDoc.id)
          if (after?.folderId !== null) throw new Error('document did not return to the library root')
          return { folderId: folder.id, renamed: true, movedBack: true }
        })
        await run('settings.roundtrip', async () => {
          const before = await api.rpc('settings.get')
          const paper = before?.settings?.appearance?.paper ?? 'auto'
          const next = paper === 'auto' ? 'sepia' : 'auto'
          const saved = await api.rpc('settings.set', { patch: { appearance: { paper: next } } })
          if (saved?.settings?.appearance?.paper !== next) throw new Error('settings patch not applied')
          await api.rpc('settings.set', { patch: { appearance: { paper } } })
          return next
        })
        if (includeAi) {
          await run('ai.chat.default-model', async () => {
            let text = ''
            let model = null
            await api.stream(
              'ai.chat',
              {
                messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
                context: {
                  docId: epubDoc.id,
                  title: 'E2E Book',
                  text: 'This is the first paragraph of the self-test book. It exists to verify the EPUB parser extracts reading blocks correctly.',
                },
              },
              {
                onDelta: (delta) => {
                  text += delta
                },
                onDone: (value) => {
                  if (typeof value?.text === 'string' && text.trim() === '') text = value.text
                  model = value?.model ?? null
                },
              },
            )
            if (text.trim() === '') throw new Error('model returned no text')
            return { chars: text.length, model, preview: text.slice(0, 40) }
          })
          await run('ai.translate.cache', async () => {
            const texts = ['The quick brown fox jumps over the lazy dog.']
            const first = await api.rpc('ai.translate', { texts, targetLang: 'zh-CN', ref: { docId: epubDoc.id } })
            if (!first.translations?.[0]) throw new Error('empty translation')
            const second = await api.rpc('ai.translate', { texts, targetLang: 'zh-CN', ref: { docId: epubDoc.id } })
            if (second.cached?.[0] !== true) throw new Error('second identical translation was not served from cache')
            return { first: first.translations[0].slice(0, 60), cached: second.cached[0], model: first.model }
          })
          await run('ai.reflow.cache', async () => {
            const { content } = await api.rpc('library.get', { id: pdfDoc.id })
            const pages = Array.isArray(content?.pages) ? content.pages : []
            if (pages.length === 0) throw new Error('temporary PDF has no pages')
            let first = null
            await api.stream('ai.reflow', { docId: pdfDoc.id, title: 'E2E Self Test PDF', pages }, { onDone: (value) => { first = value } })
            if (!first || !Array.isArray(first.pages)) throw new Error('ai.reflow returned no page suggestions')
            let second = null
            await api.stream('ai.reflow', { docId: pdfDoc.id, title: 'E2E Self Test PDF', pages }, { onDone: (value) => { second = value } })
            if ((second?.cachedPages ?? 0) < 1) throw new Error('second ai.reflow did not hit the reflow cache')
            return { totalPages: first.totalPages, firstCached: first.cachedPages, secondCached: second.cachedPages, model: first.model }
          })
          await run('ai.cache.stats', async () => {
            const stats = await api.rpc('ai.cache.stats')
            if ((stats?.entries ?? 0) < 1) throw new Error('translation cache is still empty')
            return stats.entries
          })
        }
      }
    } finally {
      await run('cleanup', async () => {
        for (const doc of [pdfDoc, epubDoc]) {
          if (doc === null || doc === undefined) continue
          try {
            await api.rpc('library.remove', { id: doc.id })
          } catch {
            /* best effort */
          }
        }
        return true
      })
    }
    const summary = { at: Date.now(), totalMs: Date.now() - started, ok: results.every((entry) => entry.ok), results }
    report('e2e', { ok: summary.ok, failed: results.filter((entry) => entry.ok !== true).map((entry) => `${entry.name}: ${entry.error}`), totalMs: summary.totalMs })
    return summary
  }

  /**
   * Render the real ReaderApp off-screen, open a temporary EPUB/PDF through the actual library
   * card click, and verify the immersive reader mounted with typeset content. Cleans up afterwards.
   */
  async function uiProbe(input) {
    const requireFn = typeof globalThis !== 'undefined' ? globalThis.__dshReaderRequire : undefined
    if (typeof requireFn !== 'function') return { ok: false, reason: 'module require unavailable' }
    let ReactDOMClient
    try {
      ReactDOMClient = requireFn('react-dom/client')
    } catch (error) {
      return { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` }
    }
    const kinds = Array.isArray(input?.kinds) && input.kinds.length > 0 ? input.kinds.filter((kind) => kind === 'epub' || kind === 'pdf') : ['epub', 'pdf']
    const results = []
    for (const kind of kinds) results.push(await probeReaderUi(kind, ReactDOMClient))
    const summary = { at: Date.now(), ok: results.every((entry) => entry.ok), results }
    report('ui-probe', { ok: summary.ok, failed: results.filter((entry) => entry.ok !== true).map((entry) => `${entry.kind}: ${entry.error ?? 'assertion failed'}`) })
    return summary
  }

  /** Create one temporary document, render the app, click its card and inspect the reader DOM. */
  async function probeReaderUi(kind, ReactDOMClient) {
    let doc = null
    let container = null
    let root = null
    const started = Date.now()
    const steps = []
    const errorsBefore = state.errors.length
    try {
      // 1. Create a real document through the same pipeline the UI uses.
      if (kind === 'epub') {
        const bytes = base64Bytes(SELF_TEST_EPUB_BASE64)
        const parsed = await extractEpub(bytes.buffer)
        const uploaded = await api.upload(new Blob([bytes], { type: 'application/epub+zip' }), 'epub', 'ui-probe.epub')
        const committed = await api.rpc('upload.commit', {
          uploadId: uploaded.uploadId,
          meta: { title: 'UI Probe EPUB', author: 'DSH Reader' },
          content: { kind: 'epub', version: 1, meta: parsed.meta, toc: parsed.toc, blocks: parsed.blocks },
        })
        doc = committed.doc
      } else {
        const bytes = base64Bytes(SELF_TEST_PDF_BASE64)
        const assets = {
          moduleUrl: api.assetUrl('pdf/pdf.mjs'),
          workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
          cMapUrl: api.assetUrl('pdf/cmaps/'),
          standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
        }
        const parsed = await importPdf(bytes.buffer, { assets })
        const uploaded = await api.upload(new Blob([bytes], { type: 'application/pdf' }), 'pdf', 'ui-probe.pdf')
        const committed = await api.rpc('upload.commit', {
          uploadId: uploaded.uploadId,
          meta: { title: 'UI Probe PDF', author: 'DSH Reader' },
          content: parsed.content,
        })
        doc = committed.doc
      }
      steps.push({ name: 'document.created', ok: doc !== null && doc.id !== undefined })
      // 2. Render the real app shell off-screen through the shell's react-dom.
      container = document.createElement('div')
      container.setAttribute('data-dsh-reader-uiprobe', kind)
      container.style.cssText = 'position:fixed;left:-5000px;top:0;width:1280px;height:900px;overflow:hidden;opacity:0;pointer-events:none;'
      document.body.append(container)
      root = ReactDOMClient.createRoot(container)
      root.render(React.createElement(ReaderApp, { api, t, diag: { state, report, recordError }, ctx: null }))
      await wait(1500)
      const card = container.querySelector('.dr-card, .dr-listrow')
      steps.push({ name: 'library.rendered', ok: card !== null, cards: container.querySelectorAll('.dr-card, .dr-listrow').length })
      if (card === null) throw new Error('library card did not render')
      // 3. Open the document through the exact code path a user click takes.
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(1700)
      const contentEl = container.querySelector('.dr-reader-content')
      const text = (contentEl?.textContent ?? '').slice(0, 300)
      const info = {
        reader: container.querySelector('.dr-reader') !== null,
        content: contentEl !== null,
        blocks: container.querySelectorAll('[data-block-id]').length,
        tocItems: container.querySelectorAll('.dr-toc-item').length,
        leftPanel: container.querySelector('.dr-leftpanel') !== null,
        topBar: container.querySelector('.dr-reader-top') !== null,
        progress: container.querySelector('.dr-reader-progress') !== null,
        text,
      }
      const expected = kind === 'epub' ? /self-test|chapter/i.test(text) : /hello/i.test(text)
      const ok = info.reader && info.content && info.blocks > 0 && expected
      steps.push({ name: 'reader.rendered', ok, ...info })
      const result = { kind, ok, ms: Date.now() - started, steps, errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6) }
      if (doc !== null) {
        try {
          await api.rpc('library.remove', { id: doc.id })
        } catch {
          /* best effort */
        }
        doc = null
      }
      return result
    } catch (error) {
      return { kind, ok: false, ms: Date.now() - started, steps, error: String(error?.message ?? error), errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6) }
    } finally {
      try {
        root?.unmount()
      } catch {
        /* ignore */
      }
      try {
        container?.remove()
      } catch {
        /* ignore */
      }
      if (doc !== null) {
        try {
          await api.rpc('library.remove', { id: doc.id })
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * Open EXISTING library documents off-screen through the real card click and report the reader
   * DOM, including the PDF "original layout" canvas mode.
   */
  async function openDocProbe(input) {
    const requireFn = globalThis.__dshReaderRequire
    if (typeof requireFn !== 'function') return { ok: false, reason: 'module require unavailable' }
    let ReactDOMClient
    try {
      ReactDOMClient = requireFn('react-dom/client')
    } catch (error) {
      return { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` }
    }
    const docIds = Array.isArray(input?.docIds) ? input.docIds.filter((id) => typeof id === 'string' && id !== '').slice(0, 5) : []
    const results = []
    for (const docId of docIds) results.push(await probeExistingDoc(docId, ReactDOMClient))
    return { at: Date.now(), ok: results.every((entry) => entry.ok), results }
  }

  /** Render the app, click one existing document card, inspect the reader and PDF original mode. */
  async function probeExistingDoc(docId, ReactDOMClient) {
    let container = null
    let root = null
    const steps = []
    const errorsBefore = state.errors.length
    try {
      container = document.createElement('div')
      container.setAttribute('data-dsh-reader-docprobe', docId)
      container.style.cssText = 'position:fixed;left:-5000px;top:0;width:1280px;height:900px;overflow:hidden;opacity:0;pointer-events:none;'
      document.body.append(container)
      root = ReactDOMClient.createRoot(container)
      root.render(React.createElement(ReaderApp, { api, t, diag: { state, report, recordError }, ctx: null }))
      await wait(1100)
      const card = container.querySelector(`[data-doc-id="${docId}"]`)
      steps.push({ name: 'card.present', ok: card !== null })
      if (card === null) throw new Error(`document card ${docId} was not rendered`)
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(1700)
      const contentEl = container.querySelector('.dr-reader-content')
      const text = (contentEl?.textContent ?? '').slice(0, 500)
      const info = {
        reader: container.querySelector('.dr-reader') !== null,
        content: contentEl !== null,
        blocks: container.querySelectorAll('[data-block-id]').length,
        tocItems: container.querySelectorAll('.dr-toc-item').length,
        topBar: container.querySelector('.dr-reader-top') !== null,
        leftPanel: container.querySelector('.dr-leftpanel') !== null,
        progress: container.querySelector('.dr-reader-progress') !== null,
        statusText: (container.querySelector('.dr-pdf-status')?.textContent ?? container.querySelector('.dr-empty')?.textContent ?? '').slice(0, 300),
        text,
      }
      // Verify the side-panel splitter actually resizes the panel (the splitter was missing before).
      const splitter = container.querySelector('.dr-panel-resizer')
      const leftPanel = container.querySelector('.dr-leftpanel')
      if (splitter !== null && leftPanel !== null) {
        const before = leftPanel.getBoundingClientRect().width
        splitter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, clientX: 500 }))
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: 560 }))
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
        await wait(120)
        info.resizer = { present: true, before: Math.round(before), after: Math.round(leftPanel.getBoundingClientRect().width) }
      } else {
        info.resizer = { present: false }
      }
      // Region count only; the dedicated regionProbe scrolls and verifies rendered pixels.
      info.regions = {
        count: container.querySelectorAll('.dr-region').length,
        figure: container.querySelectorAll('.dr-region-figure').length,
        formula: container.querySelectorAll('.dr-region-formula').length,
      }
      steps.push({ name: 'reader.rendered', ok: info.reader && info.content && info.blocks > 0, ...info })
      // PDF original-layout mode: the segmented control's second option.
      let original = null
      const segments = Array.from(container.querySelectorAll('.dr-reader-top .dr-segment'))
      if (segments.length >= 2) {
        segments[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        await wait(1900)
        original = {
          modeButtons: segments.map((segment) => segment.textContent),
          canvases: container.querySelectorAll('canvas').length,
          pdfPages: container.querySelectorAll('[data-pdf-page]').length,
          readerChrome: container.querySelector('.dr-reader-top') !== null,
        }
        steps.push({ name: 'pdf.original.rendered', ok: original.canvases > 0, ...original })
      }
      const errors = state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6)
      const ok = info.reader && info.content && info.blocks > 0 && (original === null || original.canvases > 0) && errors.length === 0
      return { docId, ok, info, original, errors, steps }
    } catch (error) {
      return { docId, ok: false, error: String(error?.message ?? error), steps, errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6) }
    } finally {
      try {
        root?.unmount()
      } catch {
        /* ignore */
      }
      try {
        container?.remove()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Open one existing document off-screen, scroll to its first figure/formula region and verify
   * that a real cropped image was rendered (the reflow previously dropped figures entirely).
   */
  async function regionProbe(input) {
    const docId = typeof input?.docId === 'string' ? input.docId : ''
    if (docId === '') return { ok: false, reason: 'docId is required' }
    const requireFn = globalThis.__dshReaderRequire
    if (typeof requireFn !== 'function') return { ok: false, reason: 'module require unavailable' }
    let ReactDOMClient
    try {
      ReactDOMClient = requireFn('react-dom/client')
    } catch (error) {
      return { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` }
    }
    let container = null
    let root = null
    const errorsBefore = state.errors.length
    try {
      container = document.createElement('div')
      container.setAttribute('data-dsh-reader-regionprobe', '')
      container.style.cssText = 'position:fixed;left:-5000px;top:0;width:1280px;height:900px;overflow:hidden;opacity:0;pointer-events:none;'
      document.body.append(container)
      root = ReactDOMClient.createRoot(container)
      root.render(React.createElement(ReaderApp, { api, t, diag: { state, report, recordError }, ctx: null }))
      await wait(900)
      const card = container.querySelector(`[data-doc-id="${docId}"]`)
      if (card === null) throw new Error('card did not render')
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(1200)
      const region = container.querySelector('.dr-region')
      if (region === null) return { ok: false, reason: 'no figure/formula region in this document', regions: 0, errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 4) }
      try {
        region.scrollIntoView({ block: 'center' })
      } catch {
        /* ignore */
      }
      await wait(5200)
      const images = Array.from(container.querySelectorAll('.dr-region-img'))
      const loaded = images.filter((img) => typeof img.currentSrc === 'string' && img.currentSrc.startsWith('data:image/') && img.naturalWidth > 0)
      return {
        ok: loaded.length > 0,
        regions: container.querySelectorAll('.dr-region').length,
        rendered: images.length,
        loaded: loaded.length,
        figure: container.querySelectorAll('.dr-region-figure').length,
        formula: container.querySelectorAll('.dr-region-formula').length,
        width: loaded[0]?.naturalWidth ?? 0,
        height: loaded[0]?.naturalHeight ?? 0,
        regionText: (region.textContent ?? '').slice(0, 160),
        errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6),
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6) }
    } finally {
      try {
        root?.unmount()
      } catch {
        /* ignore */
      }
      try {
        container?.remove()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Run AI structure refinement for selected pages of an existing document (twice, to prove the
   * host-side page cache), returning the heuristic headings vs. the model suggestions.
   */
  async function aiReflowProbe(input) {
    const docId = typeof input?.docId === 'string' ? input.docId : ''
    if (docId === '') return { ok: false, reason: 'docId is required' }
    const { doc, content } = await api.rpc('library.get', { id: docId })
    if (content === null || !Array.isArray(content.pages)) return { ok: false, reason: 'document has no extracted content' }
    const wanted = Array.isArray(input?.pageNumbers) && input.pageNumbers.length > 0 ? new Set(input.pageNumbers.map(Number)) : null
    const pages = content.pages
      .filter((page) => (wanted === null || wanted.has(Number(page.n))) && Array.isArray(page.blocks) && page.blocks.length > 0)
      .map((page) => ({
        n: page.n,
        blocks: page.blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text })),
      }))
    if (pages.length === 0) return { ok: false, reason: 'no pages selected' }
    const before = {}
    for (const page of pages) before[page.n] = page.blocks.filter((block) => block.kind === 'heading').map((block) => String(block.text ?? '').slice(0, 90))
    let first = null
    let second = null
    await api.stream('ai.reflow', { docId, title: doc?.title ?? '', pages }, { onDone: (value) => { first = value } })
    await api.stream('ai.reflow', { docId, title: doc?.title ?? '', pages }, { onDone: (value) => { second = value } })
    return {
      ok: first !== null,
      docId,
      pageNumbers: pages.map((page) => page.n),
      heuristicHeadings: before,
      suggestions: (first?.pages ?? []).map((page) => ({ page: page.n, headings: (page.headings ?? []).length, drop: (page.drop ?? []).length, explicit: page.explicit === true })),
      firstCached: first?.cachedPages ?? 0,
      secondCached: second?.cachedPages ?? 0,
      model: first?.model ?? null,
    }
  }

  /** Exercise the folder UI: create a folder through the real dialog and verify its chip appears. */
  async function foldersUiProbe() {
    const requireFn = globalThis.__dshReaderRequire
    if (typeof requireFn !== 'function') return { ok: false, reason: 'module require unavailable' }
    let ReactDOMClient
    try {
      ReactDOMClient = requireFn('react-dom/client')
    } catch (error) {
      return { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` }
    }
    let container = null
    let root = null
    let folderId = null
    const errorsBefore = state.errors.length
    const folderName = 'UI Probe Folder'
    try {
      container = document.createElement('div')
      container.setAttribute('data-dsh-reader-foldersprobe', '')
      container.style.cssText = 'position:fixed;left:-5000px;top:0;width:1280px;height:900px;overflow:hidden;opacity:0;pointer-events:none;'
      document.body.append(container)
      root = ReactDOMClient.createRoot(container)
      root.render(React.createElement(ReaderApp, { api, t, diag: { state, report, recordError }, ctx: null }))
      await wait(1500)
      const bar = container.querySelector('.dr-folder-bar')
      if (bar === null) throw new Error('folder bar did not render')
      const newButton = Array.from(bar.querySelectorAll('button')).find((button) => /new folder|新建文件夹/i.test(button.textContent ?? ''))
      if (newButton === undefined) throw new Error('new-folder button is missing')
      newButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(350)
      const nameInput = container.querySelector('.dr-modal input')
      if (nameInput === null) throw new Error('folder-name input did not open')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, folderName)
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      const saveButton = Array.from(container.querySelectorAll('.dr-modal-foot button')).filter((button) => button.disabled !== true).pop()
      if (saveButton === undefined) throw new Error('folder save button is missing')
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(1300)
      const chip = Array.from(container.querySelectorAll('.dr-folder-chip')).find((element) => (element.textContent ?? '').includes(folderName))
      const listed = await api.rpc('folders.list')
      folderId = (listed.folders ?? []).find((folder) => folder.name === folderName)?.id ?? null
      return {
        ok: chip !== undefined && folderId !== null,
        chipCount: container.querySelectorAll('.dr-folder-chip').length,
        folderId,
        errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6),
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6) }
    } finally {
      try {
        root?.unmount()
      } catch {
        /* ignore */
      }
      try {
        container?.remove()
      } catch {
        /* ignore */
      }
      if (folderId !== null) {
        try {
          await api.rpc('folders.remove', { id: folderId })
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * End-to-end vision smoke test: render one real asset page, save it as an attachment, call the
   * vision layout RPC and report the model's first region. Read-only; does not modify content.
   */
  async function visionLayoutProbe(input) {
    const docId = typeof input?.docId === 'string' ? input.docId : ''
    if (docId === '') return { ok: false, reason: 'docId is required' }
    const startedAt = Date.now()
    const errorsBefore = state.errors.length
    try {
      const loaded = await api.rpc('library.get', { id: docId })
      const content = loaded?.content
      if (content === null || content === undefined) return { ok: false, reason: 'document has no extracted content' }
      const pages = await renderVisionPages({ api, docId, content, limit: 1 })
      if (pages.length === 0) return { ok: false, reason: 'no asset page selected' }
      const page = pages[0]
      let result = null
      await api.stream('ai.visionLayout', { docId, title: loaded?.doc?.title ?? '', pages }, { onDone: (value) => { result = value } })
      if (result === null || !Array.isArray(result.pages)) return { ok: false, reason: 'empty vision result', ms: Date.now() - startedAt }
      const pageResult = result.pages[0] ?? {}
      return {
        ok: true,
        ms: Date.now() - startedAt,
        page: page.n,
        imageBytes: Math.round((page.imageBase64.length * 3) / 4),
        imageWidth: page.width,
        imageHeight: page.height,
        model: result.model ?? '',
        regions: Array.isArray(pageResult.regions) ? pageResult.regions.length : 0,
        firstRegion: Array.isArray(pageResult.regions) ? pageResult.regions[0] ?? null : null,
        captions: Array.isArray(pageResult.captionFixes) ? pageResult.captionFixes.length : 0,
        warnings: Array.isArray(pageResult.warnings) ? pageResult.warnings.slice(0, 3) : [],
        errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 4),
      }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error), ms: Date.now() - startedAt, errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 4) }
    }
  }

  /** Render one page from a fresh PDF worker with a hard timeout (diagnoses render stalls). */  async function pdfRenderProbe(input) {
    const docId = typeof input?.docId === 'string' ? input.docId : ''
    if (docId === '') return { ok: false, reason: 'docId is required' }
    const assets = {
      moduleUrl: api.assetUrl('pdf/pdf.mjs'),
      workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
      cMapUrl: api.assetUrl('pdf/cmaps/'),
      standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
    }
    let handle = null
    const startedAt = performance.now()
    let timer = null
    try {
      handle = await openPdfUrl(api.fileUrl(docId, 'original'), assets)
      const openedAt = Math.round(performance.now() - startedAt)
      const pageNumber = Math.max(1, Number(input?.page) || 1)
      const pagePromise = handle.pdf.getPage(pageNumber)
      const pageTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('getPage timeout after 3000 ms')), 3000)
      })
      const proxy = await Promise.race([pagePromise, pageTimeout])
      const pageMs = Math.round(performance.now() - startedAt)
      const viewport = proxy.getViewport({ scale: 1.5 })
      const renderPromise = renderPdfPage(handle.pdf, pageNumber, { scale: 1.5, dpr: 1 })
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('render timeout after 8500 ms')), 8500)
      })
      const rendered = await Promise.race([renderPromise, timeout])
      return {
        ok: true,
        docId,
        page: pageNumber,
        ms: Math.round(performance.now() - startedAt),
        openedMs: openedAt,
        pageMs,
        viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
        width: rendered?.canvas?.width ?? 0,
        height: rendered?.canvas?.height ?? 0,
        pages: handle.pdf?.numPages ?? 0,
      }
    } catch (error) {
      return {
        ok: false,
        docId,
        ms: Math.round(performance.now() - startedAt),
        pages: handle?.pdf?.numPages ?? 0,
        transport: handle?.pdf?._transport?.constructor?.name ?? 'n/a',
        worker: handle?.pdf?._transport?._worker?.constructor?.name ?? 'n/a',
        fakeWorker: handle?.pdf?._transport?._worker?.constructor?.name === 'PDFWorker' ? 'real' : 'fake-or-unknown',
        error: String(error?.message ?? error),
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      try {
        await handle?.destroy?.()
      } catch {
        /* best effort */
      }
    }
  }

  /** Import the embedded fixture PDF with stage logging and a hard timeout. */
  async function importPdfProbe() {
    const stages = []
    const startedAt = performance.now()
    const assets = {
      moduleUrl: api.assetUrl('pdf/pdf.mjs'),
      workerUrl: api.assetUrl('pdf/pdf.worker.mjs'),
      cMapUrl: api.assetUrl('pdf/cmaps/'),
      standardFontDataUrl: api.assetUrl('pdf/standard_fonts/'),
    }
    const bytes = base64Bytes(SELF_TEST_PDF_BASE64)
    const work = importPdf(bytes, {
      assets,
      onStage: (stage) => stages.push({ stage, ms: Math.round(performance.now() - startedAt) }),
    })
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('importPdf timeout after 8000 ms')), 8000)
    })
    try {
      const parsed = await Promise.race([work, timeout])
      return {
        ok: true,
        ms: Math.round(performance.now() - startedAt),
        stages,
        pages: parsed?.content?.pages?.length ?? 0,
        toc: parsed?.content?.toc?.length ?? 0,
        thumb: typeof parsed?.thumbDataUrl === 'string' && parsed.thumbDataUrl.startsWith('data:image/'),
      }
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - startedAt), stages, error: String(error?.message ?? error) }
    }
  }

  /** Trivial 2D canvas probe: detects a wedged GPU/compositor independently of pdf.js. */
  function canvasProbe() {
    const startedAt = performance.now()
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const context = canvas.getContext('2d', { alpha: false })
      if (context === null) return { ok: false, error: 'no 2d context' }
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 320, 240)
      context.fillStyle = '#123456'
      context.fillRect(20, 20, 120, 80)
      const pixel = context.getImageData(40, 40, 1, 1).data
      let dataUrl = ''
      try {
        dataUrl = canvas.toDataURL('image/png')
      } catch (error) {
        return { ok: false, error: `toDataURL: ${error?.message ?? error}`, getImageData: Array.from(pixel) }
      }
      return {
        ok: pixel[0] === 0x12 && pixel[1] === 0x34 && pixel[2] === 0x56 && dataUrl.startsWith('data:image/png'),
        ms: Math.round(performance.now() - startedAt),
        pixel: Array.from(pixel),
        dataUrlLength: dataUrl.length,
        fonts: typeof document.fonts?.status === 'string' ? document.fonts.status : 'n/a',
      }
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - startedAt), error: String(error?.message ?? error) }
    }
  }

  /**
   * End-to-end AI-refine UI probe: creates a temporary one-page document with a synthetic layout,
   * opens it through the real library card, clicks the real AI button, and verifies the persisted
   * result (heading protection, caption survival, aiRefined flag). One small model call.
   */
  async function aiRefineUiProbe() {
    const requireFn = globalThis.__dshReaderRequire
    if (typeof requireFn !== 'function') return { ok: false, reason: 'module require unavailable' }
    let ReactDOMClient
    try {
      ReactDOMClient = requireFn('react-dom/client')
    } catch (error) {
      return { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` }
    }
    let docId = null
    let container = null
    let root = null
    const errorsBefore = state.errors.length
    const startedAt = performance.now()
    try {
      const bytes = base64Bytes(SELF_TEST_PDF_BASE64)
      const uploaded = await api.upload(new Blob([bytes], { type: 'application/pdf' }), 'pdf', 'ai-refine-probe.pdf')
      const synthetic = {
        kind: 'pdf',
        version: 1,
        engineVersion: 4,
        pageCount: 1,
        meta: { title: 'AI Refine Probe', author: 'DSH Reader' },
        figurePages: [1],
        toc: [{ id: 't0', title: 'AI Refine Probe', level: 1, blockId: 'p1b0' }],
        pages: [
          {
            n: 1,
            blocks: [
              { id: 'p1b0', kind: 'heading', level: 1, text: 'AI Refine Probe' },
              { id: 'p1b1', kind: 'heading', level: 2, text: 'GPU router: cache hits' },
              { id: 'p1b2', kind: 'paragraph', text: 'This paragraph is real body text and must stay a paragraph after refinement.' },
              { id: 'p1b3', kind: 'caption', text: 'Figure 1: a caption that must survive refinement.' },
            ],
          },
        ],
      }
      const committed = await api.rpc('upload.commit', {
        uploadId: uploaded.uploadId,
        meta: { title: 'AI Refine Probe', author: 'DSH Reader', filename: 'ai-refine-probe.pdf' },
        content: synthetic,
      })
      docId = committed?.doc?.id ?? null
      if (docId === null) throw new Error('temporary document was not created')
      container = document.createElement('div')
      container.setAttribute('data-dsh-reader-aiprobe', '')
      container.style.cssText = 'position:fixed;left:-5000px;top:0;width:1280px;height:900px;overflow:hidden;opacity:0;pointer-events:none;'
      document.body.append(container)
      root = ReactDOMClient.createRoot(container)
      root.render(React.createElement(ReaderApp, { api, t, diag: { state, report, recordError }, ctx: null }))
      await wait(1100)
      const card = container.querySelector(`[data-doc-id="${docId}"]`)
      if (card === null) throw new Error('temporary card did not render')
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await wait(1300)
      const aiButton = Array.from(container.querySelectorAll('.dr-reader-top button')).find((button) =>
        /AI refine|AI 精排|AI 精修/i.test(`${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`),
      )
      if (aiButton === undefined) throw new Error('AI refine button is missing from the reader top bar')
      aiButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      let refined = null
      const deadline = Date.now() + 5200
      while (Date.now() < deadline) {
        await wait(260)
        const fetched = await api.rpc('library.get', { id: docId })
        if (fetched?.content?.aiRefined === true) {
          refined = fetched.content
          break
        }
      }
      if (refined === null) throw new Error('AI refinement did not finish within 5.2 s')
      const blocks = (refined.pages ?? []).flatMap((page) => page.blocks ?? [])
      const headings = blocks.filter((block) => block.kind === 'heading')
      return {
        ok: true,
        ms: Math.round(performance.now() - startedAt),
        aiRefined: true,
        headings: headings.map((block) => ({ level: block.level, text: block.text })),
        longHeading: headings.some((block) => String(block.text ?? '').length > 160),
        captionSurvived: blocks.some((block) => block.kind === 'caption'),
        toc: (refined.toc ?? []).length,
        errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6),
      }
    } catch (error) {
      return {
        ok: false,
        ms: Math.round(performance.now() - startedAt),
        error: String(error?.message ?? error),
        errors: state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6),
      }
    } finally {
      try {
        root?.unmount()
      } catch {
        /* ignore */
      }
      try {
        container?.remove()
      } catch {
        /* ignore */
      }
      if (docId !== null) {
        try {
          await api.rpc('library.remove', { id: docId })
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Client inspect provider registration payload. */
  const inspectProvider = {
    manifest: {
      id: 'ReaderDiag',
      description: 'dsh-paperhub diagnostics for activation, client errors, self-test results and read-only RPC probes.',
      methods: [
        {
          name: 'snapshot',
          description: 'Return the current reader client snapshot (mount state, recent errors, self-test result, viewport).',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'selfTest',
          description: 'Re-run the client self-test (RPC, routes, assets, streaming support) and return its steps.',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'probe',
          description: 'Run one whitelisted read-only reader RPC and return its result; used to verify host behavior from the live page.',
          inputSchema: {
            type: 'object',
            properties: { method: { type: 'string', description: 'One of: ping, library.list, ai.models, ai.cache.stats, zotero.status' } },
            required: ['method'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'env',
          description: 'Return live page environment facts: scheme/origin, DSH boot payload keys, transport base URL and computed asset URLs.',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'fetchProbe',
          description: 'Fetch a list of same-page URLs and report status/content-type/body prefix for each.',
          inputSchema: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' }, description: 'Absolute or same-origin URLs to fetch.' },
              method: { type: 'string', enum: ['GET', 'HEAD'], description: 'HTTP method; defaults to GET.' },
            },
            required: ['urls'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'importProbe',
          description: 'Attempt a dynamic import() of one URL from this page and report the outcome.',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Module URL to import.' } },
            required: ['url'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'e2e',
          description:
            'Full end-to-end plumbing test in the live page: upload 閳?library 閳?content 閳?annotations 閳?aux 閳?authenticated file route, plus an optional real AI chat and cache-checked translation. Temporary documents are removed afterwards.',
          inputSchema: {
            type: 'object',
            properties: {
              includeAi: { type: 'boolean', description: 'Run one real model call and one cached translation (small token cost). Defaults to true.' },
            },
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'uiProbe',
          description:
            'Render the real ReaderApp off-screen, open temporary EPUB/PDF documents through the actual library card click, and report the immersive reader DOM (blocks, TOC, panels). Temporary documents are removed afterwards.',
          inputSchema: {
            type: 'object',
            properties: {
              kinds: { type: 'array', items: { type: 'string' }, description: 'Document kinds to probe: epub and/or pdf. Defaults to both.' },
            },
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'openDocProbe',
          description:
            'Open EXISTING library documents off-screen through the real card click and report the reader DOM, including the PDF original-layout canvas mode and captured client errors.',
          inputSchema: {
            type: 'object',
            properties: {
              docIds: { type: 'array', items: { type: 'string' }, description: 'Library document ids to open (max 5).' },
            },
            required: ['docIds'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'regionProbe',
          description: 'Open an existing document off-screen, scroll to its first figure/formula region and verify that a real cropped page image was rendered.',
          inputSchema: {
            type: 'object',
            properties: { docId: { type: 'string', description: 'Library document id.' } },
            required: ['docId'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'aiReflowProbe',
          description:
            'Run AI structure refinement on selected pages of an existing document twice: shows heuristic headings vs. model suggestions and proves the second run is served from cache (one model call per page, small token cost).',
          inputSchema: {
            type: 'object',
            properties: {
              docId: { type: 'string', description: 'Library document id.' },
              pageNumbers: { type: 'array', items: { type: 'number' }, description: 'PDF page numbers to refine; defaults to every page (costly).' },
            },
            required: ['docId'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'foldersUiProbe',
          description: 'Render the real app off-screen and create a folder through the actual dialog, verifying the folder chip appears and the host persisted it.',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'pdfRenderProbe',
          description: 'Open a fresh PDF worker for one document and render one page with a hard 6s timeout, reporting canvas size or the stall reason.',
          inputSchema: {
            type: 'object',
            properties: {
              docId: { type: 'string', description: 'Library document id.' },
              page: { type: 'number', description: 'Page number, defaults to 1.' },
            },
            required: ['docId'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'visionLayoutProbe',
          description: 'End-to-end vision smoke test: render one real asset page, save it as an image attachment, call ai.visionLayout and report the first model region (one vision model call).',
          inputSchema: {
            type: 'object',
            properties: { docId: { type: 'string', description: 'Library document id.' } },
            required: ['docId'],
            additionalProperties: false,
          },
          outputSchema: ANY_OUTPUT,
        },

        {
          name: 'importPdfProbe',
          description: 'Import the embedded fixture PDF with stage logging and a hard timeout (diagnoses extraction stalls).',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'canvasProbe',
          description: 'Draw and read pixels from a plain 2D canvas to separate GPU/compositor stalls from pdf.js rendering stalls.',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
        {
          name: 'aiRefineUiProbe',
          description: 'Create a temporary one-page document, open it via the real card, click the real AI-refine button and verify the persisted heading/caption result (one small model call).',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        },
      ],
    },
    async query(method, input) {
      if (method === 'snapshot') return snapshot()
      if (method === 'selfTest') return runSelfTest()
      if (method === 'env') return envSnapshot()
      if (method === 'fetchProbe') return fetchProbe(input)
      if (method === 'importProbe') return importProbe(input)
      if (method === 'e2e') return endToEnd(input)
      if (method === 'uiProbe') return uiProbe(input)
      if (method === 'openDocProbe') return openDocProbe(input)
      if (method === 'regionProbe') return regionProbe(input)
      if (method === 'aiReflowProbe') return aiReflowProbe(input)
      if (method === 'foldersUiProbe') return foldersUiProbe()
      if (method === 'pdfRenderProbe') return pdfRenderProbe(input)
      if (method === 'visionLayoutProbe') return visionLayoutProbe(input)
      if (method === 'importPdfProbe') return importPdfProbe()
      if (method === 'canvasProbe') return canvasProbe()
      if (method === 'aiRefineUiProbe') return aiRefineUiProbe()
      if (method === 'probe') {
        const requested = typeof input?.method === 'string' ? input.method : ''
        if (!READ_ONLY_METHODS.has(requested)) throw new Error(`probe method "${requested}" is not whitelisted`)
        return { method: requested, value: await api.rpc(requested) }
      }
      throw new Error(`unknown ReaderDiag method "${method}"`)
    },
  }

  /** Fire-and-forget diagnostics breadcrumb (never blocks, never throws). */
  function report(kind, payload) {
    try {
      const pending = api.report(kind, payload)
      if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(() => undefined)
    } catch {
      /* diagnostics must never break the UI */
    }
  }

  return { state, recordError, install, runSelfTest, snapshot, inspectProvider, report }
}


