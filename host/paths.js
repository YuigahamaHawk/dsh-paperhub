// Reader data directory and atomic JSON persistence.
//
// Everything the reader owns lives under $DSH_HOME/dsh-reader so it survives app restarts
// and upgrades. Writes are atomic (tmp file + rename) and serialized per target path.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Root of the reader's persistent data. */
export function readerDataDir() {
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'dsh-reader')
}

/** Directory paths owned by the reader. */
export function readerPaths(dataDir = readerDataDir()) {
  return {
    root: dataDir,
    settings: join(dataDir, 'settings.json'),
    library: join(dataDir, 'library.json'),
    docs: join(dataDir, 'docs'),
    tmp: join(dataDir, 'tmp'),
    cache: join(dataDir, 'cache'),
    translate: join(dataDir, 'cache', 'translate'),
    reflow: join(dataDir, 'cache', 'reflow'),
    diagnostics: join(dataDir, 'diagnostics.jsonl'),
    docDir: (id) => join(dataDir, 'docs', String(id)),
    original: (id, format) => join(dataDir, 'docs', String(id), `original.${format === 'epub' ? 'epub' : 'pdf'}`),
    thumb: (id) => join(dataDir, 'docs', String(id), 'thumb.jpg'),
    content: (id) => join(dataDir, 'docs', String(id), 'content.json'),
    annotations: (id) => join(dataDir, 'docs', String(id), 'annotations.json'),
    aux: (id) => join(dataDir, 'docs', String(id), 'aux.json'),
  }
}

/** Create every directory the reader needs (idempotent). */
export async function ensureReaderDirs(paths) {
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.docs, { recursive: true })
  await mkdir(paths.tmp, { recursive: true })
  await mkdir(paths.translate, { recursive: true })
  await mkdir(paths.reflow, { recursive: true })
}

// ----- serialized atomic JSON file store ------------------------------------------------

const writeQueues = new Map()

/** Resolve after every earlier write to the same path settled. */
function enqueueWrite(path, operation) {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  writeQueues.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Read and parse a JSON file; returns `fallback` when absent or corrupt. */
export async function readJsonFile(path, fallback) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[dsh-reader] failed to read ${path}: ${error?.message}`)
    return fallback
  }
}

/** Atomically write pretty JSON (tmp + fsync-less rename) serialized per path. */
export function writeJsonFile(path, value) {
  return enqueueWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  })
}

/** Atomically write raw bytes, serialized per path. */
export function writeBytesFile(path, bytes) {
  return enqueueWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  })
}

/** Append one JSON line (diagnostics); bounded growth by the caller. */
export async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch (error) {
    console.warn(`[dsh-reader] diagnostics append failed: ${error?.message}`)
  }
}

/** Remove a file if it exists. */
export async function removeFile(path) {
  try {
    await rm(path, { force: true })
  } catch {
    /* best effort */
  }
}

/** Remove a whole directory tree if it exists. */
export async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** chmod helper that ignores platforms without mode bits. */
export async function bestEffortChmod(path, mode) {
  try {
    await chmod(path, mode)
  } catch {
    /* windows / unsupported fs */
  }
}
