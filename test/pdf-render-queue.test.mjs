import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPdfPage } from '../client-src/pdf-engine.js'
import { createPdfRenderQueue, PDF_PAGE_TIMEOUT } from '../client-src/pdf-render-queue.js'

test('a queued page starts its timeout only after the prior draw releases the queue', async context => {
  const timers = context.mock.method(globalThis, 'setTimeout', () => 1)
  context.mock.method(globalThis, 'clearTimeout', () => {})
  const enqueue = createPdfRenderQueue()
  let finishFirst, finishSecond
  const first = enqueue(() => new Promise(resolve => { finishFirst = resolve }))
  const second = enqueue(() => new Promise(resolve => { finishSecond = resolve }))
  await Promise.resolve()
  assert.equal(timers.mock.callCount(), 1)
  assert.equal(finishSecond, undefined)
  finishFirst('first')
  assert.equal(await first, 'first')
  await Promise.resolve()
  assert.equal(timers.mock.callCount(), 2)
  finishSecond('second')
  assert.equal(await second, 'second')
})

test('an actively stalled page is cancelled and the next page can draw', async () => {
  const enqueue = createPdfRenderQueue(20)
  let activeSignal
  const stalled = enqueue(signal => {
    activeSignal = signal
    return new Promise(() => {})
  })
  const later = enqueue(() => 'next page')
  await assert.rejects(stalled, { code: PDF_PAGE_TIMEOUT })
  assert.equal(activeSignal.aborted, true)
  assert.equal(await later, 'next page')
})

test('a cancelled PDF page lookup does not start a late canvas draw', async () => {
  let resolvePage
  const pdf = { getPage: () => new Promise(resolve => { resolvePage = resolve }) }
  const controller = new AbortController()
  const rendered = renderPdfPage(pdf, 1, { signal: controller.signal })
  controller.abort()
  resolvePage({ getViewport: () => assert.fail('A cancelled page must not allocate a canvas') })
  await assert.rejects(rendered, { name: 'AbortError' })
})
