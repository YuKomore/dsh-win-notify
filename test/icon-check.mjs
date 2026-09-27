import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildToastXml, toFileUrl, runPowerShell } from '../lib/toast.mjs'
import { normalizeConfig } from '../lib/config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.resolve(here, '..', 'assets')
const png = path.join(assets, 'toast-logo.png')
const ico = path.join(assets, 'app.ico')

const failures = []

function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

console.log('\n[1] body logo defaults to off')

check('the default config requests no body logo', () => {
  const config = normalizeConfig({})
  assert.equal(config.iconPath, '', 'iconPath should default to empty')
})

check('no icon produces no appLogoOverride element', () => {
  assert.ok(!buildToastXml({ title: 'T', body: 'B' }).includes('appLogoOverride'))
  assert.ok(!buildToastXml({ title: 'T', body: 'B', icon: '' }).includes('appLogoOverride'))
})

check('an explicit icon produces exactly one appLogoOverride', () => {
  const xml = buildToastXml({ title: 'T', body: 'B', icon: png })
  assert.equal((xml.match(/appLogoOverride/g) || []).length, 1)
  assert.ok(xml.includes('hint-crop="circle"'), 'the slot should be circle-cropped')
})

console.log('\n[2] shipped assets')

check('assets/app.ico exists and carries small frames', () => {
  assert.ok(fs.existsSync(ico), `missing ${ico}`)
  const bytes = fs.readFileSync(ico)
  assert.equal(bytes.readUInt16LE(0), 0, 'ICO reserved field')
  assert.equal(bytes.readUInt16LE(2), 1, 'ICO type must be 1')
  const count = bytes.readUInt16LE(4)
  assert.ok(count >= 6, `expected several frames, found ${count}`)
  const dimensions = []
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16
    dimensions.push(bytes[offset] === 0 ? 256 : bytes[offset])
  }
  console.log(`       frames: ${dimensions.join(', ')}`)

  assert.ok(dimensions.includes(16), 'a 16x16 frame is required for the header glyph')
  assert.ok(dimensions.includes(20), 'a 20x20 frame covers 125% scaling')
  assert.ok(dimensions.includes(32), 'a 32x32 frame covers 200% scaling')
  assert.ok(Math.max(...dimensions) >= 256, 'a large frame keeps the taskbar crisp')
})

check('assets/toast-logo.png exists and is 96x96', () => {
  assert.ok(fs.existsSync(png), `missing ${png}`)
  const bytes = fs.readFileSync(png)
  assert.equal(bytes.readUInt32BE(16), 96, 'width')
  assert.equal(bytes.readUInt32BE(20), 96, 'height')
})

check('the file URL passed to the toast is well formed', () => {
  const url = toFileUrl(png)
  assert.match(url, /^file:\/\/\/[A-Za-z]:\//, `bad url: ${url}`)
})

console.log('\n[3] live preview')

const base = {
  launch: '',
  aumid: 'electron.app.DeepSeek Harness',
  bypassDnd: false,
  foregroundProcesses: ['DeepSeek Harness'],
  foregroundTitles: ['DeepSeek Harness'],

  suppressWhenFocused: false,
  showWhenDnd: true,
  timeoutMs: 15000,
}

const cases = [
  { label: 'no body logo (the default)', icon: '' },
  { label: 'with body logo', icon: png },
]

for (const item of cases) {
  const result = await runPowerShell({
    ...base,
    title: 'DSH 通知图标测试',
    body: item.label,
    icon: item.icon,
  })
  console.log(`  ${item.label}: shown=${result.shown} exit=${result.exitCode}${result.stderr ? ' stderr=' + result.stderr : ''}`)
  await new Promise((resolve) => setTimeout(resolve, 1600))
}

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('icon rules OK — two toasts sent for visual comparison')
