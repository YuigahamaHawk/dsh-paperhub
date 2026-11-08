import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitTranslationText, translationIssue } from '../shared/translation-contract.js'
import { AiGateway } from '../host/ai.js'
import { ReaderError } from '../host/util.js'
import { translatableIndex } from '../shared/translation-blocks.js'
import { createT } from '../client-src/i18n.js'

test('sentence units preserve every source character and bound long input', () => {
  const text=('Hardware. Six systems serve models with 13 active parameters. The measured host bandwidth is 56.7–77.3 GB/s; this clause must also be translated. ').repeat(12)
  const units=splitTranslationText(text)
  assert.equal(units.join(''),text)
  assert.ok(units.length>1&&units.every(unit=>unit.length<=480))
})

test('empty, heading-only and numerically truncated cached translations fail validation', () => {
  assert.ok(translationIssue('Hardware. '+ 'Full source paragraph. '.repeat(30),'','zh-CN'))
  assert.ok(translationIssue('Time to first token. '+ 'Every clause in this paragraph matters. '.repeat(15),'首 token','zh-CN'))
  assert.ok(translationIssue('The rate stays within 12% and the baseline lost 31% at W2.','速率保持稳定。','zh-CN'))
  assert.equal(translationIssue('The rate stays within 12% and the baseline lost 31% at W2.','速率变化保持在 12% 以内，基线在 W2 已损失 31%。','zh-CN'),null)
  assert.equal(translationIssue('Steam reports 200 million users and 32,768 devices.','Steam 报告有 2 亿用户和 32768 台设备。','zh-CN'),null)
})

test('legacy bad cache is bypassed, successful v2 cache is reused, explicit retry calls the model', async () => {
  const cache=new Map();let calls=0
  const settings={ai:{active:{translate:{providerId:'dsh',model:'flash'}},providers:[],targetLang:'zh-CN',translate:{batchSize:6}}}
  const store={getSettings:()=>settings,getCachedTranslation:async key=>key.startsWith('translation-v2|')?cache.get(key)??null:'首 token',setCachedTranslation:async(key,value)=>cache.set(key,value)}
  const gateway=new AiGateway({ctx:{get:name=>name==='llm'?{listProviders:()=>[{id:'account',name:'Account'}]}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'account',model:'flash'})}:null},store})
  gateway.chat=async args=>{
    calls++
    const list=JSON.parse(args.messages[0].content)
    return {text:JSON.stringify(list.map(text=>'完整译文 '+text)),model:'test'}
  }
  const source='Time to first token. The result has 5 cells and the limit is 44 seconds. '+ 'The final availability claim must be preserved. '.repeat(12)
  const first=await gateway.translate({texts:[source]})
  assert.equal(first.cached[0],false)
  assert.match(first.translations[0],/availability claim/)
  const before=calls
  const second=await gateway.translate({texts:[source]})
  assert.equal(calls,before);assert.equal(second.cached[0],true);assert.equal(second.usage.chars,0)
  await gateway.translate({texts:[source],force:true})
  assert.ok(calls>before)
})

test('a syntactically valid but truncated batch item is repaired before caching', async () => {
  const settings={ai:{active:{translate:{providerId:'dsh',model:'flash'}},providers:[],targetLang:'zh-CN',translate:{batchSize:6}}}
  const stored=[];let calls=0
  const gateway=new AiGateway({ctx:{get:name=>name==='llm'?{listProviders:()=>[{id:'account',name:'Account'}]}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'account',model:'flash'})}:null},store:{getSettings:()=>settings,getCachedTranslation:async()=>null,setCachedTranslation:async(key,value)=>stored.push(value)}})
  gateway.chat=async args=>{calls++;return {text:calls===1?'["首 token"]':'首个 token 的时间在 5 个多轮测试单元中最短，最差回合低于 44 秒。',model:'test'}}
  const result=await gateway.translate({texts:['Time to first token is lowest in 5 multi-turn cells; the worst turn stays below 44 seconds.']})
  assert.equal(calls,2);assert.match(result.translations[0],/44/)
  assert.equal(stored.length,2);assert.ok(stored.every(value=>value!=='首 token'))
})

test('body dates and citation prefixes remain translatable, reference sections stay excluded',()=>{
 const body='In 2025, global electric vehicle sales exceeded 20 million. '+ 'This is ordinary introduction prose. '.repeat(4)
 const index=translatableIndex([{id:'intro',kind:'paragraph',text:body},{id:'cite',kind:'paragraph',text:'[1] demonstrates why this method should work.'},{id:'refs',kind:'heading',text:'VIII. REFERENCES'},{id:'entry',kind:'paragraph',text:'Smith 2025. A bibliography entry.'},{id:'appendix',kind:'heading',text:'Appendix A'},{id:'appendixbody',kind:'paragraph',text:'In 2025, this supplementary experiment was also conducted.'}])
 assert.ok(index.has('intro'));assert.ok(index.has('cite'));assert.ok(!index.has('entry'));assert.ok(index.has('appendixbody'))
})

test('unit translations retain list mantissas and translated thousand units without false missing-number errors',()=>{
 const source='As shown in Fig. 6(a), profit per station is 126.89, 152.49, and 150.89 thousand CNY for the three network sizes, respectively.'
 assert.equal(translationIssue(source,'如图 6(a) 所示，三种网络规模的每站利润分别为 126.89 千元、152.49 千元和 150.89 千元。','zh-CN'),null)
 assert.ok(translationIssue(source,'如图 6(a) 所示，三种规模的每站利润分别为 126.89 千元和 150.89 千元。','zh-CN'))
 assert.ok(translationIssue('The total is 200 million users.','总数为 200 亿用户。','zh-CN'))
})

function fixture(){
 const cache=new Map(),settings={ai:{active:{translate:{providerId:'dsh',model:'flash'}},providers:[],targetLang:'zh-CN',translate:{batchSize:6}}}
 const gateway=new AiGateway({ctx:{get:name=>name==='llm'?{listProviders:()=>[{id:'account',name:'Account'}]}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'account',model:'flash'})}:null},store:{getSettings:()=>settings,getCachedTranslation:async key=>cache.get(key)??null,setCachedTranslation:async(key,value)=>cache.set(key,value)}})
 return {gateway,cache}
}

test('a failed item does not discard or mark neighboring successful translations as failed',async()=>{
 const {gateway}=fixture();let calls=0
 gateway.chat=async args=>{
  calls++
  if(calls===1)return {text:JSON.stringify(['正常译文 A','']),model:'fixture'}
  return {text:'',model:'fixture'}
 }
 const first=await gateway.translate({texts:['Good source A.','Bad source B.']})
 assert.equal(first.translations[0],'正常译文 A');assert.equal(first.errors[0],null);assert.ok(first.errors[1])
 const before=calls
 const cached=await gateway.translate({texts:['Good source A.']})
 assert.equal(cached.cached[0],true);assert.equal(calls,before)
})

test('indexed stream publishes complete validated passages before the model finishes or repairs a neighbor', { timeout:3000 }, async()=>{
 const {gateway,cache}=fixture()
 const source=['A cached total of 101.','A result with 44 observations.','A good result with 55 observations.']
 cache.set('translation-v2|dsh|dsh:account:flash|zh-CN|'+source[0],'缓存合计 101。')
 const ready=[]
 let release,notify,calls=0
 const gate=new Promise(resolve=>{release=resolve}), rowSent=new Promise(resolve=>{notify=resolve})
 gateway.chat=async args=>{
  calls++
  if(calls>1) {
   assert.equal(args.messages[0].content,source[1])
   return {text:'完整结果含 44 次观测。'}
  }
  assert.deepEqual(JSON.parse(args.messages[0].content),source.slice(1))
  const valid=JSON.stringify({index:1,text:'结果含 55 次观测。'})+'\n'
  const invalid=JSON.stringify({index:0,text:'结果有所改善。'})+'\n'
  args.onDelta(valid.slice(0,12))
  args.onDelta(valid.slice(12)+invalid)
  notify()
  await gate
  return {text:valid+invalid}
 }
 const pending=gateway.translate({texts:source,onProgress:event=>ready.push(...event.items)})
 try {
  await rowSent
  assert.deepEqual(ready.map(item=>item.index),[0,2])
  assert.equal(ready[0].cached,true)
  assert.match(ready[1].text,/55/)
 } finally {release()}
 const result=await pending
 assert.deepEqual(ready.map(item=>item.index),[0,2,1])
 assert.match(result.translations[1],/44/)
 assert.deepEqual(result.errors,[null,null,null])
 assert.equal(calls,2)
 assert.ok(![...cache.values()].includes('结果有所改善。'))
})

test('truncated indexed output keeps valid records and retries only the missing item', async()=>{
 const {gateway}=fixture(), calls=[]
 gateway.chat=async args=>{
  calls.push(args.messages[0].content)
  if(calls.length>1)return {text:'补全第 62 条。'}
  args.onDelta('{"index":0,"text":"第 41 条完整译文。"}\n{"index":2,"text":"第 83 条完整译文。"}')
  throw new ReaderError('model-truncated','Token limit reached.')
 }
 const texts=['Result 41.','Result 62.','Result 83.']
 const result=await gateway.translate({texts})
 assert.equal(calls.length,2)
 assert.equal(calls[1],texts[1])
 assert.deepEqual(result.translations,['第 41 条完整译文。','补全第 62 条。','第 83 条完整译文。'])
})

test('a long paragraph is only published after all its indexed units arrive', async()=>{
 const {gateway}=fixture(), progress=[]
 const source=('A detailed experiment compared 42 cases under controlled conditions. ').repeat(9)
 assert.ok(splitTranslationText(source).length>1)
 gateway.chat=async args=>{
  const items=JSON.parse(args.messages[0].content)
  const lines=items.map((text,index)=>JSON.stringify({index,text:'完整译文 '+text})+'\n')
  args.onDelta(lines[0])
  assert.deepEqual(progress,[])
  for(const line of lines.slice(1))args.onDelta(line)
  return {text:lines.join('')}
 }
 const result=await gateway.translate({texts:[source],onProgress:event=>progress.push(...event.items)})
 assert.equal(progress.length,1)
 assert.equal(progress[0].text,result.translations[0])
 assert.equal(result.translations[0].match(/42/g).length,9)
})

test('retrying a failed long paragraph reuses good units and sends only the missing unit',async()=>{
 const {gateway}=fixture(),requests=[]
 const source=('The first long unit explains the method without changing the data. ').repeat(6)+'The final unit reports 44 results.'
 gateway.chat=async args=>{
  let items
  try{items=JSON.parse(args.messages[0].content)}catch{items=null}
  requests.push(items??[args.messages[0].content])
  return {text:items?JSON.stringify(items.map(text=>text.includes('44')?'':'完整译文 '+text)):'',model:'fixture'}
 }
 const first=await gateway.translate({texts:[source]});assert.ok(first.errors[0])
 const before=requests.length
 gateway.chat=async args=>{const items=JSON.parse(args.messages[0].content);requests.push(items);return {text:JSON.stringify(items.map(text=>'完整译文 '+text)),model:'fixture'}}
 const second=await gateway.translate({texts:[source]})
 assert.equal(second.errors[0],null);assert.ok(second.translations[0].includes('44'))
 assert.equal(requests.length,before+1)
 assert.ok(requests.at(-1).every(text=>text.includes('44')))
})

test('translation failures display the actual error message instead of an uninterpolated placeholder',()=>{
 const t=createT({locale:{getLocale:()=>({id:'zh-CN'})}})
 const text=t('reader.translation.failed','Translation failed: {message}',{message:'Missing number 44'})
 assert.ok(text.includes('Missing number 44'));assert.ok(!text.includes('{message}'))
})

test('reading saved translations never calls a model or writes a cache; invalid entries remain missing',async()=>{
 const {gateway,cache}=fixture()
 gateway.chat=async()=>{throw new Error('Cache inspection must never call the model')}
 const good='The total is 44.',bad='The total is 99.'
 cache.set('translation-v2|dsh|dsh:account:flash|zh-CN|'+good,'总数为44。')
 cache.set('translation-v2|dsh|dsh:account:flash|zh-CN|'+bad,'总数为9。')
 const before=cache.size,result=await gateway.getCachedTranslations({texts:[good,bad,'Missing source.']})
 assert.deepEqual(result.translations,['总数为44。',null,null]);assert.equal(cache.size,before)
})
