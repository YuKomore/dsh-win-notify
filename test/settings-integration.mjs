import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStore } from '../lib/store.mjs'
import { CONFIG_FIELDS, name as pluginId } from '../lib/index.mjs'

const composeRoot = process.env.DSH_COMPOSE_DIR || 'D:\\DSH-TEST\\compose'
const profileDir = process.env.DSH_PROFILE_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const livePath = path.join(profileDir, 'cordis.patch.yml')

if (!fs.existsSync(livePath)) {
  console.error('no live profile patch at', livePath)
  process.exit(2)
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

let jsYaml
let entryListSchema
let applyEntryPatches
try {
  const includeUrl = pathToFileURL(path.join(
    composeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js',
  ))
  const jsYamlUrl = pathToFileURL(path.join(composeRoot, 'dsh', 'node_modules', 'js-yaml', 'index.js'))
  jsYaml = (await import(jsYamlUrl.href)).default
  ;({ applyEntryPatches } = await import(includeUrl.href))

  const JsExpr = new jsYaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  entryListSchema = jsYaml.JSON_SCHEMA.extend(JsExpr)
} catch (error) {
  console.error('could not load the compose libraries from', composeRoot)
  console.error(String(error && error.message))
  process.exit(2)
}

console.log(`live profile: ${livePath}`)

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwn-integration-'))
const copyPath = path.join(scratchDir, 'cordis.patch.yml')
fs.copyFileSync(livePath, copyPath)
const before = fs.readFileSync(copyPath, 'utf8')

const store = createStore({ patchPath: copyPath, pluginId, log: () => {} })

console.log('\n[1] the live file is already well-formed')

check('the live patch parses as a top-level array', () => {
  const data = jsYaml.load(before, { schema: entryListSchema })
  assert.ok(Array.isArray(data), 'not a top-level array')
  console.log(`       ${data.length} patch entries`)
})

check('the live file contains our plugin row', () => {
  const data = jsYaml.load(before, { schema: entryListSchema })
  const row = data.find((entry) => entry && entry.id === pluginId)
  assert.ok(row, `no row for ${pluginId}`)
  assert.equal(row.name, pluginId)
  const keys = Object.keys(row.config || {})
  console.log(`       row declares ${keys.length} config keys`)
  const unknown = keys.filter((key) => !(key in CONFIG_FIELDS))
  assert.equal(unknown.length, 0, `unknown keys: ${unknown.join(', ')}`)
})

console.log('\n[2] a save keeps the file compilable')

const save = store.save({ notifyBlocked: false, notifyDone: false, quietWhenFocused: false })
check('save reports success', () => {
  assert.ok(save.ok, `save failed: ${save.error}`)
})

check('the rewritten file still parses as a top-level array', () => {
  const after = fs.readFileSync(copyPath, 'utf8')
  const data = jsYaml.load(after, { schema: entryListSchema })
  assert.ok(Array.isArray(data), 'not a top-level array')
})

check('the rewritten file composes with the real patcher', () => {
  const after = fs.readFileSync(copyPath, 'utf8')
  const patches = jsYaml.load(after, { schema: entryListSchema })
  const warnings = []
  const warn = (message, ...args) => {
    let index = 0
    warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
  }

  const base = [
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { fontSize: 15 } },
    { id: 'dsh-win-notify', name: pluginId, config: {} },
  ]
  const composed = applyEntryPatches(base, patches, warn)
  assert.ok(composed.length >= 2)

  const ours = warnings.filter((w) => w.includes(pluginId))
  assert.equal(ours.length, 0, `our row produced warnings: ${ours.join(' | ')}`)
})

check('the saved values are actually applied by the patcher', () => {
  const after = fs.readFileSync(copyPath, 'utf8')
  const patches = jsYaml.load(after, { schema: entryListSchema })
  const base = [{ id: pluginId, name: pluginId, config: { notifyBlocked: true, notifyDone: true, quietWhenFocused: true } }]
  const composed = applyEntryPatches(base, patches, () => {})
  const row = composed.find((entry) => entry && entry.id === pluginId)
  assert.equal(row.config.notifyBlocked, false, 'notifyBlocked should have been overridden to false')
  assert.equal(row.config.notifyDone, false)
  assert.equal(row.config.quietWhenFocused, false)
})

console.log('\n[3] everything else survived')

check('every other row is still present', () => {
  const parse = (text) => jsYaml.load(text, { schema: entryListSchema })
  const beforeRows = parse(before).filter((e) => e && e.id).map((e) => e.id)
  const afterRows = parse(fs.readFileSync(copyPath, 'utf8')).filter((e) => e && e.id).map((e) => e.id)
  assert.deepEqual(afterRows, beforeRows, `row ids changed:\n  before: ${beforeRows.join(', ')}\n  after:  ${afterRows.join(', ')}`)
})

check('another row\'s config is untouched', () => {
  const after = fs.readFileSync(copyPath, 'utf8')
  const data = jsYaml.load(after, { schema: entryListSchema })
  const theme = data.find((entry) => entry && entry.id === 'ui-theme')
  assert.ok(theme, 'ui-theme row disappeared')
  assert.equal(theme.config.fontSize, 15)
})

check('comments outside our row are preserved', () => {
  const after = fs.readFileSync(copyPath, 'utf8')
  assert.ok(after.includes('# Your patch layer for this dsh profile'), 'header comment lost')
})

console.log('\n[4] a second save is stable')

check('reloading and re-saving yields identical config', () => {
  const reopened = createStore({ patchPath: copyPath, pluginId, log: () => {} })
  const first = reopened.load()
  assert.ok(first.found)
  const again = reopened.save({ notifyBlocked: false, notifyDone: false, quietWhenFocused: false })
  assert.ok(again.ok, `second save failed: ${again.error}`)
  const second = createStore({ patchPath: copyPath, pluginId, log: () => {} }).load()
  assert.deepEqual(second.config, first.config, 'config drifted between saves')
})

check('no temp files were left in the profile directory', () => {
  const leftovers = fs.readdirSync(scratchDir).filter((f) => f.includes('.tmp-'))
  assert.equal(leftovers.length, 0, `leftovers: ${leftovers.join(', ')}`)
})

check('the live file was never modified', () => {
  assert.equal(fs.readFileSync(livePath, 'utf8'), before, 'the live patch changed!')
})

fs.rmSync(scratchDir, { recursive: true, force: true })

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('settings integration OK (live file untouched)')
