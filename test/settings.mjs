import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { locateRow, rewriteRowConfig } from '../lib/store.mjs'
import { createStore } from '../lib/store.mjs'
import { CONFIG_FIELDS, normalizeConfig } from '../lib/config.mjs'
import { apply } from '../lib/index.mjs'
import { ROUTE_PREFIX, installPanelInjection, installRoutes } from '../lib/serve.mjs'

const PLUGIN_ID = 'dsh-win-notify'

const failures = []

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

function scratch(patchText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwn-settings-'))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText, 'utf8')
  return dir
}

const REALISTIC = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    fontSize: 15
# —— dsh-win-notify ——
- id: dsh-win-notify
  name: "dsh-win-notify"
  config:
    enabled: true
    notifyDone: true
    doneTitle: "任务完成"
- id: trailing-row
  name: "some-other-plugin"
  config:
    keepMe: true
`

console.log('\n[1] row location')

await check('locateRow finds the row and its config block', () => {
  const found = locateRow(REALISTIC, PLUGIN_ID)
  assert.ok(found, 'row not found')
  assert.ok(found.configStart > found.start, 'config block not located')
  assert.ok(found.end > found.configStart, 'row end not located')
  assert.equal(found.lines[found.start].trim(), '- id: dsh-win-notify')
})

await check('locateRow returns null for an absent row', () => {
  assert.equal(locateRow(REALISTIC, 'no-such-plugin'), null)
})

await check('locateRow does not match a longer id with the same prefix', () => {
  const text = '- id: dsh-win-notify-extra\n  name: x\n'
  assert.equal(locateRow(text, PLUGIN_ID), null)
})

console.log('\n[2] rewriting preserves everything else')

await check('the result is still a top-level YAML array', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: false })
  const meaningful = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert.ok(/^-\s/.test(meaningful[0]), 'first meaningful line must start a list item')
})

await check('every other row survives byte-for-byte', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: false })
  assert.ok(out.includes('welcomeNoticeVersion: 2026-08-13.1'))
  assert.ok(out.includes('reasoningEffort: max'))
  assert.ok(out.includes('fontSize: 15'))
  assert.ok(out.includes('- id: trailing-row'))
  assert.ok(out.includes('keepMe: true'))
})

await check('comments above and inside are preserved', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: false })
  assert.ok(out.includes('# Your patch layer for this dsh profile'))
  assert.ok(out.includes('# —— dsh-win-notify ——'))
})

await check('the trailing row after ours is not swallowed', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: false })
  const lines = out.split('\n')
  const trailing = lines.findIndex((l) => l.includes('- id: trailing-row'))
  const ours = lines.findIndex((l) => l.includes('- id: dsh-win-notify'))
  assert.ok(trailing > ours, 'trailing row must come after ours')

  assert.ok(!out.includes('keepMe: true\n    enabled'), 'config blocks must not merge')
})

await check('rewriting is idempotent', () => {
  const once = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: true, notifyDone: false })
  const twice = rewriteRowConfig(once, PLUGIN_ID, { enabled: true, notifyDone: false })
  assert.equal(once, twice, 'a second identical write must not change the file')
})

await check('an update keeps previously written keys', () => {
  const once = rewriteRowConfig(REALISTIC, PLUGIN_ID, { notifyError: false, enabled: true, notifyDone: true, doneTitle: '任务完成' })
  const twice = rewriteRowConfig(once, PLUGIN_ID, { notifyError: false, notifyBlocked: false, enabled: true, notifyDone: true, doneTitle: '任务完成' })
  assert.ok(twice.includes('notifyBlocked: false'))
})

console.log('\n[3] hostile and awkward values stay inside their scalar')

await check('a value containing a colon and hash is quoted', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { doneTitle: 'a: b # c' })
  assert.ok(out.includes('doneTitle: "a: b # c"'), `got: ${out.split('\n').find((l) => l.includes('doneTitle'))}`)
})

await check('a value that looks like a list item is quoted', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { doneTitle: '- not a list' })
  const line = out.split('\n').find((l) => l.includes('doneTitle'))
  assert.ok(line.includes('"'), `must be quoted, got: ${line}`)
})

await check('embedded double quotes are escaped', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { doneTitle: 'say "hi"' })
  assert.ok(out.includes('doneTitle: "say \\"hi\\""'))
})

await check('a newline cannot break out of the scalar', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { doneTitle: 'line1\n- id: injected' })
  const expectedRows = REALISTIC.split('\n').filter((l) => /^- /.test(l)).length
  const line = out.split('\n').find((l) => l.includes('doneTitle'))
  assert.ok(line, 'doneTitle line missing')
  assert.ok(line.includes('\\n'), `newline must be escaped, got: ${line}`)
  assert.ok(line.trim().startsWith('doneTitle: "'), `must be a quoted scalar, got: ${line}`)
  const rows = out.split('\n').filter((l) => /^- /.test(l))
  assert.equal(rows.length, expectedRows, `row count must not change (${expectedRows})`)
  assert.ok(!/^- id: injected/m.test(out), 'no row may be injected')
})

await check('values that YAML would read as another type are quoted', () => {

  for (const value of ['%TITLE%', '*alias', '@reserved', 'yes', 'on', 'null', '2.5', '123', '#comment']) {
    const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { doneTitle: value })
    const line = out.split('\n').find((l) => l.includes('doneTitle'))
    assert.ok(line.includes('"'), `${JSON.stringify(value)} must be quoted, got: ${line}`)
  }
})

await check('ordinary paths and words stay unquoted for readability', () => {
  for (const value of ['DeepSeek Harness', 'electron.app.DeepSeek Harness', 'blank,question', 'exact']) {
    const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { focusUrl: value })
    const line = out.split('\n').find((l) => l.includes('focusUrl'))
    assert.ok(!line.includes('"'), `${JSON.stringify(value)} should stay plain, got: ${line}`)
  }
})

await check('a numeric-looking string is quoted so it stays a string', () => {

  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { focusUrl: '0' })
  const line = out.split('\n').find((l) => l.includes('focusUrl'))
  assert.ok(line.includes('"0"'), `expected a quoted string, got: ${line}`)
})

await check('unknown keys are not written back into the profile', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: true, notARealKey: 'x', anotherFake: 1 })
  assert.ok(!out.includes('notARealKey'), 'an undeclared key must not be persisted')
  assert.ok(!out.includes('anotherFake'))
})

await check('empty string becomes an explicit quoted empty scalar', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { iconPath: '' })
  assert.ok(out.includes('iconPath: ""'))
})

await check('booleans and numbers are emitted unquoted', () => {
  const out = rewriteRowConfig(REALISTIC, PLUGIN_ID, { enabled: false, rateLimitMs: 0, rateLimitMax: 6 })
  assert.ok(out.includes('enabled: false'))
  assert.ok(out.includes('rateLimitMs: 0'))
  assert.ok(out.includes('rateLimitMax: 6'))
})

await check('a row without a config block gains one', () => {
  const text = '- id: other\n  name: x\n- id: dsh-win-notify\n  name: "dsh-win-notify"\n'
  const out = rewriteRowConfig(text, PLUGIN_ID, { enabled: true })
  assert.ok(out.includes('- id: dsh-win-notify\n  config:\n    enabled: true'))
  assert.ok(out.includes('- id: other'))
})

console.log('\n[4] store round-trip on a real file')

await check('load reads back typed values', () => {
  const dir = scratch(REALISTIC)
  const store = createStore({ patchPath: path.join(dir, 'cordis.patch.yml'), pluginId: PLUGIN_ID, log: () => {} })
  const { config, found } = store.load()
  assert.ok(found)
  assert.equal(config.enabled, true)
  assert.equal(config.notifyDone, true)
  assert.equal(config.doneTitle, '任务完成')
})

await check('save merges, persists, and re-reads identically', () => {
  const dir = scratch(REALISTIC)
  const file = path.join(dir, 'cordis.patch.yml')
  const store = createStore({ patchPath: file, pluginId: PLUGIN_ID, log: () => {} })
  const result = store.save({ notifyError: false, quietWhenFocused: false })
  assert.ok(result.ok, `save failed: ${result.error}`)
  const reopened = createStore({ patchPath: file, pluginId: PLUGIN_ID, log: () => {} })
  const { config } = reopened.load()
  assert.equal(config.notifyError, false)
  assert.equal(config.quietWhenFocused, false)

  assert.equal(config.notifyDone, true)
  assert.equal(config.doneTitle, '任务完成')

  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('fontSize: 15'))
  assert.ok(text.includes('- id: trailing-row'))
})

await check('save reports failure for a missing row instead of writing', () => {
  const dir = scratch('- id: someone-else\n  name: x\n')
  const file = path.join(dir, 'cordis.patch.yml')
  const before = fs.readFileSync(file, 'utf8')
  const store = createStore({ patchPath: file, pluginId: PLUGIN_ID, log: () => {} })
  const result = store.save({ enabled: false })
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file must be untouched')
})

await check('no temp file is left behind', () => {
  const dir = scratch(REALISTIC)
  const store = createStore({ patchPath: path.join(dir, 'cordis.patch.yml'), pluginId: PLUGIN_ID, log: () => {} })
  store.save({ notifyDone: false })
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.equal(leftovers.length, 0, `leftovers: ${leftovers.join(', ')}`)
})

await check('all writable UI keys survive a full write/read cycle', () => {
  const dir = scratch(REALISTIC)
  const file = path.join(dir, 'cordis.patch.yml')
  const store = createStore({ patchPath: file, pluginId: PLUGIN_ID, log: () => {} })
  const patch = {}
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    if (field[0] === 'boolean') patch[key] = false
  }
  const result = store.save(patch)
  assert.ok(result.ok, `save failed: ${result.error}`)
  const reopened = createStore({ patchPath: file, pluginId: PLUGIN_ID, log: () => {} })
  const { config } = reopened.load()
  for (const key of Object.keys(patch)) {
    assert.equal(config[key], false, `${key} did not round-trip`)
  }
})

console.log('\n[5] HTTP surface')

function fakeCtx() {
  const routes = []
  const listeners = new Map()
  return {
    routes,
    listeners,
    get(name) {
      if (name !== 'webServer') return null
      return {
        register(route) {
          const clash = routes.find((r) => r.kind === route.kind && r.path === route.path)
          if (clash) throw new Error(`duplicate (kind,path): ${route.kind} ${route.path}`)
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      }
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
  }
}

function fakeReqRes({ method = 'GET', body, headers = {} } = {}) {
  const res = { code: 0, headers: null, body: '' }
  const req = {
    method,
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin', ...headers },
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
    },
    destroy() {},
  }
  res.writeHead = (code, hdrs) => { res.code = code; res.headers = hdrs }
  res.end = (text) => { res.body = text || '' }
  return { req, res }
}

function mountRoutes() {
  const ctx = fakeCtx()
  const live = normalizeConfig({})
  const store = { patchPath: 'X:\\cordis.patch.yml', save: () => ({ ok: true, config: {} }) }
  installRoutes(ctx, {
    getConfig: () => ({ ...live }),
    applyConfig: (patch) => { Object.assign(live, patch); return { ...live } },
    store,
    sendTest: () => ({ shown: true }),
    log: () => {},
  })
  return { ctx, live, byPath: Object.fromEntries(ctx.routes.map((r) => [r.path, r])) }
}

await check('the three routes mount under the plugin prefix', () => {
  const { ctx, byPath } = mountRoutes()
  for (const suffix of ['/widget.js', '/config', '/test']) {
    assert.ok(byPath[ROUTE_PREFIX + suffix], `missing route ${ROUTE_PREFIX}${suffix}`)
  }
  assert.equal(ctx.routes.length, 3)
})

await check('GET /config returns the current settings', async () => {
  const { byPath } = mountRoutes()
  const { req, res } = fakeReqRes()
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.config.quietWhenFocused, true)
  assert.ok(body.patchPath)
})

await check('POST /config applies and persists a valid boolean', async () => {
  const { byPath, live } = mountRoutes()
  const { req, res } = fakeReqRes({ method: 'POST', body: { notifyDone: false } })
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(live.notifyDone, false, 'the live config must update immediately')
})

await check('POST /config rejects wrong types and unknown keys', async () => {
  const { byPath, live } = mountRoutes()
  const before = live.notifyDone
  const { req, res } = fakeReqRes({ method: 'POST', body: { notifyDone: 'yes', nonsense: true } })
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 400)
  assert.equal(live.notifyDone, before, 'a rejected update must not be applied')
})

await check('POST /config rejects a cross-site request', async () => {
  const { byPath } = mountRoutes()
  const { req, res } = fakeReqRes({ method: 'POST', body: { notifyDone: false }, headers: { 'sec-fetch-site': 'cross-site' } })
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 403)
})

await check('a foreign Origin is refused on writes', async () => {
  const { byPath } = mountRoutes()
  const { req, res } = fakeReqRes({
    method: 'POST',
    body: { notifyDone: false },
    headers: { origin: 'http://evil.example' },
  })
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 403)
})

await check('a same-origin write is allowed', async () => {
  const { byPath } = mountRoutes()
  const { req, res } = fakeReqRes({
    method: 'POST',
    body: { notifyDone: false },
    headers: { origin: 'http://127.0.0.1:19387' },
  })
  await byPath[ROUTE_PREFIX + '/config'].handler(req, res)
  assert.equal(res.code, 200)
})

await check('the widget script is served with a JS content type', async () => {
  const { byPath } = mountRoutes()
  const { req, res } = fakeReqRes()
  await byPath[ROUTE_PREFIX + '/widget.js'].handler(req, res)
  assert.equal(res.code, 200)
  assert.ok(res.headers['Content-Type'].includes('javascript'))
  assert.ok(res.body.includes('__dshWinNotifyMounted'), 'served the real panel source')
})

await check('POST /test triggers a toast and refuses GET', async () => {
  const { byPath } = mountRoutes()
  const ok = fakeReqRes({ method: 'POST' })
  await byPath[ROUTE_PREFIX + '/test'].handler(ok.req, ok.res)
  assert.equal(ok.res.code, 200)
  const bad = fakeReqRes({ method: 'GET' })
  await byPath[ROUTE_PREFIX + '/test'].handler(bad.req, bad.res)
  assert.equal(bad.res.code, 405)
})

console.log('\n[6] injection row')

await check('a script row is pushed with the widget URL', () => {
  const ctx = fakeCtx()
  installPanelInjection(ctx, () => {})
  const handlers = ctx.listeners.get('webserver/index-inject') || []
  assert.equal(handlers.length, 1)
  const table = []
  handlers[0](table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.ok(table[0].text.includes(ROUTE_PREFIX + '/widget.js'))
  assert.ok(table[0].text.includes('onerror'), 'a load failure must not break the page boot')
})

await check('pushing twice does not duplicate the row', () => {
  const ctx = fakeCtx()
  installPanelInjection(ctx, () => {})
  const handler = (ctx.listeners.get('webserver/index-inject') || [])[0]
  const table = []
  handler(table)
  handler(table)
  assert.equal(table.length, 1)
})

await check('an existing script-src row for the same URL is respected', () => {
  const ctx = fakeCtx()
  installPanelInjection(ctx, () => {})
  const handler = (ctx.listeners.get('webserver/index-inject') || [])[0]
  const table = [{ kind: 'script-src', src: ROUTE_PREFIX + '/widget.js' }]
  handler(table)
  assert.equal(table.length, 1, 'must not add a second loader')
})

await check('a malformed table never throws', () => {
  const ctx = fakeCtx()
  installPanelInjection(ctx, () => {})
  const handler = (ctx.listeners.get('webserver/index-inject') || [])[0]
  handler(null)
  handler(undefined)
  handler('nope')
  handler([null, undefined, 0])
})

console.log('\n[7] route mounting when webServer is not ready yet')

function lateServerCtx({ instant = false } = {}) {
  const routes = []
  const pending = []
  const server = {
    register(route) {
      const clash = routes.find((r) => r.kind === route.kind && r.path === route.path)
      if (clash) throw new Error(`duplicate (kind,path): ${route.kind} ${route.path}`)
      routes.push(route)
      return () => {}
    },
  }
  const base = {
    routes,
    on() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get(name) {
      if (name !== 'webServer') return null
      return instant ? server : null
    },
    inject(deps, callback) {
      pending.push({ deps, callback })
      return { dispose() {} }
    },

    provideServer() {
      const scope = { ...base, get: (name) => (name === 'webServer' ? server : null) }
      for (const entry of pending.splice(0)) entry.callback(scope)
    },
  }
  return base
}

await check('routes mount even when webServer appears only after apply', () => {
  const ctx = lateServerCtx({ instant: false })
  apply(ctx, { rateLimitMs: 0 })
  assert.equal(ctx.routes.length, 0, 'nothing should mount synchronously')

  ctx.provideServer()
  assert.equal(ctx.routes.length, 3, `expected 3 routes after the service arrived, got ${ctx.routes.length}`)
  const paths = ctx.routes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/dsh-win-notify/config',
    '/dsh-win-notify/test',
    '/dsh-win-notify/widget.js',
  ])
})

await check('a synchronous mount is not duplicated by the deferred path', () => {
  const ctx = lateServerCtx({ instant: true })
  apply(ctx, { rateLimitMs: 0 })
  assert.equal(ctx.routes.length, 3, 'routes should mount immediately when the service is ready')

  ctx.provideServer()
  assert.equal(ctx.routes.length, 3, 'duplicate registration would throw on (kind,path)')
})

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('settings surface OK')
