import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_FIELDS } from './config.mjs'

// Conservative on purpose: an unquoted value that YAML reads as a mapping, list,
// comment or directive makes the whole profile patch unparsable and DSH then
// refuses to start. Quoting is always safe, so anything unusual gets quoted.
function isPlainSafe(text) {
  if (text === '') return false

  if (/[\u0000-\u001F\u007F]/.test(text)) return false

  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return false

  if (/[:#]\s/.test(text)) return false

  if (/^\s/.test(text) || /\s$/.test(text)) return false

  if (/^(true|false|null|~|yes|no|on|off)$/i.test(text)) return false
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return false

  return /^[A-Za-z0-9 _./+@(),=;<>!?*&$~^[\]{}|-]+$/.test(text)
}

// Control characters must be *escaped*, not merely wrapped in quotes: a raw line
// break inside a double-quoted scalar ends the physical line and the remainder
// parses as new structure, corrupting the profile.
export function toYaml(value) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) return '""'
    return String(value)
  }
  const text = String(value === null || value === undefined ? '' : value)
  if (isPlainSafe(text)) return text
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return '"' + escaped + '"'
}

export function locateRow(text, pluginId) {
  const lines = text.split(/\r?\n/)
  const idPattern = new RegExp(`^(\\s*)-\\s+id:\\s*["']?${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`)
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(idPattern)
    if (match) {
      start = i
      indent = match[1]
      break
    }
  }
  if (start < 0) return null

  let end = lines.length
  const itemPattern = new RegExp(`^${indent}-\\s`)
  for (let i = start + 1; i < lines.length; i += 1) {
    if (itemPattern.test(lines[i])) { end = i; break }
  }

  let configStart = -1
  const configPattern = new RegExp(`^${indent}\\s+config:\\s*$`)
  for (let i = start + 1; i < end; i += 1) {
    if (configPattern.test(lines[i])) { configStart = i; break }
  }

  return { lines, start, end, configStart, indent, rowIndent: indent + '  ' }
}

function renderConfigBlock(config, keyIndent) {
  const out = [`${keyIndent}config:`]
  const templateKeys = new Set(Object.keys(CONFIG_FIELDS))
  for (const [key, value] of Object.entries(config)) {
    if (!templateKeys.has(key)) continue
    out.push(`${keyIndent}  ${key}: ${toYaml(value)}`)
  }
  return out
}

function assertPatchShape(text, expectedRows) {
  const lines = text.split('\n')
  const meaningful = lines.filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (!meaningful.length) throw new Error('refusing to write: the file would be empty')
  if (!/^-\s/.test(meaningful[0])) {
    throw new Error('refusing to write: the result is not a top-level YAML array')
  }
  const rowStarts = lines.filter((l) => /^-\s/.test(l))
  if (rowStarts.length !== expectedRows) {
    throw new Error(`refusing to write: row count changed from ${expectedRows} to ${rowStarts.length}`)
  }

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#') || /^-\s/.test(line)) continue
    if (!/^\s+[^\s].*$/.test(line)) throw new Error(`refusing to write: bad indentation in ${JSON.stringify(line)}`)
    if (!/^\s+(?:[A-Za-z0-9_]+:\s*.*|-\s.*)$/.test(line)) {
      throw new Error(`refusing to write: not a mapping entry: ${JSON.stringify(line)}`)
    }
  }
}

export function rewriteRowConfig(text, pluginId, config) {
  const found = locateRow(text, pluginId)
  if (!found) throw new Error(`no patch row found for id "${pluginId}"`)
  const { lines, start, end, configStart, indent, rowIndent } = found
  const expectedRows = lines.filter((l) => /^-\s/.test(l)).length

  const block = renderConfigBlock(config, rowIndent)
  let next
  if (configStart < 0) {

    next = [...lines.slice(0, start + 1), ...block, ...lines.slice(start + 1)]
  } else {

    let configEnd = end
    for (let i = configStart + 1; i < end; i += 1) {
      const raw = lines[i]
      if (!raw.trim()) continue
      const lineIndent = (raw.match(/^(\s*)/) || [])[1]
      if (lineIndent.length <= rowIndent.length) { configEnd = i; break }
    }
    next = [...lines.slice(0, configStart), ...block, ...lines.slice(configEnd)]
  }

  const result = next.join('\n')
  assertPatchShape(result, expectedRows)
  return result
}

export function createStore({ patchPath, pluginId, log }) {
  let cached = null

  return {

    patchPath,

    load() {
      let text
      try {
        text = fs.readFileSync(patchPath, 'utf8')
      } catch (error) {
        return { config: null, found: false, error: String(error && error.message) }
      }
      const found = locateRow(text, pluginId)
      if (!found) return { config: null, found: false }

      const config = {}
      if (found.configStart >= 0) {
        for (let i = found.configStart + 1; i < found.end; i += 1) {
          const raw = found.lines[i]
          if (!raw.trim() || raw.trim().startsWith('#')) continue
          const lineIndent = (raw.match(/^(\s*)/) || [])[1]
          if (lineIndent.length <= found.rowIndent.length) break
          const match = raw.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/)
          if (!match) continue
          let value = match[2].trim()
          const comment = value.search(/\s#/)
          if (comment >= 0) value = value.slice(0, comment).trim()
          if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
          else if (value === 'true' || value === 'false') value = value === 'true'
          else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value)
          config[match[1]] = value
        }
      }
      cached = config
      return { config, found: true }
    },

    snapshot() {
      return cached
    },

    save(patch) {
      const current = this.load()
      if (!current.found) return { ok: false, error: `no "${pluginId}" row in ${patchPath}` }
      const merged = { ...current.config, ...patch }
      let text = fs.readFileSync(patchPath, 'utf8')
      let next
      try {
        next = rewriteRowConfig(text, pluginId, merged)
      } catch (error) {
        return { ok: false, error: String(error && error.message) }
      }
      const temp = patchPath + '.tmp-' + process.pid
      try {
        fs.writeFileSync(temp, next, 'utf8')
        fs.renameSync(temp, patchPath)
      } catch (error) {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch {  }
        return { ok: false, error: String(error && error.message) }
      }
      cached = merged
      log('saved settings:', JSON.stringify(patch))
      return { ok: true, config: merged }
    },
  }
}
