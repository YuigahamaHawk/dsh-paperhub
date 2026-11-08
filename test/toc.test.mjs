import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outlineLevels, remapPdfBookmarks } from '../client-src/toc.js'
import { applyVisionLayout } from '../client-src/vision-layout.js'

test('flat scientific headings show decimal, IEEE and appendix nesting', () => {
  const titles = [
    '1 Introduction', '2. Methods', '2.1 Dataset', '2.1.1 Preprocessing', '2.2 Model', '3. Results',
    'I. Introduction', 'II. Method', 'A. Overview', '1) Routing', 'B. Procedure', 'III. Results',
    'Appendix A', 'A.1 Extra experiments', 'A.1.1 Additional details', 'Appendix B', 'B.1 Related tables',
  ]
  const entries = titles.map(title => ({ title, level: 2 }))
  assert.deepEqual(outlineLevels(entries, 'pdf'), [1, 1, 2, 3, 2, 1, 1, 1, 2, 3, 2, 1, 1, 2, 3, 1, 2])
})

test('native EPUB and PDF outlines retain their authored depths', () => {
  const entries = [{ title: 'Part 1', level: 2 }, { title: '1. Introduction', level: 3 }, { title: 'A. Details', level: 4 }]
  assert.deepEqual(outlineLevels(entries, 'epub'), [1, 2, 3])
  assert.deepEqual(outlineLevels(entries.map((entry, index) => ({ ...entry, id: 'pdf-toc-' + index })), 'pdf'), [1, 2, 3])
})

test('PDF bookmarks recover exact headings on the same page after reflow', () => {
  const pages = [{ n: 3, blocks: [{ id: 'old-first', kind: 'paragraph', text: 'First body' }] }]
  const toc = [
    { id: 'pdf-toc-0', blockId: 'old-first', title: 'Method', level: 1 },
    { id: 'pdf-toc-1', blockId: 'old-first', title: 'Data  Sources', level: 2 },
  ]
  const content = { kind: 'pdf', pages, toc }
  const newPage = { n: 3, blocks: [
    { id: 'new-body', kind: 'paragraph', text: 'First body' },
    { id: 'method', kind: 'heading', text: 'Method', level: 2 },
    { id: 'data', kind: 'heading', text: 'Data Sources', level: 2 },
  ] }
  const remapped = remapPdfBookmarks(content, [newPage])
  assert.deepEqual(remapped.map(entry => [entry.id, entry.blockId, entry.level, entry.page]), [
    ['pdf-toc-0', 'method', 1, 3], ['pdf-toc-1', 'data', 2, 3],
  ])
  const result = applyVisionLayout({ ...content, pages: [newPage], toc: remapped }, { pages: [] })
  assert.deepEqual(result.content.toc, remapped)
})
