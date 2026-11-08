// Offline reproduction of the web-shell module activation for client.js:
// executes the module factory and plugin.apply against a minimal DOM + fake Cordis context,
// printing the first exception (the web boot only reports "entry failed" without details).
const fs = require('node:fs')
const vm = require('node:vm')

let loggedErrors = 0
const originalConsoleError = console.error
console.error = (...args) => {
  loggedErrors++
  originalConsoleError(...args)
}

const listeners = []
global.window = {
  __ModuleLoader__: { load(definition) { global.__captured = definition } },
  addEventListener(type, fn) { listeners.push([type, fn]) },
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { origin: 'http://127.0.0.1:60092', pathname: '/', href: 'http://127.0.0.1:60092/' },
  setTimeout: () => 0,
  clearTimeout: () => {},
  devicePixelRatio: 1,
  innerWidth: 1400,
  innerHeight: 900,
  getSelection: () => null,
}
global.self = global.window
global.navigator = { clipboard: {}, language: 'zh-CN', userAgent: 'node' }
global.location = global.window.location
global.requestAnimationFrame = (callback) => setTimeout(callback, 0)
global.cancelAnimationFrame = () => {}
global.atob = (value) => Buffer.from(String(value), 'base64').toString('binary')
global.btoa = (value) => Buffer.from(String(value), 'binary').toString('base64')
global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' })
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
global.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }
global.CompressionStream = class {}
global.DecompressionStream = class {}
global.URL.createObjectURL = () => 'blob:test'
global.URL.revokeObjectURL = () => {}

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false },
    children: [],
    parentElement: null,
    textContent: '',
    appendChild(child) { this.children.push(child); return child },
    append(...items) { this.children.push(...items) },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
  }
}
global.document = {
  head: makeElement('head'),
  body: makeElement('body'),
  documentElement: { dataset: {}, style: {} },
  createElement: (tag) => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => null,
}
global.window.document = global.document

class MockComponent {
  constructor(props) {
    this.props = props
    this.state = {}
  }
  setState(partial) {
    this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) }
  }
  forceUpdate() {}
  render() {
    return null
  }
}

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  cloneElement: (element) => element,
  createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
  forwardRef: (render) => render,
  createRef: () => ({ current: null }),
  Fragment: 'Fragment',
  Component: MockComponent,
  PureComponent: MockComponent,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: (context) => context?._value,
  useReducer: (reducer, initial) => [initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'id',
  memo: (component) => component,
  Children: { map: () => [], toArray: () => [] },
  isValidElement: () => true,
  StrictMode: 'StrictMode',
  default: null,
}
react.default = react

const file = process.argv[2] ?? 'client.js'
const code = fs.readFileSync(file === '-' ? 0 : file, 'utf8')
try {
  vm.runInThisContext(code, { filename: file })
} catch (error) {
  console.error('TOP-LEVEL THROW:', error)
  process.exit(1)
}
const definition = global.__captured
if (definition === undefined) {
  console.error('ModuleLoader.load was not called')
  process.exit(1)
}
console.log('module id:', definition.id)
let plugin
try {
  plugin = definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require("${name}")`)
  })
} catch (error) {
  console.error('FACTORY THROW:', error)
  process.exit(1)
}
console.log('factory ok — exports:', Object.keys(plugin))
if (plugin.__readerBootFailure !== undefined) {
  console.error('FACTORY DEGRADED:', plugin.__readerBootFailure.message)
  process.exit(1)
}
if (typeof plugin.apply !== 'function') {
  console.error('plugin.apply missing')
  process.exit(1)
}

const disposers = []
const locale = { getLocale: () => ({ active: 'zh', locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }) }
const fakeCtx = {
  effect(callback, label) {
    try {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    } catch (error) {
      console.error(`EFFECT THROW [${label}]:`, error)
      throw error
    }
  },
  on() { return () => {} },
  once() { return () => {} },
  provide() { return () => {} },
  get(name) {
    if (name === 'locale') return locale
    return undefined
  },
  slots: {
    inject(key, callback) {
      console.log('slots.inject:', key)
      try {
        const dispose = callback()
        disposers.push({ label: `slot:${key}`, dispose })
      } catch (error) {
        console.error(`SLOT INJECT THROW [${key}]:`, error)
        throw error
      }
      return () => {}
    },
    register(options, component) {
      console.log('slots.register:', options.name, options.id ?? options.key, '| label:', typeof options.label)
      if (options.name === 'sidebar.panellist' && options.id === 'reader' && options.label() !== '书库') {
        throw new Error('Reader sidebar must follow the active Chinese DSH locale')
      }
      return () => {}
    },
    registerFactory(options) {
      return () => {}
    },
  },
  locale,
  theme: { getTheme: () => ({ id: 'light' }) },
}
;(async () => {
  try {
    await plugin.apply(fakeCtx)
    console.log('APPLY OK; effects:', disposers.length)
  } catch (error) {
    console.error('APPLY THROW:', error)
    process.exitCode = 1
  }
  // Let async activation diagnostics settle, then exercise the normal unload lifecycle. An
  // offline carrier may leave a reconnect timer alive until its transport disposer runs.
  await new Promise((resolve) => setImmediate(resolve))
  for (const {label,dispose} of [...disposers].reverse()) {
    if (typeof dispose !== 'function') continue
    try { await dispose() } catch (error) {
      console.error(`DISPOSE THROW [${label}]:`, error)
      process.exitCode = 1
    }
  }
  if (loggedErrors > 0) {
    console.error(`Activation logged ${loggedErrors} error(s); refusing to publish this build.`)
    process.exitCode = 1
  }
})()
