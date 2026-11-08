// Build and validate a candidate before atomically publishing it to the live plugin.
// Usage: node build.mjs   (run inside reader-plugin/)
import { build } from 'esbuild'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireBuildLock, fingerprintSources, publishClient, wrapClient, writeAtomic } from './tools/client-release.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Prepare resource bytes without deleting or modifying files that the running reader uses.
function pdfAssets() {
  const pdfDist = join(root, 'node_modules', 'pdfjs-dist')
  const assetsPdf = join(root, 'assets', 'pdf')
  if (!existsSync(pdfDist)) {
    for (const file of ['pdf.mjs', 'pdf.worker.mjs', 'VERSION']) {
      if (!existsSync(join(assetsPdf, file))) throw new Error(`Missing assets/pdf/${file}; install development dependencies first.`)
    }
    return []
  }
  const legacy = join(pdfDist, 'legacy', 'build')
  const prepared = ['pdf.mjs', 'pdf.worker.mjs'].map((file) => ({
    filename: join(assetsPdf, file), bytes: readFileSync(join(legacy, file)),
  }))
  function collect(from, to) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(from, entry.name), join(to, entry.name))
      else prepared.push({ filename: join(to, entry.name), bytes: readFileSync(join(from, entry.name)) })
    }
  }
  for (const dir of ['cmaps', 'standard_fonts']) {
    const from = join(pdfDist, dir)
    if (existsSync(from)) collect(from, join(assetsPdf, dir))
  }
  const ver = JSON.parse(readFileSync(join(pdfDist, 'package.json'), 'utf8')).version
  prepared.push({ filename: join(assetsPdf, 'VERSION'), bytes: Buffer.from(ver) })
  prepared.push({
    filename: join(root, 'assets', 'licenses', 'PDFJS-Apache-2.0.txt'),
    bytes: readFileSync(join(pdfDist, 'LICENSE')),
  })
  return prepared
}

const unlock = acquireBuildLock(root)
try {
  const sourceFingerprint = () => fingerprintSources(join(root, 'client-src')) + fingerprintSources(join(root, 'shared'))
  const initialSources = sourceFingerprint()
  const resources = pdfAssets()
  // CJS output wrapped in the web shell module-loader envelope, still only in memory.
  const result = await build({
    entryPoints: [join(root, 'client-src', 'index.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110'],
    external: ['react'],
    jsx: 'transform',
    loader: { '.jsx': 'jsx', '.css': 'text' },
    minify: false,
    sourcemap: false,
    legalComments: 'eof',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const code = result.outputFiles[0].text
  if (code.length > 12 * 1024 * 1024) console.warn('[build] warning: client bundle is very large')
  const wrapped = wrapClient({ name: pkg.name, version: pkg.version, code })
  const changed = await publishClient({
    filename: join(root, 'client.js'),
    source: wrapped,
    smokeTest: join(root, 'tools', 'mock-activate.cjs'),
    async beforePublish() {
      if (sourceFingerprint() !== initialSources) {
        throw new Error('Reader sources changed during this build. Nothing was published; retry after the edits finish.')
      }
      for (const resource of resources) await writeAtomic(resource.filename, resource.bytes)
    },
  })
  console.log(`[build] syntax + activation checks passed; client.js ${changed ? 'published atomically' : 'unchanged'}: ${(wrapped.length / 1024).toFixed(1)} KiB`)
} finally {
  unlock()
}
