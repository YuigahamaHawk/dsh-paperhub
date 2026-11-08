// Small shared helpers for the reader host half.
import { createHash, randomUUID } from 'node:crypto'

/** Read a plain object or return an empty one. */
export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** True for non-null, non-array objects. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge plain objects; arrays and scalars in `patch` replace the base value. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

/** Clamp a numeric value into [min, max], falling back when it is not finite. */
export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Pick only the listed string fields from a value. */
export function pickStrings(value, keys) {
  const out = {}
  const src = plainObject(value)
  for (const key of keys) if (typeof src[key] === 'string') out[key] = src[key]
  return out
}

/** Browser-safe unique id. */
export function newId(size = 16) {
  try {
    return randomUUID().replace(/-/g, '').slice(0, size)
  } catch {
    return Math.random().toString(36).slice(2, 2 + size)
  }
}

/** Unix milliseconds. */
export function nowMs() {
  return Date.now()
}

/** SHA-256 hex digest. */
export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Byte length of a UTF-8 string. */
export function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

/** Truncate text to a maximum number of UTF-8 bytes without splitting a code point. */
export function truncateBytes(text, maxBytes) {
  const source = String(text)
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source
  let out = ''
  let used = 0
  for (const char of source) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** JSON response helper. */
export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** RPC success envelope. */
export function ok(value) {
  return jsonResponse({ ok: true, value })
}

/** RPC failure envelope (HTTP 200 so the client sees the reason, not a network error). */
export function fail(code, message) {
  return jsonResponse({ ok: false, error: { code: String(code), message: String(message) } })
}

/** An error carrying a stable code for the RPC envelope. */
export class ReaderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReaderError'
    this.code = code
  }
}

/** Parse a JSON request body with a byte cap. */
export async function readJson(request, maxBytes = 64 * 1024 * 1024) {
  const buf = await readBytes(request, maxBytes)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(Buffer.from(buf).toString('utf8'))
  } catch (error) {
    throw new ReaderError('bad-json', `request body is not valid JSON: ${error.message}`)
  }
}

/** Read the full request body as a Uint8Array with a byte cap. */
export async function readBytes(request, maxBytes = 300 * 1024 * 1024) {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ReaderError('too-large', `request body exceeds ${maxBytes} bytes`)
  }
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ReaderError('too-large', `request body exceeds ${maxBytes} bytes`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Create a Server-Sent-Events Response from an async producer.
 * The producer receives an `emit(event, data)` callback and the consumer's cancellation signal.
 */
export function eventStream(producer) {
  const encoder = new TextEncoder()
  const abort = new AbortController()
  let closed = false
  let timer
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event, data) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }
      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed by the carrier */
        }
      }
      Promise.resolve()
        .then(() => producer(emit, abort.signal))
        .then(close, (error) => {
          emit('error', { type: 'error', code: error?.code ?? 'internal', message: error?.message ?? String(error), ...(error?.readerUsage ? { usage: error.readerUsage } : {}) })
          close()
        })
        .finally(() => clearInterval(timer))
      timer = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          closed = true
        }
      }, 15000)
      timer.unref?.()
    },
    cancel() {
      closed = true
      clearInterval(timer)
      abort.abort()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

/** Content type by file extension (reader-specific set). */
export function contentTypeFor(filename) {
  const ext = String(filename).toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'txt':
    case 'md':
      return 'text/plain; charset=utf-8'
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8'
    case 'map':
      return 'application/json; charset=utf-8'
    case 'ttf':
      return 'font/ttf'
    case 'otf':
      return 'font/otf'
    case 'woff2':
      return 'font/woff2'
    case 'bcmap':
    case 'pfb':
    case 'wasm':
      return 'application/octet-stream'
    default:
      return 'application/octet-stream'
  }
}

/** Sleep with an abort signal. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
