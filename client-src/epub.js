// EPUB engine: pure-browser EPUB 2/3 parser.
//
// `extractEpub(arrayBuffer, { onProgress })` -> { meta, toc, blocks, thumbDataUrl? }
//
// No dependencies: a small ZIP reader (stored + raw-deflate via DecompressionStream) feeds an
// OPF/container/spine reader; each spine XHTML document is parsed with DOMParser, its images are
// inlined as small JPEG data URLs, and its body is flattened into reading Blocks. All inline
// markup that survives is sanitized by ./sanitize.js before it touches content.json.
//
// The output shape matches DESIGN.md `EpubContent` (app.jsx wraps `kind`/`version` itself).
// Failures surface as `Error('无法解析 EPUB：…')` so the library UI can show a clear message.

import { escapeText, sanitizeInlineHtml } from './sanitize.js'
import {sanitizeMathElement} from '../shared/mathml.js'
import {crc} from '../shared/zip-writer.js'

// -------------------------------------------------------------------------------------------------
// Limits (pathological / decompression-bomb guards)
// -------------------------------------------------------------------------------------------------

const MAX_ENTRIES = 20000
const MAX_TOTAL_DECLARED = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 48 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024
const MAX_SPINE_DOCUMENTS = 3000
const MAX_BLOCKS = 60000
const MAX_TOC_ENTRIES = 2000
const MAX_INLINE_ANCHORS = 64

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_WIDTH = 900
const IMAGE_QUALITY = 0.82
const IMAGE_BUDGET = 12 * 1024 * 1024
const MAX_PER_IMAGE_CHARS = 3 * 1024 * 1024
const THUMB_MAX_WIDTH = 420
const THUMB_QUALITY = 0.8
const THUMB_BUDGET = 640 * 1024

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 0))

// -------------------------------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------------------------------

/** Create the one error type this module throws. */
function fail(message) {
  const error = new Error(`无法解析 EPUB：${message}`)
  error.name = 'EpubParseError'
  return error
}

/** Normalize any thrown value into the module's error shape. */
function asEpubError(error) {
  if (error !== null && error !== undefined && error.name === 'EpubParseError') return error
  const message = error !== null && error !== undefined && error.message ? String(error.message) : String(error ?? '未知错误')
  return fail(message)
}

/** Collapse whitespace to single spaces (used for titles/labels/alt text). */
function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate a label, never splitting a surrogate pair. */
function truncateLabel(value, max = 160) {
  const text = normalizeInlineText(value)
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** True for a single CJK-ish character (used to avoid injecting spaces between CJK glyphs). */
function isCjkChar(char) {
  return typeof char === 'string' && char !== '' && CJK_CHAR.test(char)
}

/** Decode a percent-encoded string defensively. */
function safeDecode(value) {
  const raw = String(value ?? '')
  if (raw.indexOf('%') < 0) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Local (namespace-stripped, lower-cased) tag name of an element. */
function tagOf(element) {
  const raw = String(element?.localName || element?.nodeName || '').toLowerCase()
  const colon = raw.indexOf(':')
  return colon >= 0 ? raw.slice(colon + 1) : raw
}

/** All descendant elements of a document/element. */
function allElements(root) {
  try {
    return Array.from(root.getElementsByTagName('*'))
  } catch {
    return []
  }
}

/** All descendants whose local name matches (namespace-prefix tolerant). */
function elementsByLocal(root, name) {
  const out = []
  for (const element of allElements(root)) if (tagOf(element) === name) out.push(element)
  return out
}

/** First descendant (or `root` itself) whose local name matches. */
function firstByLocal(root, name) {
  if (tagOf(root) === name) return root
  for (const element of allElements(root)) if (tagOf(element) === name) return element
  return null
}

/** Direct child elements, optionally filtered by local name. */
function childElements(element, name) {
  const out = []
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType !== 1) continue
    if (name === undefined || tagOf(child) === name) out.push(child)
  }
  return out
}

/** Child nodes as a stable array (DOM mutation-safe). */
function childNodesOf(element) {
  const out = []
  for (let child = element.firstChild; child !== null; child = child.nextSibling) out.push(child)
  return out
}

/** Element id / legacy `<a name>` values, used to map TOC fragments onto blocks. */
function idsOf(element) {
  const out = []
  try {
    const id = element.getAttribute('id')
    if (id !== null && id.trim() !== '' && id.length <= 512) out.push(id.trim())
    if (tagOf(element) === 'a') {
      const name = element.getAttribute('name')
      if (name !== null && name.trim() !== '' && name.length <= 512) out.push(name.trim())
    }
  } catch {
    /* ignore */
  }
  return out
}

/** Normalize a ZIP path: forward slashes, no `.`/`..`/empty segments. */
function normalizePath(path) {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** Directory part of a ZIP path ('' for root). */
function dirnamePath(path) {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** Resolve an href path relative to the file that referenced it. */
function resolvePath(baseFile, hrefPath) {
  const decoded = safeDecode(String(hrefPath ?? '').trim()).replace(/\\/g, '/')
  if (decoded === '') return normalizePath(baseFile)
  if (decoded.startsWith('/')) return normalizePath(decoded)
  const baseDir = dirnamePath(normalizePath(baseFile))
  return normalizePath(baseDir === '' ? decoded : `${baseDir}/${decoded}`)
}

/** Split `path/to/doc.xhtml#frag?x=1` into path and decoded fragment. */
function splitHref(href) {
  const raw = String(href ?? '').trim()
  const hash = raw.indexOf('#')
  let path = hash >= 0 ? raw.slice(0, hash) : raw
  const fragmentRaw = hash >= 0 ? raw.slice(hash + 1) : ''
  const query = path.indexOf('?')
  if (query >= 0) path = path.slice(0, query)
  return { path: path.trim(), fragment: safeDecode(fragmentRaw) }
}

/** True for absolute/remote URLs (never resolved against the ZIP). */
function isExternalHref(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(href ?? '').trim())
}

// -------------------------------------------------------------------------------------------------
// ZIP reader
// -------------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** UTF-8 with a best-effort legacy-name fallback (old Chinese EPUBs are often GBK-named). */
function decodeZipName(bytes, flags) {
  if ((flags & FLAG_UTF8) !== 0) return decodeUtf8(bytes, false)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* not UTF-8 */
  }
  for (const encoding of ['gbk', 'big5']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      /* unsupported or invalid */
    }
  }
  return decodeUtf8(bytes, false)
}

/** Decode bytes as UTF-8, optionally fatal. */
function decodeUtf8(bytes, fatal) {
  return new TextDecoder('utf-8', { fatal }).decode(bytes)
}

/** Decode document bytes using their BOM / XML declaration, falling back to UTF-8. */
function decodeDocumentBytes(bytes) {
  if (bytes.byteLength >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  let start = 0
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
  const utf8 = new TextDecoder('utf-8').decode(bytes.subarray(start))
  const declaration = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(utf8.slice(0, 200))
  if (declaration !== null) {
    const encoding = declaration[1].toLowerCase()
    if (!/^utf-?8$/.test(encoding)) {
      try {
        return new TextDecoder(encoding).decode(bytes.subarray(start))
      } catch {
        /* unsupported encoding, keep UTF-8 */
      }
    }
  }
  return utf8
}

/** Read a 64-bit little-endian integer as a JS number (safe below 2^53). */
function readUint64(view, offset) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 4294967296
}

/** Locate the End Of Central Directory record and read the directory summary (incl. ZIP64). */
function readZipDirectory(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const length = data.byteLength
  if (length < 22) throw fail('文件太小，不是有效的 EPUB')

  let eocd = -1
  let relaxedEocd = -1
  const lowest = Math.max(0, length - 22 - 0xffff)
  for (let position = length - 22; position >= lowest; position--) {
    if (view.getUint32(position, true) !== SIG_EOCD) continue
    const commentLength = view.getUint16(position + 20, true)
    const recordEnd = position + 22 + commentLength
    if (recordEnd === length) {
      eocd = position
      break
    }
    // Tolerate trailing bytes / a ZIP embedded in a larger container, but remember the first
    // candidate so we can still try it if no exact record exists.
    if (recordEnd < length && relaxedEocd < 0) relaxedEocd = position
  }
  if (eocd < 0) eocd = relaxedEocd
  if (eocd < 0) throw fail('未找到 ZIP 目录结构（EOCD），文件可能已损坏')

  let entryCount = view.getUint16(eocd + 10, true)
  let centralOffset = view.getUint32(eocd + 16, true)
  let centralSize = view.getUint32(eocd + 12, true)

  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    // ZIP64: the locator sits in the 20 bytes before the classic EOCD record.
    const locator = eocd - 20
    if (locator >= 0 && view.getUint32(locator, true) === SIG_EOCD64_LOCATOR) {
      const eocd64 = readUint64(view, locator + 8)
      if (eocd64 + 56 <= length && view.getUint32(eocd64, true) === SIG_EOCD64) {
        entryCount = readUint64(view, eocd64 + 32)
        centralSize = readUint64(view, eocd64 + 40)
        centralOffset = readUint64(view, eocd64 + 48)
      }
    }
  }

  if (!Number.isFinite(entryCount) || entryCount < 0 || entryCount > MAX_ENTRIES) {
    throw fail(`EPUB 内文件数量异常（${entryCount} 个）`)
  }
  if (
    !Number.isFinite(centralOffset) ||
    !Number.isFinite(centralSize) ||
    centralOffset < 0 ||
    centralSize < 0 ||
    centralOffset + centralSize > length
  ) {
    throw fail('ZIP 中央目录越界，文件可能已损坏')
  }

  const entries = new Map()
  const byLower = new Map()
  let totalDeclared = 0
  let position = centralOffset

  for (let index = 0; index < entryCount; index++) {
    if (position + 46 > length || view.getUint32(position, true) !== SIG_CENTRAL) {
      throw fail('ZIP 中央目录损坏（条目头无效）')
    }
    const flags = view.getUint16(position + 8, true)
    const method = view.getUint16(position + 10, true)
    let compressedSize = view.getUint32(position + 20, true)
    let uncompressedSize = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    let localOffset = view.getUint32(position + 42, true)
    const nameStart = position + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > length) throw fail('ZIP 中央目录损坏（文件名越界）')
    const extraStart = nameEnd
    const extraEnd = extraStart + extraLength
    if (extraEnd > length) throw fail('ZIP 中央目录损坏（扩展字段越界）')

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readExtraField(view, extraStart, extraEnd, 0x0001)
      if (zip64 !== null) {
        let cursor = 0
        if (uncompressedSize === 0xffffffff && cursor + 8 <= zip64.length) {
          uncompressedSize = readUint64(zip64.data, zip64.start + cursor)
          cursor += 8
        }
        if (compressedSize === 0xffffffff && cursor + 8 <= zip64.length) {
          compressedSize = readUint64(zip64.data, zip64.start + cursor)
          cursor += 8
        }
        if (localOffset === 0xffffffff && cursor + 8 <= zip64.length) {
          localOffset = readUint64(zip64.data, zip64.start + cursor)
        }
      }
    }

    const name = decodeZipName(data.subarray(nameStart, nameEnd), flags)
    totalDeclared += uncompressedSize || 0
    if (totalDeclared > MAX_TOTAL_DECLARED) throw fail('EPUB 解压后体积异常，已停止解析')

    const normalized = normalizePath(name)
    if (normalized !== '' && !name.endsWith('/')) {
      const entry = {
        name: normalized,
        rawName: name,
        crc: view.getUint32(position + 16, true),
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localOffset,
        encrypted: (flags & 0x0001) !== 0,
      }
      if (!entries.has(normalized)) entries.set(normalized, entry)
      const lower = normalized.toLowerCase()
      if (!byLower.has(lower)) byLower.set(lower, entry)
      const nfc = normalized.normalize('NFC')
      if (nfc !== normalized && !entries.has(nfc)) entries.set(nfc, entry)
    }

    position = extraEnd + commentLength
  }

  return { data, view, length, entries, byLower }
}

/** Lazy PDF/EPUB members of a document ZIP, reusing the tested EPUB ZIP reader. */
export function openDocumentArchive(arrayBuffer) {
  try {
    const zip = readZipDirectory(new Uint8Array(arrayBuffer)), seen = new Set(), files = [], skipped = []
    for (const entry of zip.entries.values()) {
      if (seen.has(entry.localOffset)) continue
      seen.add(entry.localOffset)
      const path = String(entry.rawName ?? entry.name).replace(/\\/g,'/')
      if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) throw new Error('ZIP 包含不安全的文件路径')
      if (path.split('/').some(part=>part.startsWith('.') || part==='__MACOSX') || !/\.(pdf|epub)$/i.test(path)) { skipped.push(path); continue }
      files.push({name:path.split('/').pop(),relativePath:path,size:entry.uncompressedSize,
        async arrayBuffer() {
          try {
            const bytes = await readEntryBytes(zip,entry,100*1024*1024)
            if (bytes.byteLength!==entry.uncompressedSize || crc(bytes)!==entry.crc) throw new Error('ZIP 文件校验失败：'+path)
            return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
          } catch (error) { throw new Error(String(error.message).replace(/EPUB/g,'ZIP')) }
        },
      })
    }
    return {files,skipped}
  } catch (error) { throw new Error(String(error.message).replace(/^无法解析 EPUB：/,'无法解析 ZIP：')) }
}

/** Locate an extra-field block by id; returns a DataView-backed slice descriptor. */
function readExtraField(view, start, end, wantedId) {
  let cursor = start
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true)
    const size = view.getUint16(cursor + 2, true)
    const dataStart = cursor + 4
    if (dataStart + size > end) return null
    if (id === wantedId) return { data: view, start: dataStart, length: size }
    cursor = dataStart + size
  }
  return null
}

/** Look up a ZIP entry by path, tolerating case / percent-encoding differences. */
function findEntry(zip, path) {
  const normalized = normalizePath(path)
  if (normalized === '') return null
  let entry = zip.entries.get(normalized)
  if (entry !== undefined) return entry
  entry = zip.byLower.get(normalized.toLowerCase())
  if (entry !== undefined) return entry
  const variants = []
  try {
    variants.push(normalized.split('/').map((part) => encodeURIComponent(part)).join('/'))
  } catch {
    /* ignore */
  }
  try {
    const decoded = decodeURIComponent(normalized)
    if (decoded !== normalized) variants.push(decoded)
  } catch {
    /* ignore */
  }
  for (const variant of variants) {
    entry = zip.entries.get(variant)
    if (entry !== undefined) return entry
    entry = zip.byLower.get(variant.toLowerCase())
    if (entry !== undefined) return entry
  }
  return null
}

/** Decompress a raw-deflate payload with the platform DecompressionStream. */
async function inflateRaw(bytes, maxBytes) {
  if (bytes.byteLength === 0) return new Uint8Array(0)
  let stream
  try {
    stream = new DecompressionStream('deflate-raw')
  } catch {
    try {
      stream = new DecompressionStream('deflate')
    } catch {
      throw fail('当前浏览器不支持解压 EPUB（缺少 DecompressionStream）')
    }
  }
  let sourceStream
  if (typeof Blob !== 'undefined') sourceStream = new Blob([bytes]).stream()
  else if (typeof Response !== 'undefined') sourceStream = new Response(bytes).body
  else throw fail('当前浏览器环境不支持读取 EPUB')
  const reader = sourceStream.pipeThrough(stream).getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw fail('EPUB 条目解压后体积异常')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error !== null && error !== undefined && error.name === 'EpubParseError') throw error
    throw fail(`解压失败：${error !== null && error !== undefined && error.message ? error.message : error}`)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/** Read one ZIP entry's bytes (stored or deflate), enforcing a size cap. */
async function readEntryBytes(zip, entry, maxBytes = MAX_ENTRY_BYTES) {
  if (entry.encrypted) throw fail('EPUB 包含加密文件，暂不支持')
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw fail('EPUB 条目体积异常')
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw fail(`不支持的 ZIP 压缩方法（${entry.method}），请重新打包 EPUB`)
  }
  const localOffset = entry.localOffset
  if (localOffset < 0 || localOffset + 30 > zip.length) throw fail('ZIP 本地文件头越界')
  if (zip.view.getUint32(localOffset, true) !== SIG_LOCAL) throw fail('ZIP 本地文件头损坏')
  const nameLength = zip.view.getUint16(localOffset + 26, true)
  const extraLength = zip.view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataStart < 0 || dataEnd > zip.length) throw fail('ZIP 本地数据越界')
  const payload = zip.data.subarray(dataStart, dataEnd)
  if (entry.method === METHOD_STORED) {
    if (payload.byteLength > maxBytes) throw fail('EPUB 条目体积异常')
    return payload
  }
  return inflateRaw(payload, maxBytes)
}

/** Read and decode one text entry. */
async function readText(zip, path, maxBytes = MAX_DOCUMENT_BYTES) {
  const entry = findEntry(zip, path)
  if (entry === null) return null
  const bytes = await readEntryBytes(zip, entry, maxBytes)
  return decodeDocumentBytes(bytes)
}

// -------------------------------------------------------------------------------------------------
// Markup parsing (XHTML / OPF / NCX)
// -------------------------------------------------------------------------------------------------

/** True when a DOMParser result carries a parser error. */
function hasParserError(document) {
  try {
    if (document === null || document === undefined) return true
    if (document.getElementsByTagName('parsererror').length > 0) return true
    const root = document.documentElement
    return root !== null && root !== undefined && tagOf(root) === 'parsererror'
  } catch {
    return true
  }
}

/**
 * Parse XHTML/XML with DOMParser: strict XML first (EPUB spec), HTML fallback for real-world
 * files that use HTML named entities or unclosed tags. Returns null when both fail.
 */
function parseMarkup(text, { htmlFallback = true } = {}) {
  if (typeof DOMParser === 'undefined') throw fail('当前环境不支持 DOMParser')
  const source = String(text ?? '')
  if (source.trim() === '') return null
  try {
    const xml = new DOMParser().parseFromString(source, 'application/xhtml+xml')
    if (!hasParserError(xml)) return xml
  } catch {
    /* fall through */
  }
  if (htmlFallback) {
    try {
      const html = new DOMParser().parseFromString(source, 'text/html')
      if (!hasParserError(html)) return html
      return html
    } catch {
      /* fall through */
    }
  }
  try {
    const xml = new DOMParser().parseFromString(source, 'text/xml')
    return hasParserError(xml) ? null : xml
  } catch {
    return null
  }
}

/** Parse an OPF/NCX/container XML document, returning null on hard failure. */
function parseXmlDocument(text) {
  return parseMarkup(text, { htmlFallback: true })
}

// -------------------------------------------------------------------------------------------------
// OPF (package document)
// -------------------------------------------------------------------------------------------------

/** Extract readable text of a metadata element. */
function metadataText(element) {
  if (element === null || element === undefined) return ''
  return normalizeInlineText(element.textContent ?? '')
}

/** Parse container.xml -> absolute OPF path inside the ZIP. */
async function readOpfPath(zip) {
  const containerText = await readText(zip, 'META-INF/container.xml', 1024 * 1024)
  if (containerText === null) throw fail('缺少 META-INF/container.xml，不是标准 EPUB')
  const container = parseXmlDocument(containerText)
  if (container === null) throw fail('META-INF/container.xml 解析失败')
  for (const rootfile of elementsByLocal(container, 'rootfile')) {
    const fullPath = rootfile.getAttribute('full-path') ?? rootfile.getAttribute('fullpath') ?? ''
    if (fullPath.trim() !== '') return resolvePath('', safeDecode(fullPath))
  }
  // Broken container: fall back to the first OPF-looking file inside the archive.
  for (const path of zip.entries.keys()) {
    if (/\.opf$/i.test(path)) return path
  }
  throw fail('container.xml 中没有指定 OPF 文件')
}

/** Read one OPF attribute with a fallback. */
function opfAttr(element, name, fallback = '') {
  const value = element.getAttribute(name)
  return value === null || value === undefined ? fallback : value
}

/** Parse the media type of a ZIP path from the manifest or its extension. */
const EXTENSION_MEDIA_TYPES = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ncx': 'application/x-dtbncx+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Extension based media-type fallback. */
function mimeForPath(path, manifestByPath) {
  const lower = String(path ?? '').toLowerCase()
  const manifestItem = manifestByPath?.get(lower)
  if (manifestItem !== undefined && manifestItem.mediaType !== '') return manifestItem.mediaType
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? EXTENSION_MEDIA_TYPES[lower.slice(dot)] ?? '' : ''
}

/** Parse the OPF package document into manifest / spine / metadata / guide. */
function parseOpf(opfText, opfPath) {
  const document = parseXmlDocument(opfText)
  if (document === null) throw fail('OPF 文件解析失败')
  const packageElement = firstByLocal(document, 'package')
  if (packageElement === null) throw fail('OPF 文件缺少 package 元素')

  const metadataElement = firstByLocal(packageElement, 'metadata')
  const metadata = {
    title: '',
    author: '',
    language: '',
    description: '',
    coverId: '',
  }
  if (metadataElement !== null) {
    const titles = elementsByLocal(metadataElement, 'title')
    const creators = elementsByLocal(metadataElement, 'creator')
    const languages = elementsByLocal(metadataElement, 'language')
    const descriptions = elementsByLocal(metadataElement, 'description')
    metadata.title = metadataText(titles[0])
    const authors = []
    for (const creator of creators) {
      const name = metadataText(creator)
      if (name !== '' && authors.indexOf(name) < 0) authors.push(name)
    }
    metadata.author = authors.join(', ')
    metadata.language = metadataText(languages[0])
    const description = descriptions[0] ?? null
    if (description !== null) {
      const raw = String(description.textContent ?? '')
      metadata.description = normalizeInlineText(raw.replace(/<[^>]*>/g, ' ')).slice(0, 2000)
    }
    for (const meta of elementsByLocal(metadataElement, 'meta')) {
      if ((meta.getAttribute('name') ?? '').toLowerCase() === 'cover') {
        const content = (meta.getAttribute('content') ?? '').trim()
        if (content !== '') metadata.coverId = content
        break
      }
    }
  }

  const manifestElement = firstByLocal(packageElement, 'manifest')
  if (manifestElement === null) throw fail('OPF 文件缺少 manifest')
  const manifest = []
  const manifestById = new Map()
  const manifestByPath = new Map()
  for (const item of childElements(manifestElement, 'item')) {
    const id = (opfAttr(item, 'id') ?? '').trim()
    const href = (opfAttr(item, 'href') ?? '').trim()
    if (href === '' || isExternalHref(href)) continue
    const { path: hrefPath } = splitHref(href)
    if (hrefPath === '') continue
    const path = resolvePath(opfPath, hrefPath)
    const manifestItem = {
      id,
      href,
      path,
      mediaType: (opfAttr(item, 'media-type') ?? '').trim().toLowerCase(),
      properties: (opfAttr(item, 'properties') ?? '').trim().toLowerCase(),
    }
    manifest.push(manifestItem)
    if (id !== '' && !manifestById.has(id)) manifestById.set(id, manifestItem)
    const lower = path.toLowerCase()
    if (!manifestByPath.has(lower)) manifestByPath.set(lower, manifestItem)
  }
  if (manifest.length === 0) throw fail('OPF 清单（manifest）为空')

  const spineElement = firstByLocal(packageElement, 'spine')
  if (spineElement === null) throw fail('OPF 文件缺少 spine')
  const spine = []
  for (const itemref of childElements(spineElement, 'itemref')) {
    const idref = (opfAttr(itemref, 'idref') ?? '').trim()
    if (idref === '') continue
    const item = manifestById.get(idref)
    if (item === undefined) continue
    const isMarkup = /xhtml|html/.test(item.mediaType) || /\.x?html?$/i.test(item.path)
    if (!isMarkup) continue
    const linear = (opfAttr(itemref, 'linear', 'yes') ?? 'yes').trim().toLowerCase() !== 'no'
    spine.push({ idref, linear, item })
  }
  if (spine.length === 0) throw fail('未找到可读章节（spine 为空）')
  if (spine.length > MAX_SPINE_DOCUMENTS) throw fail(`章节数量异常（${spine.length} 个）`)

  const guide = []
  const guideElement = firstByLocal(packageElement, 'guide')
  if (guideElement !== null) {
    for (const reference of childElements(guideElement, 'reference')) {
      const href = (opfAttr(reference, 'href') ?? '').trim()
      if (href === '') continue
      const { path: hrefPath } = splitHref(href)
      if (hrefPath === '') continue
      guide.push({
        type: (opfAttr(reference, 'type') ?? '').trim().toLowerCase(),
        title: (opfAttr(reference, 'title') ?? '').trim(),
        path: resolvePath(opfPath, hrefPath),
      })
    }
  }

  return {
    opfPath,
    metadata,
    manifest,
    manifestById,
    manifestByPath,
    spine,
    guide,
    tocId: (opfAttr(spineElement, 'toc') ?? '').trim(),
  }
}

// -------------------------------------------------------------------------------------------------
// Table of contents (EPUB3 nav document / EPUB2 NCX)
// -------------------------------------------------------------------------------------------------

/** Read one nav `<ol>` level. */
function parseNavList(listElement, level, basePath, output, depth) {
  if (depth > 8) return
  for (const item of childElements(listElement, 'li')) {
    const label = childElements(item, 'a')[0] ?? childElements(item, 'span')[0] ?? null
    const title = truncateLabel(label === null ? label : (label.textContent ?? ''), 200)
    const anchor = childElements(item, 'a')[0] ?? null
    const hrefRaw = anchor === null ? '' : (anchor.getAttribute('href') ?? '').trim()
    if (title !== '') {
      if (output.length >= MAX_TOC_ENTRIES) return
      const entry = { title, level, targetPath: '', fragment: '' }
      if (hrefRaw !== '' && !isExternalHref(hrefRaw)) {
        const { path: hrefPath, fragment } = splitHref(hrefRaw)
        if (hrefPath !== '') entry.targetPath = resolvePath(basePath, hrefPath)
        entry.fragment = fragment
      }
      output.push(entry)
    }
    const nested = childElements(item, 'ol')[0] ?? null
    if (nested !== null) parseNavList(nested, level + 1, basePath, output, depth + 1)
  }
}

/** Parse the EPUB3 navigation document into flat TOC entries. */
async function readNavToc(zip, navItem) {
  const text = await readText(zip, navItem.path, MAX_DOCUMENT_BYTES)
  if (text === null) return []
  const document = parseMarkup(text, { htmlFallback: true })
  if (document === null) return []
  const navs = elementsByLocal(document, 'nav')
  if (navs.length === 0) return []
  const tocNav =
    navs.find((nav) => {
      const type = `${nav.getAttribute('epub:type') ?? ''} ${nav.getAttribute('type') ?? ''} ${nav.getAttribute('role') ?? ''}`.toLowerCase()
      return /(?:^|\s)toc(?:\s|$)/.test(type) || /doc-toc/.test(type)
    }) ?? navs[0]
  const list = firstByLocal(tocNav, 'ol') ?? firstByLocal(tocNav, 'ul')
  if (list === null) return []
  const output = []
  parseNavList(list, 1, navItem.path, output, 0)
  return output
}

/** Recursively read NCX navPoints. */
function parseNcxPoints(parent, level, basePath, output, depth) {
  if (depth > 8) return
  for (const point of childElements(parent, 'navpoint')) {
    const labelElement = childElements(point, 'navlabel')[0] ?? null
    const textElement = labelElement === null ? null : childElements(labelElement, 'text')[0] ?? null
    const title = truncateLabel(textElement === null ? '' : (textElement.textContent ?? ''), 200)
    const content = childElements(point, 'content')[0] ?? null
    const src = content === null ? '' : (content.getAttribute('src') ?? '').trim()
    if (title !== '') {
      if (output.length >= MAX_TOC_ENTRIES) return
      const entry = { title, level, targetPath: '', fragment: '' }
      if (src !== '' && !isExternalHref(src)) {
        const { path: hrefPath, fragment } = splitHref(src)
        if (hrefPath !== '') entry.targetPath = resolvePath(basePath, hrefPath)
        entry.fragment = fragment
      }
      output.push(entry)
    }
    parseNcxPoints(point, level + 1, basePath, output, depth + 1)
  }
}

/** Parse an EPUB2 NCX document into flat TOC entries. */
async function readNcxToc(zip, ncxItem) {
  const text = await readText(zip, ncxItem.path, MAX_DOCUMENT_BYTES)
  if (text === null) return []
  const document = parseMarkup(text, { htmlFallback: true })
  if (document === null) return []
  const navMap = firstByLocal(document, 'navmap')
  if (navMap === null) return []
  const output = []
  parseNcxPoints(navMap, 1, ncxItem.path, output, 0)
  return output
}

/** Load TOC entries from the nav document (EPUB3) with NCX (EPUB2) fallback. */
async function loadTocEntries(zip, opf) {
  const navItems = opf.manifest.filter((item) => /(?:^|\s)nav(?:\s|$)/.test(item.properties))
  const navItem = navItems.find((item) => /\.x?html?$/i.test(item.path)) ?? navItems[0] ?? null
  if (navItem !== null) {
    try {
      const entries = await readNavToc(zip, navItem)
      if (entries.length > 0) return entries
    } catch {
      /* broken nav: fall back to NCX */
    }
  }
  const ncxItems = opf.manifest.filter((item) => /dtbncx|ncx/.test(item.mediaType) || /\.ncx$/i.test(item.path))
  const ncxById = opf.tocId !== '' ? opf.manifestById.get(opf.tocId) ?? null : null
  const ncxItem = ncxById ?? ncxItems[0] ?? null
  if (ncxItem !== null) {
    try {
      const entries = await readNcxToc(zip, ncxItem)
      if (entries.length > 0) return entries
    } catch {
      /* fall through to heading-derived TOC */
    }
  }
  return []
}

// -------------------------------------------------------------------------------------------------
// Image inlining (Image + canvas -> JPEG data URL)
// -------------------------------------------------------------------------------------------------

/** A simple additive byte budget for embedded images. */
function createBudget(limit) {
  return {
    used: 0,
    limit,
    add(dataUrl) {
      const size = String(dataUrl ?? '').length
      if (size === 0) return false
      if (this.used + size > this.limit) return false
      this.used += size
      return true
    },
  }
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,[A-Za-z0-9+/=]+$/i

/**
 * Decode image bytes and re-encode as a downscaled JPEG data URL.
 * Resolves null for broken/undecodable images instead of rejecting.
 */
function decodeImageToJpegDataUrl(bytes, mediaType, maxWidth, quality) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined' || typeof URL === 'undefined') {
      resolve(null)
      return
    }
    if (bytes === null || bytes === undefined || bytes.byteLength === 0) {
      resolve(null)
      return
    }
    let objectUrl = ''
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (objectUrl !== '') {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          /* ignore */
        }
      }
      resolve(value)
    }
    timer = setTimeout(() => finish(null), 15000)
    try {
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType || 'image/jpeg' }))
    } catch {
      finish(null)
      return
    }
    const image = new Image()
    image.onload = () => {
      try {
        const naturalWidth = image.naturalWidth || image.width || 0
        const naturalHeight = image.naturalHeight || image.height || 0
        if (naturalWidth <= 0 || naturalHeight <= 0) {
          finish(null)
          return
        }
        let targetWidth = Math.min(maxWidth, naturalWidth)
        let targetHeight = Math.max(1, Math.round((naturalHeight * targetWidth) / naturalWidth))
        if (targetWidth >= naturalWidth && targetHeight >= naturalHeight) {
          targetWidth = naturalWidth
          targetHeight = naturalHeight
        }
        const encode = (width, height, jpegQuality) => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context === null) return ''
          // Fill white first: JPEG has no alpha channel and transparent PNGs would go black.
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, width, height)
          context.drawImage(image, 0, 0, width, height)
          return canvas.toDataURL('image/jpeg', jpegQuality)
        }
        let dataUrl = encode(targetWidth, targetHeight, quality)
        if (dataUrl.length > MAX_PER_IMAGE_CHARS && targetWidth > 480) {
          const retryWidth = Math.min(640, targetWidth)
          const retryHeight = Math.max(1, Math.round((naturalHeight * retryWidth) / naturalWidth))
          const retry = encode(retryWidth, retryHeight, 0.72)
          if (retry !== '' && retry.length < dataUrl.length) dataUrl = retry
        }
        if (dataUrl === '' || !/^data:image\//i.test(dataUrl) || dataUrl.length > MAX_PER_IMAGE_CHARS) {
          finish(null)
          return
        }
        finish(dataUrl)
      } catch {
        finish(null)
      }
    }
    image.onerror = () => finish(null)
    try {
      image.src = objectUrl
    } catch {
      finish(null)
    }
  })
}

/** Shared image resolver: ZIP path -> JPEG data URL (cached, budgeted). */
function createImageResolver(zip, manifestByPath, budget) {
  return {
    cache: new Map(),
    async resolve(path) {
      const normalized = normalizePath(path)
      if (normalized === '') return null
      const key = normalized.toLowerCase()
      if (this.cache.has(key)) return this.cache.get(key)
      this.cache.set(key, null) // reserve the slot against concurrent duplicates
      let result = null
      try {
        const entry = findEntry(zip, normalized)
        if (entry !== null) {
          const bytes = await readEntryBytes(zip, entry, MAX_IMAGE_BYTES)
          if (bytes.byteLength > 0) {
            const mediaType = mimeForPath(normalized, manifestByPath) || 'image/jpeg'
            const dataUrl = await decodeImageToJpegDataUrl(bytes, mediaType, MAX_IMAGE_WIDTH, IMAGE_QUALITY)
            if (dataUrl !== null && budget.add(dataUrl)) result = dataUrl
          }
        }
      } catch {
        result = null
      }
      this.cache.set(key, result)
      return result
    },
  }
}

/** Resolve one `<img>` element to a data URL, honouring data: URLs and the budget. */
async function resolveImageElement(imageElement, context) {
  const rawSrc = (imageElement.getAttribute('src') ?? '').trim()
  if (rawSrc === '') return null
  if (/^data:image\//i.test(rawSrc)) {
    const compact = rawSrc.replace(/\s+/g, '')
    if (!SAFE_DATA_IMAGE.test(compact)) return null
    if (compact.length > MAX_PER_IMAGE_CHARS) return null
    return context.budget.add(compact) ? compact : null
  }
  if (isExternalHref(rawSrc)) return null
  const { path: hrefPath } = splitHref(rawSrc)
  if (hrefPath === '') return null
  const target = resolvePath(context.basePath, hrefPath)
  return context.images.resolve(target)
}

/** Pre-scan a document for images and inline them (before block splitting). */
async function prepareDocumentMedia(body, context) {
  const mediaMap = new Map()
  const images = elementsByLocal(body, 'img')
  for (const imageElement of images) {
    if (mediaMap.has(imageElement)) continue
    let dataUrl = null
    try {
      dataUrl = await resolveImageElement(imageElement, context)
    } catch {
      dataUrl = null
    }
    if (dataUrl !== null) mediaMap.set(imageElement, dataUrl)
  }
  return mediaMap
}

/** Build a small cover thumbnail from the OPF cover declaration or first cover-ish image. */
async function loadCoverThumbnail(zip, opf) {
  const candidatePaths = []
  const pushCandidate = (path) => {
    if (typeof path === 'string' && path !== '') candidatePaths.push(path)
  }
  if (opf.metadata.coverId !== '') {
    const item = opf.manifestById.get(opf.metadata.coverId)
    if (item !== undefined) pushCandidate(item.path)
  }
  for (const item of opf.manifest) {
    if (/cover-image/.test(item.properties)) pushCandidate(item.path)
  }
  for (const reference of opf.guide) {
    if (reference.type === 'cover') pushCandidate(reference.path)
  }
  const imageItems = opf.manifest.filter((item) => /^image\//.test(item.mediaType))
  const coverNamed = imageItems.find((item) => /cover/i.test(item.path))
  if (coverNamed !== undefined) pushCandidate(coverNamed.path)
  const firstImage = imageItems[0]
  if (firstImage !== undefined) pushCandidate(firstImage.path)

  const seen = new Set()
  for (const path of candidatePaths) {
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const entry = findEntry(zip, path)
      if (entry === null) continue
      const bytes = await readEntryBytes(zip, entry, MAX_IMAGE_BYTES)
      if (bytes.byteLength === 0) continue
      const mediaType = mimeForPath(path, opf.manifestByPath) || 'image/jpeg'
      const dataUrl = await decodeImageToJpegDataUrl(bytes, mediaType, THUMB_MAX_WIDTH, THUMB_QUALITY)
      if (dataUrl !== null && dataUrl.length <= THUMB_BUDGET) return dataUrl
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

// -------------------------------------------------------------------------------------------------
// Inline serialization
// -------------------------------------------------------------------------------------------------

/** Inline tags kept in block html (plus br/img which are handled specially). */
const ALLOWED_INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'span', 'sub', 'sup'])

/** Tags whose content is never readable text. */
const DROP_ANY = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'param', 'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
  'meta', 'link', 'base', 'head', 'title', 'svg', 'canvas', 'video', 'audio', 'source',
  'track', 'map', 'area', 'dialog', 'slot', 'portal',
])

/** Elements handled as inline flow at block level. */
const FLOW_INLINE = new Set([
  'math',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i',
  'img', 'ins', 'kbd', 'label', 'mark', 'q', 'ruby', 's', 'samp', 'small', 'span', 'strike',
  'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
])

/** Generic wrapper containers that are flattened when they hold block children. */
const WRAPPER_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'center', 'address',
  'details', 'summary', 'fieldset', 'dl', 'body',
])

/** Block-ish tags that need separation when they appear inside an inline run. */
const BLOCK_LIKE = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'blockquote', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'table', 'tr', 'td', 'th', 'pre', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'address', 'center', 'details', 'summary',
])

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

/** Incremental inline serializer that keeps html and plain text in sync. */
function createInlineBuilder() {
  return {
    htmlParts: [],
    text: '',
    pendingSpace: false,
    anchors: [],
    /** Append a word (already whitespace-free), inserting one space when needed. */
    appendWord(word) {
      if (word === '') return
      if (this.pendingSpace && this.text !== '') {
        const previous = this.text[this.text.length - 1]
        const next = word[0]
        if (!(isCjkChar(previous) && isCjkChar(next))) {
          this.htmlParts.push(' ')
          this.text += ' '
        }
      }
      this.pendingSpace = false
      this.htmlParts.push(escapeText(word))
      this.text += word
    },
    /** Append raw text, collapsing whitespace and remembering a pending single space. */
    appendRawText(raw) {
      const value = String(raw ?? '').replace(/\u00a0/g, ' ')
      const parts = value.split(/(\s+)/)
      for (const part of parts) {
        if (part === '') continue
        if (/^\s+$/.test(part)) {
          if (this.text !== '' && !this.text.endsWith(' ')) this.pendingSpace = true
          continue
        }
        this.appendWord(part)
      }
    },
    /** A hard line break: `<br>` in html, one space in plain text. */
    appendBreak() {
      if (this.htmlParts.length === 0 && this.text === '') return
      this.htmlParts.push('<br>')
      this.pendingSpace = false
      if (this.text !== '' && !this.text.endsWith(' ')) this.text += ' '
    },
    /** Append pre-serialized html (e.g. an inlined image). */
    appendHtml(html) {
      if (html !== '') this.htmlParts.push(html)
    },
    /** Remember an element anchor id that maps to this block. */
    addAnchor(anchor) {
      if (typeof anchor === 'string' && anchor !== '' && this.anchors.length < MAX_INLINE_ANCHORS) this.anchors.push(anchor)
    },
    /** Final `{ html, text }` pair, empty strings when nothing survived. */
    finish() {
      return {
        html: this.htmlParts.join('').trim(),
        text: normalizeInlineText(this.text),
      }
    },
  }
}

/** Serialize the safe attributes of one inline element. */
function inlineAttributes(tag, element) {
  const parts = []
  const title = (element.getAttribute('title') ?? '').trim()
  if (title !== '') parts.push(`title="${escapeText(title)}"`)
  if (tag === 'a') {
    const href = (element.getAttribute('href') ?? '').trim()
    if (href !== '') parts.push(`href="${escapeText(href)}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

/** Serialize one node inside an inline context (block tags are unwrapped). */
function serializeInlineNode(builder, node, context) {
  if (node === null || node === undefined) return
  if (node.nodeType === 3 || node.nodeType === 4) {
    builder.appendRawText(node.nodeValue)
    return
  }
  if (node.nodeType !== 1) return
  const tag = tagOf(node)
  if (tag === '' || DROP_ANY.has(tag)) return
  if(tag==='math'){
    const math=sanitizeMathElement(node)
    if(builder.pendingSpace&&builder.text){builder.appendHtml(' ');builder.text+=' '}
    builder.pendingSpace=false;builder.appendHtml(math.html);builder.text+=math.text;return
  }
  if (tag === 'br') {
    builder.appendBreak()
    return
  }
  if (tag === 'img') {
    const dataUrl = context.mediaMap.get(node) ?? null
    if (dataUrl !== null && typeof dataUrl === 'string' && dataUrl !== '') {
      const alt = normalizeInlineText(node.getAttribute('alt') ?? '')
      builder.appendHtml(`<img src="${escapeText(dataUrl)}" alt="${escapeText(alt)}">`)
    } else {
      const alt = normalizeInlineText(node.getAttribute('alt') ?? '')
      if (alt !== '') builder.appendWord(alt)
    }
    return
  }
  if (ALLOWED_INLINE_TAGS.has(tag)) {
    for (const anchor of idsOf(node)) builder.addAnchor(anchor)
    builder.appendHtml(`<${tag}${inlineAttributes(tag, node)}>`)
    for (const child of childNodesOf(node)) serializeInlineNode(builder, child, context)
    builder.appendHtml(`</${tag}>`)
    return
  }
  // Unknown / block element in inline context: unwrap to its inline content.
  if (BLOCK_LIKE.has(tag) && (builder.text !== '' || builder.htmlParts.length > 0)) builder.appendBreak()
  for (const child of childNodesOf(node)) serializeInlineNode(builder, child, context)
}

/** Build `{ html, text, anchors }` for a list of nodes. */
function buildInlineNodes(nodes, context) {
  const builder = createInlineBuilder()
  for (const node of nodes) serializeInlineNode(builder, node, context)
  const result = builder.finish()
  return { html: result.html, text: result.text, anchors: builder.anchors }
}

/** Build `{ html, text, anchors }` for all children of one element. */
function buildInlineElement(element, context) {
  return buildInlineNodes(childNodesOf(element), context)
}

/** Wrap inline html into a Block (sanitized one last time). */
function createInlineBlock(kind, inline, extra = {}) {
  const html = inline.html !== '' ? sanitizeInlineHtml(inline.html) : ''
  if (html === '' && inline.text === '') return null
  const block = { kind, text: inline.text }
  if (html !== '') block.html = html
  if (extra.level !== undefined) block.level = extra.level
  return { block, anchors: inline.anchors }
}

// -------------------------------------------------------------------------------------------------
// Block splitting
// -------------------------------------------------------------------------------------------------

/** Emit one block, registering its anchor ids for TOC fragment resolution. */
function emitBlock(docState, block, anchors) {
  if (block === null || block === undefined) return
  docState.ctx.blockCount++
  if (docState.ctx.blockCount > MAX_BLOCKS) throw fail('文档内容异常（段落数量过多）')
  const idList = Array.isArray(anchors) ? anchors : []
  for (const anchor of idList) {
    if (typeof anchor !== 'string' || anchor === '') continue
    if (!docState.lookup.has(anchor)) docState.lookup.set(anchor, block)
  }
  docState.blocks.push(block)
}

/** Element ids that should resolve a TOC fragment to the next emitted block. */
function blockAnchors(ancestorIds, element, inlineAnchors) {
  const anchors = Array.isArray(ancestorIds) ? ancestorIds.slice() : []
  if (element !== null && element !== undefined && element.nodeType === 1) {
    for (const id of idsOf(element)) anchors.push(id)
  }
  if (Array.isArray(inlineAnchors)) for (const anchor of inlineAnchors) anchors.push(anchor)
  return anchors
}

/** True when styled as hidden (display:none / visibility:hidden / hidden attribute). */
function isHiddenElement(element) {
  try {
    if (element.getAttribute('hidden') !== null) return true
    const style = (element.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '')
    if (style.indexOf('display:none') >= 0 || style.indexOf('visibility:hidden') >= 0) return true
    const epubType = `${element.getAttribute('epub:type') ?? ''} ${element.getAttribute('role') ?? ''}`.toLowerCase()
    if (/\bpagebreak\b|doc-pagebreak/.test(epubType)) return true
  } catch {
    /* ignore */
  }
  return false
}

/** Does the element contain anything renderable (text or media)? */
function hasReadableContent(element) {
  const tag = tagOf(element)
  if (tag === 'img' || tag === 'br') return true
  if (normalizeInlineText(element.textContent ?? '') !== '') return true
  return elementsByLocal(element, 'img').length > 0 || elementsByLocal(element, 'br').length > 0
}

/** Does the element have block-level element children (so it should be flattened)? */
function hasBlockChild(element) {
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType !== 1) continue
    const tag = tagOf(child)
    if (tag === '' || DROP_ANY.has(tag)) continue
    if (tag === 'img' || tag === 'br') continue // images alone stay inline unless wrapper is media-only
    if (FLOW_INLINE.has(tag)) continue
    return true
  }
  return false
}

/** True when a container has no text and only images (cover / illustration wrappers). */
function isMediaOnly(element) {
  if (normalizeInlineText(element.textContent ?? '') !== '') return false
  return elementsByLocal(element, 'img').length > 0
}

/** Options for a footnote-style aside. */
function isFootnoteAside(element) {
  const type = `${element.getAttribute('epub:type') ?? ''} ${element.getAttribute('role') ?? ''}`.toLowerCase()
  return /footnote|endnote|rearnote|sidenote|doc-endnote|doc-footnote/.test(type)
}

/** Normalize a code element's text: dedent common indentation, trim blank lines, keep newlines. */
function codeTextOf(element) {
  const raw = String(element.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
  const lines = raw.split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  let indent = Infinity
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^[ \t]*/.exec(line)
    const width = match === null ? 0 : match[0].length
    if (width < indent) indent = width
  }
  if (!Number.isFinite(indent)) indent = 0
  return lines
    .map((line) => (line.length >= indent ? line.slice(indent) : line).replace(/[ \t]+$/, ''))
    .join('\n')
}

/** Emit one list block (`<ul>`/`<ol>` markup with inline-only item content). */
function emitListBlock(listElement, docState, context, ancestorIds) {
  const itemTexts = []
  const buildList = (element, depth) => {
    const tag = tagOf(element) === 'ol' ? 'ol' : 'ul'
    if (depth > 4) return ''
    let html = `<${tag}>`
    for (const item of childElements(element, 'li')) {
      const builder = createInlineBuilder()
      const nestedLists = []
      for (const child of childNodesOf(item)) {
        if (child.nodeType === 1) {
          const tag2 = tagOf(child)
          if (tag2 === 'ul' || tag2 === 'ol') {
            nestedLists.push(child)
            continue
          }
        }
        serializeInlineNode(builder, child, context)
      }
      const finish = builder.finish()
      const itemHtml = finish.html !== '' ? sanitizeInlineHtml(finish.html) : escapeText(finish.text)
      if (itemHtml === '' && finish.text === '') continue
      if (finish.text !== '') itemTexts.push(finish.text)
      html += `<li>${itemHtml}`
      for (const nested of nestedLists) html += buildList(nested, depth + 1)
      html += '</li>'
    }
    return `${html}</${tag}>`
  }

  const html = buildList(listElement, 0)
  if (!html.includes('<li>')) return
  const text = normalizeInlineText(itemTexts.join(' '))
  emitBlock(docState, { kind: 'list', html, text }, blockAnchors(ancestorIds, listElement, []))
}

/** Emit paragraph blocks for a table (rows joined with a visible separator). */
function emitTableBlocks(tableElement, docState, context, ancestorIds) {
  const rows = elementsByLocal(tableElement, 'tr')
  if (rows.length === 0) {
    const inline = buildInlineElement(tableElement, context)
    const created = createInlineBlock('paragraph', inline)
    if (created !== null) emitBlock(docState, created.block, blockAnchors(ancestorIds, tableElement, inline.anchors))
    return
  }
  for (const row of rows) {
    const cells = childElements(row).filter((cell) => {
      const tag = tagOf(cell)
      return tag === 'td' || tag === 'th'
    })
    if (cells.length === 0) continue
    const builder = createInlineBuilder()
    cells.forEach((cell, index) => {
      if (index > 0) {
        builder.pendingSpace = builder.text !== ''
        builder.appendWord('|')
        builder.pendingSpace = true
      }
      for (const child of childNodesOf(cell)) serializeInlineNode(builder, child, context)
    })
    const result = builder.finish()
    if (result.text === '' && result.html === '') continue
    const html = result.html !== '' ? sanitizeInlineHtml(result.html) : ''
    const block = { kind: 'paragraph', text: result.text }
    if (html !== '') block.html = html
    const anchors = blockAnchors(ancestorIds, row, builder.anchors)
    for (const cell of cells) for (const id of idsOf(cell)) anchors.push(id)
    emitBlock(docState, block, anchors)
  }
}

/** Emit the blocks of one spine document body. */
function walkFlow(container, docState, context, ancestorIds) {
  let run = []

  const flushRun = () => {
    if (run.length === 0) return
    const nodes = run
    run = []
    const inline = buildInlineNodes(nodes, context)
    const created = createInlineBlock('paragraph', inline)
    if (created === null) return
    emitBlock(docState, created.block, blockAnchors(ancestorIds, null, inline.anchors))
  }

  const emitParagraphForElement = (element, childAncestors) => {
    const inline = buildInlineElement(element, context)
    const created = createInlineBlock('paragraph', inline)
    if (created === null) return
    emitBlock(docState, created.block, blockAnchors(childAncestors, element, inline.anchors))
  }

  for (const node of childNodesOf(container)) {
    if (node.nodeType === 3) {
      if ((node.nodeValue ?? '').trim() !== '') run.push(node)
      continue
    }
    if (node.nodeType !== 1) continue
    const tag = tagOf(node)
    if (tag === '' || DROP_ANY.has(tag)) continue
    if (isHiddenElement(node)) continue
    if (!hasReadableContent(node)) continue

    if (tag === 'br') {
      if (run.length > 0) run.push(node)
      continue
    }
    if (tag === 'img') {
      if (run.length === 0) {
        flushRun()
        const dataUrl = context.mediaMap.get(node) ?? null
        if (typeof dataUrl === 'string' && dataUrl !== '') {
          const alt = normalizeInlineText(node.getAttribute('alt') ?? '')
          emitBlock(docState, { kind: 'image', image: dataUrl, alt, text: alt }, blockAnchors(ancestorIds, node, []))
        }
        continue
      }
      run.push(node)
      continue
    }
    if (tag === 'code') {
      flushRun()
      const text = codeTextOf(node)
      if (text !== '') emitBlock(docState, { kind: 'code', text }, blockAnchors(ancestorIds, node, []))
      continue
    }
    if (FLOW_INLINE.has(tag)) {
      run.push(node)
      continue
    }

    // Block-level elements.
    const childAncestors = (Array.isArray(ancestorIds) ? ancestorIds : []).concat(idsOf(node))

    const headingLevel = HEADING_LEVELS[tag]
    if (headingLevel !== undefined) {
      flushRun()
      const inline = buildInlineElement(node, context)
      const created = createInlineBlock('heading', inline, { level: headingLevel })
      if (created !== null) emitBlock(docState, created.block, blockAnchors(childAncestors, node, inline.anchors))
      continue
    }

    if (tag === 'p' || tag === 'dt' || tag === 'dd' || tag === 'li') {
      flushRun()
      emitParagraphForElement(node, childAncestors)
      continue
    }

    if (tag === 'blockquote') {
      flushRun()
      const inline = buildInlineElement(node, context)
      const created = createInlineBlock('quote', inline)
      if (created !== null) emitBlock(docState, created.block, blockAnchors(childAncestors, node, inline.anchors))
      continue
    }

    if (tag === 'pre') {
      flushRun()
      const text = codeTextOf(node)
      if (text !== '') emitBlock(docState, { kind: 'code', text }, blockAnchors(childAncestors, node, []))
      continue
    }

    if (tag === 'figcaption') {
      flushRun()
      const inline = buildInlineElement(node, context)
      const created = createInlineBlock('caption', inline)
      if (created !== null) emitBlock(docState, created.block, blockAnchors(childAncestors, node, inline.anchors))
      continue
    }

    if (tag === 'figure') {
      flushRun()
      walkFlow(node, docState, context, childAncestors)
      continue
    }

    if (tag === 'ul' || tag === 'ol') {
      flushRun()
      emitListBlock(node, docState, context, ancestorIds)
      continue
    }

    if (tag === 'table') {
      flushRun()
      emitTableBlocks(node, docState, context, ancestorIds)
      continue
    }

    if (tag === 'aside' && isFootnoteAside(node)) {
      flushRun()
      const inline = buildInlineElement(node, context)
      const created = createInlineBlock('footnote', inline)
      if (created !== null) emitBlock(docState, created.block, blockAnchors(childAncestors, node, inline.anchors))
      continue
    }

    if (WRAPPER_TAGS.has(tag) || tag === 'div' || tag === 'p') {
      flushRun()
      if (hasBlockChild(node)) {
        walkFlow(node, docState, context, childAncestors)
      } else if (isMediaOnly(node)) {
        for (const imageElement of elementsByLocal(node, 'img')) {
          const dataUrl = context.mediaMap.get(imageElement) ?? null
          if (typeof dataUrl !== 'string' || dataUrl === '') continue
          const alt = normalizeInlineText(imageElement.getAttribute('alt') ?? '')
          emitBlock(docState, { kind: 'image', image: dataUrl, alt, text: alt }, blockAnchors(childAncestors, imageElement, []))
        }
      } else {
        emitParagraphForElement(node, childAncestors)
      }
      continue
    }

    // Unknown block-ish element (details, custom tags...): flatten or keep its text.
    flushRun()
    if (hasBlockChild(node)) {
      walkFlow(node, docState, context, childAncestors)
    } else {
      emitParagraphForElement(node, childAncestors)
    }
  }

  flushRun()
}

/** Parse one spine document into blocks + fragment lookup. */
async function parseSpineDocument(zip, item, docIndex, options) {
  const text = await readText(zip, item.path, MAX_DOCUMENT_BYTES)
  if (text === null) return null
  const document = parseMarkup(text, { htmlFallback: true })
  if (document === null) throw new Error('XHTML 内容解析失败')
  const body = firstByLocal(document, 'body') ?? document.documentElement
  if (body === null) return null
  const mediaMap = await prepareDocumentMedia(body, {
    basePath: item.path,
    images: options.images,
    budget: options.budget,
  })
  const docState = {
    index: docIndex,
    path: item.path,
    blocks: [],
    lookup: new Map(),
    ctx: options.ctx,
  }
  walkFlow(body, docState, { mediaMap }, idsOf(body))
  return docState
}

// -------------------------------------------------------------------------------------------------
// TOC -> block mapping
// -------------------------------------------------------------------------------------------------

/** Find a block for one TOC fragment (decoded, raw and case-tolerant). */
function lookupFragment(docState, fragment) {
  if (docState === null || fragment === '') return null
  const decoded = safeDecode(fragment).trim()
  const candidates = [decoded, fragment.trim(), decoded.toLowerCase()]
  for (const candidate of candidates) {
    if (candidate === '') continue
    const block = docState.lookup.get(candidate)
    if (block !== undefined) return block
  }
  return null
}

/** Map raw nav/NCX entries onto parsed spine documents + resolved target blocks. */
function mapTocEntries(rawEntries, docsByPath) {
  const mapped = []
  for (const raw of rawEntries) {
    const doc = raw.targetPath === '' ? null : docsByPath.get(raw.targetPath.toLowerCase()) ?? null
    if (doc === null) continue
    // Unknown fragments degrade to the document's first block instead of dropping the chapter.
    const target = (raw.fragment !== '' ? lookupFragment(doc, raw.fragment) : null) ?? doc.firstBlock ?? null
    if (target === null) continue
    mapped.push({ raw, doc, target })
  }
  return mapped
}

/**
 * When a chapter's first block is not a heading, prepend a heading carrying the TOC title so the
 * reader shows a visible chapter title and the TOC anchor has a real target.
 */
function applyPrependHeadings(mapped) {
  const prependTitleByDoc = new Map()
  for (const entry of mapped) {
    if (prependTitleByDoc.has(entry.doc)) continue
    const first = entry.doc.firstBlock
    if (first === undefined || first === null) continue
    if (entry.target === first && first.kind !== 'heading') prependTitleByDoc.set(entry.doc, entry.raw.title)
  }
  for (const [doc, title] of prependTitleByDoc) {
    const heading = { kind: 'heading', level: 1, text: title }
    const html = sanitizeInlineHtml(escapeText(title))
    if (html !== '') heading.html = html
    doc.blocks.unshift(heading)
    doc.prependedHeading = heading
  }
}

/** Stable block ids: `e<docIndex>_<blockIndex>`. */
function assignBlockIds(docs) {
  for (const doc of docs) {
    for (let index = 0; index < doc.blocks.length; index++) doc.blocks[index].id = `e${doc.index}_${index}`
  }
}

/** Turn mapped TOC entries into the final TocItem[] (ids already assigned). */
function resolveTocItems(mapped) {
  const toc = []
  const seen = new Set()
  for (const entry of mapped) {
    const doc = entry.doc
    let target = entry.target
    if (target === doc.firstBlock && doc.prependedHeading !== undefined) target = doc.prependedHeading
    if (target === null || target === undefined || typeof target.id !== 'string') continue
    const key = `${target.id}|${entry.raw.level}|${entry.raw.title}`
    if (seen.has(key)) continue
    seen.add(key)
    toc.push({ id: `toc_${toc.length}`, title: entry.raw.title, level: entry.raw.level, blockId: target.id })
    if (toc.length >= MAX_TOC_ENTRIES) break
  }
  return toc
}

/** Build a TOC from heading blocks when the EPUB ships no nav/NCX. */
function buildFallbackToc(docs) {
  const headingEntries = []
  for (const doc of docs) {
    for (const block of doc.blocks) {
      if (block.kind !== 'heading') continue
      const title = truncateLabel(block.text, 120)
      if (title === '') continue
      headingEntries.push({ id: `toc_${headingEntries.length}`, title, level: Math.min(6, Math.max(1, Number(block.level) || 1)), blockId: block.id })
      if (headingEntries.length >= MAX_TOC_ENTRIES) return headingEntries
    }
  }
  if (headingEntries.length > 0) return headingEntries
  const snippetEntries = []
  for (const doc of docs) {
    const block = doc.blocks.find((candidate) => normalizeInlineText(candidate.text ?? '') !== '')
    if (block === undefined) continue
    snippetEntries.push({
      id: `toc_${snippetEntries.length}`,
      title: truncateLabel(block.text, 60),
      level: 1,
      blockId: block.id,
    })
    if (snippetEntries.length >= MAX_TOC_ENTRIES) break
  }
  return snippetEntries
}

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------

/** Extract a full reading model from an EPUB file. */
export async function extractEpub(arrayBuffer, { onProgress } = {}) {
  try {
    return await extractEpubInner(arrayBuffer, onProgress)
  } catch (error) {
    throw asEpubError(error)
  }
}

/** Implementation behind `extractEpub` (all errors normalized by the wrapper). */
async function extractEpubInner(arrayBuffer, onProgress) {
  if (arrayBuffer === null || arrayBuffer === undefined) throw fail('没有收到文件数据')
  let data
  if (arrayBuffer instanceof Uint8Array) data = arrayBuffer
  else if (arrayBuffer instanceof ArrayBuffer) data = new Uint8Array(arrayBuffer)
  else if (typeof arrayBuffer.byteLength === 'number') data = new Uint8Array(arrayBuffer)
  else throw fail('文件数据格式无效')
  if (data.byteLength === 0) throw fail('文件为空')
  if (data.byteLength < 22) throw fail('文件太小，不是有效的 EPUB')

  const reportProgress = (done, total) => {
    if (typeof onProgress !== 'function') return
    try {
      onProgress({ done, total })
    } catch {
      /* progress listeners must never break parsing */
    }
  }

  const zip = readZipDirectory(data)
  const opfPath = await readOpfPath(zip)
  const opfText = await readText(zip, opfPath, MAX_DOCUMENT_BYTES)
  if (opfText === null) throw fail(`未找到 OPF 文件（${opfPath}）`)
  const opf = parseOpf(opfText, opfPath)
  const meta = { ...opf.metadata }
  delete meta.coverId

  const rawToc = await loadTocEntries(zip, opf)

  const budget = createBudget(IMAGE_BUDGET)
  const images = createImageResolver(zip, opf.manifestByPath, budget)
  const ctx = { blockCount: 0 }
  const docs = []
  const skipped = []

  const total = opf.spine.length
  reportProgress(0, total)
  for (let index = 0; index < opf.spine.length; index++) {
    const spineItem = opf.spine[index]
    try {
      const docState = await parseSpineDocument(zip, { path: spineItem.item.path }, index, { images, budget, ctx })
      if (docState !== null && docState.blocks.length > 0) docs.push(docState)
    } catch (error) {
      skipped.push(error !== null && error !== undefined && error.message ? String(error.message) : String(error))
    }
    reportProgress(index + 1, total)
    await YIELD()
  }

  if (docs.length === 0) {
    const detail = skipped.length > 0 ? skipped[0] : '未能解析出任何文本内容'
    throw fail(detail)
  }

  for (const doc of docs) doc.firstBlock = doc.blocks[0]

  const docsByPath = new Map()
  for (const doc of docs) docsByPath.set(doc.path.toLowerCase(), doc)

  const mappedToc = mapTocEntries(rawToc, docsByPath)
  if (mappedToc.length > 0) applyPrependHeadings(mappedToc)
  assignBlockIds(docs)
  let toc = mappedToc.length > 0 ? resolveTocItems(mappedToc) : []
  if (toc.length === 0) toc = buildFallbackToc(docs)

  const blocks = []
  for (const doc of docs) for (const block of doc.blocks) blocks.push(block)

  if (meta.title === '') {
    const firstTocTitle = toc.find((entry) => normalizeInlineText(entry.title) !== '')
    meta.title = firstTocTitle !== undefined ? truncateLabel(firstTocTitle.title, 200) : '未命名文档'
  }
  if (meta.author === undefined) meta.author = ''
  if (meta.language === undefined) meta.language = ''
  if (meta.description === undefined) meta.description = ''

  let thumbDataUrl
  try {
    thumbDataUrl = await loadCoverThumbnail(zip, opf)
  } catch {
    thumbDataUrl = undefined
  }

  const result = { kind: 'epub', version: 1, meta, toc, blocks }
  if (typeof thumbDataUrl === 'string' && thumbDataUrl !== '') {
    result.thumbDataUrl = thumbDataUrl
    result.cover = thumbDataUrl
  }
  return result
}
