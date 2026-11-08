// Unit tests for the pure AI structure-refinement transform (no DOM, no React).
// Run: node test/refine.test.mjs
import assert from 'node:assert/strict'
import { applyStructureRefinement } from '../client-src/refine.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL  ${name}: ${error?.stack ?? error}`)
  }
}

const content = {
  kind: 'pdf',
  version: 1,
  engineVersion: 2,
  pageCount: 2,
  pages: [
    {
      n: 1,
      blocks: [
        { id: 'p1b0', kind: 'heading', level: 2, text: '1 Introduction' },
        { id: 'p1b1', kind: 'heading', level: 3, text: 'GPU figure label' },
        { id: 'p1b2', kind: 'paragraph', text: 'arXiv:2603.29765v1 [cs.LG] 31 Mar 2026' },
        { id: 'p1b3', kind: 'paragraph', text: 'Real body paragraph.' },
      ],
    },
    { n: 2, blocks: [{ id: 'p2b0', kind: 'heading', level: 2, text: 'Untouched page heading' }] },
  ],
  toc: [{ id: 'old', title: 'old toc', level: 1, blockId: 'p1b0' }],
}

test('drops artifacts, rewrites heading levels and demotes unconfirmed heuristic headings', () => {
  const result = {
    model: 'DeepSeek account · deepseek-flash',
    pages: [
      { n: 1, headings: [{ id: 'p1b0', level: 1 }], drop: ['p1b2'] },
      { n: 2, headings: [{ id: 'p2b0', level: 2 }], drop: [] },
    ],
  }
  const refined = applyStructureRefinement(content, result, { now: 1234 })
  const page1 = refined.content.pages[0]
  assert.deepEqual(page1.blocks.map((block) => block.id), ['p1b0', 'p1b1', 'p1b3'])
  assert.equal(page1.blocks[0].level, 1)
  assert.equal(page1.blocks[1].kind, 'paragraph', 'unconfirmed heuristic heading is demoted')
  assert.equal(page1.blocks[1].level, undefined)
  assert.equal(refined.content.pages[1].blocks[0].kind, 'heading', 'page not in the suggestion list is untouched')
  assert.equal(refined.dropCount, 1)
  assert.equal(refined.headingCount, 2)
  assert.ok(refined.changed >= 3)
  assert.equal(refined.content.toc.length, 2)
  assert.deepEqual(refined.content.toc.map((item) => item.blockId), ['p1b0', 'p2b0'])
  assert.equal(refined.content.aiRefined, true)
  assert.equal(refined.content.aiRefinedAt, 1234)
  assert.equal(refined.content.aiRefinedModel, 'DeepSeek account · deepseek-flash')
  assert.equal(content.pages[0].blocks.length, 4, 'input content is not mutated')
})

test('promotes a paragraph suggested as heading and clamps levels to 1..3', () => {
  const refined = applyStructureRefinement(content, {
    pages: [{ n: 1, headings: [{ id: 'p1b3', level: 99 }, { id: 'p1b0', level: -4 }], drop: [] }],
  })
  const page1 = refined.content.pages[0]
  const promoted = page1.blocks.find((block) => block.id === 'p1b3')
  const clamped = page1.blocks.find((block) => block.id === 'p1b0')
  assert.equal(promoted.kind, 'heading')
  assert.equal(promoted.level, 3)
  assert.equal(clamped.level, 1)
})

test('empty suggestion leaves content untouched', () => {
  const refined = applyStructureRefinement(content, null)
  assert.equal(refined.content, content)
  assert.equal(refined.changed, 0)
})

test('a page with no model opinion is left untouched (a failed page cannot demote headings)', () => {
  const refined = applyStructureRefinement(content, { pages: [{ n: 1, headings: [], drop: [] }, { n: 2, headings: [{ id: 'p2b0', level: 2 }], drop: [] }] })
  const page1 = refined.content.pages[0]
  assert.equal(page1.blocks[0].kind, 'heading', 'page 1 keeps its heuristic heading')
  assert.equal(refined.content.pages[1].blocks[0].level, 2)
})

test('an explicit empty answer demotes heuristic headings on that page', () => {
  const refined = applyStructureRefinement(content, { pages: [{ n: 1, headings: [], drop: [], explicit: true }] })
  const page1 = refined.content.pages[0]
  assert.equal(page1.blocks[0].kind, 'paragraph', 'heuristic heading demoted after an explicit review')
  assert.equal(page1.blocks[1].kind, 'paragraph')
  assert.equal(refined.content.pages[1].blocks[0].kind, 'heading', 'other pages untouched')
  assert.equal(refined.dropCount, 0)
})

test('long merged heading+body blocks and captions are protected', () => {
  const longContent = {
    pages: [
      {
        n: 1,
        blocks: [
          { id: 'a', kind: 'paragraph', text: `2.1 A section title ${'body sentence '.repeat(30)}` },
          { id: 'b', kind: 'caption', text: 'Figure 1: an important chart caption' },
          { id: 'c', kind: 'heading', level: 2, text: '2.1 Real heading' },
        ],
      },
    ],
    toc: [],
  }
  const refined = applyStructureRefinement(longContent, { pages: [{ n: 1, headings: [{ id: 'a', level: 1 }, { id: 'c', level: 2 }], drop: ['b'] }] })
  const blocks = refined.content.pages[0].blocks
  const longBlock = blocks.find((block) => block.id === 'a')
  assert.equal(longBlock.kind, 'paragraph', 'long block is not promoted to a heading')
  assert.ok(blocks.some((block) => block.id === 'b'), 'captions are never dropped')
  assert.equal(refined.dropCount, 0)
})

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n${results.length - failed.length}/${results.length} refinement tests passed`)
if (failed.length > 0) process.exitCode = 1
