// Client entry for dsh-paperhub.
//
// Registers the left-sidebar entry (`sidebar.panellist` id "reader"), the main-panel reader
// (`main` key "reader"), the shared stylesheet, a live diagnostics inspect provider and a
// client self-test that proves RPC, authenticated routes and the bundled pdf.js assets work.
import React from 'react'
import {shellRenderHealth} from '../shared/render-health.js'
import {version} from '../package.json'
import { createApi } from './api.js'
import { createT } from './i18n.js'
import { createDiag } from './diag.js'
import { ReaderApp, createReaderWorkspace } from './app.jsx'
import { READER_CSS } from './styles.js'

const h = React.createElement

/** The left-sidebar entry icon (inherits the host's label color and active state). */
function ReaderNavIcon({ size = 18, active = false }) {
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 1.9 : 1.65,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', { d: 'M4 5.2c2.6-.85 5-.7 8 .9 3-1.6 5.4-1.75 8-.9v13.5c-2.6-.85-5-.65-8 .9-3-1.55-5.4-1.75-8-.9V5.2Z' }),
    h('path', { d: 'M12 6.1v13.5' }),
    active ? h('path', { d: 'M18.45 2.6l.72 1.78 1.78.72-1.78.72-.72 1.78-.72-1.78-1.78-.72 1.78-.72.72-1.78Z', fill: 'currentColor', stroke: 'none' }) : null,
  )
}

/** Services this client module requires; activation waits for them. */
export const inject = ['slots', 'locale', 'theme']

/** Mount the reader UI into the DSH web shell. */
export function apply(ctx) {
  // Defensive activation: an exception thrown here during web boot is fatal for the whole
  // application (boot crash loop). Report it and keep the shell alive instead; the panel simply
  // stays absent until the next fixed build.
  try {
    activate(ctx)
  } catch (error) {
    try {
      console.error('[dsh-reader] activation failed:', error)
    } catch {
      /* console may be unavailable */
    }
    try {
      createApi()
        .report('client-activation-failed', {
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 2000),
        })
        .catch(() => undefined)
    } catch {
      /* best effort */
    }
  }
}

function activate(ctx) {
  const t = createT(ctx)
  const api = createApi()
  const diag = createDiag({ api, t, version })
  const workspace = createReaderWorkspace()
  ctx.effect(()=>()=>api.dispose?.(),'dsh-reader: transport cleanup')
  ctx.effect(() => () => {
    for (const session of workspace.readers.values()) session.translate?.dispose()
    for (const controller of workspace.visionRuns.values()) controller.abort()
    workspace.readers.clear()
  }, 'dsh-reader: workspace cleanup')

  ctx.effect(() => diag.install(), 'dsh-reader: error capture')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.reader = 'dsh-paperhub'
    tag.textContent = READER_CSS
    document.head.append(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-reader: stylesheet')

  // Left sidebar entry: the sidebar itself dispatches selectPanel('reader') on click.
  ctx.slots.inject('sidebar.panellist', () => {
    diag.state.mount.panelRegistered = true
    return ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'reader',
        order: 5,
        label: () => t('nav.library', 'Library'),
      },
      ReaderNavIcon,
    )
  })

  // Main panel: full immersive reader + library.
  ctx.slots.inject('main', () => {
    diag.state.mount.mainRegistered = true
    return ctx.slots.register({ name: 'main', key: 'reader' }, () => h(ReaderApp, { api, t, diag, ctx, workspace }))
  })

  // Optional live inspection: exposes diagnostics to cordis_inspect_query(client).
  try {
    const inspect = ctx.get('cordisInspect')
    if (inspect !== undefined && inspect !== null && typeof inspect.register === 'function') {
      ctx.effect(() => inspect.register(diag.inspectProvider), 'dsh-reader: inspect provider')
      diag.report('inspect-provider', { ok: true })
    } else {
      diag.report('inspect-provider', { ok: false, reason: 'cordisInspect unavailable' })
    }
  } catch (error) {
    diag.report('inspect-provider', { ok: false, reason: String(error?.message ?? error) })
  }

  // Do NOT fetch pdf.js assets or render PDF pages automatically during web boot: if the page
  // loads while the host is still starting/restarting, those cross-origin asset requests fail with
  // console errors and DSH reports the plugin entry as failed ("web boot: entry did not activate").
  // Self-test stays available on demand through the ReaderDiag inspect provider / e2e probe.

  // Render the whole UI tree into a detached container: proves every component module mounts
  // without crashing (the web shell only logs slot render crashes page-locally).
  scheduleRenderTest(ctx, api, t, diag)

  diag.report('client-activated', { locale: t.locale, href: typeof window !== 'undefined' ? window.location.pathname : null })
}

/**
 * Mount <ReaderApp> off-screen through the shell's own react-dom, verify it produced the expected
 * DOM, report the outcome, then unmount. Runs on every activation (including HMR reloads).
 */
function scheduleRenderTest(ctx, api, t, diag) {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    window.setTimeout(() => {
      try {
        const requireFn = globalThis.__dshReaderRequire
        if (typeof requireFn !== 'function') {
          diag.report('render-test', { ok: false, reason: 'module require unavailable' })
          return
        }
        let ReactDOMClient = null
        try {
          ReactDOMClient = requireFn('react-dom/client')
        } catch (error) {
          diag.report('render-test', { ok: false, reason: `react-dom/client unavailable: ${error?.message ?? error}` })
          return
        }
        const container = document.createElement('div')
        container.setAttribute('data-dsh-reader-rendertest', '')
        container.style.cssText = 'position:fixed;left:-4000px;top:0;width:1180px;height:820px;overflow:hidden;opacity:0;pointer-events:none;'
        document.body.append(container)
        const errorsBefore = diag.state.errors.length
        const root = ReactDOMClient.createRoot(container)
        root.render(h(ReaderApp, { api, t, diag, ctx }))
        window.setTimeout(() => {
          let result
          try {
            const html = container.innerHTML || ''
            result = {
              ...shellRenderHealth(html),
              at: Date.now(),
              htmlLength: html.length,
              errors: diag.state.errors.slice(errorsBefore).map((entry) => entry.message).slice(0, 6),
            }
          } catch (error) {
            result = { ok: false, error: String(error?.message ?? error) }
          }
          diag.state.renderTest = result
          diag.report('render-test', result)
          try {
            root.unmount()
          } catch {
            /* ignore */
          }
          container.remove()
        }, 1700)
      } catch (error) {
        const result = { ok: false, error: String(error?.message ?? error) }
        diag.state.renderTest = result
        diag.report('render-test', result)
      }
    }, 3000)
  } catch {
    /* non-browser */
  }
}
