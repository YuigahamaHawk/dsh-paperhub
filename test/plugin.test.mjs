// Host wiring test: mounts the real plugin against a stub Cordis context and exercises the
// registered routes (authenticated RPC/upload/file/stream + raw asset/health) end to end.
// Run: node test/plugin.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataHome = await mkdtemp(join(tmpdir(), 'dsh-reader-plugin-test-'))
process.env.DSH_HOME = dataHome

const { applyReaderHost } = await import('../host/plugin.js')
const releaseVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version

const effects = []
const fetchRoutes = []
const webRoutes = []
const tools = []
const fakeCtx = {
  effect(callback, label) {
    const dispose = callback()
    effects.push({ dispose, label })
    return dispose
  },
  connection: {
    fetch: {
      register(route) {
        assert.equal(typeof route.fetch, 'function')
        fetchRoutes.push(route)
        return async () => undefined
      },
    },
  },
  webServer: {
    register(route) {
      webRoutes.push(route)
      return () => undefined
    },
  },
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          tools.push(definition)
          return () => undefined
        },
      }
    }
    return undefined
  },
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL  ${name}: ${error?.stack ?? error}`)
  }
}

function jsonRequest(url, body) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function rpc(method, params) {
  const route = fetchRoutes.find((entry) => entry.path === '/api/dsh-reader/rpc')
  const response = await route.fetch(jsonRequest('http://local/api/dsh-reader/rpc', { method, params }))
  return response.json()
}

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

async function main() {
  applyReaderHost(fakeCtx)
  const app = await import('../index.js')
  assert.equal(typeof app.apply, 'function')

  await test('registers the four authenticated routes + two raw routes + three tools', () => {
    assert.deepEqual(
      fetchRoutes.map((route) => route.path).sort(),
      ['/api/dsh-reader/file', '/api/dsh-reader/rpc', '/api/dsh-reader/stream', '/api/dsh-reader/upload'],
    )
    assert.deepEqual(webRoutes.map((route) => route.path).sort(), ['/dsh-reader-assets', '/dsh-reader/health'])
    assert.equal(webRoutes[0].kind, 'prefix')
    assert.equal(tools.length, 3)
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['reader_ai', 'reader_library', 'reader_zotero'])
    for (const tool of tools) {
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.parameters, 'object')
    }
  })

  await test('rpc ping works through the registered route', async () => {
    const ping = await rpc('ping')
    assert.equal(ping.ok, true, JSON.stringify(ping))
    assert.equal(typeof ping.value.dataDir, 'string')
    assert.equal(ping.value.docs, 0)
    assert.equal(ping.value.version,releaseVersion)
  })

  await test('asset route serves the bundled pdf.js module', async () => {
    const assetRoute = webRoutes.find((route) => route.path === '/dsh-reader-assets')
    const response = fakeResponse()
    await assetRoute.handler({ url: '/dsh-reader-assets/pdf/VERSION', method: 'GET' }, response)
    assert.equal(response.status, 200)
    assert.match(String(response.body), /^\d+\.\d+\.\d+/)
    const moduleResponse = fakeResponse()
    await assetRoute.handler({ url: '/dsh-reader-assets/pdf/pdf.mjs', method: 'HEAD' }, moduleResponse)
    assert.equal(moduleResponse.status, 200)
    assert.match(String(moduleResponse.headers['content-type']), /javascript/)
    const traversal = fakeResponse()
    await assetRoute.handler({ url: '/dsh-reader-assets/../../package.json', method: 'GET' }, traversal)
    assert.notEqual(traversal.status, 200)
  })

  await test('health route reports aggregate status and pdf.js version', async () => {
    const healthRoute = webRoutes.find((route) => route.path === '/dsh-reader/health')
    const response = fakeResponse()
    await healthRoute.handler({ url: '/dsh-reader/health', method: 'GET' }, response)
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.version,releaseVersion)
    assert.equal(payload.documentCount, 0)
    assert.match(String(payload.pdfjs), /^\d+\.\d+\.\d+/)
  })

  await test('upload + commit + library.list through routes', async () => {
    const uploadRoute = fetchRoutes.find((route) => route.path === '/api/dsh-reader/upload')
    const uploadResponse = await uploadRoute.fetch(
      new Request('http://local/api/dsh-reader/upload?name=test.pdf&format=pdf', { method: 'POST', body: Buffer.from('%PDF-1.4 test') }),
    )
    const upload = await uploadResponse.json()
    assert.equal(upload.ok, true, JSON.stringify(upload))
    const commit = await rpc('upload.commit', {
      uploadId: upload.value.uploadId,
      meta: { title: 'Route Test', filename: 'test.pdf' },
      content: { kind: 'pdf', version: 1, pageCount: 1, pages: [] },
    })
    assert.equal(commit.ok, true, JSON.stringify(commit))
    const list = await rpc('library.list')
    assert.equal(list.value.docs.length, 1)
    const fileRoute = fetchRoutes.find((route) => route.path === '/api/dsh-reader/file')
    const fileResponse = await fileRoute.fetch(new Request(`http://local/api/dsh-reader/file?docId=${commit.value.doc.id}&kind=original`))
    assert.equal(fileResponse.status, 200)
    assert.equal(Buffer.from(await fileResponse.arrayBuffer()).slice(0, 4).toString(), '%PDF')
  })

  await test('stream route emits SSE frames for a bad method as an error frame', async () => {
    const streamRoute = fetchRoutes.find((route) => route.path === '/api/dsh-reader/stream')
    const response = await streamRoute.fetch(jsonRequest('http://local/api/dsh-reader/stream', { method: 'nope.stream', params: {} }))
    assert.equal(response.status, 200)
    assert.match(String(response.headers.get('content-type')), /event-stream/)
    const text = await response.text()
    assert.match(text, /event: start/)
    assert.match(text, /event: error/)
  })

  await test('tool reader_library list executes against the same store', async () => {
    const tool = tools.find((entry) => entry.name === 'reader_library')
    const text = await tool.execute({ action: 'list' }, {})
    assert.match(String(text), /Route Test/)
    const output = tool.output.render({ action: 'list' }, text)
    assert.equal(output[0].type, 'text')
  })

  for (const effect of effects) {
    try {
      await effect.dispose?.()
    } catch {
      /* ignore */
    }
  }
  await rm(dataHome, { recursive: true, force: true })
  const failed = results.filter((entry) => entry.ok === false)
  console.log(`\n${results.length - failed.length}/${results.length} plugin wiring tests passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
