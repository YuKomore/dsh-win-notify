import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((p) => fs.existsSync(p))
if (!browser) {
  console.log('SKIP: no Chrome or Edge found; browser checks not run')
  process.exit(0)
}

const build = spawnSync(process.execPath, [path.join(root, 'tools', 'make-fixture.mjs')], { encoding: 'utf8' })
if (build.status !== 0) {
  console.error('fixture build failed:', build.stderr || build.stdout)
  process.exit(1)
}

// Keep the browser profile out of the repository: Chrome writes hundreds of files.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwn-panel-'))
const generated = [
  path.join(root, 'assets', 'fixture.html'),
  path.join(root, 'assets', 'fixture-panel.js'),
]
process.on('exit', () => {
  try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* best effort */ }
  for (const file of generated) {
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  }
})

const url = 'file:///' + path.join(root, 'tools', 'drive-fixture.html').replace(/\\/g, '/')
const run = spawnSync(browser, [
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
const match = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/)
if (!match) {
  console.error('no report in the dumped DOM; chrome stderr:')
  console.error((run.stderr || '').slice(0, 1500))
  process.exit(1)
}
const decoded = match[1]
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

let report
try {
  report = JSON.parse(decoded)
} catch (error) {
  console.error('report was not JSON:', decoded.slice(0, 800))
  process.exit(1)
}

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

console.log('\n[1] the panel mounts')

check('the driver completed without throwing', () => {
  assert.equal(report.status, 'ok', `driver status: ${report.status}`)
})

check('no uncaught errors from the panel', () => {
  assert.deepEqual(report.errors, [], `errors: ${JSON.stringify(report.errors, null, 1)}`)
})

check('the launcher and panel elements exist', () => {
  assert.equal(report.hostPresent, true, 'host missing')
  assert.equal(report.shadowRoot, true, 'shadow root missing')
  assert.equal(report.launchPresent, true, 'launcher missing')
  assert.equal(report.panelPresent, true, 'panel missing')
})

check('the launcher is visible and labelled', () => {
  assert.equal(report.launchHidden, false, 'launcher is hidden')
  assert.equal(report.launchText, '通知', `label was ${JSON.stringify(report.launchText)}`)
  assert.equal(report.launchClass, 'launch', 'should use the in-bar placement, not the float fallback')
})

check('the launcher is text only, with no icon', () => {

  assert.equal(report.launchSvgCount, 0, 'the launcher must not contain an svg')
  assert.equal(report.launchChildElements, 0, 'the label should be a bare text node')
})

check('the launcher exposes its expanded state', () => {

  assert.equal(report.launchAriaExpanded, 'false', 'collapsed button should report false')
  assert.equal(report.ariaExpandedWhenOpen, 'true', 'an open panel should flip it to true')
})

console.log('\n[2] the launcher matches 应用 / 编辑')

check('the shell caption menu is present in the fixture', () => {
  assert.equal(report.menuHostPresent, true, 'no [data-windows-menu] to align against')
  assert.equal(report.shellButtonCount, 2)
})

check('every inherited style matches the sibling button', () => {

  const expected = {
    'font-size': '14px',
    color: 'rgb(91, 100, 114)',
    height: '28px',
    'padding-left': '10px',
    'padding-right': '10px',
    'border-radius': '6px',
    'background-color': 'rgba(0, 0, 0, 0)',
  }
  for (const [prop, want] of Object.entries(expected)) {
    const got = report.styles[prop]
    assert.ok(got, `no measurement for ${prop}`)
    assert.equal(got.ours, want, `${prop}: ours=${got.ours} expected=${want}`)
    assert.equal(got.ours, got.shell, `${prop} must equal the shell's value`)
  }
  const font = report.styles['font-family']
  assert.equal(font.ours, font.shell, 'font-family must be inherited, not overridden')
  assert.ok(!/apple-system/.test(font.ours), 'the hardcoded font stack must be gone')
})

check('it sits flush to the right of 编辑 and shares its vertical centre', () => {
  const g = report.geometry
  assert.ok(g, 'no geometry measured')
  assert.ok(Math.abs(g.gap) <= 2, `horizontal gap should be ~0-2px, was ${g.gap}`)
  assert.ok(Math.abs(g.centreDelta) <= 1, `vertical centre should align, delta was ${g.centreDelta}`)
  assert.equal(g.ours.height, g.shell.height, 'heights must match')
})

console.log('\n[3] clicking renders a usable panel')

check('the panel opens', () => {
  assert.equal(report.openAfterClick, true, 'did not open on click')
  assert.equal(report.openAfterWait, true, 'closed again on its own')
  assert.equal(report.panelVisible, true, 'panel is not visible')
})

check('the panel actually has content', () => {

  assert.ok(report.rowCount >= 12, `expected at least 12 switches, got ${report.rowCount}`)
  assert.equal(report.switchCount, report.rowCount, 'every row needs a switch')
  assert.ok(report.textLength > 150, `panel text is suspiciously short: ${report.textLength} chars`)
  assert.equal(report.hasTestButton, true, 'missing the test-notification button')
})

check('the settings-file line is gone from the UI', () => {
  assert.equal(report.mentionsSettingsFilePath, false, 'the panel still shows a 配置文件 line')
})

check('the panel is not positioned off-screen', () => {
  const r = report.panelRect
  assert.ok(r.width >= 300, `width ${r.width}`)
  assert.ok(r.height > 200, `height ${r.height}`)
  assert.ok(r.top >= 0 && r.top < 200, `top ${r.top}`)
  assert.ok(r.left >= 0, `left ${r.left}`)
})

console.log('\n[4] the switches work')

check('toggling a switch flips it and POSTs the change', () => {
  assert.ok(report.toggle, 'toggle was not exercised')
  assert.notEqual(report.toggle.before, report.toggle.after, 'the switch did not flip')
  assert.equal(report.toggle.posted.length, 1, `expected 1 POST, got ${report.toggle.posted.length}`)
  const patch = report.toggle.posted[0]
  assert.deepEqual(Object.keys(patch), ['notifyApproval'], `posted ${JSON.stringify(patch)}`)
  assert.equal(typeof patch.notifyApproval, 'boolean')
})

check('a status message is shown after saving', () => {
  assert.ok(report.toggle.status.includes('已保存'), `status was ${JSON.stringify(report.toggle.status)}`)
})

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('panel browser checks OK')
