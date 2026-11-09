import assert from 'node:assert/strict'
import { applyLayoutPlan, buildLayoutWindows } from '../client-src/layout-plan.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.error(`FAIL  ${name}: ${error?.message ?? error}`)
  }
}

function doc() {
  return {
    pages: [
      { n: 1, blocks: [{ id: 'p1b1', kind: 'paragraph', text: 'A separate preceding paragraph.' }, { id: 'p1b0', kind: 'paragraph', text: 'First half of a paragraph' }] },
      { n: 2, blocks: [{ id: 'p2b0', kind: 'paragraph', text: 'continues here and ends.' }, { id: 'p2b1', kind: 'caption', text: 'Figure 1 A caption.' }] },
    ],
  }
}

test('windows overlap so a boundary paragraph is fully visible', () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({ n: index + 1, blocks: [{ id: `p${index + 1}b0`, kind: 'paragraph', text: `page ${index + 1}` }] }))
  const windows = buildLayoutWindows({ pages }, { size: 6, stride: 4 })
  assert.equal(windows.length, 2)
  assert.equal(windows[0].pages[0].n, 1)
  assert.equal(windows[1].pages[0].n, 5)
  assert.equal(windows[1].pages[windows[1].pages.length - 1].n, 10)
})

test('cross-page group merges text and keeps the first id', () => {
  const result = applyLayoutPlan(doc(), { windows: [{ groups: [['p1b0', 'p2b0']], captions: [] }] })
  assert.equal(result.merged, 1)
  assert.equal(result.content.pages[0].blocks[1].id, 'p1b0')
  assert.equal(result.content.pages[0].blocks[1].text, 'First half of a paragraph continues here and ends.')
  assert.equal(result.content.pages[1].blocks.length, 1)
})

test('same-page group with a finished anchor is rejected', () => {
  const base = {
    pages: [
      {
        n: 1,
        blocks: [
          { id: 'p1b0', kind: 'paragraph', text: 'A complete first paragraph.' },
          { id: 'p1b1', kind: 'paragraph', text: 'A separate second paragraph.' },
        ],
      },
    ],
  }
  const result = applyLayoutPlan(base, { windows: [{ groups: [['p1b0', 'p1b1']], captions: [] }] })
  assert.equal(result.merged, 0)
  assert.equal(result.content.pages[0].blocks.length, 2)
})

test('captions are labelled but invalid ids are ignored', () => {
  const result = applyLayoutPlan(doc(), { windows: [{ groups: [['p1b0', 'ghost', 'p2b0']], captions: ['p2b1', 'ghost'] }] })
  assert.equal(result.merged, 1)
  assert.equal(result.captions, 1)
  assert.equal(result.content.pages[1].blocks.find((block) => block.id === 'p2b1').kind, 'caption')
})

test('demotes a body sentence that starts with a figure reference', () => {
  const base = { pages: [{ n: 10, blocks: [{ id: 'b7', kind: 'caption', text: 'Figure 3 reports decode throughput and mean TTFT.' }, { id: 'b8', kind: 'paragraph', text: 'Decode throughput.' }] }] }
  const result = applyLayoutPlan(base, { windows: [{ groups: [], captions: [], demoteCaptions: ['b7'] }] })
  assert.equal(result.content.pages[0].blocks[0].kind, 'paragraph')
  assert.equal(result.captions, 0)
})

test('same-page group with an open anchor is allowed, finished anchors are not', () => {
  const base = {
    pages: [
      {
        n: 3,
        blocks: [
          { id: 'a', kind: 'paragraph', text: 'The value is' },
          { id: 'b', kind: 'paragraph', text: 'controlled by a hyperparameter.' },
          { id: 'c', kind: 'paragraph', text: 'A finished paragraph.' },
          { id: 'd', kind: 'paragraph', text: 'Another paragraph.' },
        ],
      },
    ],
  }
  const open = applyLayoutPlan(base, { windows: [{ groups: [['a', 'b']], captions: [] }] })
  assert.equal(open.merged, 1)
  const closed = applyLayoutPlan(base, { windows: [{ groups: [['c', 'd']], captions: [] }] })
  assert.equal(closed.merged, 0)
})

test('hyphenated continuation joins without a duplicate hyphen', () => {
  const base = { pages: [{ n: 1, blocks: [{ id: 'a', kind: 'paragraph', text: 'inter-' }] }, { n: 2, blocks: [{ id: 'b', kind: 'paragraph', text: 'national text.' }] }] }
  const result = applyLayoutPlan(base, { windows: [{ groups: [['a', 'b']], captions: [] }] })
  assert.equal(result.content.pages[0].blocks[0].text, 'international text.')
})

test('rejects a plan that skips over real body text or jumps a failed page', () => {
  const base = doc()
  base.pages[0].blocks.reverse()
  const plan = { windows: [{ groups: [['p1b0', 'p2b0']] }] }
  assert.equal(applyLayoutPlan(base, plan, { inferContinuations: true }).merged, 0)
  base.pages[0].blocks.pop()
  base.pages.splice(1, 0, { n: 2, layoutFailed: true, blocks: [{ kind: 'pageFigure', id: 'unknown' }] })
  base.pages[2].n = 3
  assert.equal(applyLayoutPlan(base, plan, { inferContinuations: true }).merged, 0)
})

test('original float geometry and source-aligned math survive regrouping and retry', () => {
  const record = (text, variable, before, after) => ({
    source: text, segments: [{ type: 'text', text: before }, { type: 'math', source: variable, latex: variable, alignment: 'unique-prose-context' }, { type: 'text', text: after }],
  })
  const a = { id: 'a', kind: 'paragraph', text: 'The variable x measures',
    sourceRect: { x: .1, y: .1, w: .7, h: .02 }, parserInlineMath: record('The variable x measures', 'x', 'The variable ', ' measures') }
  const b = { id: 'b', kind: 'paragraph', text: 'motion and y is the result.',
    sourceRect: { x: .1, y: .6, w: .7, h: .02 }, parserInlineMath: record('motion and y is the result.', 'y', 'motion and ', ' is the result.') }
  const figure = { id: 'f', kind: 'figure', structure: 'figure', visionGenerated: true, visionRect: { x: .1, y: .2, w: .7, h: .3 } }
  const base = { pages: [{ n: 1, blocks: [a, b, figure] }] }
  const first = applyLayoutPlan(base, null, { inferContinuations: true }).content
  const merged = first.pages[0].blocks[0]
  assert.equal(merged.text, a.text + ' ' + b.text)
  assert.deepEqual(merged.sourceIds, ['a', 'b'])
  assert.equal(merged.parserInlineMath.source, merged.text)
  assert.deepEqual(merged.parserInlineMath.segments.filter(segment => segment.type === 'math').map(segment => segment.source), ['x', 'y'])
  assert.deepEqual(first.pages[0].blocks[1], figure)
  assert.deepEqual(applyLayoutPlan(first, null, { inferContinuations: true }).content, first)
})

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n${results.length - failed.length}/${results.length} layout-plan tests passed`)
if (failed.length > 0) process.exitCode = 1
