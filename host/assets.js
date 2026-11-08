// Static asset + health routes.
//
// pdf.js is loaded by the browser half as a real ES module from this route
// (`import('/dsh-reader-assets/pdf/pdf.mjs')`) and its worker/cmaps/fonts follow.
// The route is read-only, unauthenticated (like other app static assets) and only serves files
// that live under the plugin's own assets directory.
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { contentTypeFor } from './util.js'

const ASSET_PREFIX = '/dsh-reader-assets/'

/** Build the prefix route handler that serves `<root>/assets/**`. */
export function createAssetHandler({ assetsRoot, pluginRoot }) {
  return async function assetHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      let relative = decodeURIComponent(url.pathname.slice(ASSET_PREFIX.length))
      if (relative === '' || relative.endsWith('/')) {
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
        return
      }
      const safe = normalize(relative).split(/[\\/]+/).filter((part) => part !== '' && part !== '.' && part !== '..').join(sep)
      const file = join(assetsRoot, safe)
      const resolvedRoot = normalize(assetsRoot)
      if (file !== resolvedRoot && !file.startsWith(resolvedRoot + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden')
        return
      }
      let info
      try {
        info = await stat(file)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
        return
      }
      if (!info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
        return
      }
      const bytes = await readFile(file)
      const ext = extname(file).toLowerCase()
      const cache = ext === '.bcmap' || ext === '.pfb' || ext === '.ttf' ? 'public, max-age=604800' : 'public, max-age=300'
      res.writeHead(200, {
        'content-type': contentTypeFor(file),
        'content-length': String(bytes.byteLength),
        'cache-control': cache,
        'access-control-allow-origin': '*',
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(error?.message ?? 'asset error')
    }
  }
}

/** Build the unauthenticated health route used for local verification. */
export function createHealthHandler({ store, pluginRoot, version }) {
  return async function healthHandler(req, res) {
    try {
      await store.init()
      let pdfVersion = null
      try {
        pdfVersion = (await readFile(join(pluginRoot, 'assets', 'pdf', 'VERSION'), 'utf8')).trim()
      } catch {
        pdfVersion = null
      }
      const payload = {
        ok: true,
        version,
        hostRevision: 'visual-layout-v4',
        inlineMathVersion: 1,
        documentCount: store.listDocs().length,
        pdfjs: pdfVersion,
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload, null, 2))
    } catch {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'reader unavailable' }))
    }
  }
}
