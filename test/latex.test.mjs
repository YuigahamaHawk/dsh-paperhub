// Unit tests for the LaTeX -> MathML converter used by AI-reconstructed formulas.
import assert from 'node:assert/strict'
import { latexToMathML } from '../client-src/latex.js'

const cases = []
function test(name, fn) {
  try {
    fn()
    cases.push({ name, ok: true })
    console.log(`  ok  ${name}`)
  } catch (error) {
    cases.push({ name, ok: false })
    console.error(`FAIL  ${name}: ${error?.message ?? error}`)
  }
}

test('fractions, scripts and greek letters', () => {
  const mathml = latexToMathML('q^* = \\frac{m B_{PCIe}}{B_{Host}} = 1')
  assert.match(mathml, /<math /)
  assert.match(mathml, /<mfrac>/)
  assert.match(mathml, /<msub>/)
  assert.match(mathml, /<msup>/)
  assert.match(mathml, /π|q/)
  assert.ok(!mathml.includes('<script'))
})

test('sqrt, operators and text', () => {
  const mathml = latexToMathML('\\sqrt{x^2 + y^2} \\le \\sum_{i=1}^{n} a_i \\quad \\text{for all } i')
  assert.match(mathml, /<msqrt>/)
  assert.match(mathml, /≤/)
  assert.match(mathml, /∑/)
  assert.match(mathml, /for all/)
})

test('dollar delimiters are stripped and markup is escaped', () => {
  const mathml = latexToMathML('$$x = <img src=x onerror=alert(1)>$$')
  assert.match(mathml, /&lt;/)
  assert.ok(!mathml.includes('<img'))
  assert.ok(!mathml.includes('$'))
})

test('empty or unusable input produces no mathml', () => {
  assert.equal(latexToMathML(''), '')
  assert.equal(latexToMathML('   '), '')
})

const failed = cases.filter((entry) => entry.ok === false)
console.log(`\n${cases.length - failed.length}/${cases.length} latex tests passed`)
if (failed.length > 0) process.exitCode = 1
