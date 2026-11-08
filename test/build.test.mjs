// Reproduce startup failures against throwaway files, never the installed plugin.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { acquireBuildLock, fingerprintSources, publishClient, validateClient, wrapClient } from '../tools/client-release.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const smokeTest = join(root, 'tools', 'mock-activate.cjs')
const good = (value) => wrapClient({ name: '@local/dsh-reader', version: 'test', code: `module.exports = { apply() {}, value: ${JSON.stringify(value)} };` })

async function withLiveClient(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-reader-build-test-'))
  const filename = join(directory, 'client.js')
  const original = good('last working build')
  await writeFile(filename, original)
  try {
    await run({ directory, filename, original })
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.startsWith(join(tmpdir(), 'dsh-reader-build-test-')))
    await rm(directory, { recursive: true, force: true })
  }
}

test('the crash-log RegExp passes esbuild but V8 rejects it before publication', async () => {
  const broken = String.raw`module.exports = { apply() {} }; const symbols = /[\u{1D400}-\u{1D7FF}\u2200-\u22ff]/;`
  const result = await transform(broken, { target: 'chrome110', format: 'cjs' })
  await withLiveClient(async ({ filename, original, directory }) => {
    let resourcesChanged = false
    await assert.rejects(publishClient({ filename, source: wrapClient({ name: '@local/dsh-reader', version: 'test', code: result.code }), smokeTest, beforePublish() { resourcesChanged = true } }), /regular expression|Range out of order/i)
    assert.equal(await readFile(filename, 'utf8'), original)
    assert.equal(resourcesChanged, false)
    assert.deepEqual(await readdir(directory), ['client.js'])
  })
})

test('a factory exception is contained at runtime and shown in the Reader panel', () => {
  let definition
  const slots = []
  const reports = []
  const context = createContext({
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    console: { error() {} },
    fetch: async (_url, init) => { reports.push(JSON.parse(init.body)); return {} },
  })
  new Script(wrapClient({ name: '@local/dsh-reader', version: 'test', code: 'throw new Error("missing browser dependency")' })).runInContext(context)
  const plugin = definition.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) }))
  assert.match(plugin.__readerBootFailure.message, /missing browser dependency/)
  assert.doesNotThrow(() => plugin.apply({ slots: {
    inject(_name, callback) { callback() },
    register(options, component) { slots.push({ options, component }) },
  } }))
  assert.equal(slots.length, 2)
  assert.equal(slots[1].component().props.role, 'alert')
  assert.equal(reports[0].params.kind, 'client-module-failed')
})

test('the runtime fallback is a failed build, never a successful smoke test', async () => {
  await withLiveClient(async ({ filename, original }) => {
    const source = wrapClient({ name: '@local/dsh-reader', version: 'test', code: 'throw new Error("candidate is broken")' })
    await assert.rejects(publishClient({ filename, source, smokeTest }), /activation check/)
    assert.equal(await readFile(filename, 'utf8'), original)
  })
})

test('activation errors caught by the plugin still fail the release check', async () => {
  await withLiveClient(async ({ filename, original }) => {
    const source = wrapClient({ name: '@local/dsh-reader', version: 'test', code: 'module.exports = { apply() { try { throw new Error("registration failed") } catch (error) { console.error(error) } } };' })
    await assert.rejects(publishClient({ filename, source, smokeTest }), /activation check/)
    assert.equal(await readFile(filename, 'utf8'), original)
  })
})

test('a validated release replaces the complete file and retains the working predecessor', async () => {
  await withLiveClient(async ({ filename, original, directory }) => {
    const source = good('new working build')
    assert.equal(await publishClient({ filename, source, smokeTest }), true)
    assert.equal(await readFile(filename, 'utf8'), source)
    assert.equal(await readFile(join(directory, '.build', 'client.previous.js'), 'utf8'), original)
    validateClient(await readFile(filename, 'utf8'))
    assert.equal(await publishClient({ filename, source, smokeTest }), false)
    assert.equal(await readFile(join(directory, '.build', 'client.previous.js'), 'utf8'), original)
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false)
  })
})

test('another active build cannot acquire the publication lock', async () => {
  await withLiveClient(async ({ directory }) => {
    const unlock = acquireBuildLock(directory)
    try {
      assert.throws(() => acquireBuildLock(directory), /already running/)
    } finally {
      unlock()
    }
    acquireBuildLock(directory)()
  })
})

test('source edits during validation cancel publication and retain the live version', async () => {
  await withLiveClient(async ({ directory, filename, original }) => {
    const sourceFile = join(directory, 'draft.js')
    await writeFile(sourceFile, 'first draft')
    const before = fingerprintSources(directory)
    await writeFile(sourceFile, 'another task edited the draft')
    await assert.rejects(publishClient({ filename, source: good('cancelled build'), smokeTest,
      beforePublish() {
        if (fingerprintSources(directory) !== before) throw new Error('sources changed')
      },
    }), /sources changed/)
    assert.equal(await readFile(filename, 'utf8'), original)
  })
})

test('an already broken live version never overwrites the recovery copy', async () => {
  await withLiveClient(async ({ directory, filename, original }) => {
    await publishClient({ filename, source: good('second working build'), smokeTest })
    await writeFile(filename, 'this is not a valid script !')
    await publishClient({ filename, source: good('recovered build'), smokeTest })
    assert.equal(await readFile(join(directory, '.build', 'client.previous.js'), 'utf8'), original)
  })
})

test('offline activation exercises effect cleanup instead of leaving recovery timers running',()=>{
  const source=wrapClient({name:'@local/dsh-reader',version:'test',code:`module.exports = { apply(ctx) { ctx.effect(() => { const timer = setTimeout(() => { throw new Error('transport was not disposed'); }, 50); return () => clearTimeout(timer); }, 'transport cleanup'); } };`})
  assert.match(validateClient(source,{smokeTest}),/APPLY OK/)
})
