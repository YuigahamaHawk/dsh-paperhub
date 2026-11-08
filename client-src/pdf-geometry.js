// PDF text uses the page's unrotated user space. Canvas/vision coordinates use
// the rendered viewport, including Rotate, CropBox offsets and UserUnit. Keep
// both extraction baselines and glyph bounds in that ONE rendered frame.
export function multiplyTransform(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function unionRects(rects) {
  const list = rects.filter(r => r && r.w > 0 && r.h > 0)
  if (!list.length) return null
  const x = Math.max(0, Math.min(...list.map(r => r.x)))
  const y = Math.max(0, Math.min(...list.map(r => r.y)))
  const right = Math.min(1, Math.max(...list.map(r => r.x + r.w)))
  const bottom = Math.min(1, Math.max(...list.map(r => r.y + r.h)))
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null
}

export function viewportTextItems(items, styles, viewport) {
  const matrix = viewport?.transform
  if (!Array.isArray(matrix)) return items
  const width = viewport.width, height = viewport.height
  const scale = Math.hypot(matrix[0], matrix[1]) || 1
  // LaTeXiT may expose invisible XML metadata split across several PDF text
  // items. Remove only complete metadata elements, keeping item-to-glyph
  // correspondence for all visible text.
  const joined = items.map(item => item.str ?? '').join('')
  const metadata = [...joined.matchAll(/<latexit\b[^>]*>[\s\S]*?<\/latexit>/gi)].map(match => [match.index, match.index + match[0].length])
  let offset = 0
  return items.map(item => {
    const start = offset; offset += String(item.str ?? '').length
    if (!Array.isArray(item.transform) || typeof item.str !== 'string') return item
    let text = item.str
    for (const [from, to] of metadata.slice().reverse()) {
      const a = Math.max(0, from - start), b = Math.min(text.length, to - start)
      if (b > a) text = text.slice(0, a) + text.slice(b)
    }
    item = { ...item, str: text }
    const t = multiplyTransform(matrix, item.transform)
    const font = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 1
    const advanceLength = Math.hypot(t[0], t[1]) || font
    const advance = [t[0] / advanceLength * (Number(item.width) || 0) * scale, t[1] / advanceLength * (Number(item.width) || 0) * scale]
    const up = [t[2] / font, t[3] / font]
    const style = styles?.[item.fontName] ?? {}
    const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.9
    const descent = Number.isFinite(style.descent) ? style.descent : -0.25
    const points = [ascent, descent].flatMap(metric => [0, 1].map(end => [t[4] + up[0] * font * metric + advance[0] * end, t[5] + up[1] * font * metric + advance[1] * end]))
    const x0 = Math.max(0, Math.min(...points.map(p => p[0])) / width)
    const y0 = Math.max(0, Math.min(...points.map(p => p[1])) / height)
    const x1 = Math.min(1, Math.max(...points.map(p => p[0])) / width)
    const y1 = Math.min(1, Math.max(...points.map(p => p[1])) / height)
    return {
      ...item,
      // Existing line/paragraph helpers use a bottom-left baseline. This is a
      // virtual upright PDF frame, NOT the original unrotated coordinates.
      transform: [t[0], -t[1], t[2], -t[3], t[4], height - t[5]],
      width: (Number(item.width) || 0) * scale,
      height: font,
      sourceRect: x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined,
    }
  })
}
