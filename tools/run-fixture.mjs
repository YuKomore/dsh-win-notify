import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const outDir = path.join(root, '.fixture-out')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

spawnSync(process.execPath, [path.join(here, 'make-fixture.mjs')], { stdio: 'inherit' })

const url = 'file:///' + path.join(here, 'drive-fixture.html').replace(/\\/g, '/')
const run = spawnSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--allow-file-access-from-files',
  '--virtual-time-budget=9000',
  '--dump-dom',
  '--user-data-dir=' + path.join(outDir, 'profile'),
  url,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const dom = run.stdout || ''
if (!dom) {
  console.error('chrome produced no output')
  console.error((run.stderr || '').slice(0, 2000))
  process.exit(1)
}

const match = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/)
if (!match) {
  console.error('no report element in the dumped DOM; first 1200 chars:')
  console.error(dom.slice(0, 1200))
  process.exit(1)
}

const text = match[1]
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

console.log(text)
