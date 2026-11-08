// Formula visuals are atomic source spans. Existing annotation offsets stay in the
// unchanged extraction text, rather than MathML's DOM text or toolbar labels.
const EXCLUDE = '.dr-block-translation,.dr-highlight-layer,.dr-inline-tools'

export function collectSourceSegments(root) {
  const segments = []; let text = ''
  function visit(node) {
    if (node.nodeType === 1) {
      if (node.matches(EXCLUDE) && !(node===root&&root.getAttribute('data-annotation-layer')==='translation')) return
      if (node.hasAttribute('data-math-source')) {
        const value = node.getAttribute('data-math-source')
        segments.push({ element: node, start: text.length, end: text.length + value.length })
        text += value; return
      }
    }
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? ''
      if (value) segments.push({ node, start: text.length, end: text.length + value.length })
      text += value; return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  if (root) visit(root)
  return { segments, text }
}

export function sourcePoint(segments, offset, edge = 'start') {
  const segment = segments.find(s => offset >= s.start && (offset < s.end || offset === s.end && edge === 'end')) ?? segments.at(-1)
  if (!segment) return null
  if (segment.node) return { node: segment.node, offset: Math.max(0, Math.min(segment.end - segment.start, offset - segment.start)) }
  const element = segment.element, parent = element.parentNode
  const index = [...parent.childNodes].indexOf(element)
  return { node: parent, offset: index + (offset >= segment.end || edge === 'end' && offset > segment.start ? 1 : 0) }
}

export function sourceOffset(root, container, offset, edge = 'start') {
  const { segments, text } = collectSourceSegments(root)
  for (const segment of segments) {
    if (segment.node === container) return segment.start + Math.min(offset, segment.end - segment.start)
    if (segment.element?.contains(container)) return edge === 'end' ? segment.end : segment.start
  }
  // Element-boundary selections (including select-all) need a logical prefix.
  try {
    const range = document.createRange(); range.selectNodeContents(root); range.setEnd(container, offset)
    return collectSourceSegments(range.cloneContents()).text.length
  } catch { return text.length }
}
