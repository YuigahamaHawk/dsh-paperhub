import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parserInlineMath,contentInlineRecords} from '../shared/parser-inline.js'
import {validateInlineMath,protectInlineMath,translatedMathSegments} from '../shared/inline-math.js'
const t=content=>({type:'text',content}),m=content=>({type:'equation_inline',content})

test('unique parser prose anchors recover subscripts and fractions without rewriting any native prose',()=>{
 const source='Let 𝑝 𝑑 be the perplexity. We define ¯ 𝑝 = 100 𝐷 Í 𝐷 𝑑 = 1 ˆ 𝑝 𝑑 𝑝 𝑑. This completes the definition.'
 const record=parserInlineMath(source,[t('Let '),m('p_d'),t(' be the perplexity. We define '),m(String.raw`\bar p=\frac{100}{D}\sum_{d=1}^{D}\frac{\hat p_d}{p_d}`),t('. This completes the definition.')],'4.test')
 assert.equal(record.maths,2);assert.equal(record.origin.parserVersion,'4.test');assert.equal(record.request,null)
 assert.equal(record.segments.map(s=>s.type==='text'?s.text:s.source).join(''),source)
 assert.ok(!record.segments.some(s=>s.confidence!==undefined))
 assert.throws(()=>validateInlineMath(record,source),/confidently/)
 assert.equal(validateInlineMath(record,source,{sourceAlignedParser:true}).maths,2)
 const protectedText=protectInlineMath(record);assert.ok(protectedText.includes('⟦DSHMATH_A⟧'));assert.equal(translatedMathSegments('令 ⟦DSHMATH_A⟧ 为困惑度，定义 ⟦DSHMATH_B⟧。',record).filter(s=>s.type==='math').length,2)
})
test('ambiguous, short, unsupported or changed context leaves the extraction unchanged',()=>{
 assert.equal(parserInlineMath('Long repeated context x with the same suffix. Long repeated context x with the same suffix.',[t('Long repeated context '),m('x'),t(' with the same suffix.')]),null)
 assert.equal(parserInlineMath('Let x equal y.',[t('Let '),m('x'),t(' equal '),m('y'),t('.')]),null)
 assert.equal(parserInlineMath('A reliable source says x is the value.',[t('Invented introduction '),m('x'),t(' is the value.')]),null)
 assert.equal(parserInlineMath('A reliable source says x is the value.',[{type:'unknown',content:'x'}]),null)
})
test('invalid LaTeX and lost source numbers are rejected but another valid formula survives',()=>{
 const source='The first expression x 12 is uncertain. The second expression y i is preserved correctly.'
 const record=parserInlineMath(source,[t('The first expression '),m('x_1'),t(' is uncertain. The second expression '),m('y_i'),t(' is preserved correctly.')])
 assert.equal(record.maths,1);assert.ok(record.segments[0].text.includes('x 12'))
 assert.equal(parserInlineMath('The expression x is invalid in this context.',[t('The expression '),m(String.raw`\href{http://x}{x}`),t(' is invalid in this context.')]),null)
})
test('an OCR substitution cannot turn a native Latin variable into a different Greek variable',()=>{
 assert.equal(parserInlineMath('The dense expert E d is evaluated separately.',[t('The dense expert '),m(String.raw`\varepsilon_d`),t(' is evaluated separately.')]),null)
 const correct=parserInlineMath('The dense expert E d is evaluated separately.',[t('The dense expert '),m(String.raw`\mathcal E_d`),t(' is evaluated separately.')])
 assert.equal(correct.maths,1)
})
test('saved user toggles override matching parser records while stale records cannot hide new source',()=>{
 const text='The expression x i is defined here.',seed=parserInlineMath(text,[t('The expression '),m('x_i'),t(' is defined here.')]),content={pages:[{blocks:[{id:'a',text,parserInlineMath:seed}]}]}
 assert.equal(contentInlineRecords(content,{a:{...seed,enabled:false}}).a.enabled,false)
 assert.equal(contentInlineRecords(content,{a:{...seed,source:'old source',enabled:false}}).a.enabled,true)
})
