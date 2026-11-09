// Standalone host test: no Cordis, no browser. Exercises persistence, RPC envelopes,
// upload/file routes, the translation cache, and an OpenAI-compatible mock model server.
// Run: node test/host.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReaderStore } from '../host/store.js'
import { AiGateway } from '../host/ai.js'
import { ZoteroService } from '../host/zotero.js'
import { createRpcSurface } from '../host/rpc.js'

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

async function jsonOf(response) {
  return JSON.parse(await response.text())
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reader-test-'))
  const store = new ReaderStore(join(dir, 'dsh-reader'))
  await store.init()
  const ai = new AiGateway({ ctx: null, store })
  const zotero = new ZoteroService({ store })
  const surface = createRpcSurface({ store, ai, zotero, version: 'test' })

  const rpc = async (method, params) => {
    const response = await surface.routes[0].fetch(
      new Request('http://local/api/dsh-reader/rpc', { method: 'POST', body: JSON.stringify({ method, params }) }),
    )
    return jsonOf(response)
  }

  await test('settings default + patch + clamp', async () => {
    const before = store.getSettings()
    assert.equal(before.appearance.fontSize, 18)
    const settings = await store.patchSettings({ appearance: { fontSize: 99, paper: 'sepia' }, ai: { targetLang: 'ja' } })
    assert.equal(settings.appearance.fontSize, 32)
    assert.equal(settings.appearance.paper, 'sepia')
    assert.equal(settings.ai.targetLang, 'ja')
  })

  await test('open library folder targets only the configured data directory', async () => {
    const opened = []
    const call = async (openDataDirectory, method, params) => {
      const surface = createRpcSurface({ store, ai, zotero, version: 'test', openDataDirectory })
      return jsonOf(await surface.routes[0].fetch(new Request('http://local/api/dsh-reader/rpc', {
        method: 'POST', body: JSON.stringify({ method, params }),
      })))
    }
    const open = async directory => { opened.push(directory) }
    assert.equal((await call(open, 'ping')).value.canOpenDataDirectory, true)
    assert.equal((await call(open, 'library.openDirectory', { path: join(dir, 'another-folder') })).ok, true)
    assert.deepEqual(opened, [store.dataDir])
    assert.equal((await call(null, 'ping')).value.canOpenDataDirectory, false)
    assert.equal((await call(null, 'library.openDirectory')).error.code, 'library-directory-unavailable')
  })

  await test('upload + commit + list + get', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake pdf body for tests')
    const uploadResponse = await surface.routes[1].fetch(
      new Request(`http://local/api/dsh-reader/upload?name=${encodeURIComponent('My Paper.pdf')}&format=pdf`, { method: 'POST', body: bytes }),
    )
    const upload = await jsonOf(uploadResponse)
    assert.equal(upload.ok, true, JSON.stringify(upload))
    const commit = await rpc('upload.commit', {
      uploadId: upload.value.uploadId,
      meta: { title: 'My Paper', author: 'Ada', filename: 'My Paper.pdf' },
      content: { kind: 'pdf', version: 1, pageCount: 2, pages: [], toc: [{ id: 't1', title: 'One', level: 1, blockId: 'p1b0' }] },
    })
    assert.equal(commit.ok, true, JSON.stringify(commit))
    assert.equal(commit.value.doc.title, 'My Paper')
    assert.equal(commit.value.doc.contentVersion, 1)
    assert.equal(commit.value.doc.pageCount, 2, 'pageCount derives from stored content')
    assert.equal(commit.value.doc.chapterCount, 1, 'chapterCount derives from stored toc')
    const list = await rpc('library.list')
    assert.equal(list.value.docs.length, 1)
    const got = await rpc('library.get', { id: commit.value.doc.id })
    assert.equal(got.value.content.pageCount, 2)
    // original file is served
    const fileResponse = await surface.routes[2].fetch(new Request(`http://local/api/dsh-reader/file?docId=${commit.value.doc.id}&kind=original`))
    assert.equal(fileResponse.status, 200)
    assert.equal(Buffer.from(await fileResponse.arrayBuffer()).slice(0, 4).toString(), '%PDF')
  })

  await test('annotations + aux persist', async () => {
    const docId = store.listDocs()[0].id
    const ann = {
      id: randomUUID(),
      color: 'yellow',
      style: 'underline',
      text: 'highlighted words',
      note: 'my note',
      target: { kind: 'reflow', blockId: 'b1', start: 0, end: 5 },
    }
    const saved = await rpc('annotations.save', { id: docId, annotations: [ann] })
    assert.equal(saved.ok, true)
    const listed = await rpc('annotations.list', { id: docId })
    assert.equal(listed.value.annotations.length, 1)
    assert.equal(listed.value.annotations[0].note, 'my note')
    assert.equal(listed.value.annotations[0].style, 'underline')
    const aux = await rpc('aux.set', { id: docId, patch: { summary: 'hello', chat: [{ role: 'user', content: 'q' }] } })
    assert.equal(aux.value.aux.summary, 'hello')
    assert.equal(aux.value.aux.chat[0].role, 'user')
  })

  await test('chat appends once per message and preserves concurrent auxiliary writes', async () => {
    const id = store.listDocs()[0].id
    const user = { id: 'question-1', role: 'user', content: 'What is shown?', quote: 'Figure 1' }
    const answer = { id: 'answer-1', role: 'assistant', content: 'A comparison' }
    const results = await Promise.all([
      rpc('aux.appendChat', { id, message: user }),
      rpc('aux.set', { id, patch: { summary: 'A short summary' } }),
      rpc('aux.appendChat', { id, message: answer }),
      rpc('aux.appendChat', { id, message: user }),
    ])
    assert.ok(results.every(result => result.ok))
    const { aux } = (await rpc('aux.get', { id })).value
    assert.equal(aux.summary, 'A short summary')
    assert.equal(aux.chat.length, 3)
    assert.equal(aux.chat.filter(message => message.id === user.id).length, 1)
    assert.equal(aux.chat.find(message => message.id === user.id).quote, 'Figure 1')
    assert.equal(aux.chat.find(message => message.id === answer.id).content, answer.content)
  })

  await test('cancelling a chat response aborts the model and retains the selected-source context', async () => {
    const image = 'data:image/png;base64,eA=='
    let input
    const chatSurface = createRpcSurface({
      store, version: 'test', zotero,
      ai: { async chat(args) {
        input = args
        input.onDelta('started')
        await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
        return { text: 'aborted answer' }
      } },
    })
    const route = chatSurface.routes.find(item => item.path.endsWith('/stream'))
    const response = await route.fetch(new Request('http://local/api/dsh-reader/stream', {
      method: 'POST',
      body: JSON.stringify({ method: 'ai.chat', params: {
        messages: [{ role: 'user', content: 'Explain the labels' }],
        context: { sourceKind: 'media', text: 'Figure 1 legend', figureImage: image },
      } }),
    }))
    const stream = response.body.getReader()
    const decoder = new TextDecoder()
    assert.match(decoder.decode((await stream.read()).value), /event: start/)
    assert.match(decoder.decode((await stream.read()).value), /started/)
    assert.equal(input.figureImage, image)
    assert.match(input.system, /Selected source[\s\S]*Figure 1 legend/)
    assert.equal(input.signal.aborted, false)
    await stream.cancel()
    assert.equal(input.signal.aborted, true)
  })

  await test('unknown rpc method returns coded failure', async () => {
    const response = await rpc('nope.nope')
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unknown-method')
  })

  await test('default model falls back to the DeepSeek account route when the API-key route has no key', async () => {
    const calls = []
    const fakeLlm = {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'deepseek-account', name: 'DeepSeek Account' },
      ],
      stream(options) {
        calls.push(options.provider)
        if (options.provider === 'deepseek-official') {
          throw new Error('llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service')
        }
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'pong' }
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const fakeCtx = {
      get(name) {
        if (name === 'llm') return fakeLlm
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
        return undefined
      },
    }
    const fallbackAi = new AiGateway({ ctx: fakeCtx, store })
    const deltas = []
    const result = await fallbackAi.chat({ messages: [{ role: 'user', content: 'ping' }], onDelta: (text) => deltas.push(text) })
    assert.equal(result.text, 'pong')
    assert.deepEqual(calls, ['deepseek-official', 'deepseek-account'])
    assert.deepEqual(deltas, ['pong'])
    assert.match(result.model, /DeepSeek Account/)
  })

  // ----- mock OpenAI-compatible model server ------------------------------------------------
  let chatCalls = 0
  const mock = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      chatCalls++
      const user = payload.messages?.find((message) => message.role === 'user')?.content ?? ''
      let text = ''
      if (typeof user === 'string' && user.trim().startsWith('[')) {
        try {
          const items = JSON.parse(user)
          text = JSON.stringify(items.map((item) => `译文:${item}`))
        } catch {
          text = '["译文"]'
        }
      } else {
        text = 'Translated plain text.'
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, usage) => `data: ${JSON.stringify({ choices: [{ delta }], usage })}\n\n`
      res.write(chunk({ content: text.slice(0, Math.ceil(text.length / 2)) }))
      res.write(chunk({ content: text.slice(Math.ceil(text.length / 2)) }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const port = mock.address().port

  await test('custom provider translation + disk cache', async () => {
    const settings = await store.patchSettings({
      ai: {
        providers: [{ id: 'mock', name: 'Mock', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', models: ['mock-1'] }],
        active: { translate: { providerId: 'mock', model: 'mock-1' } },
      },
    })
    assert.equal(settings.ai.providers.length, 1)
    const first = await ai.translate({ texts: ['hello world', 'second paragraph'], targetLang: 'zh-CN' })
    assert.equal(first.translations.length, 2)
    assert.match(first.translations[0], /译文/)
    assert.equal(first.cached.every((flag) => flag === false), true)
    const callsAfterFirst = chatCalls
    const second = await ai.translate({ texts: ['hello world', 'second paragraph'], targetLang: 'zh-CN' })
    assert.equal(second.cached.every((flag) => flag === true), true)
    assert.equal(chatCalls, callsAfterFirst, 'cached translation must not call the model again')
    const stats = await store.cacheStats()
    assert.ok(stats.entries >= 2)
    const statsRpc = await rpc('ai.cache.stats')
    assert.ok(statsRpc.value.entries >= 2)
  })

  await test('custom provider chat streams deltas', async () => {
    const deltas = []
    const result = await ai.chat({ messages: [{ role: 'user', content: 'hi' }], ref: { providerId: 'mock', model: 'mock-1' }, onDelta: (text) => deltas.push(text) })
    assert.ok(result.text.length > 0)
    assert.ok(deltas.length >= 1)
    assert.equal(deltas.join(''), result.text)
  })

  await test('zotero status without configuration is explicit', async () => {
    const status = await zotero.status()
    assert.equal(status.web.configured, false)
    assert.equal(typeof status.local.available, 'boolean')
  })

  await test('public health probe exposes only version and aggregate status', async () => {
    const { createHealthHandler } = await import('../host/assets.js')
    const health = createHealthHandler({ store, pluginRoot: join(dir, 'plugin'), version: 'test' })
    const response = await new Promise((resolve) => {
      const chunks = []
      health({ url: '/dsh-reader/health', method: 'GET' }, {
        writeHead(code, headers) { this.code = code; this.headers = headers },
        end(body) { resolve({ code: this.code, body: body ? JSON.parse(body) : null }) },
      })
    })
    assert.equal(response.code, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.documentCount, 1)
    assert.deepEqual(Object.keys(response.body).sort(), ['documentCount', 'hostRevision', 'inlineMathVersion', 'ok', 'pdfjs', 'version'])
  })

  await test('folders: create, move doc, rename, remove (docs return to root)', async () => {
    await store.init()
    const docId = store.listDocs()[0].id
    const created = await rpc('folders.create', { name: 'Paper Reading' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const folder = created.value.folder
    assert.equal(created.value.folders.length, 1)
    // idempotent for the same name
    const again = await rpc('folders.create', { name: 'Paper Reading' })
    assert.equal(again.value.folder.id, folder.id)
    const moved = await rpc('folders.moveDoc', { docId, folderId: folder.id })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.value.doc.folderId, folder.id)
    const listed = await rpc('library.list')
    assert.equal(listed.value.folders.length, 1)
    assert.equal(listed.value.docs.find((doc) => doc.id === docId).folderId, folder.id)
    const renamed = await rpc('folders.rename', { id: folder.id, name: 'AI Systems' })
    assert.equal(renamed.value.folder.name, 'AI Systems')
    const removed = await rpc('folders.remove', { id: folder.id })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.equal(removed.value.folders.length, 0)
    assert.equal(removed.value.docs.find((doc) => doc.id === docId).folderId, null)
    // moving to an unknown folder is an explicit failure
    const badMove = await rpc('folders.moveDoc', { docId, folderId: 'no-such-folder' })
    assert.equal(badMove.ok, false)
    assert.equal(badMove.error.code, 'internal')
  })

  await test('AI structure refinement caches per page and filters invalid ids', async () => {
    const modelCalls = []
    const fakeLlm = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
      stream(options) {
        modelCalls.push(options.provider)
        const userMessage = options.messages?.[0]?.content?.[0]?.text ?? ''
        const payload = JSON.parse(userMessage)
        const ids = payload.blocks.map((block) => block.id)
        const answer = JSON.stringify({
          headings: [
            { id: ids[0], level: 1 },
            { id: ids[1], level: 2 },
            { id: 'not-a-real-id', level: 1 },
            { id: ids[2], level: 99 },
          ],
          drop: [ids[2], 'nope'],
        })
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const fakeCtx = {
      get(name) {
        if (name === 'llm') return fakeLlm
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
        return undefined
      },
    }
    const reflowAi = new AiGateway({ ctx: fakeCtx, store })
    const pages = [
      {
        n: 1,
        blocks: [
          { id: 'p1b0', kind: 'heading', text: '1 Introduction' },
          { id: 'p1b1', kind: 'heading', text: 'This is body text that was mis-classified.' },
          { id: 'p1b2', kind: 'paragraph', text: 'arXiv:2603.29765v1 [cs.LG] 31 Mar 2026' },
          { id: 'p1b3', kind: 'paragraph', text: 'Real body paragraph with a sentence.' },
        ],
      },
    ]
    const first = await reflowAi.refineStructure({ title: 'Test', pages })
    assert.equal(first.pages.length, 1)
    assert.equal(first.totalPages, 1)
    assert.equal(first.cachedPages, 0)
    assert.equal(modelCalls.length, 1)
    const suggestion = first.pages[0]
    assert.deepEqual(
      suggestion.headings.map((heading) => heading.id),
      ['p1b0', 'p1b1', 'p1b2'],
      'invalid ids are filtered',
    )
    assert.equal(suggestion.headings.find((heading) => heading.id === 'p1b2').level, 3, 'levels are clamped to 3')
    assert.deepEqual(suggestion.drop, ['p1b2'], 'invalid drop ids are filtered')
    const second = await reflowAi.refineStructure({ title: 'Test', pages })
    assert.equal(second.cachedPages, 1, 'second run is served from the reflow cache')
    assert.equal(modelCalls.length, 1, 'cache hit must not call the model again')
  })

  mock.close()
  await rm(dir, { recursive: true, force: true })

  const failed = results.filter((result) => result.ok === false)
  console.log(`\n${results.length - failed.length}/${results.length} host tests passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
