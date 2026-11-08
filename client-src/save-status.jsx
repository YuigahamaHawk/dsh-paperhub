import React from 'react'
import {Button, IconButton} from './ui.jsx'
import {IconClose, IconInfo, Spinner} from './icons.jsx'

const h = React.createElement

/** Fixed header slot; saving and recovery never change the reading surface's geometry. */
export function SaveStatus({connection, pending, failed, durable, onRetry, t}) {
  const [slowSave, setSlowSave] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const wrapper = React.useRef(null)
  const trigger = React.useRef(null)
  const detailsId = React.useId()
  const disconnected = connection.status !== 'connected'
  const attention = disconnected || failed

  React.useEffect(() => {
    if (!pending) { setSlowSave(false); return }
    const timer = setTimeout(() => setSlowSave(true), 800)
    return () => clearTimeout(timer)
  }, [pending])

  React.useEffect(() => {
    if (attention) setOpen(true)
    else if (!pending) setOpen(false)
  }, [attention, pending])

  React.useEffect(() => {
    if (!open) return
    const outside = event => { if (!wrapper.current?.contains(event.target)) setOpen(false) }
    const escape = event => {
      if (event.key !== 'Escape') return
      setOpen(false)
      if (wrapper.current?.contains(document.activeElement)) trigger.current?.focus({preventScroll:true})
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  const kind = attention ? 'attention' : pending && slowSave ? 'saving' : 'idle'
  const message = connection.status === 'unauthorized'
    ? t('connection.auth','Login expired. Reconnect after signing in.')
    : disconnected ? t('connection.offline','Reader connection interrupted. Reconnecting…')
      : failed ? t('connection.unsaved','Some annotation changes still need to be saved.')
        : t('connection.saving','Saving annotations…')
  const detail = !durable
    ? t('connection.memory','Changes are held in this window; wait for saving before closing.')
    : disconnected ? t('connection.localOffline','Annotation changes are saved locally and will resume when reconnected.')
      : t('connection.local','Annotation changes are saved locally, awaiting confirmation from the library.')

  return h('div', {className:'dr-save-status', ref:wrapper, 'data-status':kind},
    h('span', {className:'dr-save-announcement', role:'status'}, kind === 'idle' ? '' : message),
    kind !== 'idle' ? h('button', {
      type:'button', className:'dr-iconbtn dr-save-indicator', ref:trigger,
      title:message, 'aria-label':message, 'aria-expanded':open,
      'aria-controls':detailsId, onClick:() => setOpen(value => !value),
    }, kind === 'saving' ? h(Spinner,{size:15}) : h(IconInfo,{size:17})) : null,
    open && (attention || pending) ? h('div', {
      className:'dr-connection-banner dr-save-details', id:detailsId, role:'region',
      'aria-label':t('connection.details','Save and connection status'),
    },
      h(IconButton,{className:'dr-save-dismiss',size:'sm',icon:h(IconClose,{size:13}),label:t('common.close','Close'),onClick:()=>{setOpen(false);trigger.current?.focus({preventScroll:true})}}),
      h('strong',null,message),
      pending ? h('p',null,detail) : null,
      attention ? h(Button,{size:'sm',onClick:onRetry},t('connection.retry','Retry connection')) : null,
    ) : null)
}
