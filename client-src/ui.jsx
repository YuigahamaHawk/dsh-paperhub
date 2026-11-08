// Reader UI primitives. Written from scratch against the host theme tokens (`--dsw-alias-*`)
// so the reader looks like part of the Harness UI rather than an embedded app.
import React from 'react'
import { clsx } from './util.js'
import { IconClose, Spinner } from './icons.jsx'

const h = React.createElement

/** Text/icon button. */
export function Button({ variant = 'default', size = 'md', icon, iconRight, children, className, type = 'button', ...rest }) {
  return h(
    'button',
    { type, className: clsx('dr-btn', `dr-btn-${variant}`, `dr-btn-${size}`, children === undefined && icon !== undefined && 'dr-btn-icononly', className), ...rest },
    icon !== undefined ? h('span', { className: 'dr-btn-icon' }, icon) : null,
    children !== undefined && children !== null ? h('span', { className: 'dr-btn-label' }, children) : null,
    iconRight !== undefined ? h('span', { className: 'dr-btn-icon' }, iconRight) : null,
  )
}

/** Square icon-only button with an accessible label. */
export function IconButton({ icon, label, active = false, className, size = 'md', ...rest }) {
  return h(
    'button',
    { type: 'button', className: clsx('dr-iconbtn', `dr-iconbtn-${size}`, active && 'is-active', className), 'aria-label': label, title: label, ...rest },
    icon,
  )
}

/** Single-line text input. */
export const Input = React.forwardRef(function Input({ className, leadIcon, trailing, ...rest }, ref) {
  return h(
    'label',
    { className: clsx('dr-input', className) },
    leadIcon !== undefined ? h('span', { className: 'dr-input-lead' }, leadIcon) : null,
    h('input', { ref, ...rest }),
    trailing !== undefined ? h('span', { className: 'dr-input-trailing' }, trailing) : null,
  )
})

/** Multi-line text area. */
export function Textarea({ className, rows = 3, ...rest }) {
  return h('textarea', { className: clsx('dr-textarea', className), rows, ...rest })
}

/** Native select styled to match. */
export function Select({ options = [], value, onChange, className, ...rest }) {
  return h(
    'select',
    { className: clsx('dr-select', className), value, onChange: (event) => onChange?.(event.target.value), ...rest },
    options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

/** Boolean switch. */
export function Switch({ checked, onChange, label, description, disabled = false }) {
  return h(
    'label',
    { className: clsx('dr-switch-row', disabled && 'is-disabled') },
    h(
      'span',
      { className: 'dr-switch-text' },
      label !== undefined ? h('span', { className: 'dr-switch-label' }, label) : null,
      description !== undefined ? h('span', { className: 'dr-switch-desc' }, description) : null,
    ),
    h(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': typeof label === 'string' ? label : 'switch',
        className: clsx('dr-switch', checked && 'is-on'),
        onClick: () => !disabled && onChange?.(!checked),
        disabled,
      },
      h('span', { className: 'dr-switch-knob' }),
    ),
  )
}

/** Range slider with an optional value label. */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, label, display, className }) {
  return h(
    'label',
    { className: clsx('dr-slider-row', className) },
    label !== undefined ? h('span', { className: 'dr-slider-head' }, h('span', null, label), display !== undefined ? h('span', { className: 'dr-slider-value' }, display) : null) : null,
    h('input', {
      type: 'range',
      className: 'dr-slider',
      min,
      max,
      step,
      value,
      onChange: (event) => onChange?.(Number(event.target.value)),
      'aria-label': typeof label === 'string' ? label : 'slider',
    }),
  )
}

/** Dialog with backdrop, Escape close and a focus-friendly title row. */
export function Modal({ open, onClose, title, children, footer, width = 620, className, bodyClassName }) {
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return h(
    'div',
    { className: 'dr-modal-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() } },
    h(
      'div',
      { className: clsx('dr-modal', className), style: { width }, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : undefined },
      title !== undefined
        ? h('div', { className: 'dr-modal-head' }, h('div', { className: 'dr-modal-title' }, title), h(IconButton, { icon: h(IconClose, { size: 16 }), label: 'Close', onClick: onClose }))
        : null,
      h('div', { className: clsx('dr-modal-body', bodyClassName) }, children),
      footer !== undefined ? h('div', { className: 'dr-modal-foot' }, footer) : null,
    ),
  )
}

/** Side sheet. */
export function Drawer({ open, onClose, title, children, side = 'right', width = 380 }) {
  if (!open) return null
  return h(
    'div',
    { className: 'dr-drawer-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() } },
    h(
      'aside',
      { className: clsx('dr-drawer', `dr-drawer-${side}`), style: { width }, role: 'dialog', 'aria-modal': 'true' },
      h('div', { className: 'dr-drawer-head' }, h('div', { className: 'dr-drawer-title' }, title), h(IconButton, { icon: h(IconClose, { size: 16 }), label: 'Close', onClick: onClose })),
      h('div', { className: 'dr-drawer-body' }, children),
    ),
  )
}

/** Underlined/segmented tab row. */
export function Tabs({ tabs = [], value, onChange, variant = 'underline', className }) {
  return h(
    'div',
    { className: clsx('dr-tabs', `dr-tabs-${variant}`, className), role: 'tablist' },
    tabs.map((tab) =>
      h(
        'button',
        {
          key: tab.id,
          type: 'button',
          role: 'tab',
          'aria-selected': tab.id === value,
          className: clsx('dr-tab', tab.id === value && 'is-active'),
          onClick: () => onChange?.(tab.id),
          title: tab.title,
        },
        tab.icon !== undefined ? h('span', { className: 'dr-tab-icon' }, tab.icon) : null,
        tab.label !== undefined ? h('span', { className: 'dr-tab-label' }, tab.label) : null,
        tab.badge !== undefined && tab.badge !== 0 ? h('span', { className: 'dr-tab-badge' }, tab.badge) : null,
      ),
    ),
  )
}

/** Lightweight popover anchored inside a relatively positioned wrapper. */
export function Popover({ open, children, align = 'end', className }) {
  if (!open) return null
  return h('div', { className: clsx('dr-popover', `dr-popover-${align}`, className), role: 'menu' }, children)
}

/** One row inside a Popover. */
export function MenuItem({ icon, children, danger = false, onClick, disabled, shortcut }) {
  return h(
    'button',
    { type: 'button', role: 'menuitem', className: clsx('dr-menuitem', danger && 'is-danger'), onClick, disabled },
    icon !== undefined ? h('span', { className: 'dr-menuitem-icon' }, icon) : null,
    h('span', { className: 'dr-menuitem-label' }, children),
    shortcut !== undefined ? h('span', { className: 'dr-menuitem-shortcut' }, shortcut) : null,
  )
}

/** Centered empty state with an optional action. */
export function EmptyState({ icon, title, body, action, className }) {
  return h(
    'div',
    { className: clsx('dr-empty', className) },
    icon !== undefined ? h('div', { className: 'dr-empty-icon' }, icon) : null,
    title !== undefined ? h('div', { className: 'dr-empty-title' }, title) : null,
    body !== undefined ? h('div', { className: 'dr-empty-body' }, body) : null,
    action !== undefined ? h('div', { className: 'dr-empty-action' }, action) : null,
  )
}

/** Circular progress with a centered label. */
export function ProgressRing({ value = 0, size = 40, stroke = 3.5, label }) {
  const clamped = Math.min(1, Math.max(0, Number(value) || 0))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  return h(
    'span',
    { className: 'dr-ring', style: { width: size, height: size } },
    h(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': true },
      h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: stroke }),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: circumference,
        strokeDashoffset: circumference * (1 - clamped),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
    label !== undefined ? h('span', { className: 'dr-ring-label' }, label) : h('span', { className: 'dr-ring-label' }, `${Math.round(clamped * 100)}`),
  )
}

/** Small status badge. */
export function Badge({ children, tone = 'neutral', className }) {
  return h('span', { className: clsx('dr-badge', `dr-badge-${tone}`, className) }, children)
}

/** Horizontal progress bar. */
export function ProgressBar({ value = 0, className, tone = 'brand' }) {
  const clamped = Math.min(1, Math.max(0, Number(value) || 0))
  return h('div', { className: clsx('dr-progress', `dr-progress-${tone}`, className), role: 'progressbar', 'aria-valuenow': Math.round(clamped * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { className: 'dr-progress-fill', style: { width: `${clamped * 100}%` } }))
}

/** Segmented control. */
export function SegmentedControl({ value, onChange, options = [], className, size = 'md' }) {
  return h(
    'div',
    { className: clsx('dr-segmented', `dr-segmented-${size}`, className), role: 'group' },
    options.map((option) =>
      h(
        'button',
        { key: option.value, type: 'button', className: clsx('dr-segment', option.value === value && 'is-active'), onClick: () => onChange?.(option.value), title: option.title, 'aria-pressed': option.value === value },
        option.icon !== undefined ? h('span', { className: 'dr-segment-icon' }, option.icon) : null,
        option.label !== undefined ? h('span', null, option.label) : null,
      ),
    ),
  )
}

/** Keyboard hint. */
export function Kbd({ children }) {
  return h('kbd', { className: 'dr-kbd' }, children)
}

/** Inline spinner block. */
export function LoadingBlock({ label }) {
  return h('div', { className: 'dr-loading' }, h(Spinner, { size: 18 }), label !== undefined ? h('span', null, label) : null)
}

/** Toast host. */
export function ToastHost({ toasts = [], onDismiss }) {
  if (toasts.length === 0) return null
  return h(
    'div',
    { className: 'dr-toasts', role: 'status', 'aria-live': 'polite' },
    toasts.map((toast) =>
      h(
        'div',
        { key: toast.id, className: clsx('dr-toast', `dr-toast-${toast.kind ?? 'info'}`) },
        h('span', { className: 'dr-toast-text' }, toast.message),
        h('button', { type: 'button', className: 'dr-toast-close', onClick: () => onDismiss?.(toast.id), 'aria-label': 'Dismiss' }, h(IconClose, { size: 13 })),
      ),
    ),
  )
}

/** A hairline separator with an optional label. */
export function Divider({ label }) {
  return h('div', { className: 'dr-divider' }, label !== undefined ? h('span', { className: 'dr-divider-label' }, label) : null)
}

/** Definition-style settings row with a control on the right. */
export function Row({ label, description, children, className }) {
  return h(
    'div',
    { className: clsx('dr-row', className) },
    h('div', { className: 'dr-row-text' }, h('div', { className: 'dr-row-label' }, label), description !== undefined ? h('div', { className: 'dr-row-desc' }, description) : null),
    h('div', { className: 'dr-row-control' }, children),
  )
}
