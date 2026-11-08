// Host-side AI gateway.
//
// Model routes:
//   'dsh'  — the model provider selected in Harness, with credentials managed by Harness.
//   custom — any OpenAI-compatible endpoint (DeepSeek API key, OpenAI, Moonshot, Qwen, …).
//   translation engines — separate text-only routes for translation.
//
// Translation results are cached on disk keyed by (provider, model, language, source text), so
// re-opening a document never pays for the same paragraph twice.
import { defaultSettings } from './store.js'
import { randomUUID } from 'node:crypto'
import { ReaderError, byteLength, delay, plainObject, sha256, truncateBytes } from './util.js'
import { VISION_LAYOUT_SYSTEM_PROMPT, buildVisionLayoutInput } from './vision-prompt.js'
import { VISION_LAYOUT_VERSION, validateVisionPage } from '../shared/vision-contract.js'
import { CHAT_FIGURE_LIMIT } from '../shared/chat-context.js'
import { DEEPSEEK_ACCOUNT_PROVIDER, DEEPSEEK_ACCOUNT_ROUTE } from '../shared/model-ref.js'
import { TRANSLATION_CACHE_VERSION, splitTranslationText, translationIssue } from '../shared/translation-contract.js'
import { refineInlineParagraph } from './inline-math.js'
import { LIBRETRANSLATE, TRANSLATION_ENGINES, translationEngineScope } from '../shared/translation-engines.js'
import { MachineTranslator } from './machine-translation.js'

/** Model presets offered by the settings UI (id shown only; users may edit baseURL/models). */
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'moonshot', name: 'Moonshot Kimi', baseURL: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'] },
  { id: 'qwen', name: 'Qwen (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'siliconflow', name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { id: 'custom', name: 'Custom (OpenAI compatible)', baseURL: '', models: [] },
]

const LANGUAGE_NAMES = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian',
  'pt': 'Portuguese',
  'it': 'Italian',
  'ar': 'Arabic',
}

function languageName(code) {
  return LANGUAGE_NAMES[code] ?? code
}

function translationCacheKey(route, lang, text) {
  const identifier = route.kind === 'dsh' ? 'dsh:' + route.provider + ':' + route.model
    : route.kind === 'machine' ? route.providerId + ':' + sha256(route.scope)
    : route.providerId + ':' + route.model
  return 'translation-v' + TRANSLATION_CACHE_VERSION + '|' + route.kind + '|' + identifier + '|' + lang + '|' + text
}

/** Combine an external abort signal with an internal timeout. */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

/** Parse an OpenAI-compatible SSE stream into text deltas. */
async function* openAiSseText(response, signal) {
  if (response.body === null) throw new ReaderError('no-body', 'model endpoint returned an empty body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw new ReaderError('aborted', 'request aborted')
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '' || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return { usage }
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        if (parsed?.usage !== undefined && parsed.usage !== null) usage = parsed.usage
        if (parsed?.choices?.some(choice => choice.finish_reason === 'length')) throw new ReaderError('model-truncated', 'The model response reached its token limit; incomplete output was not cached.')
        const delta = parsed?.choices?.[0]?.delta
        const text = typeof delta?.content === 'string' ? delta.content : typeof parsed?.choices?.[0]?.text === 'string' ? parsed.choices[0].text : ''
        if (text !== '') yield { text, usage: null }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { usage }
}

/** Strip possible Markdown fences around a JSON payload. */
function stripFences(text) {
  let out = String(text).trim()
  if (out.startsWith('```')) out = out.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  return out
}

/** Parse a JSON array of `count` translated strings. */
function parseTranslationArray(text, count) {
  const source = stripFences(text)
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let value
  try {
    value = JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length !== count) return null
  if (!value.every((item) => typeof item === 'string')) return null
  return value
}

/** Errors with a machine-readable reason for the RPC envelope. */
function modelError(code, message) {
  return new ReaderError(code, message)
}

/**
 * Whether a model failure means the selected route has no usable credential (for example a
 * `deepseek-official` API-key route while the user authenticates through `deepseek-account`).
 */
function isMissingCredentialError(error) {
  const message = String(error?.message ?? error)
  return /no api key|missing (api key|credential)|DEEPSEEK_API_KEY|not signed in|sign.?in required|unauthorized/i.test(message)
}

/** Honor the model's declared levels, preferring a light tier when a task asks for off. */
function supportedControls(controls, info, preferredEffort) {
  const available = info?.reasoning?.efforts
  if (!preferredEffort || !available?.length) return controls
  const preferences = preferredEffort === 'off' ? ['off', 'minimal', 'low'] : [preferredEffort]
  const effort = preferences.find(id => available.some(item => item.id === id))
  return effort ? { ...controls, reasoningEffort: effort } : controls
}

/** Parse one JSON object out of model output (fences stripped, outermost braces). */
function parseJsonObject(text) {
  const source = stripFences(text)
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(source.slice(start, end + 1))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Validate one page's AI structure suggestion against the page's block ids.
 *
 * Guards against model over-reach:
 *  - a heading must be a short block (<= 160 chars, <= 30 words): a long block is a merged
 *    heading+paragraph and promoting it would render the whole paragraph as a giant heading;
 *  - captions / images / lists / quotes are never dropped (they carry the figures);
 *  - at most 6 headings and ~18% (max 8) artifact drops per page.
 */
function sanitizeStructureSuggestion(parsed, blocks) {
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const headings = []
  const drop = []
  const droppable = new Set(['paragraph', 'heading', 'footnote', 'artifact'])
  if (parsed !== null) {
    for (const entry of Array.isArray(parsed.headings) ? parsed.headings : []) {
      const value = typeof entry === 'string' ? { id: entry } : plainObject(entry)
      const id = typeof value.id === 'string' ? value.id : ''
      const block = byId.get(id)
      if (block === undefined) continue
      if (!['paragraph', 'heading'].includes(String(block.kind ?? 'paragraph'))) continue
      const text = String(block.text ?? '').trim()
      const words = text.split(/\s+/).filter((word) => word !== '').length
      if (text.length > 160 || words > 30) continue
      const level = Number(value.level)
      headings.push({ id, level: Number.isFinite(level) ? Math.min(3, Math.max(1, Math.round(level))) : 1 })
      if (headings.length >= 6) break
    }
    const maxDrop = Math.max(1, Math.min(8, Math.floor(blocks.length * 0.18)))
    for (const entry of Array.isArray(parsed.drop) ? parsed.drop : []) {
      const value = typeof entry === 'string' ? { id: entry } : plainObject(entry)
      const id = typeof value.id === 'string' ? value.id : ''
      const block = byId.get(id)
      if (block === undefined) continue
      if (!droppable.has(String(block.kind ?? 'paragraph'))) continue
      drop.push(id)
      if (drop.length >= maxDrop) break
    }
  }
  return { headings, drop }
}

export class AiGateway {
  async inlineMath(args) { return refineInlineParagraph(this, args) }
  constructor({ ctx, store }) {
    this.ctx = ctx
    this.store = store
    this.activeRequests = 0
    this.machineTranslator = new MachineTranslator()
  }

  llm() {
    const ctx = this.ctx
    try {
      return ctx.get?.('llm') ?? null
    } catch {
      return null
    }
  }

  dshSelection() {
    let selection = null
    try {
      const service = this.ctx.get?.('agentDefaultModel')
      if (service !== undefined && service !== null) selection = service.currentSelection()
    } catch {
      selection = null
    }
    const llm = this.llm()
    const providers = []
    try {
      if (llm !== null) {
        for (const provider of llm.listProviders()) providers.push({ id: provider.id, name: provider.name })
      }
    } catch {
      /* adapter listing is best-effort */
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider : ''
    return {
      available: llm !== null && providers.length > 0 && selection !== null,
      provider,
      providerName: providers.find(item => item.id === provider)?.name || provider,
      model: typeof selection?.model === 'string' ? selection.model : '',
      reasoningEffort: typeof selection?.reasoningEffort === 'string' ? selection.reasoningEffort : undefined,
      providers,
    }
  }

  /**
   * Resolve a call route: an explicit ModelRef wins, otherwise the task's configured
   * active model (falling back to the selected Harness model).
   */
  resolveFor(task, ref) {
    const requested = plainObject(ref)
    const settings = this.store.getSettings()
    const selected = typeof requested.providerId === 'string' && requested.providerId !== ''
      ? requested : settings.ai.active[task] ?? { providerId: 'dsh' }
    const { providerId } = selected
    if (!Object.hasOwn(TRANSLATION_ENGINES, providerId)) return this.resolveRef(selected)
    if (task !== 'translate') throw modelError('model-not-configured', 'This engine supports translation only.')
    const scope = translationEngineScope(providerId, settings.ai.translate)
    if (providerId === LIBRETRANSLATE && !scope) throw modelError('model-not-configured', 'Set a valid LibreTranslate server URL in Reader settings.')
    if (typeof selected.scope === 'string' && selected.scope !== scope) throw modelError('translation-settings-changed', 'Translation settings changed. Retry with the saved settings.')
    return { kind: 'machine', providerId, label: TRANSLATION_ENGINES[providerId], scope, apiKey: providerId === LIBRETRANSLATE ? settings.ai.translate.libreKey : undefined }
  }

  /** Resolve a ModelRef from settings to a concrete call route. */
  resolveRef(ref) {
    const settings = this.store.getSettings()
    const requested = plainObject(ref)
    const providerId = typeof requested.providerId === 'string' ? requested.providerId : 'dsh'
    const pinnedAccount = providerId === DEEPSEEK_ACCOUNT_ROUTE
    if (providerId === 'dsh' || providerId === '' || pinnedAccount) {
      const dsh = this.dshSelection()
      const account = pinnedAccount ? dsh.providers.find(item => item.id === DEEPSEEK_ACCOUNT_PROVIDER) : undefined
      if (pinnedAccount && !account) throw modelError('model-unavailable', 'The DeepSeek account provider is unavailable. Check your sign-in in DSH.')
      if (!pinnedAccount && !dsh.available) throw modelError('model-unavailable', 'The DSH model is unavailable. Choose a model in DSH settings or configure a provider in Reader settings.')
      const provider = account?.id ?? dsh.provider
      const providerName = account ? account.name || account.id : dsh.providerName
      const namedModel = typeof requested.model === 'string' ? requested.model.trim() : ''
      const model = namedModel || (pinnedAccount ? '' : dsh.model)
      if (!model) throw modelError('model-not-configured', 'Select a model in Reader settings.')
      return {
        kind: 'dsh',
        providerId: pinnedAccount ? DEEPSEEK_ACCOUNT_ROUTE : 'dsh',
        provider,
        providerName,
        model,
        reasoningEffort: provider === dsh.provider && model === dsh.model ? dsh.reasoningEffort : undefined,
        label: `${providerName} · ${model}`,
      }
    }
    const provider = settings.ai.providers.find((item) => item.id === providerId)
    if (provider === undefined) throw modelError('model-not-configured', `model provider "${providerId}" is not configured`)
    if (provider.baseURL === '') throw modelError('model-not-configured', `provider "${provider.name}" has no base URL`)
    if (provider.apiKey === '') throw modelError('model-not-configured', `provider "${provider.name}" has no API key`)
    const model = typeof requested.model === 'string' && requested.model.trim() !== '' ? requested.model.trim() : provider.models[0]
    if (typeof model !== 'string' || model === '') throw modelError('model-not-configured', `provider "${provider.name}" has no model selected`)
    return {
      kind: 'openai',
      providerId: provider.id,
      provider: provider.name,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model,
      label: `${provider.name} · ${model}`,
    }
  }

  /** Describe the currently selectable models for the settings UI. */
  async models() {
    const settings = this.store.getSettings()
    const dsh = this.dshSelection()
    const llm = this.llm()
    const loadCatalog = async provider => {
      if (!llm || !provider) return []
      try {
        const listed = await llm.listModels(provider)
        return (Array.isArray(listed) ? listed : []).map(model => ({
          id: typeof model?.id === 'string' ? model.id : '',
          name: typeof model?.name === 'string' ? model.name : '',
          description: typeof model?.description === 'string' ? model.description : '',
          contextWindow: Number(model?.contextWindow) || 0,
          inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.filter((value) => value === 'text' || value === 'image') : [],
        })).filter((model) => model.id !== '')
      } catch {
        return []
      }
    }
    const currentCatalog = loadCatalog(dsh.provider)
    const accountCatalogRequest = dsh.provider === DEEPSEEK_ACCOUNT_PROVIDER
      ? currentCatalog
      : dsh.providers.some(item => item.id === DEEPSEEK_ACCOUNT_PROVIDER) ? loadCatalog(DEEPSEEK_ACCOUNT_PROVIDER) : []
    const [catalog, accountCatalog] = await Promise.all([currentCatalog, accountCatalogRequest])
    const resolveActive = (ref) => {
      const requested = plainObject(ref)
      if (requested.providerId === undefined || requested.providerId === 'dsh' || requested.providerId === '') {
        return { providerId: 'dsh', model: typeof requested.model === 'string' && requested.model !== '' ? requested.model : dsh.model }
      }
      return { providerId: requested.providerId, model: typeof requested.model === 'string' ? requested.model : '' }
    }
    return {
      dsh: { ...dsh, catalog, accountCatalog },
      presets: PROVIDER_PRESETS,
      custom: settings.ai.providers.map((provider) => ({ id: provider.id, name: provider.name, baseURL: provider.baseURL, models: provider.models, hasKey: provider.apiKey !== '' })),
      active: { chat: resolveActive(settings.ai.active.chat), translate: resolveActive(settings.ai.active.translate), vision: resolveActive(settings.ai.active.vision) },
      targetLang: settings.ai.targetLang,
      languages: Object.entries(LANGUAGE_NAMES).map(([id, name]) => ({ id, name })),
    }
  }

  /**
   * Run one chat completion, streaming text deltas to `onDelta`.
   *
   * The DSH default route may be an API-key provider while the user is signed in through the
   * account provider (or vice versa). A missing-credential failure on the selected route therefore
   * retries once on a registered DeepSeek *account* route, so the default model keeps working and
   * consumption stays on the DeepSeek account without extra configuration.
   * @returns {Promise<{ text:string, model:string, usage:object|null }>}
   */
  async chat(args) {
    const route = this.resolveFor('chat', args.ref)
    const images = args.figureImage
      ? [await this.prepareChatFigure(args.figureImage, route, args.signal)]
      : args.images
    try {
      return await this.chatWithRoute({ ...args, images, route })
    } catch (error) {
      if (args.signal?.aborted || !isMissingCredentialError(error)) throw error
      const fallback = this.accountFallbackRoute(route)
      if (fallback === null) throw error
      return this.chatWithRoute({ ...args, images, route: fallback })
    }
  }

  async prepareChatFigure(dataUrl, route, signal) {
    signal?.throwIfAborted()
    const image = dataUrl.length <= CHAT_FIGURE_LIMIT && /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
    if (!image) throw modelError('chat-image-invalid', 'The figure is too large or has an unsupported image format.')
    if (route.kind === 'openai') return { dataUrl }

    const catalog = await this.llm()?.listModels(route.provider)
    const model = Array.isArray(catalog) ? catalog.find(item => item.id === route.model) : undefined
    if (!model?.inputModalities?.includes('image')) {
      throw modelError('chat-image-unsupported', 'This model does not accept figure images.')
    }
    signal?.throwIfAborted()
    const attachments = this.ctx.get?.('attachments')
    if (!attachments) throw modelError('chat-image-unavailable', 'The image attachment service is unavailable.')
    return attachments.saveImage({
      data: new Uint8Array(Buffer.from(image[2], 'base64')),
      mediaType: `image/${image[1]}`,
      name: `reader-figure.${image[1] === 'jpeg' ? 'jpg' : 'png'}`,
    })
  }

  /** The account-backed DeepSeek route registered beside an API-key route, when present. */
  accountFallbackRoute(route) {
    if (route.kind !== 'dsh' || !/^deepseek(?:-|$)/i.test(route.provider) || /^deepseek-account(?:-|$)/i.test(route.provider)) return null
    const fallback = this.dshSelection().providers.find(provider => /^deepseek-account(?:-|$)/i.test(provider.id))
    if (!fallback) return null
    const providerName = fallback.name || fallback.id
    return { ...route, provider: fallback.id, providerName, reasoningEffort: undefined, label: `${providerName} · ${route.model}` }
  }

  async chatWithRoute({ messages, system, route, images = [], reasoningEffort, maxTokens = 4096, temperature = 0.4, signal, onDelta = () => undefined, timeoutMs = 240000 }) {
    const safeMessages = (Array.isArray(messages) ? messages : [])
      .filter((message) => plainObject(message).role === 'user' || plainObject(message).role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: truncateBytes(typeof message.content === 'string' ? message.content : '', 200000),
      }))
    if (safeMessages.length === 0) throw modelError('bad-request', 'a model request needs at least one message')
    const imageRefs = (Array.isArray(images) ? images : []).filter((image) => image !== null && typeof image === 'object' && typeof image.attachmentId === 'string')
    const inlineImages = (Array.isArray(images) ? images : []).filter(image => typeof image?.dataUrl === 'string' && /^data:image\/(?:jpeg|png);base64,/.test(image.dataUrl))
    const bounded = withTimeout(signal, timeoutMs)
    let usage = null
    let text = ''
    try {
      if (route.kind === 'dsh') {
        const llm = this.llm()
        if (llm === null) throw modelError('model-unavailable', 'LLM service is unavailable')
        const contentMessages = safeMessages.map((message, index) => {
          const isLastUser = index === safeMessages.length - 1 && message.role === 'user'
          return {
            id: randomUUID(),
            role: message.role,
            // Saved replies are plain text. Replay them as provider-neutral history.
            source: message.role === 'assistant'
              ? { kind: 'model', provider: 'dsh-reader', model: 'history' }
              : { kind: 'user' },
            content: [
              { type: 'text', text: message.content },
              ...(isLastUser ? imageRefs.map(attachment => ({ type: 'image', attachment })) : []),
            ],
          }
        })
        const config = { provider: route.provider, model: route.model, maxTokens, temperature }
        const preferredEffort = reasoningEffort ?? route.reasoningEffort
        const request = {
          messages: contentMessages,
          signal: bounded.signal,
          ...(typeof system === 'string' && system !== '' ? { system } : {}),
        }
        let stream
        if (typeof llm.prepareCall === 'function') {
          const call = await llm.prepareCall(config, bounded.signal, (controls, info) => supportedControls(controls, info, preferredEffort))
          bounded.signal.throwIfAborted()
          stream = call.stream({ ...request, ...call.config })
        } else {
          const info = preferredEffort ? await llm.resolveModelInfo?.(route.provider, route.model, bounded.signal) : undefined
          bounded.signal.throwIfAborted()
          stream = llm.stream({ ...request, ...supportedControls(config, info, preferredEffort) })
        }
        for await (const chunk of stream) {
          if (bounded.signal.aborted) throw modelError('aborted', 'model call aborted')
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text
            onDelta(chunk.text)
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'max-tokens') throw modelError('model-truncated', 'The model response reached its token limit; retry with a larger output budget or less reasoning.')
            if (chunk.reason?.kind === 'error') throw modelError('model-error', chunk.reason.failure?.message ?? 'model call failed')
            if (chunk.reason?.kind === 'aborted') throw modelError('aborted', chunk.reason.failure?.message ?? 'model call aborted')
          }
        }
      } else {
        const endpoint = `${route.baseURL}/chat/completions`
        const body = {
          model: route.model,
          messages: [...(typeof system === 'string' && system !== '' ? [{ role: 'system', content: system }] : []), ...safeMessages.map((message, index) => index === safeMessages.length - 1 && message.role === 'user' && inlineImages.length ? { role: message.role, content: [{ type: 'text', text: message.content }, ...inlineImages.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } }))] } : message)],
          stream: true,
          temperature,
          max_tokens: maxTokens,
          stream_options: { include_usage: true },
        }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
          body: JSON.stringify(body),
          signal: bounded.signal,
        })
        if (!response.ok) {
          const detail = truncateBytes(await response.text().catch(() => ''), 2000)
          throw modelError('model-http-error', `${route.provider} returned HTTP ${response.status}${detail !== '' ? `: ${detail}` : ''}`)
        }
        const iterator = openAiSseText(response, bounded.signal)
        for (;;) {
          const next = await iterator.next()
          if (next.done) {
            usage = next.value?.usage ?? usage
            break
          }
          text += next.value.text
          onDelta(next.value.text)
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError' || bounded.signal.aborted) throw modelError('aborted', 'model call aborted or timed out')
      if (error instanceof ReaderError) throw error
      throw modelError('model-error', error?.message ?? String(error))
    } finally {
      bounded.dispose()
    }
    return { text, model: route.label, usage, provider: route.provider, modelId: route.model, routeKind: route.kind }
  }

  /** Read only: warming a reader or exporting existing translations must never call a model. */
  async getCachedTranslations({texts,targetLang,ref}) {
    const route=this.resolveFor('translate',ref),settings=this.store.getSettings()
    const lang=targetLang||settings.ai.targetLang
    const list=(Array.isArray(texts)?texts:[]).slice(0,5000).map(text=>typeof text==='string'?text:'')
    const translations=await Promise.all(list.map(async text=>{
      if(!text.trim())return ''
      const value=await this.store.getCachedTranslation(translationCacheKey(route,lang,text))
      return value!==null&&translationIssue(text,value,lang)===null?value:null
    }))
    return {translations,model:route.label}
  }

  /**
   * Translate a batch of texts with cache-first semantics.
   * @returns {Promise<{ translations:(string|null)[], errors:({code:string,message:string}|null)[], cached:boolean[], usage:{chars:number,cachedChars:number}, model:string }>}
   */
  async translate({ texts, targetLang, ref, force = false, signal, onProgress = () => undefined }) {
    const settings = this.store.getSettings()
    const list = (Array.isArray(texts) ? texts : []).map((text) => (typeof text === 'string' ? text : ''))
    if (list.length === 0) return { translations: [], errors: [], cached: [], usage: { chars: 0, cachedChars: 0 }, model: '' }
    const route = this.resolveFor('translate', ref)
    const lang = typeof targetLang === 'string' && targetLang !== '' ? targetLang : settings.ai.targetLang
    const results = new Array(list.length).fill(null)
    const errors = new Array(list.length).fill(null)
    const cached = new Array(list.length).fill(false)
    const lookups = await Promise.all(
      list.map(async (text, index) => {
        if (text.trim() === '') return { index, text, empty: true, hit: null, key: '' }
        const key = translationCacheKey(route, lang, text)
        const saved = force ? null : await this.store.getCachedTranslation(key)
        const hit = saved !== null && translationIssue(text, saved, lang) === null ? saved : null
        return { index, text, empty: false, hit, key }
      }),
    )
    for (const lookup of lookups) {
      if (lookup.empty) {
        results[lookup.index] = ''
        cached[lookup.index] = true
      } else if (lookup.hit !== null) {
        results[lookup.index] = lookup.hit
        cached[lookup.index] = true
      }
    }
    onProgress({ done: lookups.length, total: list.length, cached: true })
    const pending = lookups.filter((lookup) => lookup.empty === false && lookup.hit === null)
    if (pending.length === 0) {
      return {
        translations: results,
        errors,
        cached,
        usage: { chars: 0, cachedChars: list.reduce((sum, text) => sum + text.length, 0) },
        model: route.label,
      }
    }
    // Header/footer repeats and repeated short lines should cost one translation, not N.
    const byText = new Map()
    for (const item of pending) {
      const existing = byText.get(item.text)
      if (existing !== undefined) existing.indices.push(item.index)
      else byText.set(item.text, { text: item.text, key: item.key, indices: [item.index] })
    }
    const unique = [...byText.values()]
    const batchSize = Math.max(1, Math.min(12, settings.ai.translate.batchSize))
    const maxBatchChars = 7000
    const batches = []
    let current = []
    let currentChars = 0
    for (const item of unique) {
      const length = item.text.length
      if (current.length > 0 && (current.length >= batchSize || currentChars + length > maxBatchChars)) {
        batches.push(current)
        current = []
        currentChars = 0
      }
      current.push(item)
      currentChars += length
    }
    if (current.length > 0) batches.push(current)

    const modelLabel = route.label
    let translatedChars = 0
    let cachedChars = lookups.reduce((sum, lookup) => sum + (lookup.empty || lookup.hit !== null ? lookup.text.length : 0), 0)
    for (const batch of batches) {
      if (signal?.aborted) throw modelError('aborted', 'translation aborted')
      const units = batch.flatMap((item, parent) => splitTranslationText(item.text).map((text, index) => ({ text, parent, key: `translation-unit-v1|${item.key}|${index}|${text}` })))
      const pieces = batch.map(() => [])
      const values = new Array(units.length), missing = []
      for (const [index, unit] of units.entries()) {
        const saved = force ? null : await this.store.getCachedTranslation(unit.key)
        if (saved !== null && translationIssue(unit.text, saved, lang) === null) values[index] = saved
        else missing.push({ ...unit, position: index })
      }
      for (let start = 0; start < missing.length; start += batchSize) {
        const slice = missing.slice(start, start + batchSize)
        const translated = await this.translateBatch({ batch: slice, lang, route, signal })
        for (const [index, unit] of slice.entries()) {
          const value = translated[index] ?? { error: 'The model returned no translation for this unit.', code: 'translate-empty' }
          values[unit.position] = value
          if (typeof value === 'string' && translationIssue(unit.text, value, lang) === null) await this.store.setCachedTranslation(unit.key, value, { model: modelLabel, lang, version: 'unit-v1' })
        }
      }
      for (const [index, unit] of units.entries()) pieces[unit.parent].push(values[index])
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index]
        const failed = pieces[index].find(value => typeof value !== 'string')
        const value = failed ? '' : pieces[index].map(text => text.trim()).join(' ')
        const issue = failed?.error ?? translationIssue(item.text, value, lang)
        if (issue) {
          for (const targetIndex of item.indices) errors[targetIndex] = { code: failed?.code ?? 'translate-incomplete', message: issue }
          continue
        }
        for (const targetIndex of item.indices) results[targetIndex] = value
        translatedChars += item.text.length
        if (value.trim() !== '') await this.store.setCachedTranslation(item.key, value, { model: modelLabel, lang, version: TRANSLATION_CACHE_VERSION, units: pieces[index].length })
      }
      onProgress({ done: results.filter((value) => value !== null).length, total: list.length, batch: true })
    }
    return {
      translations: results,
      errors,
      cached,
      usage: { chars: translatedChars, cachedChars },
      model: modelLabel,
    }
  }

  async translateBatch({ batch, lang, route, signal }) {
    if (route.kind === 'machine') return this.machineTranslator.translate({ batch, lang, route, signal })
    const language = languageName(lang)
    const system = [
      'You are a precise professional translator.',
      `Translate each item of the JSON string array the user sends into ${language}.`,
      'Preserve meaning, tone, formatting, names, numbers, formulas and citations.',
      'Preserve every ⟦DSHMATH_…⟧ placeholder exactly as supplied, exactly once. These are immutable formula objects; do not interpret or translate them.',
      'Translate EVERY sentence and clause completely. Never summarize or return only a heading. Keep all digits, decimal values, percentages and citation years in numeric form.',
      'Keep the original numeric spellings; translate unit names without rescaling quantities (for example 150.89 thousand CNY remains 150.89 千元, not a different mantissa).',
      'Do not merge, split, add or omit items.',
      'Return ONLY a valid JSON array of strings with exactly the same number of items, in the same order. No explanations, no code fences.',
    ].join('\n')
    const user = JSON.stringify(batch.map((item) => item.text))
    try {
      const { text } = await this.chat({
        messages: [{ role: 'user', content: user }],
        system,
        reasoningEffort: route.kind === 'dsh' ? 'off' : undefined,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: Math.min(8192, Math.max(1024, Math.ceil(batch.reduce((sum, item) => sum + item.text.length, 0) / 1.5) + 768)),
        temperature: 0.2,
        signal,
        timeoutMs: 180000,
      })
      const parsed = parseTranslationArray(text, batch.length)
      if (parsed !== null && parsed.every((value, index) => translationIssue(batch[index].text, value, lang) === null)) return parsed
      if (parsed !== null) {
        for (let index = 0; index < parsed.length; index++) {
          const issue = translationIssue(batch[index].text, parsed[index], lang)
          if (!issue) continue
          try { parsed[index] = await this.translateSingle({ text: batch[index].text, lang, route, signal, issue }) }
          catch (error) {
            if (signal?.aborted) throw error
            parsed[index] = { error: error?.message ?? String(error), code: error?.code ?? 'translate-failed' }
          }
        }
        return parsed
      }
      // A malformed array should not cost N extra model calls. Split the batch and retry the
      // halves; only a single unparseable item falls back to a one-item request.
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2)
        const left = await this.translateBatch({ batch: batch.slice(0, middle), lang, route, signal })
        const right = await this.translateBatch({ batch: batch.slice(middle), lang, route, signal })
        return [...left, ...right]
      }
      // Fallback: translate one item at a time (robust against model formatting drift).
      const out = []
      for (const item of batch) {
        try { out.push(await this.translateSingle({ text: item.text, lang, route, signal })) }
        catch (error) {
          if (signal?.aborted) throw error
          out.push({ error: error?.message ?? String(error), code: error?.code ?? 'translate-failed' })
        }
      }
      return out
    } catch (error) {
      if (signal?.aborted) throw error
      return batch.map(() => ({ error: error?.message ?? String(error), code: error?.code ?? 'translate-failed' }))
    }
  }

  async translateSingle({ text: source, lang, route, signal, issue = '' }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.chat({
        messages: [{ role: 'user', content: source }],
        system: `Translate the ENTIRE user text into ${languageName(lang)}. Translate every sentence and clause without summarizing. Keep all original numeric spellings, decimal values, percentages, mathematical expressions and citation years; translate units without rescaling quantities. Preserve every ⟦DSHMATH_…⟧ formula placeholder exactly once, unchanged. Return only the complete translation. ${issue ? `A previous result failed validation: ${issue}` : ''}`,
        reasoningEffort: route.kind === 'dsh' ? 'off' : undefined,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: Math.min(8192, Math.max(1536, source.length * 2)),
        temperature: 0,
        signal, timeoutMs: 120000,
      })
      const value = response.text.trim()
      issue = translationIssue(source, value, lang)
      if (!issue) return value
    }
    throw modelError('translate-incomplete', issue)
  }

  /**
   * AI structure refinement for PDF reflow blocks.
   *
   * The deterministic reflow produces paragraph text plus heuristic heading guesses; this pass asks
   * the model, page by page, to confirm/correct which blocks are headings (and at what level) and
   * which are page furniture (running heads, figure fragments, page numbers). Paragraph text is
   * never rewritten. One model call per page, cached by the exact block payload hash — re-running
   * "AI 精排" on the same extraction costs nothing.
   *
   * @returns {Promise<{pages:{n:number,headings:{id:string,level:number}[],drop:string[],cached:boolean}[],
   *           model:string,cachedPages:number,totalPages:number}>}
   */
  async refineStructure({ title, pages, ref, signal, onProgress = () => undefined }) {
    const list = Array.isArray(pages) ? pages : []
    if (list.length === 0) return { pages: [], model: '', cachedPages: 0, totalPages: 0 }
    const route = this.resolveFor('chat', ref)
    const concurrency = 3
    const results = []
    let cachedPages = 0
    let cursor = 0
    const system = [
      'You are a document-structure analyst converting a PDF page into a clean reading structure.',
      'You receive JSON: {"document": string, "page": number, "blocks": [{"id": string, "kind": "paragraph|heading|list|caption|footnote|image|figure|formula|code", "text": string}]}.',
      'Return STRICT JSON only, of the form: {"headings":[{"id":"<block id>","level":1|2|3}],"drop":["<block id>"]}.',
      'Rules:',
      '- Mark ONLY titles of sections/subsections that the page itself shows as headings (e.g. "1 Introduction", "2.1 Challenges ..."), never a block that contains body sentences or more than ~20 words.',
      '- Never mark figure/formula/image/caption/list blocks as headings, and never drop them.',
      '- Heuristic heading blocks that are actually figure labels, chart text or legends must be OMITTED from headings so they are demoted back to body text.',
      '- Do NOT mark body paragraphs, equations, figure/table labels, running headers/footers, page numbers, citations, email addresses or affiliation lines as headings.',
      '- Add to "drop" only page furniture: running headers/footers, standalone page numbers, arXiv stamps, broken equation fragments, figure tick labels. NEVER drop real paragraphs, captions, lists, images, figures or formulas.',
      '- If you are unsure about a block, leave it out of both arrays.',
      '- Every id must come from the input blocks. Keep the response compact. No prose, no markdown fences.',
    ].join('\n')
    const runPage = async (page) => {
      const rawBlocks = Array.isArray(page?.blocks) ? page.blocks : []
      const blocks = rawBlocks
        .map((block) => {
          const value = plainObject(block)
          return {
            id: typeof value.id === 'string' ? value.id : '',
            kind: typeof value.kind === 'string' ? value.kind : 'paragraph',
            text: truncateBytes(typeof value.text === 'string' ? value.text : '', 280),
          }
        })
        .filter((block) => block.id !== '')
      const pageNumber = Number(page?.n) || 0
      if (blocks.length === 0) return { n: pageNumber, headings: [], drop: [], cached: false }
      const signature = sha256(JSON.stringify(blocks))
      const cacheKey = `reflow-v3|${signature}`
      const cached = await this.store.getCachedReflow(cacheKey)
      if (cached !== null) {
        cachedPages++
        return { n: pageNumber, headings: cached.headings, drop: cached.drop, cached: true, explicit: cached.explicit !== false }
      }
      const user = JSON.stringify({ document: String(title ?? '').slice(0, 200), page: pageNumber, blocks })
      const { text } = await this.chat({
        messages: [{ role: 'user', content: user }],
        system,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: 900,
        temperature: 0,
        signal,
        timeoutMs: 120000,
      })
      const parsed = parseJsonObject(text)
      const suggestion = sanitizeStructureSuggestion(parsed, blocks)
      const explicit = parsed !== null
      await this.store.setCachedReflow(cacheKey, { headings: suggestion.headings, drop: suggestion.drop, explicit })
      return { n: pageNumber, headings: suggestion.headings, drop: suggestion.drop, cached: false, explicit }
    }
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= list.length) return
        const result = await runPage(list[index])
        results.push(result)
        onProgress({
          done: results.length,
          total: list.length,
          page: result.n,
          cached: result.cached,
          suggestion: { n: result.n, headings: result.headings, drop: result.drop, explicit: result.explicit === true },
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
    results.sort((a, b) => a.n - b.n)
    return { pages: results, model: route.label, cachedPages, totalPages: list.length }
  }

  /**
   * Reconstruct display equations from noisy PDF text in ONE model call.
   *
   * A dedicated, simple JSON contract is far more reliable (and cheaper) than mixing equation
   * reconstruction with page classification: the model receives all candidate fragments and
   * returns LaTeX for each id it recognises.
   */
  async reconstructFormulas({ title, items, ref, signal }) {
    const list = (Array.isArray(items) ? items : [])
      .map((item) => {
        const value = plainObject(item)
        return {
          id: typeof value.id === 'string' ? value.id : '',
          text: truncateBytes(typeof value.text === 'string' ? value.text : '', 700),
        }
      })
      .filter((item) => item.id !== '' && item.text.trim() !== '')
      .slice(0, 16)
    if (list.length === 0) return { formulas: [], model: '', cached: false }
    const route = this.resolveFor('chat', ref)
    const system = [
      'You convert one noisy PDF text fragment of a display equation into clean LaTeX.',
      'Input JSON: {"text": string}.',
      'Return STRICT JSON only: {"latex": "<latex>"} for equations, or {"latex": ""} when the text is prose or not an equation.',
      'Rules: reconstruct from the fragments, no $ delimiters, use \\frac{}{}, ^{}, _{}, \\sqrt{}, \\sum, \\int, \\le, \\ge, \\approx and Greek commands (\\alpha, \\sigma, \\theta ...). Keep under 800 characters.',
      'When the text has several lines, they are fragments of ONE equation (numerator, denominator, continuation, equation number); reconstruct the complete relation, normally with \\frac{}{}.',
      'Example input: {"text":"q* = m · B_PCIe / B_Host = 1"}',
      'Example output: {"latex":"q^* = \\frac{m B_{PCIe}}{B_{Host}} = 1"}',
      'No markdown, no explanation.',
    ].join('\n')
    const results = []
    let cachedCount = 0
    let cursor = 0
    const runItem = async (item) => {
      const cacheKey = `formula-item-v2|${sha256(item.text)}`
      const cached = await this.store.getCachedReflow(cacheKey)
      if (cached !== null) {
        cachedCount++
        if (typeof cached.latex === 'string' && cached.latex !== '') results.push({ id: item.id, latex: cached.latex })
        return
      }
      const { text } = await this.chat({
        messages: [{ role: 'user', content: JSON.stringify({ text: item.text }) }],
        system,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: 900,
        temperature: 0,
        signal,
        timeoutMs: 90000,
      })
      const parsed = parseJsonObject(text)
      const latex = String(parsed?.latex ?? '').replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim().slice(0, 800)
      // Never cache an empty reconstruction: an early miss used to poison every later open.
      if (latex !== '') await this.store.setCachedReflow(cacheKey, { latex })
      if (latex !== '') results.push({ id: item.id, latex })
    }
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= list.length) return
        try {
          await runItem(list[index])
        } catch {
          /* one failed formula must not block the others */
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
    const order = new Map(list.map((item, index) => [item.id, index]))
    results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return { formulas: results, model: route.label, cached: cachedCount === list.length }
  }

  /**
   * AI document-structure plan. Windowing is the caller's job (6 pages, 4-page stride, 2-page
   * overlap); this method only labels one window. It returns block groups, never rewritten text,
   * so a bad model answer cannot alter the document contents.
   */
  async planLayout({ title, windows, force = false, ref, signal, onProgress = () => undefined }) {
    const list = Array.isArray(windows) ? windows.slice(0, 250) : []
    if (list.length === 0) return { windows: [], model: '', cachedWindows: 0, totalWindows: 0 }
    const route = this.resolveFor('chat', ref)
    const concurrency = 3
    const results = []
    let cachedWindows = 0
    let cursor = 0
    const system = [
      'You are a document structure engine for a PDF reader.',
      'Input JSON: {"title": string, "pages":[{"n": number, "blocks":[{"id": string, "kind": string, "text": string}]}]}.',
      'Return STRICT JSON only: {"groups": [[blockId, ...]], "captions": [blockId], "demoteCaptions": [blockId], "openTail": [blockId]}.',
      'Rules:',
      '- A group is ONE natural paragraph; list its block ids in reading order, including a paragraph that continues across a page break or around a heading/caption boundary.',
      '- Only paragraph/list blocks may appear in groups. Never put headings, figure blocks, formula blocks or captions in a group.',
      '- captions: ids of blocks that are actual figure/table captions ("Figure 2 ...", "Table 1 ..."), even when long.',
      '- demoteCaptions: ids of blocks that START with "Figure/Table N" but are body prose referencing the figure (for example "Figure 3 reports decode throughput..."). They must stay paragraphs.',
      '- openTail: ids of the last group when its sentence is unfinished at the end of this window; otherwise [].',
      '- Never invent ids, never rewrite text, never merge separate paragraphs. Use only ids present in the input.',
      '- No markdown, no prose, no code fences.',
    ].join('\n')
    const runWindow = async (window) => {
      const windowId = typeof window?.id === 'string' ? window.id : `w${results.length}`
      const pages = (Array.isArray(window?.pages) ? window.pages : []).map((page) => ({
        n: Number(page?.n) || 0,
        blocks: (Array.isArray(page?.blocks) ? page.blocks : [])
          .map((block) => ({
            id: typeof block?.id === 'string' ? block.id : '',
            kind: typeof block?.kind === 'string' ? block.kind : 'paragraph',
            text: truncateBytes(typeof block?.text === 'string' ? block.text : '', 6000),
          }))
          .filter((block) => block.id !== '' && block.text.trim() !== ''),
      })).filter((page) => page.blocks.length > 0)
      if (pages.length === 0) return { id: windowId, groups: [], captions: [], openTail: [], cached: false }
      const signature = sha256(JSON.stringify({ title, pages }))
      const cacheKey = `layout-plan-v5|${route.provider}:${route.model}|${sha256(system)}|${signature}`
      const cached = force === true ? null : await this.store.getCachedReflow(cacheKey)
      if (cached !== null) {
        cachedWindows++
        return { id: windowId, groups: Array.isArray(cached.groups) ? cached.groups : [], captions: Array.isArray(cached.captions) ? cached.captions : [], demoteCaptions: Array.isArray(cached.demoteCaptions) ? cached.demoteCaptions : [], openTail: Array.isArray(cached.openTail) ? cached.openTail : [], cached: true }
      }
      const { text } = await this.chat({
        messages: [{ role: 'user', content: JSON.stringify({ title: typeof title === 'string' ? title : '', pages }) }],
        system,
        reasoningEffort: route.kind === 'dsh' ? 'off' : undefined,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: 2400,
        temperature: 0,
        signal,
        timeoutMs: 120000,
      })
      const parsed = parseJsonObject(text)
      if (parsed === null || !Array.isArray(parsed.groups)) throw modelError('invalid-layout-plan', 'The model did not return a valid paragraph plan')
      const groups = Array.isArray(parsed?.groups)
        ? parsed.groups.filter((group) => Array.isArray(group) && group.every((id) => typeof id === 'string')).slice(0, 80)
        : []
      const captions = Array.isArray(parsed?.captions) ? parsed.captions.filter((id) => typeof id === 'string').slice(0, 80) : []
      const demoteCaptions = Array.isArray(parsed?.demoteCaptions) ? parsed.demoteCaptions.filter((id) => typeof id === 'string').slice(0, 80) : []
      const openTail = Array.isArray(parsed?.openTail) ? parsed.openTail.filter((id) => typeof id === 'string').slice(0, 8) : []
      await this.store.setCachedReflow(cacheKey, { groups, captions, demoteCaptions, openTail })
      return { id: windowId, groups, captions, demoteCaptions, openTail, cached: false }
    }
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= list.length) return
        try {
          results.push(await runWindow(list[index]))
        } catch (error) {
          results.push({ id: typeof list[index]?.id === 'string' ? list[index].id : `w${index}`, groups: [], captions: [], demoteCaptions: [], openTail: [], error: String(error?.message ?? error).slice(0, 160), cached: false })
        }
        onProgress({ done: results.length, total: list.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
    return { windows: results, model: route.label, cachedWindows, totalWindows: list.length }
  }

  /**
   * Vision layout pass: one page image + its text candidates → corrected region bboxes and roles.
   * The model never rewrites text; only the four geometry/role fields are consumed by the client.
   */
  async visionLayout({ title, pages, force = false, ref, signal, onProgress = () => undefined }) {
    const list = Array.isArray(pages) ? pages.slice(0, 32) : []
    if (list.length === 0) return { pages: [], model: '', cachedPages: 0, totalPages: 0 }
    let route = this.resolveFor('vision', ref)
    const attachments = (() => {
      try {
        return this.ctx.get?.('attachments') ?? null
      } catch {
        return null
      }
    })()
    if (route.kind === 'dsh' && attachments === null) throw modelError('vision-unavailable', 'The image attachment service is unavailable')
    const llm = this.llm()
    if (route.kind === 'dsh' && llm === null) throw modelError('vision-unavailable', 'LLM service is unavailable')
    // The active model must advertise image input; never silently send image blocks to a text model.
    try {
      const catalog = route.kind === 'dsh' ? await llm.listModels(route.provider) : []
      const info = (Array.isArray(catalog) ? catalog : []).find((model) => model?.id === route.model)
      if (info !== undefined && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
        const explicit = ref?.model || this.store.getSettings().ai.active.vision?.model
        const automatic = !explicit && catalog.find(model => model.inputModalities?.includes('image'))
        if (!automatic) throw modelError('vision-unsupported', `model ${route.model} does not accept image input`)
        route = { ...route, model: automatic.id, reasoningEffort: undefined, label: `${route.providerName} · ${automatic.id}` }
      }
    } catch (error) {
      if (error instanceof ReaderError) throw error
      /* catalog listing is best effort */
    }
    const results = []
    let cursor = 0
    let cachedPages = 0
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= list.length) return
        const page = list[index]
        try {
          const pageNumber = Number(page?.n) || index + 1
          const raw = typeof page?.imageBase64 === 'string' ? page.imageBase64.replace(/^data:image\/[a-z+]+;base64,/, '') : ''
          if (raw === '') throw modelError('vision-bad-request', `page ${pageNumber} has no image`)
          const candidates = Array.isArray(page?.candidates) ? page.candidates : []
          const signature = sha256(`${raw}|${JSON.stringify(candidates)}`)
          const promptHash = sha256(VISION_LAYOUT_SYSTEM_PROMPT)
          const cacheKey = `vision-layout-v${VISION_LAYOUT_VERSION}|${route.provider}:${route.model}|${promptHash}|${pageNumber}|${signature}`
          const evidence = { imageHash: sha256(raw), promptHash, provider: route.provider, model: route.model, version: VISION_LAYOUT_VERSION }
          let cached = force ? null : await this.store.getCachedReflow(cacheKey)
          if (cached !== null) {
            try { validateVisionPage(cached, { ...page, n: pageNumber }) } catch { cached = null }
          }
          if (cached !== null) {
            cachedPages++
            const suggestion = { n: pageNumber, ...cached, evidence, cached: true }
            results.push(suggestion)
            onProgress({ done: results.length, total: list.length, suggestion })
            continue
          }
          const saved = route.kind === 'dsh' ? await attachments.saveImage({
            data: new Uint8Array(Buffer.from(raw, 'base64')),
            mediaType: 'image/jpeg',
            name: `reader-page-${pageNumber}.jpg`,
          }) : { dataUrl: `data:image/jpeg;base64,${raw}` }
          const userText = buildVisionLayoutInput({
            document: { title: typeof title === 'string' ? title : '', page: pageNumber, pageCount: Number(page?.pageCount) || 0 },
            page: { width: Number(page?.width) || 1, height: Number(page?.height) || 1 },
            candidates,
          })
          let value, repair = null, previousText = '', actualModel = route.label, actualProvider = route.provider
          const usages = []
          for (let attempt = 0; attempt < 2; attempt++) {
            const { text, model: resolvedModel, provider: resolvedProvider, usage } = await this.chat({
              messages: [{ role: 'user', content: repair ? `${userText}\n\nRepair the layout for this attached page. Validation failed: ${repair}. Previous JSON:\n${previousText}\nReturn the COMPLETE corrected layout. Each line must have ONE owner. Preserve all equation terms and keep explanation lines as prose.` : userText }],
              system: VISION_LAYOUT_SYSTEM_PROMPT,
              images: [saved],
              reasoningEffort: route.kind === 'dsh' ? 'off' : undefined,
              ref: { providerId: route.providerId, model: route.model },
              maxTokens: Math.min(32000, Math.max(10000, candidates.length * 40)),
              temperature: 0,
              signal,
              timeoutMs: 150000,
            })
            actualModel = resolvedModel; actualProvider = resolvedProvider ?? route.provider; usages.push(usage)
            try {
              value = validateVisionPage(parseJsonObject(text), { ...page, n: pageNumber })
              break
            } catch (error) {
              if (attempt || error.code !== 'vision-ownership') throw error
              repair = error.message; previousText = text
            }
          }
          value.request = { provider: actualProvider, model: route.model, routeLabel: actualModel, images: usages.length, attempts: usages.length, at: Date.now(), usages }
          await this.store.setCachedReflow(cacheKey, value)
          const suggestion = { n: pageNumber, ...value, evidence, cached: false }
          results.push(suggestion)
          onProgress({ done: results.length, total: list.length, suggestion })
        } catch (error) {
          const suggestion = { n: Number(page?.n) || index + 1, error: String(error?.message ?? error).slice(0, 240), cached: false }
          results.push(suggestion)
          onProgress({ done: results.length, total: list.length, suggestion })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, list.length) }, worker))
    const order = new Map(list.map((page, index) => [Number(page?.n) || index + 1, index]))
    results.sort((a, b) => (order.get(a.n) ?? 0) - (order.get(b.n) ?? 0))
    return { pages: results, model: results.find(page => page.request?.routeLabel)?.request.routeLabel ?? route.label, cachedPages, totalPages: list.length }
  }

  /**
   * AI layout enhancement: decide whether a page is essentially a figure/table page (so the reader
   * can show one clean page image instead of fragmented labels) and reconstruct display equations
   * as LaTeX. Runs only for pages the client flags, one model call per page, cached by payload hash.
   */
  async layoutPages({ title, pages, ref, signal, onProgress = () => undefined }) {
    const list = Array.isArray(pages) ? pages : []
    if (list.length === 0) return { pages: [], model: '', cachedPages: 0, totalPages: 0 }
    const route = this.resolveFor('chat', ref)
    const concurrency = 3
    const results = []
    let cachedPages = 0
    let cursor = 0
    const system = [
      'You are the AI layout engine of a PDF reader. You receive one page of noisy PDF text blocks plus layout statistics.',
      'Input JSON: {"document": string, "page": number, "blocks": [{"id": string, "kind": string, "text": string}], "candidates": [string], "stats": {"figureHint": boolean, "shortRatio": number, "longParagraphs": number, "bodyChars": number, "captions": number, "headings": number}}.',
      'Return STRICT JSON only: {"figurePage": boolean, "formulas": [{"id": "<candidate id>", "latex": "<latex>"}]}.',
      'Rules:',
      '- figurePage=true when the page is essentially one figure, table, chart or diagram rather than running prose. Use figureHint and the statistics (many short labels, captions, almost no long body paragraphs).',
      '- For EVERY candidate that is a mathematical or algorithmic expression, reconstruct clean LaTeX from the fragments (no $ delimiters; use \\frac{}{}, ^{}, _{}, \\sum, \\int, Greek commands). Candidates that look like equations must not be omitted.',
      '- Only omit a candidate when it is clearly ordinary prose. Every id must be a candidate. Never invent missing content. Keep each latex under 600 characters.',
      '- No prose, no markdown fences.',
    ].join('\n')
    const runPage = async (page) => {
      const pageNumber = Number(page?.n) || 0
      const rawBlocks = Array.isArray(page?.blocks) ? page.blocks : []
      const blocks = rawBlocks
        .map((block) => {
          const value = plainObject(block)
          return {
            id: typeof value.id === 'string' ? value.id : '',
            kind: typeof value.kind === 'string' ? value.kind : 'paragraph',
            text: truncateBytes(typeof value.text === 'string' ? value.text : '', 260),
          }
        })
        .filter((block) => block.id !== '')
      const ids = new Set(blocks.map((block) => block.id))
      const candidates = (Array.isArray(page?.candidates) ? page.candidates : []).filter((id) => typeof id === 'string' && ids.has(id)).slice(0, 8)
      if (blocks.length === 0) return { n: pageNumber, figurePage: false, formulas: [], cached: false }
      const signature = sha256(JSON.stringify({ blocks, candidates }))
      const cacheKey = `layout-v2|${signature}`
      const cached = await this.store.getCachedReflow(cacheKey)
      if (cached !== null) {
        cachedPages++
        return { n: pageNumber, figurePage: cached.figurePage === true, formulas: Array.isArray(cached.formulas) ? cached.formulas : [], cached: true }
      }
      const user = JSON.stringify({
        document: String(title ?? '').slice(0, 200),
        page: pageNumber,
        blocks,
        candidates,
        stats: plainObject(page?.stats),
      })
      const { text } = await this.chat({
        messages: [{ role: 'user', content: user }],
        system,
        ref: { providerId: route.providerId, model: route.model },
        maxTokens: 1400,
        temperature: 0,
        signal,
        timeoutMs: 120000,
      })
      const parsed = parseJsonObject(text)
      const formulas = []
      if (parsed !== null) {
        for (const entry of Array.isArray(parsed.formulas) ? parsed.formulas : []) {
          const value = plainObject(entry)
          const id = typeof value.id === 'string' ? value.id : ''
          if (!candidates.includes(id)) continue
          const latex = String(value.latex ?? '').replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim()
          if (latex === '' || latex.length > 800) continue
          formulas.push({ id, latex })
          if (formulas.length >= 8) break
        }
      }
      const figurePage = parsed !== null && parsed.figurePage === true
      await this.store.setCachedReflow(cacheKey, { figurePage, formulas })
      return { n: pageNumber, figurePage, formulas, cached: false }
    }
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= list.length) return
        const result = await runPage(list[index])
        results.push(result)
        onProgress({ done: results.length, total: list.length, page: result.n, result })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
    results.sort((a, b) => a.n - b.n)
    return { pages: results, model: route.label, cachedPages, totalPages: list.length }
  }

  /**
   * Summarize / extract key points, streaming through `onDelta`.
   * @returns {Promise<string>} the complete generated text
   */
  async summarize({ text, title, scope = 'doc', ref, signal, onDelta }) {
    const bounded = truncateBytes(typeof text === 'string' ? text : '', 240000)
    if (bounded.trim() === '') throw modelError('bad-request', 'no text to summarize')
    const system = [
      'You are an expert reading assistant.',
      'Produce a compact, well-structured Markdown study note for the reading passage.',
      'Use these sections: ## 摘要 (3-5 sentences), ## 核心论点 (bulleted), ## 关键概念 (term — one-line explanation bullets), ## 值得追问 (2-3 questions).',
      'Write in the same language as the passage. Be specific and faithful; never invent facts.',
    ].join('\n')
    const user = `Document: ${title ?? 'Untitled'}\nScope: ${scope}\n\n---\n${bounded}\n---`
    const result = await this.chat({ messages: [{ role: 'user', content: user }], system, ref, maxTokens: 4096, temperature: 0.3, signal, onDelta, timeoutMs: 240000 })
    return result.text
  }

  /** Fetch the model list from a custom OpenAI-compatible endpoint (settings convenience). */
  async listCustomModels({ baseURL, apiKey }) {
    const url = String(baseURL ?? '').replace(/\/+$/, '')
    if (url === '') throw modelError('bad-request', 'base URL is required')
    const headers = { accept: 'application/json' }
    if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    timer.unref?.()
    try {
      const response = await fetch(`${url}/models`, { headers, signal: controller.signal })
      if (!response.ok) throw modelError('model-http-error', `endpoint returned HTTP ${response.status}`)
      const payload = await response.json()
      const models = Array.isArray(payload?.data)
        ? payload.data
            .map((item) => (typeof item?.id === 'string' ? item.id : ''))
            .filter((id) => id !== '')
            .slice(0, 100)
        : []
      return models
    } finally {
      clearTimeout(timer)
    }
  }
}
