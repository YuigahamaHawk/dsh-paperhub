// Export helpers: reading notes, AI summary, document text and the original file.
import { downloadFile } from './util.js'
import { mathTokenIssue, protectInlineMath, translatedMathSegments } from '../shared/inline-math.js'
import { isTranslatable } from '../shared/translation-blocks.js'

function sanitizeFilename(name) {
  return String(name ?? 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120)
}

function htmlToText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html')
    return doc.body.textContent ?? ''
  } catch {
    return String(html).replace(/<[^>]+>/g, '')
  }
}

/** Convert stored reading blocks to Markdown. */
export function contentToMarkdown(content, { translate, inlineEntries } = {}) {
  if (content === null || typeof content !== 'object') return ''
  const lines = []
  const blocks = Array.isArray(content.blocks) ? content.blocks : Array.isArray(content.pages) ? content.pages.flatMap((page) => (Array.isArray(page.blocks) ? page.blocks : [])) : []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const record = inlineEntries?.[block.id]?.record
    const math = record?.enabled && record.maths && record.source === block.text ? record : null
    const original = typeof block.text === 'string' && block.text !== '' ? block.text : htmlToText(block.html ?? '')
    const text = math ? inlineMarkdown(math.segments) : original
    if (text.trim() === '') continue
    if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, Number(block.level) || 2))
      lines.push(`${'#'.repeat(level)} ${text.replace(/\s+/g, ' ').trim()}`, '')
    } else if (block.kind === 'code') {
      lines.push('```', text, '```', '')
    } else if (block.kind === 'quote') {
      lines.push(text.split('\n').map((line) => `> ${line}`).join('\n'), '')
    } else if (block.kind === 'list' && block.html) {
      lines.push(htmlToText(block.html ?? '').trim(), '')
    } else {
      lines.push(text, '')
    }
    if (translate?.enabled && isTranslatable(block)) {
      const entry = translate.get(block.id)
      const source = math ? protectInlineMath(math) : block.text
      if (entry?.status !== 'done' || (entry.source && entry.source !== source) || !entry.text?.trim() || (math && mathTokenIssue(source, entry.text))) continue
      const segments = math ? translatedMathSegments(entry.text, math) : null
      lines.push(segments ? inlineMarkdown(segments) : entry.text.trim(), '')
    }
  }
  return lines.join('\n')
}

function inlineMarkdown(segments) {
  return segments.map(segment => segment.type === 'math' ? '$' + segment.latex + '$' : segment.text).join('')
}

/** Reading notes as Markdown (summary + annotations with notes). */
export function notesToMarkdown({ doc, annotations = [], aux = {} }) {
  const lines = [`# ${doc?.title ?? 'Untitled'} — 读书笔记`, '']
  if (typeof doc?.author === 'string' && doc.author !== '') lines.push(`作者：${doc.author}`, '')
  if (typeof doc?.progress?.percent === 'number') lines.push(`阅读进度：${Math.round(doc.progress.percent * 100)}%`, '')
  if (typeof aux?.summary === 'string' && aux.summary.trim() !== '') lines.push('## AI 摘要', '', aux.summary.trim(), '')
  const grouped = new Map()
  for (const ann of annotations) {
    const key = ann.color ?? 'yellow'
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(ann)
  }
  if (annotations.length === 0) {
    lines.push('_还没有高亮或批注。_')
  } else {
    lines.push(`## 批注（${annotations.length}）`, '')
    const colorLabels = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色', purple: '紫色' }
    for (const [color, list] of grouped) {
      lines.push(`### ${colorLabels[color] ?? color}`, '')
      for (const ann of list) {
        lines.push(`- ${String(ann.text ?? '').trim()}`)
        if (typeof ann.note === 'string' && ann.note.trim() !== '') lines.push(`  - 批注：${ann.note.trim()}`)
        if (ann.target?.kind === 'pdf' && typeof ann.target.page === 'number') lines.push(`  - 位置：第 ${ann.target.page + 1} 页`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** Download the reading notes of one document. */
export function exportNotes({ doc, annotations, aux, t }) {
  const markdown = notesToMarkdown({ doc, annotations, aux })
  downloadFile(`${sanitizeFilename(doc?.title)}-notes.md`, markdown, 'text/markdown;charset=utf-8')
  t?.('toast.exported', 'File exported')
}

/** Download the AI summary of one document. */
export function exportSummary({ doc, aux }) {
  const summary = typeof aux?.summary === 'string' ? aux.summary : ''
  const markdown = `# ${doc?.title ?? 'Untitled'} — AI 摘要\n\n${summary || '_尚未生成 AI 摘要。_'}\n`
  downloadFile(`${sanitizeFilename(doc?.title)}-summary.md`, markdown, 'text/markdown;charset=utf-8')
}

/** Download the document text as Markdown. */
export function exportText({ doc, content, translate, inlineEntries }) {
  const body = contentToMarkdown(content, { translate, inlineEntries })
  downloadFile(`${sanitizeFilename(doc?.title)}.md`, `# ${doc?.title ?? 'Untitled'}\n\n${body}\n`, 'text/markdown;charset=utf-8')
}

/** Download the original PDF/EPUB file. */
export async function exportOriginal({ api, doc }) {
  const response = await fetch(api.fileUrl(doc.id, 'original'))
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  const extension = doc.format === 'epub' ? 'epub' : 'pdf'
  downloadFile(`${sanitizeFilename(doc.title)}.${extension}`, blob, blob.type || 'application/octet-stream')
}

/** Export every document's notes into one Markdown file. */
export async function exportAllNotes({ api, docs, t }) {
  const sections = []
  for (const doc of docs ?? []) {
    try {
      const [{ annotations }, { aux }] = await Promise.all([api.rpc('annotations.list', { id: doc.id }), api.rpc('aux.get', { id: doc.id })])
      if ((annotations?.length ?? 0) === 0 && (aux?.summary ?? '') === '') continue
      sections.push(notesToMarkdown({ doc, annotations: annotations ?? [], aux: aux ?? {} }))
    } catch {
      /* skip unreadable document */
    }
  }
  const markdown = `# 阅读器 · 全部读书笔记\n\n生成时间：${new Date().toLocaleString()}\n\n${sections.join('\n\n---\n\n') || '_还没有任何笔记或 AI 摘要。_'}\n`
  downloadFile('reader-all-notes.md', markdown, 'text/markdown;charset=utf-8')
  return sections.length
}
