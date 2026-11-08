import { ReaderError, byteLength } from './util.js'
import { translationIssue } from '../shared/translation-contract.js'
import { MYMEMORY } from '../shared/translation-engines.js'

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get'
const MYMEMORY_LIMIT = 500
const MYMEMORY_QUOTA = /used all available free translations|(?:quota|daily limit).{0,30}(?:exceeded|reached|exhausted)/i
const LIBRE_LANGUAGE_ALIASES = { 'zh-CN': ['zh-hans', 'zh', 'zh-cn'], 'zh-TW': ['zh-hant', 'zt', 'zh-tw'] }

// The gateway already splits paragraphs at natural boundaries. This second limit
// is measured in UTF-8 bytes, so multibyte text needs a Unicode-safe split.
function limitBytes(text) {
  const chunks = []
  while (byteLength(text) > MYMEMORY_LIMIT) {
    let end = 0, bytes = 0, boundary = 0
    for (const character of text) {
      bytes += byteLength(character)
      if (bytes > MYMEMORY_LIMIT) break
      end += character.length
      if (/\s/u.test(character)) boundary = end
    }
    const cut = boundary > end / 2 ? boundary : end
    chunks.push(text.slice(0, cut))
    text = text.slice(cut)
  }
  return [...chunks, text]
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
    if (!value.startsWith('#')) return named[value.toLowerCase()]
    const hex = /^#x/i.test(value)
    const code = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity
  })
}

async function requestJson(url, options, route, signal) {
  const timeout = AbortSignal.timeout(30000)
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (response.status === 429) {
      throw new ReaderError('translation-rate-limit', route.label + ' has reached its request or character limit. Try again later.')
    }
    if (!response.ok) {
      const hint = route.providerId === MYMEMORY ? '' :
        response.status === 400 ? ' Check that the server supports the selected language.' :
        response.status === 403 || response.status === 401 ? ' Check the API key.' : ''
      throw new ReaderError('translation-http', route.label + ' returned HTTP ' + response.status + '.' + hint)
    }
    return await response.json()
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof ReaderError) throw error
    if (timeout.aborted) throw new ReaderError('translation-timeout', route.label + ' did not respond in time.')
    throw new ReaderError('translation-network', 'Could not read a response from ' + route.label + '. Check the connection and server address.')
  }
}

export class MachineTranslator {
  #myMemoryQueue = Promise.resolve()
  #myMemoryResumeAt = 0
  #libreCatalog = null

  async myMemory(text, route, target, signal) {
    const task = this.#myMemoryQueue.then(async () => {
      signal?.throwIfAborted()
      if (Date.now() < this.#myMemoryResumeAt) throw new ReaderError('translation-rate-limit', 'MyMemory has reached its free limit. Try again later or select another translation engine.')
      const url = new URL(MYMEMORY_URL)
      url.search = new URLSearchParams({ q: text, langpair: route.scope + '|' + target }).toString()
      try {
        const response = await requestJson(url, {}, route, signal)
        const value = response?.responseData?.translatedText
        if (Number(response?.responseStatus) === 429 || MYMEMORY_QUOTA.test(String(value ?? '') + ' ' + String(response?.responseDetails ?? ''))) {
          throw new ReaderError('translation-rate-limit', 'MyMemory has reached its free limit. Try again later or select another translation engine.')
        }
        if (Number(response?.responseStatus) !== 200 || typeof value !== 'string' || !value.trim()) {
          throw new ReaderError('translation-response', 'MyMemory could not translate this text. Check the selected source and target languages.')
        }
        return decodeEntities(value)
      } catch (error) {
        if (error?.code === 'translation-rate-limit') this.#myMemoryResumeAt = Date.now() + 60000
        throw error
      }
    })
    this.#myMemoryQueue = task.catch(() => undefined)
    return task
  }

  async libreTarget(lang, route, signal) {
    const aliases = LIBRE_LANGUAGE_ALIASES[lang]
    if (!aliases) return lang
    let catalog = this.#libreCatalog
    if (catalog?.url !== route.scope || catalog.expires <= Date.now()) {
      const languages = await requestJson(route.scope + '/languages', { method: 'GET' }, route, signal)
      if (!Array.isArray(languages)) throw new ReaderError('translation-response', 'LibreTranslate returned an invalid language list.')
      catalog = {
        url: route.scope,
        expires: Date.now() + 300000,
        codes: new Map(languages.filter(item => typeof item?.code === 'string').map(item => [item.code.toLowerCase(), item.code])),
      }
      this.#libreCatalog = catalog
    }
    for (const alias of aliases) {
      const supported = catalog.codes.get(alias)
      if (supported) return supported
    }
    throw new ReaderError('translation-language', 'LibreTranslate does not have a language package for ' + lang + '.')
  }

  async libreTranslate(texts, route, lang, signal) {
    const target = await this.libreTarget(lang, route, signal)
    const body = { q: texts, source: 'auto', target, format: 'text' }
    if (route.apiKey) body.api_key = route.apiKey
    const result = await requestJson(route.scope + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, route, signal)
    if (!Array.isArray(result?.translatedText) || result.translatedText.length !== texts.length) {
      throw new ReaderError('translation-response', 'LibreTranslate returned a different number of translations than requested.')
    }
    return result.translatedText
  }

  async translate({ batch, lang, route, signal }) {
    const myMemory = route.providerId === MYMEMORY
    if (myMemory && route.scope.toLowerCase() === lang.toLowerCase()) return batch.map(item => item.text)
    const inputs = []
    // Keep formula objects and whitespace in the client/host. Split only prose, so
    // translation engines cannot rewrite TeX or swallow immutable placeholders.
    const units = batch.map(({ text }) => text.split(/(⟦DSHMATH_[A-Z]+⟧)/g).flatMap((span, index) => {
      if (index % 2) return [span]
      return (myMemory ? limitBytes(span) : [span]).map(part => {
        const body = part.trim()
        if (!/\p{L}/u.test(body)) return part
        const start = part.indexOf(body)
        const input = { body, leading: part.slice(0, start), trailing: part.slice(start + body.length) }
        inputs.push(input)
        return input
      })
    }))

    for (let start = 0; start < inputs.length; start += myMemory ? 1 : 12) {
      signal?.throwIfAborted()
      const group = inputs.slice(start, start + (myMemory ? 1 : 12))
      try {
        const values = myMemory
          ? [await this.myMemory(group[0].body, route, lang, signal)]
          : await this.libreTranslate(group.map(input => input.body), route, lang, signal)
        group.forEach((input, index) => {
          const value = values[index]
          input.result = typeof value === 'string' && value.trim()
            ? input.leading + value.trim() + input.trailing
            : { code: 'translate-empty', error: route.label + ' returned an empty translation.' }
        })
      } catch (error) {
        if (signal?.aborted) throw error
        for (const input of group) input.result = { code: error.code ?? 'translate-failed', error: error.message }
      }
    }
    return units.map((parts, index) => {
      const values = parts.map(part => typeof part === 'string' ? part : part.result)
      const failed = values.find(value => typeof value !== 'string')
      if (failed) return failed
      const value = values.join('')
      const issue = translationIssue(batch[index].text, value, lang)
      return issue ? { code: 'translate-incomplete', error: issue } : value
    })
  }
}
