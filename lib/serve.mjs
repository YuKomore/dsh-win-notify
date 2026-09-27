import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FIELDS, normalizeConfig } from './index.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_PATH = path.join(PACKAGE_ROOT, 'assets', 'panel.js')

export const ROUTE_PREFIX = '/dsh-win-notify'

const EDITABLE = {
  notifyApproval: 'boolean',
  notifyQuestion: 'boolean',
  notifyDone: 'boolean',
  notifyError: 'boolean',
  notifyBlocked: 'boolean',
  notifyMaxTokens: 'boolean',
  notifyAborted: 'boolean',
  notifyUserAbort: 'boolean',
  notifySubagents: 'boolean',
  quietWhenFocused: 'boolean',
  showWhenDnd: 'boolean',
  clickToFocus: 'boolean',
  enabled: 'boolean',
}

function loaderRowText() {
  return '(function(){try{var d=document.body||document.head||document.documentElement;'
    + 'if(!d)return;if(window.__dshWinNotifyMounted)return;'
    + 'var s=document.createElement("script");s.src="' + ROUTE_PREFIX + '/widget.js";'
    + 's.async=true;s.onerror=function(){};d.appendChild(s)}catch(e){}})()'
}

export function installPanelInjection(root, log) {
  try {
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === ROUTE_PREFIX + '/widget.js') return
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf(ROUTE_PREFIX + '/widget.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: loaderRowText() })
        log('registered the desktop injection row')
      } catch (error) {
        log('injection row failed:', String(error && error.message))
      }
    })
  } catch (error) {
    log('could not subscribe to webserver/index-inject:', String(error && error.message))
  }
}

export function installRoutes(ctx, { getConfig, applyConfig, store, sendTest, log }) {
  const server = ctx.get('webServer')
  if (!server || typeof server.register !== 'function') {

    log('webServer not available yet; deferring route registration')
    return null
  }

  const disposers = []

  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('request body too large'))
          try { req.destroy() } catch {  }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!chunks.length) { resolve({}); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
      req.on('error', reject)
    })
  }

  function unsafe(req) {
    const headers = (req && req.headers) || {}
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {

      return String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
    }
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return true
    const origin = headers.origin
    if (!origin) return false
    try {
      const host = String(headers.host || '')
      const parsed = new URL(origin)
      if (parsed.host.toLowerCase() !== host.toLowerCase()) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(parsed.hostname)) return true
      return false
    } catch {
      return true
    }
  }

  function json(res, code, body) {
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function route(kind, routePath, handler) {
    const wrapped = {
      kind,
      path: routePath,
      handler: (req, res) => {
        if (unsafe(req)) { json(res, 403, { ok: false, error: 'forbidden' }); return }
        return handler(req, res)
      },
    }
    try {
      const disposer = server.register(wrapped)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      log(`route ${routePath} failed to register:`, String(error && error.message))
    }
  }

  route('exact', ROUTE_PREFIX + '/widget.js', (req, res) => {
    let source
    try {
      source = fs.readFileSync(PANEL_PATH, 'utf8')
    } catch (error) {
      json(res, 500, { ok: false, error: 'panel unavailable: ' + String(error && error.message) })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(source)
  })

  route('exact', ROUTE_PREFIX + '/config', (req, res) => {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method === 'GET') {
      json(res, 200, {
        ok: true,
        config: getConfig(),
        fields: CONFIG_FIELDS,
        patchPath: store ? store.patchPath : '',
      })
      return
    }
    if (method !== 'POST') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    readJson(req).then((body) => {
      const patch = {}
      const rejected = []
      for (const [key, value] of Object.entries(body && typeof body === 'object' ? body : {})) {
        const type = EDITABLE[key]
        if (!type) { rejected.push(key); continue }
        if (typeof value !== type) { rejected.push(key); continue }
        patch[key] = value
      }
      if (!Object.keys(patch).length) {
        json(res, 400, { ok: false, error: rejected.length ? `no editable keys in: ${rejected.join(', ')}` : 'empty update' })
        return
      }
      const applied = applyConfig(patch)
      const saved = store ? store.save(patch) : { ok: false, error: 'no store' }
      json(res, saved.ok ? 200 : 500, {
        ok: saved.ok,
        error: saved.ok ? undefined : saved.error,
        rejected: rejected.length ? rejected : undefined,
        config: applied,
      })
    }, (error) => {
      json(res, 400, { ok: false, error: String(error && error.message) })
    })
  })

  route('exact', ROUTE_PREFIX + '/test', (req, res) => {
    if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const result = sendTest()
      json(res, 200, { ok: true, result })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error && error.message) })
    }
  })

  log(`routes mounted under ${ROUTE_PREFIX}/`)
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {  }
    }
  }
}
