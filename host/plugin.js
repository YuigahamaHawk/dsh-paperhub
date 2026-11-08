// Host plugin wiring: one reader store, one AI gateway, one Zotero service, and every
// registration owned by the plugin fiber so unloading removes routes and tools.
import { dirname, join } from 'node:path'
import {readFileSync} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AiGateway } from './ai.js'
import { createAssetHandler, createHealthHandler } from './assets.js'
import { createRpcSurface } from './rpc.js'
import { ReaderStore } from './store.js'
import { createReaderTools } from './tools.js'
import { ZoteroService } from './zotero.js'

export const READER_VERSION = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version

/** Register the reader host half on a plugin context that has `webServer` and `connection`. */
export function applyReaderHost(ctx) {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const assetsRoot = join(pluginRoot, 'assets')
  const store = new ReaderStore()
  const ai = new AiGateway({ ctx, store })
  const zotero = new ZoteroService({ store })
  const surface = createRpcSurface({ store, ai, zotero, version: READER_VERSION })
  ctx.effect(()=>()=>surface.dispose(),'dsh-reader: local parser cleanup')

  // Authenticated RPC routes (browser half -> host half).
  for (const route of surface.routes) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({ ...route })
      return () => {
        Promise.resolve(dispose()).catch(() => undefined)
      }
    }, `dsh-reader: ${route.path}`)
  }

  // Read-only static assets for pdf.js (ES module + worker + cmaps + standard fonts).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-reader-assets',
        handler: createAssetHandler({ assetsRoot, pluginRoot }),
      }),
    'dsh-reader: static assets',
  )

  // Unauthenticated local health probe (no secrets; shell-verifiable).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-reader/health',
        handler: createHealthHandler({ store, pluginRoot, version: READER_VERSION }),
      }),
    'dsh-reader: health route',
  )

  // Agent tools reuse the same operations as the UI.
  const tools = (() => {
    try {
      return ctx.get('tools') ?? null
    } catch {
      return null
    }
  })()
  if (tools !== null && tools !== undefined) {
    for (const tool of createReaderTools({ store, ai, zotero })) {
      try {
        ctx.effect(() => tools.register(tool), `dsh-reader: tool ${tool.name}`)
      } catch (error) {
        console.warn(`[dsh-reader] tool ${tool.name} registration failed: ${error?.message}`)
      }
    }
  }

  // Warm the store and leave one activation breadcrumb for live verification.
  store
    .init()
    .then(async () => {
      let model = { available: false }
      try {
        const dsh = ai.dshSelection()
        model = { available: dsh.available, provider: dsh.provider, model: dsh.model }
      } catch {
        /* best effort */
      }
      await store.appendDiagnostic('host-activated', {
        version: READER_VERSION,
        dataDir: store.dataDir,
        docs: store.listDocs().length,
        model,
      })
    })
    .catch((error) => {
      console.error('[dsh-reader] host initialization failed:', error)
    })
}
