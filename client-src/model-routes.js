import { DEEPSEEK_ACCOUNT_PROVIDER, DEEPSEEK_ACCOUNT_ROUTE } from '../shared/model-ref.js'
import { LIBRETRANSLATE, MYMEMORY } from '../shared/translation-engines.js'

export function decodeRoute(value) {
  const separator = value.indexOf('|')
  if (separator < 0) return { providerId: 'dsh', model: '' }
  return { providerId: value.slice(0, separator) || 'dsh', model: value.slice(separator + 1) }
}

export function encodeRoute(ref) {
  return `${ref?.providerId || 'dsh'}|${ref?.model || ''}`
}

/** Build model choices, using DSH's advertised image support for visual layout. */
export function modelRouteOptions(t, dsh, providers = [], { forVision = false, forTranslation = false } = {}) {
  const label = t('settings.model.default', 'DSH current model')
  const providerName = dsh?.providerName || dsh?.provider || 'DSH'
  const options = new Map([['dsh|', { label: dsh?.model ? `${label} · ${providerName} · ${dsh.model}` : label }]])
  const addModels = (catalog, providerId, name) => {
    for (const model of catalog ?? []) {
      if (!model.id || (forVision && !model.inputModalities?.includes('image'))) continue
      options.set(encodeRoute({ providerId, model: model.id }), { label: `${name} · ${model.name || model.id}` })
    }
  }
  addModels(dsh?.accountCatalog, DEEPSEEK_ACCOUNT_ROUTE, t('settings.model.deepseekAccount', 'DeepSeek Account'))
  if (forTranslation) {
    options.set(encodeRoute({ providerId: MYMEMORY }), { label: t('translation.mymemory.label', 'MyMemory · free quota') })
    options.set(encodeRoute({ providerId: LIBRETRANSLATE }), { label: t('translation.libre.label', 'LibreTranslate · self-hosted') })
  }
  if (dsh?.provider !== DEEPSEEK_ACCOUNT_PROVIDER || !dsh?.accountCatalog) {
    addModels(dsh?.catalog, 'dsh', providerName)
  }
  for (const provider of providers) {
    const models = provider.models?.length ? provider.models : ['']
    for (const model of models) {
      options.set(encodeRoute({ providerId: provider.id, model }), {
        label: model ? `${provider.name || provider.id} · ${model}` : provider.name || provider.id,
      })
    }
  }
  return Array.from(options, ([value, option]) => ({ value, ...option }))
}

export function withCurrentRoute(options, value) {
  if (options.some(option => option.value === value)) return options
  const ref = decodeRoute(value)
  const provider = options.find(option => decodeRoute(option.value).providerId === ref.providerId)
  const providerName = ref.providerId === DEEPSEEK_ACCOUNT_ROUTE ? 'DeepSeek' : ref.providerId === 'dsh' ? 'DSH' : ref.providerId
  const label = ref.model ? `${providerName} · ${ref.model}` : provider?.label ?? providerName
  return [...options, { value, label }]
}

/** Custom providers do not advertise modalities. Use images for their configured vision model. */
export function canAskWithImage(ref, vision, dsh, providers = []) {
  const providerId = ref?.providerId || 'dsh'
  if (providerId === DEEPSEEK_ACCOUNT_ROUTE) {
    return dsh?.accountCatalog?.some(item => item.id === ref.model && item.inputModalities?.includes('image')) === true
  }
  if (providerId === 'dsh') {
    const model = ref?.model || dsh?.model
    return dsh?.catalog?.some(item => item.id === model && item.inputModalities?.includes('image')) === true
  }
  if (providerId !== vision?.providerId) return false
  const fallback = providers.find(provider => provider.id === providerId)?.models?.[0]
  return Boolean(ref.model || fallback) && (ref.model || fallback) === (vision.model || fallback)
}
