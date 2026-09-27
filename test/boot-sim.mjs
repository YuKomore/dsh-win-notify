import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import assert from 'node:assert/strict'

import plugin, { name as pluginId, normalizeConfig } from '../lib/index.mjs'

const composeRoot = process.env.DSH_COMPOSE_DIR || 'D:\\DSH-TEST\\compose'
const profileDir = process.env.DSH_PROFILE_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const includeUrl = pathToFileURL(
  path.join(composeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js'),
)
const jsYamlUrl = pathToFileURL(path.join(composeRoot, 'dsh', 'node_modules', 'js-yaml', 'index.js'))

let applyEntryPatches
let yaml
try {
  ({ applyEntryPatches } = await import(includeUrl.href))
  yaml = (await import(jsYamlUrl.href)).default
} catch (error) {
  console.error('could not load the compose libraries from', composeRoot)
  console.error(String(error && error.message))
  process.exit(2)
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

const warnings = []
const warn = (message, ...args) => {
  let index = 0
  warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
}

const problems = []

function parseEntryList(file) {
  const content = fs.readFileSync(file, 'utf8')
  const data = yaml.load(content, { schema: entryListSchema })
  if (!Array.isArray(data)) {
    throw new TypeError(`config file must be a top-level array of entries: ${file}`)
  }
  return data
}

console.log(`profile: ${profileDir}`)
const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
console.log(`bundles (in order): ${bundles.join(', ')}`)

const modulesDir = path.join(profileDir, 'node_modules')
let entries = []

for (const bundleName of bundles) {
  const bundleDir = path.join(modulesDir, ...bundleName.split('/'))
  const manifestPath = path.join(bundleDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {

    const fallback = path.join(composeRoot, 'dsh', 'node_modules', ...bundleName.split('/'))
    if (!bundleName.startsWith('@deepseek-ai/')) {
      problems.push(`bundle "${bundleName}" is in dsh.profile.bundles but not installed at ${bundleDir}`)
      continue
    }
    const fallbackPatch = path.join(fallback, 'cordis.patch.yml')
    if (!fs.existsSync(fallbackPatch)) {
      console.log(`  skipped built-in layer: ${bundleName} (not extracted to ${fallback})`)
      continue
    }
    let patch
    try {
      patch = parseEntryList(fallbackPatch)
    } catch (error) {
      problems.push(`built-in bundle "${bundleName}" patch failed to parse: ${error.message}`)
      continue
    }
    entries = applyEntryPatches(entries, patch, warn)
    console.log(`  applied built-in layer (from asar): ${bundleName} (${patch.length} patch entries) -> ${entries.length} rows`)
    continue
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const patchFiles = [].concat(manifest.dsh?.bundle?.patch ?? [])
  if (!patchFiles.length) {
    problems.push(`bundle "${bundleName}" declares no dsh.bundle.patch`)
    continue
  }
  for (const rel of patchFiles) {
    const file = path.resolve(bundleDir, rel)
    if (!fs.existsSync(file)) {
      problems.push(`bundle "${bundleName}" declares patch ${rel} but ${file} does not exist`)
      continue
    }
    let patch
    try {
      patch = parseEntryList(file)
    } catch (error) {
      problems.push(`bundle "${bundleName}" patch ${rel} failed to parse: ${error.message}`)
      continue
    }
    entries = applyEntryPatches(entries, patch, warn)
    console.log(`  applied bundle layer: ${bundleName} (${patch.length} patch entries) -> ${entries.length} rows`)
  }
}

const profilePatch = path.join(profileDir, 'cordis.patch.yml')
let profilePatchData
try {
  profilePatchData = parseEntryList(profilePatch)
} catch (error) {
  console.error(`\nFATAL: ${profilePatch} is not a valid top-level array: ${error.message}`)
  process.exit(1)
}
entries = applyEntryPatches(entries, profilePatchData, warn)
console.log(`  applied profile layer (${profilePatchData.length} patch entries) -> ${entries.length} rows`)

const rootConfig = path.join(profileDir, 'cordis.yml')
if (fs.existsSync(rootConfig)) {
  try {
    const data = parseEntryList(rootConfig)
    if (data.length !== 0) problems.push(`profile cordis.yml should be an empty array, found ${data.length} entries`)
  } catch (error) {
    problems.push(`profile cordis.yml failed to parse: ${error.message}`)
  }
}

const byId = new Map()

function walk(rows, depth = 0) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      problems.push(`non-object entry at depth ${depth}: ${JSON.stringify(row)}`)
      continue
    }
    if (row.id) {
      if (byId.has(row.id)) problems.push(`duplicate loader entry id: ${row.id}`)
      else byId.set(row.id, row)
    }
    if (row.group && Array.isArray(row.config)) walk(row.config, depth + 1)
  }
}
walk(entries)
console.log(`composed rows: ${byId.size} unique ids`)

const row = byId.get(pluginId)
if (!row) {
  problems.push(`no composed row with id "${pluginId}" — the plugin would never load`)
} else {
  if (row.name !== pluginId) problems.push(`row name should be "${pluginId}", got ${JSON.stringify(row.name)}`)
  if (row.disabled) problems.push(`row is disabled (disabled: ${JSON.stringify(row.disabled)})`)
  console.log(`plugin row found: id=${row.id} name=${row.name} disabled=${JSON.stringify(row.disabled ?? false)}`)

  const rawConfig = row.config && typeof row.config === 'object' ? row.config : {}
  const unknown = Object.keys(rawConfig).filter((key) => !(key in normalizeConfig(undefined)))
  if (unknown.length) problems.push(`composed config has keys the plugin ignores: ${unknown.join(', ')}`)
  const normalized = normalizeConfig(rawConfig)
  console.log('composed plugin config:', JSON.stringify({
    enabled: normalized.enabled,
    notifyApproval: normalized.notifyApproval,
    notifyQuestion: normalized.notifyQuestion,
    notifyDone: normalized.notifyDone,
    quietWhenFocused: normalized.quietWhenFocused,
    approvalDelayMs: normalized.approvalDelayMs,
    doneTitle: normalized.doneTitle,
  }))
}

if (warnings.length) {
  console.log('')
  console.log('patch warnings (a skipped patch is a silently ignored setting):')
  for (const line of warnings) console.log('  WARN', line)
}

let applyError = null
try {
  const cordisUrl = pathToFileURL(
    path.join(composeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  )
  const { Context } = await import(cordisUrl.href)
  const ctx = new Context()
  const originalLog = console.log
  console.log = () => {}
  try {

    const validated = plugin.Config['~standard'].validate(row?.config ?? {})
    assert.ok(!validated.issues, 'the config validator must not report issues')
    plugin.apply(ctx, validated.value)
  } finally {
    console.log = originalLog
  }
  await ctx.stop?.()
  console.log('plugin applied on a real cordis Context without throwing')
} catch (error) {
  applyError = error
  problems.push(`plugin.apply() threw on a real cordis Context: ${error && error.message}`)
}

if (problems.length) {
  console.log('')
  for (const problem of problems) console.log('  FAIL', problem)
  console.log(`\nFAILED: ${problems.length} boot problem(s)`)
  process.exit(1)
}
if (applyError) process.exit(1)
console.log('\nboot simulation OK: the composed tree is valid and the plugin applies cleanly')
