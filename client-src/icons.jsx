// Reader icon set: single-path stroke icons rendered as React elements (no SVG files, no deps).
import React from 'react'

const h = React.createElement

function makeIcon(children, { viewBox = '0 0 24 24', fill = 'none', strokeWidth = 1.7 } = {}) {
  const Icon = ({ size = 18, className, style, title }) =>
    h(
      'svg',
      {
        viewBox,
        width: size,
        height: size,
        fill,
        stroke: fill === 'none' ? 'currentColor' : 'none',
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        style: { display: 'block', flex: 'none', ...style },
        'aria-hidden': title === undefined,
        role: title === undefined ? undefined : 'img',
        'aria-label': title,
      },
      ...children.map((child, index) => (Array.isArray(child) ? h(child[0], { key: index, ...child[1] }) : h(child, { key: index }))),
    )
  Icon.displayName = 'ReaderIcon'
  return Icon
}

const p = (d, extra = {}) => ['path', { d, ...extra }]
const c = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }]
const l = (x1, y1, x2, y2, extra = {}) => ['line', { x1, y1, x2, y2, ...extra }]
const r = (x, y, width, height, rx, extra = {}) => ['rect', { x, y, width, height, rx, ...extra }]

export const IconLibrary = makeIcon([p('M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z'), p('M8 3v15'), p('M12 7h5'), p('M12 10.5h5')])
export const IconBook = makeIcon([p('M3 5.5A2.5 2.5 0 0 1 5.5 3H11v16H5.5A2.5 2.5 0 0 0 3 21.5v-16Z'), p('M21 5.5A2.5 2.5 0 0 0 18.5 3H13v16h5.5A2.5 2.5 0 0 1 21 21.5v-16Z')])
export const IconSearch = makeIcon([c(11, 11, 7), p('m20 20-3.8-3.8')])
export const IconSettings = makeIcon([c(12, 12, 3.2), p('M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z')])
export const IconTranslate = makeIcon([p('M4 5h8'), p('M8 3v2'), p('M6.5 5c.4 3 2.1 5.3 5 6.8'), p('M11 5c-.5 3.6-2.6 6.3-6.4 7.6'), p('M13 21l4-10 4 10'), p('M14.6 17h4.8')])
export const IconSpark = makeIcon([p('M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9L12 3.5Z'), p('M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z')])
export const IconHighlighter = makeIcon([p('M15.5 3.5 20.5 8.5 11 18H6v-5L15.5 3.5Z'), p('M4 21h16')])
export const IconUnderline = makeIcon([p('M6 4v7a6 6 0 0 0 12 0V4'), p('M5 21h14')])
export const IconNote = makeIcon([p('M5 3h9l5 5v13H5V3Z'), p('M14 3v5h5'), p('M8.5 12h7'), p('M8.5 15.5h5')])
export const IconList = makeIcon([p('M8 6h13'), p('M8 12h13'), p('M8 18h13'), p('M3.5 6h.01'), p('M3.5 12h.01'), p('M3.5 18h.01')])
export const IconChevronLeft = makeIcon([p('m14.5 5-7 7 7 7')])
export const IconChevronRight = makeIcon([p('m9.5 5 7 7-7 7')])
export const IconChevronDown = makeIcon([p('m5 9.5 7 7 7-7')])
export const IconClose = makeIcon([p('M6 6l12 12'), p('M18 6 6 18')])
export const IconPlus = makeIcon([p('M12 5v14'), p('M5 12h14')])
export const IconUpload = makeIcon([p('M12 16V4'), p('m7 9 5-5 5 5'), p('M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2')])
export const IconFolder = makeIcon([p('M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18V7.5Z')])
export const IconCloud = makeIcon([p('M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5H7Z')])
export const IconSun = makeIcon([c(12, 12, 4), p('M12 2.5v2'), p('M12 19.5v2'), p('M2.5 12h2'), p('M19.5 12h2'), p('m5 5 1.4 1.4'), p('m17.6 17.6 1.4 1.4'), p('m19 5-1.4 1.4'), p('m6.4 17.6-1.4 1.4')])
export const IconMoon = makeIcon([p('M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z')])
export const IconAuto = makeIcon([c(12, 12, 8.5), p('M12 3.5v17'), p('M12 8.5a3.5 3.5 0 0 1 0 7')])
export const IconTextSize = makeIcon([p('M4 19 9 5h1.5L15 19'), p('M6 14h7'), p('M17 19h4'), p('M17 11h3')])
export const IconPanelLeft = makeIcon([r(3, 4, 18, 16, 2), p('M9.5 4v16')])
export const IconPanelRight = makeIcon([r(3, 4, 18, 16, 2), p('M14.5 4v16')])
export const IconMore = makeIcon([c(5, 12, 1.2, { fill: 'currentColor', stroke: 'none' }), c(12, 12, 1.2, { fill: 'currentColor', stroke: 'none' }), c(19, 12, 1.2, { fill: 'currentColor', stroke: 'none' })])
export const IconDownload = makeIcon([p('M12 4v12'), p('m7 11 5 5 5-5'), p('M4 20h16')])
export const IconTrash = makeIcon([p('M4 7h16'), p('M9.5 7V4.5h5V7'), p('M6.5 7l1 13h9l1-13'), p('M10 11v5.5'), p('M14 11v5.5')])
export const IconEdit = makeIcon([p('M4 20h4L20 8l-4-4L4 16v4Z'), p('m14.5 5.5 4 4')])
export const IconCheck = makeIcon([p('m4.5 12.5 5 5 10-11')])
export const IconCopy = makeIcon([r(9, 9, 11, 11, 2), p('M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5')])
export const IconBookmark = makeIcon([p('M6.5 3.5h11v17L12 16.5 6.5 20.5v-17Z')])
export const IconRefresh = makeIcon([p('M20 11a8 8 0 0 0-14.9-4M4 5v4h4'), p('M4 13a8 8 0 0 0 14.9 4M20 19v-4h-4')])
export const IconZap = makeIcon([p('M13 2.5 4.5 13.5H11l-1 8 9-11.5H12.5l.5-7.5Z')])
export const IconArrowLeft = makeIcon([p('M20 12H4.5'), p('m10 5.5-6.5 6.5 6.5 6.5')])
export const IconFullscreen = makeIcon([p('M8.5 3.5H3.5v5'), p('M15.5 3.5h5v5'), p('M20.5 15.5v5h-5'), p('M3.5 15.5v5h5')])
export const IconExitFullscreen = makeIcon([p('M3.5 8.5h5v-5'), p('M20.5 8.5h-5v-5'), p('M15.5 20.5v-5h5'), p('M8.5 20.5v-5h-5')])
export const IconQuote = makeIcon([p('M9.5 6.5H5.5v5h4v6h-4'), p('M20 6.5h-4v5h4v6h-4')])
export const IconGlobe = makeIcon([c(12, 12, 8.5), p('M3.5 12h17'), p('M12 3.5c2.5 2.5 3.8 5.4 3.8 8.5S14.5 18 12 20.5C9.5 18 8.2 15.1 8.2 12S9.5 6 12 3.5Z')])
export const IconInfo = makeIcon([c(12, 12, 8.5), p('M12 10.5V17'), p('M12 7.5h.01')])
export const IconEye = makeIcon([p('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z'), c(12, 12, 3)])
export const IconEyeOff = makeIcon([p('M4 4l16 16'), p('M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 3.9M6.1 8.1A17.4 17.4 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6'), p('M10.6 10.6a2 2 0 0 0 2.8 2.8')])
export const IconStar = makeIcon([p('M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z')])
export const IconGrid = makeIcon([r(4, 4, 7, 7, 1.5), r(13, 4, 7, 7, 1.5), r(4, 13, 7, 7, 1.5), r(13, 13, 7, 7, 1.5)])
export const IconChat = makeIcon([p('M4 5.5h16v11H9l-5 4v-15Z'), p('M8 10h8'), p('M8 13h5')])
export const IconSend = makeIcon([p('M21 3 10.5 13.5'), p('M21 3l-6.5 18-4-7.5L3 9.5 21 3Z')])
export const IconStop = makeIcon([r(6.5, 6.5, 11, 11, 2, { fill: 'currentColor', stroke: 'none' })])
export const IconClock = makeIcon([c(12, 12, 8.5), p('M12 7.5V12l3.5 2')])
export const IconFile = makeIcon([p('M6 3h8l4.5 4.5V21H6V3Z'), p('M13.5 3v5H18'), p('M9 12.5h6'), p('M9 16h4')])
export const IconReading = makeIcon([p('M12 6.5C10 5 7.5 4.6 4.5 5.2v13c3-.6 5.5-.2 7.5 1.3 2-1.5 4.5-1.9 7.5-1.3v-13c-3-.6-5.5-.2-7.5 1.3Z'), p('M12 6.5v13')])

/** A spinner element with the shared `dr-spin` animation. */
export function Spinner({ size = 16, className = '' }) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: size, height: size, className: `dr-spin ${className}`, 'aria-hidden': true },
    h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.18 }),
    h('path', { d: 'M21 12a9 9 0 0 0-9-9', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
  )
}

/** Document cover artwork fallback: a deterministic gradient monogram. */
export function CoverArt({ title = '', format = 'pdf', size = 96, className = '' }) {
  const label = String(title || '?').trim()
  const monogram = label.slice(0, 2).toUpperCase()
  let hash = 0
  for (let index = 0; index < label.length; index++) hash = (hash * 31 + label.charCodeAt(index)) >>> 0
  const hue = hash % 360
  const palette = `linear-gradient(145deg, hsl(${hue} 62% 58%), hsl(${(hue + 48) % 360} 58% 42%))`
  return h(
    'div',
    { className: `dr-cover-art ${className}`, style: { background: palette, width: '100%', height: '100%' } },
    h('div', { className: 'dr-cover-art-inner' }, h('span', { className: 'dr-cover-monogram' }, monogram || '📖'), h('span', { className: 'dr-cover-format' }, format.toUpperCase())),
  )
}
