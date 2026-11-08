import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewportTextItems, multiplyTransform } from '../client-src/pdf-geometry.js'
import { groupTextItems } from '../client-src/reflow.js'
import { applyVisionLayout } from '../client-src/vision-layout.js'

function inverse([a,b,c,d,e,f]) {
  const det=a*d-b*c
  return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det]
}

test('text, glyph boxes and canvas agree for every PDF rotation and a shifted crop box', () => {
  for (const viewport of [
    {width:600,height:800,transform:[1,0,0,-1,0,800]},
    {width:800,height:600,transform:[0,1,1,0,0,0]},
    {width:600,height:800,transform:[-1,0,0,1,600,0]},
    {width:800,height:600,transform:[0,-1,-1,0,800,600]},
    {width:500,height:700,transform:[1,0,0,-1,-50,850]},
  ]) {
    const onCanvas=[10,0,0,-10,100,200]
    const raw=multiplyTransform(inverse(viewport.transform),onCanvas)
    const [item]=viewportTextItems([{str:'Method',transform:raw,width:40,height:10,fontName:'f'}],{f:{ascent:.8,descent:-.2}},viewport)
    assert.ok(Math.abs(item.transform[4]-100)<1e-8)
    assert.ok(Math.abs(item.transform[5]-(viewport.height-200))<1e-8)
    const expected={x:100/viewport.width,y:192/viewport.height,w:40/viewport.width,h:10/viewport.height}
    for(const key of Object.keys(expected)) assert.ok(Math.abs(item.sourceRect[key]-expected[key])<1e-10, `${key} matches rendered pixels`)
    const [line]=groupTextItems([item])
    assert.deepEqual(line.sourceRects,[item.sourceRect])
  }
})

test('neighboring prose is excluded from a model crop without erasing owned equation glyphs', () => {
  const prose={id:'prose',kind:'paragraph',text:'The final output is:',sourceRect:{x:.1,y:.84,w:.7,h:.03},sourceRects:[{x:.1,y:.84,w:.18,h:.012}]}
  const equation={id:'eq',kind:'paragraph',text:'x = e(x)',sourceRect:{x:.35,y:.875,w:.3,h:.015},sourceRects:[{x:.35,y:.875,w:.3,h:.015}]}
  const {content}=applyVisionLayout({pages:[{n:1,blocks:[],sourceBlocks:[prose,equation]}]}, {pages:[{n:1,regions:[{kind:'formula',candidateIds:['eq'],bbox:[.1,.845,.9,.895]}],textBlocks:[{ids:['prose'],kind:'paragraph'}]}]})
  const image=content.pages[0].blocks.find(b=>b.kind==='formula')
  assert.deepEqual(image.exclusionRects,prose.sourceRects)
  assert.ok(content.pages[0].blocks.some(b=>b.id==='prose'&&b.text===prose.text))
  assert.ok(!image.exclusionRects.some(rect=>rect===equation.sourceRect))
})

test('invisible LaTeXiT metadata split over PDF text items is removed without dropping visible text', () => {
  const viewport={width:600,height:800,transform:[1,0,0,-1,0,800]}
  const item=str=>({str,transform:[10,0,0,10,20,200],width:50,fontName:'f'})
  const items=viewportTextItems([item('<latexit sha1_base64="abc">'),item('encoded'),item('</latexit>'),item('x = 1')],{},viewport)
  assert.equal(items.map(item=>item.str).join(''),'x = 1')
})

test('a table crop excludes caption continuation and page furniture at glyph-run precision', () => {
  const cell={id:'cell',kind:'paragraph',text:'37.78',sourceRect:{x:.3,y:.32,w:.04,h:.02}}
  const caption={id:'caption',kind:'caption',text:'Table 4 description',sourceRect:{x:.1,y:.24,w:.8,h:.06},sourceRects:[{x:.1,y:.24,w:.8,h:.015},{x:.1,y:.26,w:.4,h:.015}]}
  const {content}=applyVisionLayout({pages:[{n:1,sourceBlocks:[cell,caption],blocks:[]}]},{pages:[{n:1,regions:[{kind:'table',candidateIds:['cell'],captionId:'caption',bbox:[.1,.26,.9,.8]}],textBlocks:[{ids:['caption'],kind:'caption'}]}]})
  const table=content.pages[0].blocks.find(b=>b.structure==='table')
  assert.deepEqual(table.exclusionRects,caption.sourceRects)
  assert.ok(table.cropRect.y<table.rect.y,'a thin top rule just outside the approximate model box is preserved')
  assert.ok(table.cropRect.y+table.cropRect.h>table.rect.y+table.rect.h)
})
