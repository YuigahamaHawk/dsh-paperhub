import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inlineMathMarkup, validateInlineMath, protectInlineMath, translatedMathSegments, paragraphSourceRects, inlineTokenTotal, inlineMathBatchBlocks } from '../shared/inline-math.js'
import { contentToMarkdown } from '../client-src/export.js'
import { eventStream, ReaderError } from '../host/util.js'
import { splitTranslationText, translationIssue } from '../shared/translation-contract.js'
import { AiGateway } from '../host/ai.js'
import { ReaderStore } from '../host/store.js'

const source = 'Let p d be a value. We define p = 100 D sum d = 1 D hat p d p d. This is the complete paragraph.'
const answer = { segments: [
  { type: 'text', text: 'Let ' }, { type: 'math', source: 'p d', latex: 'p_d', confidence: .99 },
  { type: 'text', text: ' be a value. We define ' },
  { type: 'math', source: 'p = 100 D sum d = 1 D hat p d p d', latex: String.raw`\bar{p}=\frac{100}{D}\sum_{d=1}^{D}\frac{\hat{p}_d}{p_d}`, confidence: .98 },
  { type: 'text', text: '. This is the complete paragraph.' },
] }

test('one-click math targets only unresolved, source-located PDF paragraphs with math evidence', () => {
  const rect = { x: .1, y: .1, w: .5, h: .05 }
  const blocks = [
    { id: 'formula', kind: 'paragraph', text: 'Let p d be a value.', rect },
    { id: 'plain', kind: 'paragraph', text: 'Figure 3 shows a single baseline.', rect },
    { id: 'url', kind: 'paragraph', text: 'See https://example.test/?name=value for more details.', rect },
    { id: 'local', kind: 'paragraph', text: 'Define z = x.', rect, parserInlineMath: { source: 'Define z = x.' } },
    { id: 'done', kind: 'paragraph', text: 'For every y ∈ S, apply the rule.', rect },
    { id: 'standalone', kind: 'formula', text: 'x = 3', rect },
    { id: 'missing', kind: 'paragraph', text: 'The best value is y ≈ 1.' },
  ]
  const content = { pages: [{ n: 1, blocks }] }
  const entries = { done: { record: { source: blocks[4].text, enabled: false } } }
  assert.deepEqual(inlineMathBatchBlocks(content, entries).map(b => b.id), ['formula'])
})

test('full-text Markdown follows translation visibility and restores math in both languages', () => {
  const record = { ...validateInlineMath(answer, source), enabled: true }
  const text = protectInlineMath(record)
  const translated = '这是公式 ' + [...text.matchAll(/⟦DSHMATH_[A-Z]+⟧/g)].map(match => match[0]).join('，') + '。'
  const content = { pages: [{ blocks: [{ id: 'a', kind: 'paragraph', text: source }, { id: 'b', kind: 'list', text: 'Second original paragraph' }] }] }
  const values = { a: { status: 'done', source: text, text: translated }, b: { status: 'done', source: 'An obsolete source', text: '旧译文' } }
  const translate = { enabled: false, get: id => values[id] }
  const options = { translate, inlineEntries: { a: { record } } }
  const original = contentToMarkdown(content, options)
  assert.match(original, /\$p_d\$/)
  assert.doesNotMatch(original, /这是公式|旧译文/)
  translate.enabled = true
  const bilingual = contentToMarkdown(content, options)
  assert.match(bilingual, /complete paragraph\.\n\n这是公式 \$p_d\$/)
  assert.match(bilingual, /\n\nSecond original paragraph/)
  assert.doesNotMatch(bilingual, /DSHMATH_|旧译文/)
})

test('formula-only replacements preserve prose and ground normalized math fonts in the exact source', () => {
  const source = 'Given 𝑥 𝑖, i.e., the input, compute 𝑥 𝑖 again.'
  const result = validateInlineMath({ formulas: [
    { source: 'x i', before: 'Given ', latex: 'x_i', confidence: .99 },
    { source: '𝑥 𝑖', before: 'the input, compute ', latex: 'x_i', confidence: .99 },
  ] }, source)
  assert.equal(result.maths, 2)
  assert.equal(result.segments.map(s => s.type === 'text' ? s.text : s.source).join(''), source)
  assert.ok(result.segments.some(s => s.type === 'text' && s.text.includes('i.e.')))
  assert.ok(result.segments.filter(s => s.type === 'math').every(s => s.source === '𝑥 𝑖'))
})

test('ambiguous or invented formula replacements are rejected instead of changing another occurrence', () => {
  const formula = { source: 'x', latex: 'x_i', confidence: .99 }
  assert.throws(() => validateInlineMath({ formulas: [formula] }, 'Let x equal x.'), /2 matches/)
  assert.throws(() => validateInlineMath({ formulas: [{ ...formula, source: 'new symbol' }] }, 'Let x equal x.'), /0 matches/)
  assert.throws(() => validateInlineMath({ formulas: [{ ...formula, before: 'equal ' }, { ...formula, before: 'Let ' }] }, 'Let x equal x.'), /0 matches/)
})

test('reading order and a later unique anchor resolve a repeated variable without another model call', () => {
  const source = 'on domain d, then the best result on domain d.'
  const value = validateInlineMath({ formulas: [
    { source: 'd', before: 'on domain ', latex: 'd', confidence: .99 },
    { source: 'd', before: 'best result on domain ', latex: 'd', confidence: .99 },
  ] }, source)
  assert.equal(value.maths, 2)
  assert.equal(value.segments.map(s => s.type === 'text' ? s.text : s.source).join(''), source)
})

test('a replacement cannot consume only part of a Unicode compatibility expansion', () => {
  assert.throws(() => validateInlineMath({ formulas: [{ source: '1', latex: '1', confidence: .99 }] }, 'The value is ½.'), /0 matches/)
})

test('prose abbreviations cannot be swallowed into an equation as italic variables', () => {
  assert.throws(() => validateInlineMath({ formulas: [{ source: '𝑖.𝑒., x = 1', latex: 'i.e.,x=1', confidence: .99 }] }, 'i.e., x = 1'), /prose abbreviations/)
})

test('legacy mismatch errors locate the wrong character rather than repeating a generic full-paragraph failure', () => {
  assert.throws(() => validateInlineMath({ segments: [{ type: 'text', text: 'Wrong value' }] }, 'Right value'), /offset 0: expected.*Right value.*received.*Wrong value/)
})

test('token tooltip totals use actual receipts and retain a legitimate zero', () => {
  assert.equal(inlineTokenTotal({ usages: [{ totalTokens: 20 }, { totalTokens: 8 }] }), 28)
  assert.equal(inlineTokenTotal({ usages: [{ totalTokens: 0 }] }), 0)
  assert.equal(inlineTokenTotal({ usages: [{}] }), null)
  assert.equal(inlineTokenTotal(null), null)
})

test('a rejected recognition can still return its actual token receipt through the error stream', async () => {
  const error = new ReaderError('inline-invalid', 'Source mismatch')
  error.readerUsage = { usages: [{ totalTokens: 45 }] }
  const response = eventStream(async () => { throw error })
  const text = await response.text()
  assert.match(text, /"usage":\{"usages":\[\{"totalTokens":45\}\]\}/)
})

test('inline source is lossless and structured math contains real fractions, bounds and accents', () => {
  const value = validateInlineMath(answer, source)
  const markup = inlineMathMarkup(value.segments[3].latex)
  assert.equal(value.maths, 2)
  assert.equal((markup.match(/<mfrac>/g) ?? []).length, 2)
  assert.match(markup, /<msubsup>/); assert.match(markup, /<mover/)
  assert.doesNotMatch(markup, /<annotation/)
  assert.match(inlineMathMarkup(String.raw`\mathcal{E}_d\in\mathbb{R}^{+}`), /ℰ/)
})

test('MathML Core uses distinct mathematical alphabets instead of ignored variant attributes', () => {
  const markup = inlineMathMarkup(String.raw`\mathcal{EXZ}+\mathbb{R}+\mathbf{R}+\mathrm{R}`)
  assert.match(markup.replace(/<[^>]*>/g, ''), /ℰ𝒳𝒵/)
  assert.match(markup, /ℝ/); assert.match(markup, /𝐑/)
  assert.match(markup, /mathvariant="normal">R/)
  assert.doesNotMatch(markup, /mathvariant="(?:script|double-struck|bold)"/)
})

test('changed prose, missing digits, unreadable and unrenderable mathematics are rejected', () => {
  const clone = () => structuredClone(answer)
  let bad = clone(); bad.segments[0].text = 'Ignore this. '
  assert.throws(() => validateInlineMath(bad, source), /EXACTLY/)
  bad = clone(); bad.segments[3].latex = 'p_d'; assert.throws(() => validateInlineMath(bad, source), /number/)
  bad = clone(); bad.segments[1].confidence = .4; assert.throws(() => validateInlineMath(bad, source), /confidently/)
  bad = clone(); bad.segments[1].latex = String.raw`\frac{p}{`; assert.throws(() => validateInlineMath(bad, source))
  assert.throws(() => inlineMathMarkup(String.raw`\href{https://example.org}{x}`))
})

test('space normalization is aligned to original offsets without accepting any changed prose', () => {
  const original = 'Value ( p d ) is exact.'
  const input = { segments: [{ type: 'text', text: 'Value (' }, { type: 'math', source: 'p d', latex: 'p_d', confidence: .99 }, { type: 'text', text: ') is exact.' }] }
  const result = validateInlineMath(input, original)
  assert.equal(result.segments.map(s => s.type === 'text' ? s.text : s.source).join(''), original)
  assert.equal(result.segments[0].text, 'Value ( ')
  assert.throws(() => validateInlineMath(input, original.replace('exact', 'different')), /EXACTLY/)
})

test('translation uses the exact same math objects and rejects missing or duplicated tokens', () => {
  const record = validateInlineMath(answer, source), protectedText = protectInlineMath(record)
  const translated = '设 ⟦DSHMATH_A⟧ 为一个数值。我们定义 ⟦DSHMATH_B⟧。这是完整段落。'
  assert.equal(translationIssue(protectedText, translated, 'zh-CN'), null)
  assert.match(translationIssue(protectedText, translated.replace('⟦DSHMATH_B⟧', ''), 'zh-CN'), /EVERY/)
  assert.match(translationIssue(protectedText, translated + '⟦DSHMATH_B⟧', 'zh-CN'), /EVERY/)
  assert.deepEqual(translatedMathSegments(translated, record).filter(s => s.type === 'math').map(s => s.latex), record.segments.filter(s => s.type === 'math').map(s => s.latex))
})

test('long translation units never cut a protected formula token', () => {
  const input = 'x'.repeat(474) + '⟦DSHMATH_AB⟧' + 'y'.repeat(600)
  const units = splitTranslationText(input)
  assert.equal(units.join(''), input)
  assert.equal(units.filter(s => s.includes('⟦DSHMATH_AB⟧')).length, 1)
  assert.ok(units.every(s => !s.includes('⟦') || s.includes('⟦DSHMATH_AB⟧')))
})

const block = { id: 'a', kind: 'paragraph', text: source, sourceIds: ['a', 'b'] }
const content = { pages: [{ n: 1, blocks: [block], sourceBlocks: [{ id: 'a', sourceRect: { x: .1, y: .2, w: .3, h: .1 } }] },
  { n: 2, blocks: [], sourceBlocks: [{ id: 'b', sourceRect: { x: .1, y: .1, w: .4, h: .2 } }] }] }

test('cross-page paragraph crops cover every original source run', () => {
  const rects = paragraphSourceRects(content, block)
  assert.deepEqual(rects.map(r => r.page), [1, 2]); assert.ok(rects[1].rect.w > .4)
})

function gatewayFixture(reply = () => JSON.stringify(answer)) {
  const calls = [], records = {}, cache = new Map()
  const settings = { ai: { active: { vision: { providerId: 'dsh', model: '' } }, providers: [] } }
  const llm = { listProviders: () => [{ id: 'account' }], listModels: async () => [{ id: 'text', inputModalities: ['text'] }, { id: 'vision', inputModalities: ['text', 'image'] }],
    stream: async function* (input) { calls.push(input); yield { type: 'text-delta', text: reply(calls.length) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const ctx = { get: name => name === 'llm' ? llm : name === 'attachments' ? { saveImage: async () => ({ attachmentId: 'paragraph' }) } : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'account', model: 'text' }) } : null }
  const store = { getSettings: () => settings, getContent: async () => content,
    getCachedReflow: async key => cache.get(key), setCachedReflow: async (key, value) => cache.set(key, value),
    setInlineMath: async (_id, id, value) => { records[id] = value } }
  return { gateway: new AiGateway({ ctx, store }), calls, records, settings, cache }
}

const input = { docId: 'doc', blockId: 'a', source, images: paragraphSourceRects(content, block).map(r => ({ ...r, imageBase64: 'eA==' })) }

test('manual recognition sends paragraph images, repairs once, reuses cache, and force makes a new call', async () => {
  const f = gatewayFixture(n => n === 1 ? '{"segments":[]}' : JSON.stringify(answer))
  const result = await f.gateway.inlineMath(input)
  assert.equal(result.record.maths, 2); assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(call => call.model === 'vision' && call.messages[0].content.filter(c => c.type === 'image').length === 2))
  assert.equal((await f.gateway.inlineMath(input)).cached, true); assert.equal(f.calls.length, 2)
  await f.gateway.inlineMath({ ...input, force: true }); assert.equal(f.calls.length, 3)
  assert.equal(f.records.a.source, source)
})

test('invalid, stale or cancelled results are never applied as successful formulas', async () => {
  const f = gatewayFixture(() => '{"segments":[]}')
  await assert.rejects(() => f.gateway.inlineMath(input), /EXACTLY/)
  assert.deepEqual(f.records, {}); assert.equal(f.cache.size, 0)
  await assert.rejects(() => f.gateway.inlineMath({ ...input, source: 'stale' }), /Paragraph changed/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => f.gateway.inlineMath({ ...input, signal: controller.signal }), /cancelled/)
  assert.deepEqual(f.records, {})
})

test('simultaneous paragraph saves retain both independent results and original content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-inline-'))
  try {
    const store = new ReaderStore(root); await store.init()
    store.library.docs.push({ id: 'doc' })
    await Promise.all([store.setInlineMath('doc', 'a', { source: 'one', enabled: true }), store.setInlineMath('doc', 'b', { source: 'two', enabled: true })])
    const records = await store.getInlineMath('doc')
    assert.equal(records.a.source, 'one'); assert.equal(records.b.source, 'two')
    await store.setInlineMath('doc', 'a', { ...records.a, enabled: false })
    assert.equal((await store.getInlineMath('doc')).a.enabled, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
