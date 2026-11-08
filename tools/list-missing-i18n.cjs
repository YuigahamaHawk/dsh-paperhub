const fs = require('node:fs')
const path = require('node:path')

const files = fs.readdirSync('client-src').filter((file) => file.endsWith('.jsx') || file.endsWith('.js'))
const used = new Map()
for (const file of files) {
  const source = fs.readFileSync(path.join('client-src', file), 'utf8')
  const re = /t\(\s*'([^']+)'\s*,\s*'([^']*)'/g
  let match
  while ((match = re.exec(source)) !== null) used.set(match[1], match[2])
}
const i18n = fs.readFileSync('client-src/i18n.js', 'utf8')
const missing = [...used.entries()].filter(([key]) => !i18n.includes(`'${key}':`)).sort()
console.log(`${missing.length} missing keys`)
for (const [key, fallback] of missing) console.log(`${key}  =>  ${fallback}`)
