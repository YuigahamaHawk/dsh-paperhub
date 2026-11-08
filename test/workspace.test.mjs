import {test} from 'node:test'
import assert from 'node:assert/strict'
import {normalizeTabs,closeTab,moveTab} from '../shared/reader-tabs.js'
import {zipStored} from '../shared/zip-writer.js'
import {sanitizeMathElement} from '../shared/mathml.js'
import {findInBlocks} from '../shared/document-search.js'
import {shellRenderHealth} from '../shared/render-health.js'

test('saved tabs discard duplicates, missing documents and invalid ids and bound open sessions',()=>{
 assert.deepEqual(normalizeTabs(['a','b','a','missing',null],['a','b']),['a','b'])
 assert.equal(normalizeTabs(Array.from({length:80},(_,i)=>'doc'+i)).length,32)
})
test('closing the active tab selects its neighbor; closing another preserves the active tab',()=>{
 assert.deepEqual(closeTab(['a','b','c'],'b','b'),{tabs:['a','c'],nextId:'c'})
 assert.deepEqual(closeTab(['a','b','c'],'c','c'),{tabs:['a','b'],nextId:'b'})
 assert.deepEqual(closeTab(['a'],'a','a'),{tabs:[],nextId:null})
 assert.deepEqual(closeTab(['a','b','c'],'a','c'),{tabs:['b','c'],nextId:'c'})
 assert.deepEqual(moveTab(['a','b','c'],'c','a'),['c','a','b'])
})
test('EPUB archive starts with uncompressed mimetype and writes Unicode names and valid offsets',()=>{
 const data=zipStored([['mimetype','application/epub+zip'],['目录.xhtml','123456789']]),view=new DataView(data.buffer)
 assert.equal(view.getUint32(0,true),0x04034b50)
 assert.equal(view.getUint16(8,true),0)
 assert.equal(new TextDecoder().decode(data.slice(30,38)),'mimetype')
 const second=30+8+20
 assert.equal(view.getUint32(second+14,true),0xcbf43926)
 assert.equal(view.getUint16(second+6,true),0x800)
 const end=data.length-22,central=view.getUint32(end+16,true)
 assert.equal(view.getUint32(central,true),0x02014b50)
 assert.equal(view.getUint16(end+10,true),2)
 assert.throws(()=>zipStored([['../escape','x']]),/Invalid archive path/)
})

test('MathML preserves formula structure but drops active content and untrusted attributes',()=>{
 const token=text=>({nodeType:3,nodeValue:text})
 const el=(localName,children=[],attributes=[])=>({nodeType:1,localName,childNodes:children,attributes:attributes.map(([name,value])=>({name,value}))})
 const root=el('math',[el('mfrac',[el('mi',[token('x')]),el('mn',[token('2')])]),el('annotation-xml',[el('script',[token('evil()')])])],[['display','inline'],['onclick','evil()'],['href','https://external.invalid']])
 const result=sanitizeMathElement(root)
 assert.match(result.html,/<mfrac><mi>x<\/mi><mn>2<\/mn><\/mfrac>/);assert.equal(result.text,'x2')
 assert.ok(!/onclick|href|script|annotation|evil/.test(result.html))
})

test('document search includes completed Chinese translations and bounds large result sets',()=>{
 const blocks=[{id:'network',text:'Network scale.',page:11},{id:'bad',text:'Incomplete.'}]
 const entries=new Map([['network',{status:'done',text:'网络规模。公式为 ⟦DSHMATH_A⟧。'}],['bad',{status:'loading',text:'网络规模。'}]])
 assert.equal(findInBlocks(blocks,'网络规模',{entries}).length,0)
 assert.deepEqual(findInBlocks(blocks,'网络规模',{entries,translated:true}).map(hit=>[hit.blockId,hit.translated]),[['network',true]])
 assert.equal(findInBlocks(blocks,'DSHMATH',{entries,translated:true}).length,0)
 assert.equal(findInBlocks([{id:'many',text:'test '.repeat(200)}],'test').length,80)
})

test('startup recognizes the workspace tab header and list cards, and still rejects missing chrome',()=>{
 const body='<main class="dr-root"><header class="dr-workspace-bar"></header><section class="dr-library"><div class="dr-listrow">'+ 'Saved document. '.repeat(80)+'</div></section></main>'
 const result=shellRenderHealth(body)
 assert.equal(result.ok,true);assert.equal(result.hasHeader,true);assert.equal(result.hasCards,true)
 assert.equal(shellRenderHealth(body.replace('dr-workspace-bar','missing')).ok,false)
})
