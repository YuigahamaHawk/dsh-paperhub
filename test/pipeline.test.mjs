// Unit tests for PDF extraction helpers that do not need a browser (formula fragment grouping).
import assert from 'node:assert/strict'
import { mergeFormulaFragments } from '../client-src/pdf-engine.js'

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

test('merges display-equation fragments and stops at prose', () => {
  const blocks = [
    { id: 'a', kind: 'formula', text: 'T_fill(q) ≈', page: 7, y: 100 },
    { id: 'b', kind: 'paragraph', text: 'qS BP', page: 7, y: 90 },
    { id: 'c', kind: 'paragraph', text: '(m − q)S BH − BP', page: 7, y: 80 },
    { id: 'd', kind: 'paragraph', text: '. (3)', page: 7, y: 70 },
    { id: 'e', kind: 'paragraph', text: 'Balancing the concurrent branches gives', page: 7, y: 50 },
  ]
  const merged = mergeFormulaFragments(blocks)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].kind, 'formula')
  assert.equal(merged[0].id, 'a')
  assert.match(merged[0].text, /qS BP/)
  assert.match(merged[0].text, /\(3\)/)
  assert.equal(merged[1].id, 'e')
})

test('single short math paragraphs are left alone', () => {
  const blocks = [{ id: 'a', kind: 'paragraph', text: 'x = y + 1', page: 2, y: 10 }]
  const merged = mergeFormulaFragments(blocks)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].kind, 'paragraph')
})

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n${results.length - failed.length}/${results.length} pdf-extraction tests passed`)
if (failed.length > 0) process.exitCode = 1
