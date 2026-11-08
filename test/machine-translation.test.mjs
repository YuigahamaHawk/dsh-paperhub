import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AiGateway } from '../host/ai.js'
import { normalizeSettings } from '../host/store.js'
import { modelRouteOptions } from '../client-src/model-routes.js'
import { LIBRETRANSLATE, MYMEMORY, normalizeLibreUrl } from '../shared/translation-engines.js'

function fixture(providerId) {
  const cache = new Map()
  const settings = normalizeSettings({ ai: { active: { translate: { providerId } } } })
  const gateway = new AiGateway({
    ctx: { get() { throw new Error('a machine translation must not access a DSH model') } },
    store: {
      getSettings: () => settings,
      getCachedTranslation: async key => cache.get(key) ?? null,
      setCachedTranslation: async (key, value) => cache.set(key, value),
    },
  })
  return { gateway, settings, cache }
}

test('free engines are selectable for translation only, without changing defaults', () => {
  const { gateway, settings } = fixture(MYMEMORY)
  assert.equal(normalizeSettings({}).ai.active.translate.providerId, 'dsh')
  assert.equal(settings.ai.active.translate.providerId, MYMEMORY)
  assert.throws(() => gateway.resolveFor('chat', { providerId: MYMEMORY }), /translation only/)
  assert.throws(() => gateway.resolveFor('vision', { providerId: LIBRETRANSLATE }), /translation only/)
  const normalized = normalizeSettings({ ai: { active: { chat: { providerId: MYMEMORY }, vision: { providerId: LIBRETRANSLATE } } } })
  assert.equal(normalized.ai.active.chat.providerId, 'dsh')
  assert.equal(normalized.ai.active.vision.providerId, 'dsh')
  const t = (_key, label) => label
  for (const id of [MYMEMORY, LIBRETRANSLATE]) {
    assert.ok(modelRouteOptions(t, {}, [], { forTranslation: true }).some(option => option.value === id + '|'))
    assert.ok(!modelRouteOptions(t, {}).some(option => option.value === id + '|'))
    assert.ok(!modelRouteOptions(t, {}, [], { forVision: true }).some(option => option.value === id + '|'))
  }
})

test('MyMemory chunks UTF-8 losslessly, shields formulas and uses separate source-language caches', async t => {
  const { gateway, settings } = fixture(MYMEMORY)
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.origin, 'https://api.mymemory.translated.net')
    const text = url.searchParams.get('q')
    assert.ok(Buffer.byteLength(text) <= 500)
    assert.ok(!text.includes('DSHMATH'))
    assert.ok(!text.includes('\uFFFD'))
    requests.push({ text, pair: url.searchParams.get('langpair') })
    return Response.json({ responseStatus: 200, responseData: { translatedText: text.replace('&', '&amp;') } })
  })
  const prose = '研究𠀀'.repeat(90) + '&'
  const token = '⟦DSHMATH_A⟧'
  const source = prose + ' ' + token + ' The network has 32 stations.'
  const first = await gateway.translate({ texts: [source] })
  assert.deepEqual(first.translations, [source])
  assert.equal(first.model, 'MyMemory')
  assert.ok(requests.length > 2)
  assert.ok(requests.every(request => request.pair === 'en|zh-CN'))
  const count = requests.length
  assert.deepEqual((await gateway.getCachedTranslations({ texts: [source] })).translations, [source])
  assert.equal(requests.length, count)
  settings.ai.translate.myMemorySource = 'ja'
  assert.deepEqual((await gateway.getCachedTranslations({ texts: [source] })).translations, [null])
  await gateway.translate({ texts: [source] })
  assert.equal(requests.at(-1).pair, 'ja|zh-CN')
})

test('MyMemory quota errors stop additional requests and are never cached as text', async t => {
  const { gateway, cache } = fixture(MYMEMORY)
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    responseStatus: 403,
    responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' },
  }))
  const result = await gateway.translate({ texts: ['The control group performed well.', 'The second trial used a different setup.'] })
  assert.equal(fetch.mock.callCount(), 1)
  assert.deepEqual(result.translations, [null, null])
  assert.ok(result.errors.every(error => error.code === 'translation-rate-limit'))
  assert.equal(cache.size, 0)
})

test('LibreTranslate batches separate prose spans and segregates the endpoint cache', async t => {
  const { gateway, settings, cache } = fixture(LIBRETRANSLATE)
  settings.ai.translate.libreUrl = 'http://127.0.0.1:8080/example'
  settings.ai.translate.libreKey = 'test-key'
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/languages')) {
      assert.equal(url, settings.ai.translate.libreUrl + '/languages')
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      return Response.json([{ code: 'en' }, { code: 'zt' }])
    }
    assert.equal(url, settings.ai.translate.libreUrl + '/translate')
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    const payload = JSON.parse(options.body)
    assert.deepEqual(payload, {
      q: ['The optimal value', 'is reached after 4 steps.', 'The follow-up test used 21 participants.'],
      source: 'auto', target: 'zt', format: 'text', api_key: 'test-key',
    })
    return Response.json({ translatedText: ['最佳值', '在 4 步後達成。', '後續測試有 21 位參與者。'] })
  })
  const token = '⟦DSHMATH_A⟧'
  const texts = ['The optimal value ' + token + ' is reached after 4 steps.', 'The follow-up test used 21 participants.']
  const result = await gateway.translate({ texts, targetLang: 'zh-TW' })
  assert.deepEqual(result.translations, ['最佳值 ' + token + ' 在 4 步後達成。', '後續測試有 21 位參與者。'])
  assert.equal(fetch.mock.callCount(), 2)
  assert.ok([...cache.keys()].every(key => !key.includes('test-key')))
  assert.deepEqual((await gateway.getCachedTranslations({ texts, targetLang: 'zh-TW' })).translations, result.translations)
  settings.ai.translate.libreUrl = 'http://127.0.0.1:8081'
  assert.deepEqual((await gateway.getCachedTranslations({ texts, targetLang: 'zh-TW' })).translations, [null, null])
  await assert.rejects(gateway.translate({ texts, ref: { providerId: LIBRETRANSLATE, scope: 'http://127.0.0.1:8080/example' } }), /settings changed/)
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(normalizeLibreUrl('file:///test'), '')
  assert.equal(normalizeLibreUrl('https://user:secret@example.org'), '')
  assert.equal(normalizeLibreUrl('http://127.0.0.1:5000/'), 'http://127.0.0.1:5000')
})

test('LibreTranslate rejects malformed batch responses without shifting or caching results', async t => {
  const { gateway, cache } = fixture(LIBRETRANSLATE)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/languages')) return Response.json([{ code: 'en' }, { code: 'zh-Hans' }])
    assert.equal(JSON.parse(options.body).target, 'zh-Hans')
    return Response.json({ translatedText: ['只有一条结果'] })
  })
  const result = await gateway.translate({ texts: ['First item.', 'Second item.'] })
  assert.deepEqual(result.translations, [null, null])
  assert.ok(result.errors.every(error => error.code === 'translation-response'))
  assert.equal(cache.size, 0)
})
