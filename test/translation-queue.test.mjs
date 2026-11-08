import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { translatableIndex } from '../shared/translation-blocks.js'
import * as translationEngines from '../shared/translation-engines.js'

// Run the production service with its unused JSX rendering imports stubbed.
const defaults = { ai: { targetLang: 'zh-CN', translate: { auto: true, batchSize: 3, concurrency: 1 } } }
const deps = {
  react: { createElement() {} },
  './store.jsx': { DEFAULT_SETTINGS: defaults },
  './ui.jsx': {},
  './icons.jsx': {},
  './util.js': {},
  '../shared/translation-blocks.js': { translatableIndex },
  '../shared/translation-engines.js': translationEngines,
}
const source = await readFile(new URL('../client-src/translate.jsx', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'jsx', format: 'cjs', target: 'node20' })
const module = { exports: {} }
new Function('require', 'module', 'exports', code)(id => deps[id], module, module.exports)
const { createTranslationService } = module.exports

function setup(t, options = {}, useStream = false) {
  const blocks = Array.from({ length: 7 }, (_, n) => ({ id: String(n), kind: 'paragraph', text: 'Passage ' + n }))
  const calls = [], waiting = []
  const api = {
    rpc(method, params, {signal} = {}) { return request(method, params, undefined, signal) },
  }
  if (useStream) api.stream = request
  function request(method, params, handlers, signal) {
      assert.equal(method, 'ai.translate')
      return new Promise((resolve, reject) => {
        const ids = params.texts.map(text => text.split(' ').at(-1))
        signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once:true})
        calls.push({
          ids, signal,
          progress: (index, text) => handlers?.onProgress({items:[{index,text}]}),
          finish: () => resolve({ translations: ids.map(id => '译文 ' + id) }),
          fail: () => reject(new Error('connection closed')),
        })
        for (const listener of waiting.splice(0)) listener()
      })
  }
  const settings = { ai: { ...defaults.ai, translate: { ...defaults.ai.translate, ...options } } }
  const service = createTranslationService({ api, settings, blocks })
  t.after(() => service.dispose())
  return { service, calls, async at(index) {
    while (!calls[index]) await new Promise(resolve => waiting.push(resolve))
    return calls[index]
  } }
}

test('one visible batch starts first and free slots translate off-screen paragraphs without scrolling', { timeout: 3000 }, async t => {
  const { service, at } = setup(t, { concurrency: 2 })
  service.setViewport(['4', '5'])
  service.setEnabled(true)
  assert.equal(service.stats.queued, 7)
  assert.equal(service.autoPending('0'), false)
  const visible = await at(0), background = await at(1)
  assert.deepEqual(visible.ids, ['4', '5'])
  assert.deepEqual(background.ids, ['0', '1', '2'])
  background.finish()
  assert.deepEqual((await at(2)).ids, ['3', '6'])
  assert.equal(service.get('4').status, 'loading')
})

test('the next request favors the new viewport over unsent work from the old viewport', { timeout: 3000 }, async t => {
  const { service, calls, at } = setup(t, { batchSize: 1 })
  service.setViewport(['3', '4'])
  service.setEnabled(true)
  const first = await at(0)
  assert.deepEqual(first.ids, ['3'])
  service.setViewport(['6', '5'])
  first.finish()
  assert.deepEqual((await at(1)).ids, ['6'])
  assert.equal(calls.length, 2)
})

test('automatic work pauses with translation off and resumes without repeating completed results', { timeout: 3000 }, async t => {
  const { service, calls, at } = setup(t, { batchSize: 1 })
  service.setViewport(['3', '4'])
  service.setEnabled(true)
  const first = await at(0)
  service.setEnabled(false)
  first.finish()
  await new Promise(setImmediate)
  assert.equal(service.get('3').status, 'done')
  assert.equal(service.stats.queued, 0)
  assert.equal(calls.length, 1)
  service.setEnabled(true)
  assert.deepEqual((await at(1)).ids, ['4'])
})

test('manual full-document translation uses viewport priority with automatic translation disabled', { timeout: 3000 }, async t => {
  const { service, calls, at } = setup(t, { auto: false })
  service.setViewport(['5'])
  service.setEnabled(true)
  assert.equal(service.stats.queued, 0)
  assert.equal(calls.length, 0)
  service.requestAll()
  const first = await at(0)
  assert.deepEqual(first.ids, ['5'])
  first.finish()
  assert.deepEqual((await at(1)).ids, ['0', '1', '2'])
})

test('streamed results display immediately and survive a later failure in the same request', { timeout:3000 }, async t=>{
  const {service,at}=setup(t,{},true)
  service.setViewport(['4','5'])
  service.setEnabled(true)
  const batch=await at(0)
  batch.progress(0,'已完成的译文')
  assert.equal(service.get('4').text,'已完成的译文')
  assert.equal(service.get('5').status,'loading')
  batch.fail()
  await at(1)
  assert.equal(service.get('4').status,'done')
  assert.equal(service.get('5').status,'error')
})

test('changing translation language cancels obsolete requests and rejects their late results', {timeout:3000}, async t=>{
  const {service,at}=setup(t,{batchSize:1},true)
  service.setViewport(['5'])
  service.setEnabled(true)
  const old=await at(0)
  service.setLang('ja')
  assert.equal(old.signal.aborted,true)
  const next=await at(1)
  assert.deepEqual(next.ids,['5'])
  old.progress(0,'旧译文')
  assert.equal(service.get('5').status,'loading')
  next.progress(0,'新しい訳文')
  assert.equal(service.get('5').text,'新しい訳文')
})

test('updated concurrency applies to the current document while a batch is running', {timeout:3000}, async t=>{
  const {service,at}=setup(t,{batchSize:1},true)
  service.setEnabled(true)
  const first=await at(0)
  service.setScheduling({batchSize:2,concurrency:2})
  const second=await at(1)
  assert.deepEqual(first.ids,['0'])
  assert.deepEqual(second.ids,['1','2'])
  assert.equal(service.get('0').status,'loading')
})
