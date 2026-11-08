import React from 'react'
import { useApp, useReader } from './store.jsx'
import { Button, IconButton, Select } from './ui.jsx'
import { IconBook, IconClose, IconGrid, IconQuote, IconSend, IconSpark, IconStop, IconTrash } from './icons.jsx'
import { Markdown } from './markdown.jsx'
import { canAskWithImage, decodeRoute, encodeRoute, modelRouteOptions, withCurrentRoute } from './model-routes.js'
import { CHAT_FIGURE_LIMIT } from '../shared/chat-context.js'
import { uid } from './util.js'

const EMPTY_CHAT = []
const DOC_ROUTE = { providerId: 'dsh', model: '' }
const FIGURE_URL = /^data:image\/(?:png|jpeg);base64,/

function tokensOf(usage) {
  return usage?.totalTokens ?? usage?.total_tokens ??
    ((usage?.inputTokens ?? usage?.prompt_tokens ?? 0) + (usage?.outputTokens ?? usage?.completion_tokens ?? 0))
}

function sourceHeading(source, t) {
  const title = source.title ?? t('ai.context.selection', 'Selection')
  return source.page ? `${title} · P${source.page}` : title
}

function sourcePrompt(source, t) {
  if (source.kind === 'point') return t('ai.quick.point', 'Explain this finding')
  if (source.kind === 'media') return source.mediaKind === 'table'
    ? t('ai.quick.table', 'Explain this table') : t('ai.quick.figure', 'Explain this figure')
  return t('ai.quick.explain', 'Explain this passage')
}

function Message({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`dr-chat-msg${isUser ? ' is-user' : ''}`}>
      {message.quote ? <div className="dr-chat-quote" title={message.quote}>{message.quote}</div> : null}
      <div className={`dr-chat-bubble${isUser ? '' : ' dr-md'}`}>
        {isUser ? message.content : <Markdown text={message.content} />}
      </div>
      {!isUser && message.model ? <small className="dr-chat-meta">{message.model}</small> : null}
    </div>
  )
}

export function AiPanel({ onClose }) {
  const { api, t, state, actions } = useApp()
  const reader = useReader()
  const { doc, session, askSource } = reader
  const { ai } = state.settings
  const [input, setInput] = React.useState(session?.ui.chatDraft ?? '')
  const [streaming, setStreaming] = React.useState(null)
  const [error, setError] = React.useState('')
  const [receipt, setReceipt] = React.useState(null)
  const [figureNotice, setFigureNotice] = React.useState('')
  const [modelsInfo, setModelsInfo] = React.useState(null)
  const controllerRef = React.useRef(null)
  const mounted = React.useRef(true)
  const bodyRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const seenRequest = React.useRef(null)

  const messages = Array.isArray(state.aux?.chat) ? state.aux.chat : EMPTY_CHAT
  const modelRef = ai.active.chat ?? DOC_ROUTE
  const selectedRoute = encodeRoute(modelRef)
  const modelOptions = withCurrentRoute(modelRouteOptions(t, modelsInfo?.dsh, ai.providers), selectedRoute)
  const contextMode = ai.chat.contextMode === 'section' ? 'section' : 'doc'
  const imageCapable = canAskWithImage(modelRef, ai.active.vision, modelsInfo?.dsh, ai.providers)
  const busy = streaming !== null
  const draft = value => {
    setInput(value)
    if (session) session.ui.chatDraft = value
  }

  React.useEffect(() => {
    const controller = new AbortController()
    api.rpc('ai.models', {}, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setModelsInfo(value) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [api])

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controllerRef.current?.abort()
    }
  }, [])

  React.useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [messages.length, streaming, error])

  async function send(raw, { source = askSource, translate = false, summarize = false, clearInput = false } = {}) {
    const question = raw.trim()
    if (!question || !doc || controllerRef.current) return
    const controller = new AbortController()
    const { signal } = controller
    controllerRef.current = controller
    setStreaming('')
    setError('')
    setFigureNotice('')
    setReceipt(null)
    if (clearInput) draft('')
    const quote = source ? [sourceHeading(source, t), source.text].filter(Boolean).join('\n\n') : ''
    const user = { id: uid('msg'), role: 'user', content: question, quote, createdAt: Date.now() }
    const history = [...messages, user].slice(-24).map(message => ({
      role: message.role, content: message.content.slice(0, 16000),
    }))
    let partial = ''
    try {
      void actions.appendChat(user, doc.id)
      signal.throwIfAborted()
      let result
      if (translate) {
        const response = await api.rpc('ai.translate', {
          texts: [source.text], targetLang: ai.targetLang, ref: { docId: doc.id },
        }, { signal })
        if (response?.errors?.[0]?.message) throw new Error(response.errors[0].message)
        result = { text: response?.translations?.[0], model: response?.model }
      } else if (summarize && state.aux?.summary) {
        result = { text: state.aux.summary }
      } else {
        let figureImage
        if (source?.kind === 'media' && imageCapable) {
          const entry = reader.media.find(item => item.id === source.id)
          const image = entry ? await reader.mediaImages?.image(entry).catch(() => '') : ''
          if (typeof image === 'string' && image.length <= CHAT_FIGURE_LIMIT && FIGURE_URL.test(image)) figureImage = image
          else if (!signal.aborted) setFigureNotice(t('ai.figureUnavailable', 'The figure could not be attached. This answer uses its description.'))
        }
        signal.throwIfAborted()
        const context = source ? {
          docId: doc.id, title: doc.title, text: quote, sourceKind: source.kind, figureImage,
        } : reader.buildContext(summarize ? 'doc' : contextMode)
        result = await api.stream('ai.chat', { messages: history, modelRef, context }, {
          onDelta: delta => {
            if (signal.aborted) return
            partial += delta
            setStreaming(partial)
          },
        }, signal)
      }
      signal.throwIfAborted()
      const answer = result?.text?.trim() || partial.trim()
      if (!answer) {
        setError(t('ai.error.empty', 'The model returned an empty answer. Try again.'))
        return
      }
      void actions.appendChat({ id: uid('msg'), role: 'assistant', content: answer, model: result?.model, createdAt: Date.now() }, doc.id)
      if (summarize && !state.aux?.summary) void actions.saveDocAux({ summary: answer }, doc.id)
      const tokens = tokensOf(result?.usage)
      if (Number.isFinite(tokens) && tokens > 0) setReceipt(t('ai.tokens', '{count} tokens', { count: tokens.toLocaleString() }))
    } catch (cause) {
      if (partial.trim()) void actions.appendChat({ id: uid('msg'), role: 'assistant', content: partial, createdAt: Date.now() }, doc.id)
      if (mounted.current && !signal.aborted) setError(t('ai.error', 'The model call failed: {message}', { message: cause.message ?? String(cause) }))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (mounted.current) setStreaming(null)
    }
  }

  React.useEffect(() => {
    const request = reader.askRequest
    if (!request || request.id === seenRequest.current) return
    if (request.action === 'translate' && busy) return
    seenRequest.current = request.id
    reader.clearAskRequest()
    inputRef.current?.focus({ preventScroll: true })
    if (request.action === 'translate') {
      void send(t('ai.quick.translate', 'Translate this passage'), { source: request.source, translate: true })
    }
  }, [reader.askRequest, busy])

  const changeModel = value => actions.patchSettings({ ai: { active: { chat: decodeRoute(value) } } }, { immediate: true })
  const heading = askSource ? sourceHeading(askSource, t) : ''
  const modelLabel = modelOptions.find(option => option.value === selectedRoute)?.label

  return (
    <aside className="dr-aipanel" aria-label={t('ai.title', 'AI assistant')}>
      <header className="dr-aipanel-head">
        <span className="dr-ai-mark" aria-hidden="true"><IconSpark size={17} /></span>
        <div className="dr-ai-head-main">
          <strong>{t('ai.title', 'AI assistant')}</strong>
          <Select className="dr-ai-model" aria-label={t('settings.model.activeChat', 'Chat model')}
            title={modelLabel} value={selectedRoute} options={modelOptions} onChange={changeModel} disabled={busy} />
        </div>
        <IconButton size="sm" icon={<IconTrash size={15} />} label={t('ai.clearChat', 'Clear chat')}
          disabled={busy || !messages.length} onClick={() => {
            setError('')
            setReceipt(null)
            void actions.saveDocAux({ chat: [] }, doc.id)
          }} />
        <IconButton size="sm" icon={<IconClose size={16} />} label={t('common.close', 'Close')} onClick={onClose} />
      </header>
      <div className="dr-aipanel-body" ref={bodyRef} role="log" aria-label={t('ai.history', 'Conversation')}>
        {!messages.length && !busy && !error ? (
          <div className="dr-ai-empty">
            <IconSpark size={25} />
            <strong>{t('ai.ready', 'Ask about this document')}</strong>
            <p>{t('ai.noMessages', 'Select a passage, figure or key point to ask about it.')}</p>
            {!askSource && doc ? <Button variant="ghost" size="sm" icon={<IconBook size={14} />}
              onClick={() => void send(t('ai.quick.summary', 'Summarize the document'), { source: null, summarize: true })}>
              {t('ai.quick.summary', 'Summarize the document')}
            </Button> : null}
          </div>
        ) : null}
        {messages.map((message, index) => <Message key={message.id ?? index} message={message} />)}
        {busy ? (
          <div className="dr-chat-msg">
            {streaming ? <div className="dr-chat-bubble dr-md"><Markdown text={streaming} /></div>
              : <div className="dr-ai-thinking" role="status"><span />{t('ai.thinking', 'Thinking…')}</div>}
          </div>
        ) : null}
        {figureNotice ? <p className="dr-chat-meta" role="status">{figureNotice}</p> : null}
        {error ? <p className="dr-ai-error" role="alert">{error}</p> : null}
        {receipt ? <p className="dr-chat-meta dr-ai-receipt">{receipt}</p> : null}
      </div>
      <form className="dr-chat-composer" onSubmit={event => {
        event.preventDefault()
        void send(input, { clearInput: true })
      }}>
        {askSource ? (
          <div className="dr-ai-source" data-source-kind={askSource.kind}>
            {askSource.kind === 'media' ? <IconGrid size={15} /> : <IconQuote size={15} />}
            <div className="dr-ai-source-copy">
              <strong>{heading}</strong>
              {askSource.text ? <span title={askSource.text}>{askSource.text}</span> : null}
            </div>
            <IconButton size="sm" icon={<IconClose size={13} />} label={t('ai.removeSource', 'Remove source')}
              onClick={() => { setFigureNotice(''); reader.selectAskSource(null) }} />
          </div>
        ) : null}
        <div className="dr-chat-field">
          <textarea ref={inputRef} className="dr-chat-input" rows={2} value={input} maxLength={8000}
            aria-label={t('ai.question', 'Question')} placeholder={t('ai.placeholder', 'Ask anything about this document…')}
            onChange={event => draft(event.target.value)} onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              event.currentTarget.form.requestSubmit()
            }} />
          <div className="dr-chat-controls">
            {askSource ? (
              <div className="dr-ai-source-tools">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send(sourcePrompt(askSource, t))}>
                  {sourcePrompt(askSource, t)}
                </Button>
                {askSource.kind === 'media' ? <span>{imageCapable ? t('ai.figureImage', 'Image and description') : t('ai.figureText', 'Description only')}</span> : null}
              </div>
            ) : (
              <Select className="dr-ai-scope" aria-label={t('ai.scope', 'Reading context')} value={contextMode}
                options={[
                  { value: 'doc', label: t('ai.context.doc', 'Whole document') },
                  { value: 'section', label: t('ai.context.section', 'Current section') },
                ]}
                onChange={value => actions.patchSettings({ ai: { chat: { contextMode: value } } })} />
            )}
            {busy ? <button type="button" className="dr-chat-send is-stop" aria-label={t('ai.stop', 'Stop')} title={t('ai.stop', 'Stop')}
              onClick={() => controllerRef.current?.abort()}><IconStop size={16} /></button>
              : <button type="submit" className="dr-chat-send" aria-label={t('ai.send', 'Send')} title={t('ai.send', 'Send')}
                disabled={!doc || !input.trim()}><IconSend size={16} /></button>}
          </div>
        </div>
      </form>
    </aside>
  )
}
