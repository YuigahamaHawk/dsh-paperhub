import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReaderStore } from '../host/store.js'
import { AiGateway } from '../host/ai.js'
import { applyVisionLayout } from '../client-src/vision-layout.js'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.error(`FAIL  ${name}: ${error?.stack ?? error}`)
  }
}

function content() {
  return {
    pages: [
      {
        n: 3,
        blocks: [
          { id: 'p3b0', kind: 'paragraph', text: 'body before' },
          { id: 'p3b1', kind: 'paragraph', text: 'caption candidate', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
          { id: 'p3b2', kind: 'caption', text: 'Figure 2 caption' },
        ],
      },
    ],
  }
}

await test('vision region replaces an existing candidate rect and role', () => {
  const out = applyVisionLayout(content(), {
    pages: [{ n: 3, regions: [{ id: 'r1', kind: 'figure', candidateIds: ['p3b1'], bbox: [0.05, 0.1, 0.95, 0.6], captionId: 'p3b2', confidence: 0.9 }] }],
  })
  const block = out.content.pages[0].blocks.find((item) => item.id === 'p3b1')
  assert.equal(block.kind, 'figure')
  assert.ok(Math.abs(block.rect.x - 0.05) < 1e-9)
  assert.ok(Math.abs(block.rect.w - 0.9) < 1e-9)
  assert.equal(block.rect.y, 0.1)
  assert.equal(out.content.pages[0].blocks.find((item) => item.id === 'p3b2').kind, 'caption')
  assert.equal(out.regions, 1)
})

await test('vision region without a candidate becomes a new image block at its anchor', () => {
  const out = applyVisionLayout(content(), {
    pages: [{ n: 3, regions: [{ id: 'r1', kind: 'algorithm', candidateIds: [], bbox: [0.1, 0.1, 0.9, 0.5], afterBlockId: 'p3b0', number: '1', renderAs: 'image' }] }],
  })
  const created = out.content.pages[0].blocks.find((block) => block.id.startsWith('p3vision'))
  assert.ok(created)
  assert.equal(created.kind, 'figure')
  assert.equal(created.structure, 'algorithm')
  assert.equal(created.number, '1')
  assert.equal(out.created, 1)
})

await test('frame caption fix demotes a body reference', () => {
  const out = applyVisionLayout(content(), { pages: [{ n: 3, captionFixes: [{ id: 'p3b2', kind: 'paragraph' }] }] })
  assert.equal(out.content.pages[0].blocks.find((block) => block.id === 'p3b2').kind, 'paragraph')
})

await test('host visionLayout saves an image and sends an image block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reader-vision-'))
  try {
    const store = new ReaderStore(join(dir, 'reader'))
    await store.init()
    let captured = null
    const saved = { attachmentId: 'sha256:test-image', mediaType: 'image/jpeg', width: 1200, height: 1600 }
    const llm = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
      listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text', 'image'] }],
      stream: async function* (options) {
        captured = options
        yield { type: 'text-delta', text: JSON.stringify({ page: 1, regions: [{ id: 'r1', kind: 'formula', candidateIds: ['p1b0'], bbox: [0.2, 0.3, 0.8, 0.4], number: '4', renderAs: 'image', confidence: 0.95 }], captionFixes: [], paragraphs: [], warnings: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const ctx = {
      get(name) {
        if (name === 'llm') return llm
        if (name === 'attachments') return { saveImage: async (input) => { assert.equal(input.mediaType, 'image/jpeg'); return saved } }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
        return undefined
      },
    }
    const gateway = new AiGateway({ ctx, store })
    const result = await gateway.visionLayout({
      title: 'test',
      pages: [{ n: 1, imageBase64: Buffer.from('fake-jpeg').toString('base64'), width: 1200, height: 1600, candidates: [{ id: 'p1b0', kind: 'formula', text: 'x = 1', bbox: [0.1, 0.1, 0.9, 0.2] }] }],
    })
    assert.equal(result.pages.length, 1)
    assert.equal(result.pages[0].regions.length, 1)
    assert.ok(captured)
    const user = captured.messages[captured.messages.length - 1]
    const image = user.content.find((part) => part.type === 'image')
    assert.deepEqual(image?.attachment, saved)
    assert.match(user.content.find((part) => part.type === 'text')?.text ?? '', /candidates/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const failed = results.filter((result) => !result.ok)
if (failed.length > 0) {
  console.error(`${failed.length}/${results.length} vision tests failed`)
  process.exitCode = 1
} else {
  console.log(`${results.length}/${results.length} vision tests passed`)
}
