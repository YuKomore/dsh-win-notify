import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CONFIG_FIELDS, name as pluginId, normalizeConfig } from '../lib/index.mjs'

const profileDir = process.env.DSH_PROFILE_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const problems = []
const note = (message) => problems.push(message)

const pkgPath = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!bundles.includes(pluginId)) note(`${pkgPath}: "${pluginId}" is missing from dsh.profile.bundles`)
else console.log(`bundles include ${pluginId}`)
if (!pkg.dependencies?.[pluginId]) note(`${pkgPath}: "${pluginId}" is missing from dependencies`)
else console.log(`dependencies include ${pluginId} -> ${pkg.dependencies[pluginId]}`)

const installed = path.join(profileDir, 'node_modules', pluginId)
for (const rel of ['package.json', 'cordis.patch.yml', 'lib/index.mjs', 'lib/toast.mjs', 'lib/defaults.mjs']) {
  if (!fs.existsSync(path.join(installed, rel))) note(`missing installed file: ${rel}`)
}
const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  note('the installed package.json has no usable dsh.bundle.patch declaration')
} else {
  console.log('installed manifest declares dsh.bundle.patch')
}
if (manifest.main !== 'lib/index.mjs') note(`main should be lib/index.mjs, got ${manifest.main}`)

const patchPath = path.join(profileDir, 'cordis.patch.yml')
const text = fs.readFileSync(patchPath, 'utf8')
const lines = text.split(/\r?\n/)

function stripComment(value) {
  let quote = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i)
  }
  return value
}

const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+id:\\s*["']?${pluginId}["']?\\s*$`).test(line))
if (start < 0) {
  note(`${patchPath}: no override row found for id "${pluginId}"`)
} else {

  let nameLine = -1
  let configLine = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*-\s+id:/.test(lines[i])) break
    if (/^\s*name:/.test(lines[i])) nameLine = i
    if (/^\s*config:\s*$/.test(lines[i])) { configLine = i; break }
  }
  if (nameLine < 0) note(`line ${start + 1}: the override row has no "name" (the loader warns and skips when it mismatches)`)
  else {
    const value = stripComment(lines[nameLine].replace(/^\s*name:\s*/, '')).trim().replace(/^["']|["']$/g, '')
    if (value !== pluginId) note(`line ${nameLine + 1}: name "${value}" must match id "${pluginId}"`)
    else console.log('override row id/name match')
  }

  if (configLine < 0) {
    note(`line ${start + 1}: the override row has no config block`)
  } else {
    const indent = (lines[configLine].match(/^(\s*)/) || [])[1].length
    const seen = new Map()
    for (let i = configLine + 1; i < lines.length; i += 1) {
      const raw = lines[i]
      if (!raw.trim()) continue
      if (raw.trim().startsWith('#')) continue
      if ((raw.match(/^(\s*)/) || [])[1].length <= indent) break
      const match = raw.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) { note(`line ${i + 1}: unparseable config line ${JSON.stringify(raw.trim())}`); continue }
      const key = match[1]
      const rawValue = stripComment(match[2]).trim()
      if (seen.has(key)) note(`line ${i + 1}: duplicate key "${key}"`)
      seen.set(key, rawValue)
      if (!CONFIG_FIELDS[key]) note(`line ${i + 1}: unknown key "${key}" — it would be silently ignored`)
    }
    console.log(`profile override row declares ${seen.size} config keys`)

    const raw = {}
    for (const [key, rawValue] of seen) {
      const field = CONFIG_FIELDS[key]
      if (!field) continue
      const [type] = field
      if (type === 'boolean') raw[key] = rawValue === 'true'
      else if (type === 'number') raw[key] = Number(rawValue)
      else raw[key] = rawValue.replace(/^["']|["']$/g, '')
    }
    const normalized = normalizeConfig(raw)
    console.log('normalized override:', JSON.stringify({
      notifyApproval: normalized.notifyApproval,
      quietWhenFocused: normalized.quietWhenFocused,
      approvalDelayMs: normalized.approvalDelayMs,
      doneTitle: normalized.doneTitle,
    }))
    if (normalized.enabled !== true) note('the override disables the plugin; that is almost certainly not intended')
  }
}

if (fs.existsSync(path.join(installed, 'cordis.patch.yml'))) {
  console.log('installed bundle patch present')
}

if (problems.length) {
  console.log('')
  for (const problem of problems) console.log('  FAIL', problem)
  console.log(`\nFAILED: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`\nprofile OK: ${pluginId} is wired into ${profileDir}`)
