// Agent tools: the same reader operations the UI performs, exposed to the assistant.
//
// Registered as plain tool definitions (no package imports) so this local bundle stays
// dependency-free. Every tool returns one rendered text block so a Chat row reads well.
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { ReaderError, plainObject, truncateBytes } from './util.js'

const DOC_ID = { type: 'string', description: 'Reader document id (from reader_library list).' }

/** Reusable output declaration: schemas validate the string result, render shows it. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** Human-readable one-line document description. */
function describeDoc(doc, folderName) {
  const progress = Math.round((doc.progress?.percent ?? 0) * 100)
  const folder = typeof folderName === 'string' && folderName !== '' ? ` · folder=${folderName}` : ''
  return `- ${doc.title} [${doc.format}] id=${doc.id}${doc.author !== '' ? ` · ${doc.author}` : ''} · ${progress}%${folder}${doc.favorite ? ' · ★' : ''}`
}

/** Plain text of a stored content extraction, truncated. */
function contentToText(content, maxChars = 60000) {
  if (content === null || typeof content !== 'object') return ''
  const parts = []
  if (Array.isArray(content.blocks)) {
    for (const block of content.blocks) {
      const text = typeof plainObject(block).text === 'string' ? plainObject(block).text : ''
      if (text.trim() !== '') parts.push(text)
      if (parts.join('\n').length > maxChars) break
    }
  } else if (Array.isArray(content.pages)) {
    for (const page of content.pages) {
      const blocks = Array.isArray(plainObject(page).blocks) ? plainObject(page).blocks : []
      for (const block of blocks) {
        const text = typeof plainObject(block).text === 'string' ? plainObject(block).text : ''
        if (text.trim() !== '') parts.push(text)
      }
      if (parts.join('\n').length > maxChars) break
    }
  }
  return truncateBytes(parts.join('\n\n'), maxChars)
}

/** Build the reader tool definitions for one host activation. */
export function createReaderTools({ store, ai, zotero }) {
  return [
    {
      name: 'reader_library',
      description:
        'Work with the dsh-paperhub library (PDF and EPUB documents imported by the user). ' +
        'Actions: "list" lists documents with ids, progress and metadata; "get" returns one document metadata plus its table of contents; ' +
        '"import" imports a local PDF/EPUB file from an absolute path; "remove" removes a document; "notes" returns the document annotations and reading notes as Markdown.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'import', 'remove', 'notes'], description: 'Operation to perform.' },
          docId: { ...DOC_ID, description: 'Document id, required for get/remove/notes.' },
          path: { type: 'string', description: 'Absolute path of a .pdf or .epub file, for import.' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await store.init()
        const action = args.action
        if (action === 'list') {
          const docs = store.listDocs()
          if (docs.length === 0) return 'The reader library is empty. Import a PDF or EPUB from the Reader panel, or use action "import" with a file path.'
          const folderNames = new Map(store.listFolders().map((folder) => [folder.id, folder.name]))
          const lines = docs.map((doc) => describeDoc(doc, folderNames.get(doc.folderId ?? '') ?? ''))
          const folderSummary = store.listFolders().length > 0 ? `\nFolders: ${store.listFolders().map((folder) => `${folder.name} (${folder.id})`).join(', ')}` : ''
          return `Reader library (${docs.length} documents):\n${lines.join('\n')}${folderSummary}`
        }
        const docId = typeof args.docId === 'string' ? args.docId : ''
        const doc = store.getDoc(docId)
        if (action !== 'import' && doc === null) throw new ReaderError('not-found', `no reader document with id "${docId}"`)
        if (action === 'get') {
          const content = await store.getContent(docId)
          const toc = Array.isArray(content?.toc) ? content.toc.slice(0, 80) : []
          const tocText = toc.map((item) => `${'  '.repeat(Math.max(0, Math.min(2, (item.level ?? 1) - 1)))}- ${item.title}`).join('\n')
          const annotations = await store.getAnnotations(docId)
          return [
            `Title: ${doc.title}`,
            `Format: ${doc.format}`,
            doc.author !== '' ? `Author: ${doc.author}` : '',
            `Progress: ${Math.round((doc.progress?.percent ?? 0) * 100)}%`,
            doc.pageCount !== undefined ? `Pages: ${doc.pageCount}` : '',
            `Annotations: ${annotations.length}`,
            toc.length > 0 ? `Table of contents:\n${tocText}` : 'No parsed table of contents yet (open the document once in the Reader panel).',
          ].filter((line) => line !== '').join('\n')
        }
        if (action === 'import') {
          const path = typeof args.path === 'string' ? args.path : ''
          if (path === '') throw new ReaderError('bad-request', 'import requires an absolute file path')
          const ext = extname(path).toLowerCase()
          const format = ext === '.epub' ? 'epub' : ext === '.pdf' ? 'pdf' : null
          if (format === null) throw new ReaderError('unsupported-format', 'only .pdf and .epub files can be imported')
          const bytes = await readFile(path)
          if (bytes.byteLength === 0) throw new ReaderError('empty-file', 'the file is empty')
          const upload = await store.saveUpload(basename(path), format, new Uint8Array(bytes))
          const title = basename(path, extname(path))
          const doc = await store.addDoc({
            storedPath: upload.path,
            name: basename(path),
            format,
            size: bytes.byteLength,
            meta: { title, filename: basename(path) },
          })
          return `Imported "${doc.title}" (${doc.format}, ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB) as document ${doc.id}. It will be typeset the first time it is opened in the Reader panel.`
        }
        if (action === 'remove') {
          await store.removeDoc(docId)
          return `Removed "${doc.title}" from the reader library.`
        }
        if (action === 'notes') {
          const annotations = await store.getAnnotations(docId)
          const aux = await store.getAux(docId)
          const lines = [`# ${doc.title} — reading notes`, '']
          if (typeof aux.summary === 'string' && aux.summary.trim() !== '') lines.push('## Summary', aux.summary.trim(), '')
          if (annotations.length === 0) {
            lines.push('_No annotations yet._')
          } else {
            lines.push(`## Annotations (${annotations.length})`)
            for (const ann of annotations) {
              lines.push(`- **${ann.color}** ${truncateBytes(ann.text, 500)}${ann.note !== '' ? `\n  - Note: ${truncateBytes(ann.note, 1000)}` : ''}`)
            }
          }
          return lines.join('\n')
        }
        throw new ReaderError('unknown-action', `unknown reader_library action "${action}"`)
      },
    },
    {
      name: 'reader_ai',
      description:
        'Use the reader\'s model stack on reader documents. Actions: "ask" answers a question about a document using its extracted text as context; ' +
        '"summarize" writes a structured reading note; "translate" translates text (or a document excerpt) into a target language. Calls use the corresponding model in Reader settings.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['ask', 'summarize', 'translate'], description: 'Operation to perform.' },
          docId: DOC_ID,
          question: { type: 'string', description: 'Question for action "ask".' },
          text: { type: 'string', description: 'Text to translate for action "translate"; when omitted the document excerpt is used.' },
          targetLang: { type: 'string', description: 'Target language id, e.g. zh-CN or en. Defaults to the reader setting.' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await store.init()
        const action = args.action
        const docId = typeof args.docId === 'string' ? args.docId : ''
        const doc = docId !== '' ? store.getDoc(docId) : null
        let contextText = ''
        if (doc !== null) {
          const content = await store.getContent(docId)
          contextText = contentToText(content, 60000)
        }
        if (action === 'ask') {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (question === '') throw new ReaderError('bad-request', 'action "ask" needs a question')
          const result = await ai.chat({
            messages: [{ role: 'user', content: question }],
            system: `You are a reading assistant. Answer using the document context below when relevant; state clearly when it is not covered.\n\n# Document: ${doc?.title ?? 'unknown'}\n---\n${contextText}\n---`,
            maxTokens: 4096,
            temperature: 0.4,
          })
          return result.text
        }
        if (action === 'summarize') {
          if (contextText.trim() === '') throw new ReaderError('no-content', 'the document has no extracted text yet; open it once in the Reader panel')
          const text = await ai.summarize({ text: contextText, title: doc?.title, scope: 'doc' })
          if (doc !== null) await store.mergeAux(docId, { summary: text })
          return text
        }
        if (action === 'translate') {
          const source = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : contextText
          if (source.trim() === '') throw new ReaderError('bad-request', 'nothing to translate')
          const result = await ai.translate({ texts: [truncateBytes(source, 20000)], targetLang: args.targetLang, ref: doc?.title !== undefined ? undefined : undefined })
          return result.translations[0] ?? ''
        }
        throw new ReaderError('unknown-action', `unknown reader_ai action "${action}"`)
      },
    },
    {
      name: 'reader_zotero',
      description:
        'Check or run Zotero library sync for the reader. Action "status" reports Zotero configuration and local-detection state; ' +
        '"sync" downloads the user\'s Zotero PDF attachments into the reader library (requires a Zotero Web API key in Reader settings).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'sync'], description: 'Operation to perform.' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await store.init()
        if (args.action === 'status') {
          const status = await zotero.status()
          const lines = [
            `Zotero local app: ${status.local.available ? 'running' : `not detected (${status.local.error ?? 'unknown'})`}`,
            `Zotero Web API: ${status.web.configured ? `configured for user ${status.web.userId}` : 'not configured (API key + user id needed for PDF files)'}`,
            `Zotero documents in reader: ${status.docs}`,
            status.settings.lastSyncAt !== undefined ? `Last sync: ${new Date(status.settings.lastSyncAt).toLocaleString()}` : 'Never synced',
          ]
          if (!status.local.available && !status.web.configured) lines.push('Configure Zotero in Reader → Settings → Zotero.')
          return lines.join('\n')
        }
        if (args.action === 'sync') {
          const summary = await zotero.sync({ emit: () => undefined })
          return `Zotero sync finished: ${summary.added} PDFs imported, ${summary.skipped} already in the library, ${summary.withoutPdf} items had no PDF, ${summary.failed} failed.`
        }
        throw new ReaderError('unknown-action', `unknown reader_zotero action "${args.action}"`)
      },
    },
  ]
}
