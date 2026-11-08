import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFigureGeometry } from '../client-src/figure-geometry.js'
import { applyVisionLayout } from '../client-src/vision-layout.js'

const size = 1000
function raster(boxes) {
  const pixels = new Uint8Array(size * size)
  for (const [left, top, right, bottom] of boxes) {
    for (let y = top; y < bottom; y++) pixels.fill(1, y * size + left, y * size + right)
  }
  return { width: size, height: size, pixels }
}
function source(id, text, [left, top, right, bottom]) {
  return { id, kind:'paragraph', text, page:1, rect:{ x:left, y:top, w:right-left, h:bottom-top } }
}
const figure = (id, bbox, captionId = null) => ({ id, kind:'figure', bbox, captionId, renderAs:'image', candidateIds:[] })

test('one caption reunites vector fragments across both columns while a neighboring single-column figure stays separate', () => {
  const blocks = [
    source('one', 'Fig. 5 | The left plot.', [.07,.30,.48,.36]),
    source('body', 'A separate right column explains the computation in words.', [.53,.18,.92,.37]),
    source('two', 'Fig. 6 | The cross-column comparison covers the control,', [.07,.84,.48,.90]),
    source('continued', 'the alternatives, and the legend for all panels.', [.53,.84,.92,.89]),
  ]
  const page = { n:1, sourceBlocks:blocks, width:600, height:800, fontSize:10 }
  const answer = { n:1, textBlocks:blocks.map(({id}) => ({ids:[id],kind:id==='body'?'paragraph':'caption'})), regions:[
    figure('single',[.14,.13,.48,.28],'one'),
    figure('left',[.13,.42,.49,.81],'two'),
    figure('right',[.54,.40,.90,.79],'continued'),
    figure('legend',[.26,.805,.80,.82]),
  ] }
  const ink = raster([[80,120,480,280],[530,180,920,370],[100,400,480,625],[520,400,910,625],[100,637,910,795],[255,805,800,823]])
  const repaired = checkFigureGeometry(page,answer,ink)
  assert.deepEqual(repaired.regions.map(region => [region.number,region.bbox]),[
    ['5',[.08,.12,.48,.28]],
    ['6',[.10,.40,.91,.823]],
  ])
  assert.deepEqual(repaired.textBlocks.find(group => group.ids.includes('two')).ids, ['two','continued'])
  const [result] = applyVisionLayout({pages:[page]}, {pages:[repaired]}).content.pages
  assert.equal(result.blocks.find(block => block.id==='body').text, blocks[1].text)
  assert.equal(result.blocks.filter(block => block.kind==='caption').length, 2)
  assert.ok(result.blocks.find(block => block.number==='5').cropRect.x + result.blocks.find(block => block.number==='5').cropRect.w <= .5)
  assert.deepEqual(answer.regions[1].bbox, [.13,.42,.49,.81])
})

test('the crop excludes an isolated running rule even if it is close enough to join figure ink', () => {
  const blocks = [source('cap', 'Fig. 4 | The composite plot.', [.07,.55,.94,.61])]
  const page = { n:1, sourceBlocks:blocks, width:600, height:800, fontSize:10 }
  const answer = { n:1, textBlocks:[{kind:'caption',ids:['cap']}], regions:[figure('a',[.1,.06,.91,.52],'cap')] }
  const ink = raster([[65,32,250,39],[880,30,943,38],[65,45,944,47],[100,59,910,536]])
  const repaired = checkFigureGeometry(page,answer,ink)
  assert.deepEqual(repaired.regions[0].bbox,[.10,.059,.91,.536])
  const result = applyVisionLayout({pages:[page]}, {pages:[repaired]}).content.pages[0]
  assert.ok(result.blocks.find(block => block.visionGenerated).cropRect.y > .047)
})

test('panel letters, axes and unassigned legend text stay inside the complete captioned figure', () => {
  const blocks = [
    source('panel-a', 'a', [.075,.064,.085,.079]),
    source('panel-b', 'b', [.45,.064,.46,.079]),
    source('panel-title', 'Topology of the distributed test networks', [.63,.069,.82,.080]),
    source('axis-label', 'Time (h)', [.68,.523,.74,.536]),
    source('caption', 'Fig. 8 | Response across the four panels.', [.07,.55,.94,.585]),
    source('body', 'A body paragraph continues the argument below the complete figure caption.', [.07,.63,.49,.71]),
    source('vertical-axis', 'The performance of the model', [.082,.11,.096,.245]),
    source('legend-label', 'Method A', [.576,.385,.614,.399]),
  ]
  const page = { n:1, sourceBlocks:blocks, width:600, height:800, fontSize:10 }
  const answer = { n:1, textBlocks:[
    {kind:'caption', ids:['panel-a','panel-b']}, {kind:'paragraph', ids:['panel-title']},
    {kind:'caption', ids:['axis-label']}, {kind:'caption', ids:['caption']}, {kind:'paragraph', ids:['body']},
    {kind:'paragraph', ids:['vertical-axis']}, {kind:'paragraph', ids:['legend-label'], unassigned:true},
  ], regions:[
    figure('upper-left',[.11,.09,.43,.302],'panel-a'),
    figure('upper-right',[.61,.087,.94,.318]),
    figure('lower-left',[.08,.33,.43,.534],'caption'),
    figure('lower-middle',[.45,.33,.62,.521],'caption'),
    figure('lower-right',[.62,.33,.94,.524],'axis-label'),
  ] }
  const ink = raster([[75,67,85,76],[450,67,460,76],[630,70,820,79],
    [82,110,96,245],[110,90,430,302],[610,87,940,318],[80,330,940,521],[680,523,740,534]])
  const repaired = checkFigureGeometry(page,answer,ink)
  assert.deepEqual(repaired.regions.map(({bbox,number})=>[bbox,number]),[[[.075,.067,.94,.534],'8']])
  assert.deepEqual(repaired.textBlocks.map(group=>group.ids),[['caption'],['body']])
  const [result] = applyVisionLayout({pages:[page]}, {pages:[repaired]}).content.pages
  assert.deepEqual(result.blocks.map(block=>block.kind), ['figure','caption','paragraph'])
  assert.deepEqual(new Set(result.blocks[0].sourceIds),new Set(['panel-a','panel-b','panel-title','axis-label','vertical-axis','legend-label']))
  assert.equal(result.blocks[2].text,blocks[5].text)
})

test('a separate unnumbered caption remains a boundary between stacked figures', () => {
  const blocks = [
    source('independent', 'Baseline outputs', [.07,.28,.21,.298]),
    source('caption', 'Fig. 3 | The observed changes in all test systems.', [.07,.55,.94,.575]),
  ]
  const page = { n:1, sourceBlocks:blocks }
  const answer = { n:1, textBlocks:blocks.map(block=>({kind:'caption',ids:[block.id]})), regions:[
    figure('first',[.075,.10,.93,.27],'independent'),
    figure('second',[.075,.32,.93,.53],'caption'),
  ] }
  const ink = raster([[75,100,930,270],[70,282,210,296],[75,320,930,530]])
  const repaired = checkFigureGeometry(page,answer,ink)
  assert.equal(repaired.regions.length,2)
  assert.equal(repaired.regions[0],answer.regions[0])
  assert.deepEqual(repaired.regions[1].bbox,[.075,.32,.93,.53])
  assert.equal(repaired.textBlocks.length,2)
})

test('independently numbered neighboring figures keep their own crops on the same row', () => {
  const blocks = [
    source('left', 'Fig. 5 | The single-column experiment.', [.07,.51,.48,.55]),
    source('right', 'Fig. 6 | A separate single-column experiment.', [.53,.51,.94,.55]),
  ]
  const page = { n:1, sourceBlocks:blocks }
  const answer = { n:1, textBlocks:blocks.map(block=>({kind:'caption',ids:[block.id]})), regions:[
    figure('first',[.075,.15,.49,.49],'left'),
    figure('second',[.52,.15,.93,.49],'right'),
  ] }
  const ink = raster([[75,150,475,490],[525,150,930,490]])
  const repaired = checkFigureGeometry(page,answer,ink)
  assert.deepEqual(repaired.regions.map(({bbox,number})=>[bbox,number]),[
    [[.075,.15,.475,.49],'5'],
    [[.525,.15,.93,.49],'6'],
  ])
})
