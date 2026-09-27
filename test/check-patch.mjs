import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FIELDS, name as pluginId } from '../lib/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const patchPath = path.join(here, '..', 'cordis.patch.yml')
const text = fs.readFileSync(patchPath, 'utf8')

const rows = text
  .split(/\r?\n/)
  .map((raw, index) => ({ raw, line: index + 1 }))
  .filter(({ raw }) => raw.trim() && !raw.trim().startsWith('#'))

const problems = []
const note = (line, message) => problems.push(`line ${line}: ${message}`)

if (!/^- insert:\s*$/.test(rows[0]?.raw ?? '')) {
  note(rows[0]?.line ?? 1, 'the first content line must be "- insert:" (a top-level array)')
}
const rowLines = rows.slice(1)
const idLines = rowLines.filter(({ raw }) => /^\s*-\s+id:/.test(raw))
if (idLines.length !== 1) {
  note(idLines[0]?.line ?? 1, `expected exactly one inserted row, found ${idLines.length}`)
}

function stripComment(value) {
  let quote = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i)
  }
  return value
}

function readScalar(key) {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`)
  for (const { raw, line } of rowLines) {
    const match = raw.match(pattern)
    if (match) return { value: stripComment(match[1]).trim(), line }
  }
  return null
}

const idEntry = readScalar('id')
if (idEntry) {
  const value = idEntry.value.replace(/^["']|["']$/g, '').trim()
  if (value !== pluginId) note(idEntry.line, `patch id "${value}" must equal the plugin's export name "${pluginId}"`)
} else {
  note(1, 'missing `id` on the inserted row')
}

const nameEntry = readScalar('name')
if (nameEntry) {
  const value = nameEntry.value.replace(/^["']|["']$/g, '').trim()
  if (value !== 'dsh-win-notify') note(nameEntry.line, `patch name "${value}" must be the npm package name "dsh-win-notify"`)
} else {
  note(1, 'missing `name` on the inserted row')
}

const configIndex = rowLines.findIndex(({ raw }) => /^\s*config:\s*$/.test(raw))
if (configIndex < 0) {
  note(1, 'the inserted row has no `config:` block')
} else {
  const configIndent = (rowLines[configIndex].raw.match(/^(\s*)/) || [])[1].length
  const entries = []
  for (const { raw, line } of rowLines.slice(configIndex + 1)) {
    const indent = (raw.match(/^(\s*)/) || [])[1].length
    if (indent <= configIndent) break
    const match = raw.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) {
      note(line, `unparseable config line: ${JSON.stringify(raw.trim())}`)
      continue
    }
    entries.push({ key: match[1], rawValue: stripComment(match[2]).trim(), line })
  }

  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.key)) note(entry.line, `duplicate config key "${entry.key}"`)
    seen.add(entry.key)

    const field = CONFIG_FIELDS[entry.key]
    if (!field) {
      note(entry.line, `unknown config key "${entry.key}" — it would be silently ignored`)
      continue
    }
    const [type] = field

    let value
    if (/^".*"$/.test(entry.rawValue)) value = entry.rawValue.slice(1, -1)
    else if (/^'.*'$/.test(entry.rawValue)) value = entry.rawValue.slice(1, -1)
    else if (entry.rawValue === 'true' || entry.rawValue === 'false') value = entry.rawValue === 'true'
    else if (/^-?\d+(\.\d+)?$/.test(entry.rawValue)) value = Number(entry.rawValue)
    else value = entry.rawValue

    if (type === 'boolean' && typeof value !== 'boolean') {
      note(entry.line, `"${entry.key}" should be a boolean, got ${JSON.stringify(value)}`)
    }
    if (type === 'number' && !Number.isFinite(value)) {
      note(entry.line, `"${entry.key}" should be a number, got ${JSON.stringify(value)}`)
    }
    if (type === 'string' && typeof value !== 'string') {
      note(entry.line, `"${entry.key}" should be a string, got ${JSON.stringify(value)}`)
    }
  }

  const templateKeys = Object.keys(CONFIG_FIELDS).filter((key) => /Title$|Body$/.test(key))
  const missing = templateKeys.filter((key) => !seen.has(key))
  if (missing.length) note(1, `the patch omits template keys: ${missing.join(', ')}`)

  console.log(`patch config keys: ${entries.length} (all recognized: ${entries.every((e) => CONFIG_FIELDS[e.key])})`)

  const raw = {}
  for (const entry of entries) {
    const [type] = CONFIG_FIELDS[entry.key]
    if (type === 'boolean') raw[entry.key] = entry.rawValue === 'true'
    else if (type === 'number') raw[entry.key] = Number(entry.rawValue)
    else raw[entry.key] = entry.rawValue.replace(/^["']|["']$/g, '')
  }
  const { normalizeConfig } = await import('../lib/index.mjs')
  const normalized = normalizeConfig(raw)
  assert.equal(normalized.enabled, true)
  assert.ok(normalized.approvalTitle.length > 0)
  console.log('normalized fine; approvalTitle =', JSON.stringify(normalized.approvalTitle))
}

if (problems.length) {
  console.log('')
  for (const problem of problems) console.log('  FAIL', problem)
  console.log(`\nFAILED: ${problems.length} patch problem(s)`)
  process.exit(1)
}
console.log('patch OK: structure, id/name identity, and every config key check out')
