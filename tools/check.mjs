// Syntax-check JS/JSX source files with the project's esbuild. Prints one line per file.
// Usage: node tools/check.mjs [file ...]   (no arguments → every file in client-src/)
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { transform } from 'esbuild'
import { Script } from 'node:vm'

let files = process.argv.slice(2)
if (files.length === 0) {
  files = readdirSync('client-src')
    .filter((name) => name.endsWith('.js') || name.endsWith('.jsx'))
    .sort()
    .map((name) => join('client-src', name))
}

let failed = 0
for (const file of files) {
  try {
    const source = readFileSync(file, 'utf8')
    const result = await transform(source, {
      loader: extname(file) === '.jsx' ? 'jsx' : 'js',
      jsx: 'transform',
      format: 'cjs',
      target: 'chrome110',
      sourcefile: file,
    })
    // esbuild leaves RegExp bodies unchecked; compile the transformed JS with V8 too.
    new Script(result.code, { filename: file })
    console.log(`ok   ${file}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${file}\n${error?.message ?? error}`)
  }
}
if (failed > 0) process.exitCode = 1
