import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildMediaIndex} from '../shared/media-index.js'

test('media index follows explicit caption anchors and includes EPUB images without rendering',()=>{
 const items=buildMediaIndex([{id:'f1',kind:'figure',page:2,captionId:'c1'},{id:'p',kind:'paragraph',page:2,text:'Intervening prose'},{id:'c1',kind:'caption',page:2,text:'Table 1: Exact values'},{id:'eq',kind:'formula',page:4,number:'3'},{id:'ep',kind:'image',image:'data:image/png;base64,abc',alt:'EPUB illustration'}])
 assert.deepEqual(items.map(item=>[item.id,item.kind,item.caption]),[['f1','table','Table 1: Exact values'],['eq','formula',''],['ep','figure','EPUB illustration']])
 assert.equal(items[0].captionId,'c1');assert.equal(items[1].number,'3')
})

test('legacy caption inference never crosses prose, pages or chapters',()=>{
 const items=buildMediaIndex([{id:'f',kind:'figure',page:1},{id:'p',kind:'paragraph',page:1},{id:'c',kind:'caption',page:1,text:'Figure 3: Not adjacent'},{id:'f2',kind:'figure',page:2},{id:'c2',kind:'caption',page:3,text:'Figure 4: Next page'},{id:'f3',kind:'image',chapter:'one'},{id:'c3',kind:'caption',chapter:'two',text:'Figure 5: Different chapter'},{id:'f4',kind:'figure',page:4},{id:'c4',kind:'caption',page:4,text:'Figure 6: Adjacent'}])
 assert.deepEqual(items.map(item=>item.caption),['','','','Figure 6: Adjacent'])
})
