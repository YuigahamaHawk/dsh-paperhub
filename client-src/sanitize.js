// Allowlist sanitizer for EPUB inline markup.
//
// Two jobs:
//  - `escapeText(value)` turns arbitrary text into safe HTML text/attribute content.
//  - `sanitizeInlineHtml(html)` parses a fragment and re-serializes it with only an inline
//    allowlist plus a small set of safe attributes. Unknown block tags are unwrapped to their
//    children (their text survives), dangerous tags (script/style/iframe/...) are dropped with
//    their content. Parse failure degrades to escaped text instead of raw HTML.
//
// No dependencies: this is browser code (uses <template>/DOMParser), and it never executes the
// markup it inspects.

/** Tags kept as-is when they survive sanitizing. `img` and `br` are void elements. */
import {sanitizeMathElement} from '../shared/mathml.js'
const ALLOWED_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'span', 'sub', 'sup', 'br', 'img'])

/** Tags whose *content* is also discarded (safe to remove entirely). */
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'meta', 'link', 'base',
  'head', 'title', 'noscript', 'template', 'svg', 'math', 'canvas', 'video', 'audio', 'source',
  'track', 'map', 'area', 'dialog', 'slot', 'portal',
])

/** Class tokens kept on allowed elements (reader decoration hooks only). */
const INLINE_CLASS = /^dr-inline-[A-Za-z0-9_-]{1,64}$/
/** Safe anchors: absolute http(s), mailto and same-reader fragments. */
const SAFE_HREF = /^(?:https?:|mailto:|#)/i
/** Schemes that must never be reachable from cached document content. */
const UNSAFE_SCHEME = /^(?:javascript|vbscript|data|file|blob):/i
/** Inline images must already be embedded data URLs (http:/relative src never survives). */
const SAFE_IMAGE_SRC = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,[A-Za-z0-9+/=]+$/i

const MAX_INPUT_CHARS = 4_000_000
const MAX_OUTPUT_CHARS = 4_000_000
const MAX_DEPTH = 80

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for safe interpolation into an HTML document or attribute value. */
export function escapeText(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])
}

/** Resolve an element's local name without namespace prefix (`xhtml:p` -> `p`). */
function localNameOf(element) {
  const raw = element.localName || element.nodeName || ''
  const name = String(raw).toLowerCase()
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

/** Serialize an element's safe attributes; returns null for images with an unacceptable src. */
function safeAttributes(element, tag, state) {
  const parts = []
  const title = element.getAttribute('title')
  if (title !== null && title !== '') parts.push(`title="${escapeText(title)}"`)

  if (tag === 'a') {
    const href = (element.getAttribute('href') ?? '').trim()
    if (href !== '') {
      if (SAFE_HREF.test(href) && !UNSAFE_SCHEME.test(href)) {
        parts.push(`href="${escapeText(href)}"`)
        if (/^https?:/i.test(href)) parts.push('target="_blank"', 'rel="noopener noreferrer"')
      } else if (!UNSAFE_SCHEME.test(href)) {
        // Cache-safe: relative links cannot be resolved from stored content.json, and must
        // never navigate the app away. Degrade them to an inert fragment.
        parts.push('href="#"')
      }
    }
  } else if (tag === 'img') {
    const alt = element.getAttribute('alt')
    if (alt !== null) parts.push(`alt="${escapeText(alt)}"`)
    const src = (element.getAttribute('src') ?? '').replace(/\s+/g, '')
    if (!SAFE_IMAGE_SRC.test(src)) return null
    parts.push(`src="${escapeText(src)}"`)
    if (state !== null && state !== undefined) state.images++
  }

  const className = element.getAttribute('class')
  if (className) {
    const kept = []
    for (const token of className.split(/\s+/)) {
      if (token !== '' && INLINE_CLASS.test(token) && kept.indexOf(token) < 0) kept.push(token)
    }
    if (kept.length > 0) parts.push(`class="${escapeText(kept.join(' '))}"`)
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** Append a string to the accumulator, enforcing the output cap. */
function emit(state, text) {
  if (text === '' || state.truncated) return
  if (state.size + text.length > MAX_OUTPUT_CHARS) {
    state.parts.push(text.slice(0, Math.max(0, MAX_OUTPUT_CHARS - state.size)))
    state.size = MAX_OUTPUT_CHARS
    state.truncated = true
    return
  }
  state.parts.push(text)
  state.size += text.length
}

/** Serialize one node into the accumulator. */
function appendNode(state, node, depth) {
  if (state.truncated || node === null || node === undefined) return
  const type = node.nodeType
  if (type === 3 || type === 4) {
    emit(state, escapeText(node.nodeValue ?? ''))
    return
  }
  if (type !== 1) return // comments, processing instructions, doctypes
  const tag = localNameOf(node)
  if(tag==='math'){emit(state,sanitizeMathElement(node).html);return}
  if (tag === '' || DROP_TAGS.has(tag)) return
  if (!ALLOWED_TAGS.has(tag)) {
    appendChildren(state, node, depth + 1) // unwrap unknown/block tags to their content
    return
  }
  if (tag === 'br') {
    emit(state, '<br>')
    return
  }
  const attrs = safeAttributes(node, tag, state)
  if (tag === 'img') {
    if (attrs !== null) emit(state, `<img${attrs}>`)
    return
  }
  emit(state, `<${tag}${attrs ?? ''}>`)
  appendChildren(state, node, depth + 1)
  emit(state, `</${tag}>`)
}

/** Serialize a node's children. */
function appendChildren(state, node, depth) {
  if (depth > MAX_DEPTH) {
    emit(state, escapeText(node.textContent ?? ''))
    return
  }
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    appendNode(state, child, depth + 1)
    if (state.truncated) return
  }
}

/** Parse an HTML fragment into a detached DOM subtree (never executes scripts). */
function parseFragment(source) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const template = document.createElement('template')
      if (template && 'content' in template) {
        template.innerHTML = source
        return template.content
      }
    } catch {
      /* fall through to DOMParser */
    }
  }
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(source, 'text/html')
      return doc?.body ?? null
    } catch {
      return null
    }
  }
  return null
}

/** Last-resort text extraction when no DOM is available or parsing throws. */
function fallbackText(source) {
  return escapeText(String(source).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '))
}

/**
 * Sanitize an inline HTML fragment: allowlist-based, strips scripts/handlers, keeps a/b/strong/
 * i/em/u/s/code/span/sub/sup/br/img with only href/src/alt/title and `dr-inline-*` classes.
 * Unknown tags are unwrapped; `javascript:`/relative links degrade to `#` or are dropped; images
 * survive only as `data:image/...` URLs. Returns escaped text on parse failure.
 */
export function sanitizeInlineHtml(html) {
  if (html === null || html === undefined) return ''
  const source = String(html)
  if (source === '') return ''
  const bounded = source.length > MAX_INPUT_CHARS ? source.slice(0, MAX_INPUT_CHARS) : source
  if (bounded.indexOf('<') < 0) return escapeText(bounded) // fast path: plain text
  let root
  try {
    root = parseFragment(bounded)
  } catch {
    return fallbackText(bounded)
  }
  if (root === null || root === undefined) return fallbackText(bounded)
  const state = { parts: [], size: 0, truncated: false, images: 0 }
  try {
    appendChildren(state, root, 0)
  } catch {
    return fallbackText(bounded)
  }
  return state.parts.join('')
}
