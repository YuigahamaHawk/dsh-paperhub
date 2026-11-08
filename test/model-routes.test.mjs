import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { canAskWithImage, decodeRoute, modelRouteOptions, withCurrentRoute } from '../client-src/model-routes.js'
import { AiGateway } from '../host/ai.js'
import { normalizeSettings } from '../host/store.js'
import { DEEPSEEK_ACCOUNT_PROVIDER, DEEPSEEK_ACCOUNT_ROUTE } from '../shared/model-ref.js'

test('the visual picker lists every DSH image model and keeps the default and custom routes', () => {
  const t = (_key, fallback) => fallback
  const dsh = { model: 'text', catalog: [
    { id: 'text', inputModalities: ['text'] },
    { id: 'vision-a', inputModalities: ['text', 'image'] },
    { id: 'vision-b', inputModalities: ['image', 'text'] },
  ] }
  const providers = [{ id: 'custom', name: 'Custom', models: ['custom-model'] }]
  const vision = modelRouteOptions(t, dsh, providers, { forVision: true })
  assert.deepEqual(vision.map(option => option.value), ['dsh|', 'dsh|vision-a', 'dsh|vision-b', 'custom|custom-model'])
  assert.ok(modelRouteOptions(t, dsh, providers).some(option => option.value === 'dsh|text'))
  assert.ok(withCurrentRoute(vision, 'dsh|saved-model').some(option => option.value === 'dsh|saved-model'))
})

test('the native account catalog is listed ahead of WorkBuddy and its selections stay on the account route', async () => {
  const calls = [], catalogReads = [], cache = new Map()
  const account = { id: DEEPSEEK_ACCOUNT_PROVIDER, name: 'DeepSeek Account' }
  const workbuddy = { id: 'workbuddy', name: 'WorkBuddy' }
  const accountImage = `${DEEPSEEK_ACCOUNT_ROUTE}|flash`
  const accountText = `${DEEPSEEK_ACCOUNT_ROUTE}|pro`
  const ref = decodeRoute(accountImage)
  const settings = normalizeSettings({ ai: { active: { translate: ref, vision: ref } } })
  assert.deepEqual(settings.ai.active.translate, ref)
  assert.deepEqual(settings.ai.active.vision, ref)
  let selection = { provider: workbuddy.id, model: 'flash', reasoningEffort: 'max' }
  let nativeAvailable = true
  let accountLookupFails = false
  const llm = {
    listProviders: () => nativeAvailable ? [workbuddy, account] : [workbuddy],
    async listModels(provider) {
      catalogReads.push(provider)
      if (provider === account.id) {
        if (accountLookupFails) throw new Error('account catalog unavailable')
        return [
          { id: 'flash', name: 'Native Flash', inputModalities: ['text', 'image'] },
          { id: 'pro', name: 'Native Pro', inputModalities: ['text'] },
        ]
      }
      return [{ id: 'flash', name: 'WorkBuddy Flash', inputModalities: ['text'] }]
    },
    async *stream(options) {
      calls.push(options)
      const text = options.system?.includes('professional translator') ? '["结果"]'
        : options.system ? '{"page":1,"regions":[]}' : 'OK'
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = {
    llm, agentDefaultModel: { currentSelection: () => selection },
    attachments: { saveImage: async () => ({ attachmentId: 'local' }) },
  }
  const gateway = new AiGateway({ ctx: { get: name => services[name] }, store: {
    getSettings: () => settings, getCachedTranslation: async key => cache.get(key) ?? null,
    setCachedTranslation: async (key, value) => cache.set(key, value),
    getCachedReflow: async () => null, setCachedReflow: async () => {},
  } })
  const { dsh } = await gateway.models()
  const t = (_key, fallback) => fallback
  assert.deepEqual(modelRouteOptions(t, dsh).map(option => option.value), ['dsh|', accountImage, accountText, 'dsh|flash'])
  assert.deepEqual(modelRouteOptions(t, dsh, [], { forVision: true }).map(option => option.value), ['dsh|', accountImage])
  assert.equal(canAskWithImage(ref, undefined, dsh), true)
  assert.equal(canAskWithImage({ providerId: 'dsh', model: 'flash' }, undefined, dsh), false)
  assert.equal(gateway.resolveRef(ref).reasoningEffort, undefined)

  const message = { role: 'user', content: 'Question' }
  assert.equal((await gateway.chat({ messages: [message] })).provider, workbuddy.id)
  assert.equal((await gateway.chat({ messages: [message], ref, figureImage: 'data:image/png;base64,eA==' })).provider, account.id)
  assert.deepEqual((await gateway.translate({ texts: ['Results'] })).translations, ['结果'])
  assert.deepEqual((await gateway.getCachedTranslations({ texts: ['Results'], ref: { providerId: 'dsh', model: 'flash' } })).translations, [null])
  const vision = await gateway.visionLayout({ pages: [{ n: 1, imageBase64: 'eA==' }] })
  assert.equal(vision.pages[0].error, undefined)
  assert.deepEqual(calls.map(call => call.provider), [workbuddy.id, account.id, account.id, account.id])

  selection = { provider: account.id, model: 'flash' }
  catalogReads.length = 0
  const nativeDefault = (await gateway.models()).dsh
  assert.deepEqual(catalogReads, [account.id])
  assert.deepEqual(modelRouteOptions(t, nativeDefault).map(option => option.value), ['dsh|', accountImage, accountText])
  selection = { provider: workbuddy.id, model: 'flash' }
  accountLookupFails = true
  const unavailableCatalog = (await gateway.models()).dsh
  assert.deepEqual(modelRouteOptions(t, unavailableCatalog).map(option => option.value), ['dsh|', 'dsh|flash'])
  nativeAvailable = false
  await assert.rejects(() => gateway.chat({ messages: [message], ref }), /DeepSeek account provider is unavailable/)
  assert.equal(calls.length, 4)
})

test('a DSH provider without reasoning controls can translate, lay out pages and replay figure chat', async () => {
  const calls = []
  const model = { id: 'flash', inputModalities: ['text', 'image'] }
  const llm = {
    listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }, { id: 'deepseek-account', name: 'DeepSeek Account' }],
    listModels: async () => [model],
    async prepareCall({ provider, model: modelId, ...controls }, signal, configure) {
      signal.throwIfAborted()
      const config = { provider, model: modelId, ...configure(controls, model) }
      assert.equal(Object.hasOwn(config, 'reasoningEffort'), false)
      return { config, async *stream(options) {
        calls.push(options)
        assert.ok(options.messages.every(message => message.id && message.source))
        const text = options.system.includes('professional translator') ? '["结果","最佳充电策略"]'
          : options.system.includes('page') ? '{"page":1,"regions":[]}' : 'The figure shows the results.'
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
  }
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'workbuddy', model: 'flash', reasoningEffort: 'off' }) },
    attachments: { saveImage: async () => ({ attachmentId: 'figure' }) },
  }
  const store = {
    getSettings: () => ({ ai: { active: {}, translate: { batchSize: 6 }, targetLang: 'zh-CN' } }),
    getCachedTranslation: async () => null, setCachedTranslation: async () => {},
    getCachedReflow: async () => null, setCachedReflow: async () => {},
  }
  const gateway = new AiGateway({ ctx: { get: name => services[name] }, store })
  const translated = await gateway.translate({ texts: ['Results', 'Optimal charging strategy'] })
  assert.deepEqual(translated.translations, ['结果', '最佳充电策略'])
  assert.equal(translated.model, 'WorkBuddy · flash')
  assert.equal((await gateway.visionLayout({ pages: [{ n: 1, imageBase64: 'eA==' }] })).pages[0].error, undefined)
  const answer = await gateway.chat({
    system: 'Explain the figure.',
    messages: [
      { role: 'user', content: 'What is shown?' },
      { role: 'assistant', content: 'The figure shows the results.' },
      { role: 'user', content: 'Explain the figure again.' },
    ],
    figureImage: 'data:image/png;base64,eA==',
  })
  assert.equal(answer.text, 'The figure shows the results.')
  assert.equal(calls.length, 3)
  assert.ok(calls.every(options => options.provider === 'workbuddy' && options.model === 'flash'))
  assert.equal(calls[2].messages[1].source.kind, 'model')
  assert.equal(calls[2].messages[1].content[0].text, 'The figure shows the results.')
  assert.deepEqual(calls[2].messages.at(-1).content[1], { type: 'image', attachment: { attachmentId: 'figure' } })
  assert.equal(gateway.accountFallbackRoute(gateway.resolveRef({ providerId: 'dsh' })), null)
})

test('reasoning preferences apply to the exact DSH model on older host adapters', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'provider', name: 'Provider' }],
    resolveModelInfo: async (_provider, model) => model === 'main'
      ? { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }
      : { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } },
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'main', reasoningEffort: 'high' }) } }
  const gateway = new AiGateway({ ctx: { get: name => services[name] }, store: { getSettings: () => ({ ai: { active: {} } }) } })
  const args = { messages: [{ role: 'user', content: 'Question' }] }
  await gateway.chat(args)
  await gateway.chat({ ...args, reasoningEffort: 'off' })
  const alternate = { ...args, ref: { providerId: 'dsh', model: 'alternate' } }
  await gateway.chat(alternate)
  await gateway.chat({ ...alternate, reasoningEffort: 'off' })
  assert.deepEqual(calls.map(options => options.reasoningEffort), ['high', 'off', undefined, 'low'])
})

test('custom visual endpoint receives an image; model changes and force bypass cache',async()=>{
  const requests=[]
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    requests.push(JSON.parse(body))
    res.writeHead(200,{'content-type':'text/event-stream'})
    const content=JSON.stringify({page:1,regions:[],textBlocks:[{ids:['body'],kind:'paragraph'}]})
    res.end(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const settings={ai:{active:{vision:{providerId:'custom',model:'vision-a'}},providers:[{id:'custom',name:'QA vision',baseURL:`http://127.0.0.1:${server.address().port}`,apiKey:'disposable-test-value',models:['vision-a','vision-b']}]}}
    const cache=new Map()
    const gateway=new AiGateway({ctx:{get:()=>null},store:{getSettings:()=>settings,getCachedReflow:async key=>cache.get(key)??null,setCachedReflow:async(key,value)=>cache.set(key,value)}})
    const input={pages:[{n:1,imageBase64:'eA==',candidates:[{id:'body',text:'Body paragraph.'}]}]}
    const first=await gateway.visionLayout(input)
    assert.equal(first.pages[0].error,undefined)
    const image=requests[0].messages.at(-1).content.find(block=>block.type==='image_url')
    assert.equal(image.image_url.url,'data:image/jpeg;base64,eA==')
    assert.equal((await gateway.visionLayout(input)).cachedPages,1)
    assert.equal(requests.length,1)
    settings.ai.active.vision.model='vision-b'
    await gateway.visionLayout(input)
    assert.equal(requests.length,2)
    await gateway.visionLayout({...input,force:true})
    assert.equal(requests.length,3)
  } finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}
})

test('automatic visual route picks an image model while an explicit text model fails clearly',async()=>{
  let usedModel
  const llm={listProviders:()=>[{id:'deepseek-account',name:'Account'}],listModels:async()=>[{id:'pro',inputModalities:['text']},{id:'flash',inputModalities:['text','image']}],stream:async function*(options){usedModel=options.model;yield{type:'text-delta',text:'{"page":1,"regions":[]}'};yield{type:'finish',reason:{kind:'stop'}}}}
  const ctx={get:name=>name==='llm'?llm:name==='attachments'?{saveImage:async()=>({attachmentId:'test'})}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'deepseek-account',model:'pro'})}:null}
  const settings={ai:{active:{vision:{providerId:'dsh',model:''}},providers:[]}}
  const gateway=new AiGateway({ctx,store:{getSettings:()=>settings,getCachedReflow:async()=>null,setCachedReflow:async()=>{}}})
  await gateway.visionLayout({pages:[{n:1,imageBase64:'eA==',candidates:[]}]})
  assert.equal(usedModel,'flash')
  await assert.rejects(()=>gateway.visionLayout({pages:[{n:1,imageBase64:'eA=='}],ref:{providerId:'dsh',model:'pro'}}),/does not accept image/)
})

test('chat figure attaches to the selected image-capable model and rejects a text-only route', async () => {
  const attachment = { attachmentId: 'figure' }
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'account', name: 'Account' }],
    listModels: async () => [
      { id: 'text-model', inputModalities: ['text'] },
      { id: 'image-model', inputModalities: ['text', 'image'] },
    ],
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', text: 'Answer about the figure' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'text-model' }) },
    attachments: { async saveImage(input) {
      assert.equal(input.mediaType, 'image/png')
      assert.deepEqual(Array.from(input.data), [120])
      return attachment
    } },
  }
  const gateway = new AiGateway({ ctx: { get: name => services[name] }, store: { getSettings: () => ({ ai: { active: {} } }) } })
  const args = { messages: [{ role: 'user', content: 'Question' }], figureImage: 'data:image/png;base64,eA==' }
  await gateway.chat({ ...args, ref: { providerId: 'dsh', model: 'image-model' } })
  assert.equal(calls[0].model, 'image-model')
  assert.deepEqual(calls[0].messages[0].content[1], { type: 'image', attachment })
  await assert.rejects(() => gateway.chat({ ...args, ref: { providerId: 'dsh', model: 'text-model' } }), /does not accept figure images/)
  assert.equal(calls.length, 1)
})

test('conflicting text ownership is repaired with the page image before the result is cached',async()=>{
  const requests=[],saved=[]
  const settings={ai:{active:{vision:{providerId:'dsh',model:'flash'}},providers:[]}}
  const llm={listProviders:()=>[{id:'account',name:'Account'}],listModels:async()=>[{id:'flash',inputModalities:['text','image']}],stream:async function*(options){
    requests.push(options)
    yield {type:'text-delta',text:JSON.stringify({page:1,regions:[{kind:'formula',bbox:[.1,.3,.9,.4],candidateIds:['eq']}],textBlocks:[{ids:[requests.length===1?'eq':'body'],kind:'paragraph'}]})}
    yield {type:'finish',reason:{kind:'stop'}}
  }}
  const ctx={get:name=>name==='llm'?llm:name==='attachments'?{saveImage:async()=>({attachmentId:'image'})}:name==='agentDefaultModel'?{currentSelection:()=>({provider:'account',model:'flash'})}:null}
  const gateway=new AiGateway({ctx,store:{getSettings:()=>settings,getCachedReflow:async()=>null,setCachedReflow:async(key,value)=>saved.push(value)}})
  const result=await gateway.visionLayout({pages:[{n:1,imageBase64:'eA==',candidates:[{id:'eq'},{id:'body'}]}]})
  assert.equal(requests.length,2);assert.equal(saved.length,1)
  assert.ok(requests.every(request=>request.messages.length===1&&request.messages[0].content.some(block=>block.type==='image')))
  assert.equal(result.pages[0].request.attempts,2)
  assert.equal(result.pages[0].error,undefined)
})
