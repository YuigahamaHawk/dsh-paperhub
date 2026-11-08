// Unit tests for the pure AI layout transform (page figures + LaTeX formulas).
import assert from 'node:assert/strict'
import { applyAiLayout, applyFormulaLatex } from '../client-src/layout.js'

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

const content = {
  kind: 'pdf',
  version: 1,
  engineVersion: 8,
  pageCount: 3,
  figurePages: [],
  toc: [{ id: 'old', title: 'Old TOC', level: 1, blockId: 'p1b0' }],
  pages: [
    { n: 1, blocks: [{ id: 'p1b0', kind: 'heading', level: 1, text: '1 Introduction' }] },
    {
      n: 2,
      blocks: [
        { id: 'p2b0', kind: 'paragraph', text: '2.1 Method' },
        { id: 'p2b1', kind: 'paragraph', text: 'q* = m B_PCIe / B_Host = 1' },
      ],
    },
    {
      n: 3,
      blocks: [
        { id: 'p3b0', kind: 'paragraph', text: '1 Prefill' },
        { id: 'p3b1', kind: 'paragraph', text: 'E3 E7 E9' },
        { id: 'p3b2', kind: 'paragraph', text: 'Figure 2 FreeToken overview' },
      ],
    },
  ],
}

test('AI figure page replaces page blocks with one page image block', () => {
  const applied = applyAiLayout(content, { pages: [{ n: 3, figurePage: true, formulas: [] }], model: 'test-model' })
  const page = applied.content.pages[2]
  assert.equal(page.blocks.length, 1)
  assert.equal(page.blocks[0].kind, 'pageFigure')
  assert.deepEqual(page.blocks[0].rect, { x: 0, y: 0, w: 1, h: 1 })
  assert.deepEqual(applied.content.figurePages, [3])
  assert.equal(applied.figurePageCount, 1)
  assert.equal(applied.content.aiLayoutModel, 'test-model')
})

test('AI LaTeX turns a paragraph into a formula block (and keeps unrenderable latex out)', () => {
  const applied = applyAiLayout(content, {
    pages: [
      {
        n: 2,
        figurePage: false,
        formulas: [
          { id: 'p2b1', latex: 'q^* = \\frac{m B_{PCIe}}{B_{Host}} = 1' },
          { id: 'p2b0', latex: '\\frac{' },
        ],
      },
    ],
  })
  const blocks = applied.content.pages[1].blocks
  assert.equal(blocks[1].kind, 'formula')
  assert.match(blocks[1].latex, /\\frac/)
  assert.equal(blocks[0].kind, 'paragraph', 'invalid latex is ignored and the block stays text')
  assert.equal(applied.formulaCount, 1)
  assert.equal(applied.changed, 1)
})

test('empty result leaves content untouched', () => {
  const applied = applyAiLayout(content, null)
  assert.equal(applied.content, content)
  assert.equal(applied.changed, 0)
})

test('one-call formula reconstruction applies LaTeX across pages', () => {
  const applied = applyFormulaLatex(content, {
    model: 'test-model',
    formulas: [
      { id: 'p2b1', latex: 'q^* = \\frac{m B_{PCIe}}{B_{Host}} = 1' },
      { id: 'missing', latex: 'x^2' },
    ],
  })
  assert.equal(applied.formulaCount, 1)
  assert.equal(applied.content.pages[1].blocks[1].kind, 'formula')
  assert.match(applied.content.pages[1].blocks[1].latex, /\\frac/)
  assert.equal(applied.content.aiMathModel, 'test-model')
  assert.equal(applied.changed, 1)
})

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n${results.length - failed.length}/${results.length} layout tests passed`)
if (failed.length > 0) process.exitCode = 1
