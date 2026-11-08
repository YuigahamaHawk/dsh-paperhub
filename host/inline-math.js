import { INLINE_MATH_VERSION, paragraphSourceRects, validateInlineMath } from '../shared/inline-math.js'
import { INLINE_MATH_PROMPT } from './inline-math-prompt.js'
import { ReaderError, sha256 } from './util.js'

function parse(text) {
  const source = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  try { return JSON.parse(source) } catch { throw new Error('Return one complete valid JSON object') }
}

export async function refineInlineParagraph(gateway, { docId, blockId, source, images, force = false, ref, signal }) {
  const { store, ctx } = gateway
  const check = () => { if (signal?.aborted) throw new ReaderError('aborted', 'Inline formula recognition cancelled') }
  check()
  const content = await store.getContent(docId)
  const block = content?.pages?.flatMap(p => p.blocks ?? []).find(b => b.id === blockId)
  if (!block || block.text !== source || !source?.trim() || source.length > 12000) throw new ReaderError('inline-source', 'Paragraph changed or has no supported PDF source; reopen it and retry')
  const rects = paragraphSourceRects(content, block)
  if (!rects.length || rects.length > 4 || !Array.isArray(images) || images.length !== rects.length) throw new ReaderError('inline-image', 'The paragraph needs 1–4 original page crops')
  let route = gateway.resolveFor('vision', ref)
  if (route.kind === 'dsh') {
    const catalog = await gateway.llm().listModels(route.provider)
    const info = catalog.find(m => m.id === route.model)
    if (info?.inputModalities && !info.inputModalities.includes('image')) {
      const explicit = ref?.model || store.getSettings().ai.active.vision?.model
      const automatic = !explicit && catalog.find(m => m.inputModalities?.includes('image'))
      if (!automatic) throw new ReaderError('vision-unsupported', `model ${route.model} does not accept image input`)
      route = { ...route, model: automatic.id, label: `${route.providerName} · ${automatic.id}` }
    }
  }
  const raws = images.map((image, index) => {
    if (image.page !== rects[index].page || JSON.stringify(image.rect) !== JSON.stringify(rects[index].rect)) throw new ReaderError('inline-image', 'Paragraph image location does not match its source')
    const raw = String(image.imageBase64 ?? '').replace(/^data:image\/jpeg;base64,/, '')
    if (!raw || raw.length > 6 * 1024 * 1024) throw new ReaderError('inline-image', 'Invalid paragraph image')
    return raw
  })
  const signature = sha256(JSON.stringify({ source, images: raws.map(sha256), rects }))
  const key = `inline-math-v${INLINE_MATH_VERSION}|${route.providerId}:${route.provider}:${route.model}|${sha256(INLINE_MATH_PROMPT)}|${signature}`
  const cached = force ? null : await store.getCachedReflow(key)
  if (cached) {
    let valid
    try { valid = validateInlineMath(cached, source) } catch { /* invalid cache is not a successful recognition */ }
    if (valid) {
      check()
      const record = { ...cached, ...valid, enabled: true }
      await store.setInlineMath(docId, blockId, record)
      return { record, cached: true }
    }
  }
  const attachments = ctx.get?.('attachments')
  if (route.kind === 'dsh' && !attachments) throw new ReaderError('vision-unavailable', 'The image attachment service is unavailable')
  const saved = []
  for (const [index, raw] of raws.entries()) saved.push(route.kind === 'dsh'
    ? await attachments.saveImage({ data: new Uint8Array(Buffer.from(raw, 'base64')), mediaType: 'image/jpeg', name: `paragraph-${rects[index].page}.jpg` })
    : { dataUrl: `data:image/jpeg;base64,${raw}` })
  const started = Date.now(), usages = []
  const receipt = () => ({ provider: actualProvider, model: route.model, routeLabel: actualModel,
    images: saved.length * usages.length, attempts: usages.length, usages, ms: Date.now() - started, at: Date.now() })
  const input = JSON.stringify({ source, pages: rects.map(r => r.page) })
  let record, repair = '', previous = '', actualModel = route.label, actualProvider = route.provider
  for (let attempt = 0; attempt < 2; attempt++) {
    check()
    const result = await gateway.chat({
      system: INLINE_MATH_PROMPT,
      messages: [{ role: 'user', content: repair ? `${input}\nValidation failed: ${repair}\nPrevious response: ${previous}\nReturn the COMPLETE corrected formulas array. Copy exact formula source/context from the extracted paragraph; never include prose abbreviations as mathematics.` : input }],
      images: saved, ref: { providerId: route.providerId, model: route.model },
      reasoningEffort: route.kind === 'dsh' ? 'off' : undefined,
      maxTokens: Math.min(12000, Math.max(4096, source.length * 3)), temperature: 0, signal, timeoutMs: 120000,
    })
    usages.push(result.usage); actualModel = result.model; actualProvider = result.provider ?? route.provider
    try { record = validateInlineMath(parse(result.text), source); break }
    catch (error) {
      if (attempt) { const failure = new ReaderError('inline-invalid', error.message); failure.readerUsage = receipt(); throw failure }
      repair = error.message; previous = result.text
    }
  }
  check()
  const latest = await store.getContent(docId)
  if (latest?.pages?.flatMap(p => p.blocks ?? []).find(b => b.id === blockId)?.text !== source) throw new ReaderError('inline-source', 'Paragraph changed during recognition; result was not applied')
  record = { ...record, enabled: true, signature, request: receipt() }
  await store.setCachedReflow(key, record)
  check()
  await store.setInlineMath(docId, blockId, record)
  return { record, cached: false }
}
