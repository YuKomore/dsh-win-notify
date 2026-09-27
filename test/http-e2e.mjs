import assert from 'node:assert/strict'
import http from 'node:http'

import { installRoutes, ROUTE_PREFIX } from '../lib/serve.mjs'
import { normalizeConfig } from '../lib/config.mjs'

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

const live = normalizeConfig({})
const routes = []
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const match = routes.find((r) => r.kind === 'exact' && r.path === url.pathname)
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  match.handler(req, res)
})

const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

function fakeCtx() {
  return {
    get: (name) => (name === 'webServer' ? webServer : null),
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (deps, cb) => { cb({ ...fakeCtx() }); return { dispose() {} } },
  }
}

installRoutes(fakeCtx(), {
  getConfig: () => ({ ...live }),
  applyConfig: (patch) => { Object.assign(live, patch); return { ...live } },
  store: { patchPath: 'X:\\cordis.patch.yml', save: () => ({ ok: true }) },
  sendTest: () => ({ shown: true }),
  log: () => {},
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`
console.log(`test server on ${base}  (${routes.length} routes)`)

console.log('\n[1] the panel script is fetchable and is real UI')

let panelSource = ''
await check('GET /widget.js returns 200 JavaScript', async () => {
  const res = await fetch(`${base}/widget.js`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /javascript/)
  panelSource = await res.text()
  assert.ok(panelSource.length > 5000, `suspiciously small: ${panelSource.length} bytes`)
})

await check('the served panel defines the mount guard', () => {
  assert.ok(panelSource.includes('__dshWinNotifyMounted'), 'mount guard missing')
})

await check('the served panel renders the scenario switches', () => {

  for (const label of ['需要我审批时', '智能体提问时', '任务完成时', '任务出错时']) {
    assert.ok(panelSource.includes(label), `missing switch label: ${label}`)
  }
})

await check('the served panel renders the behaviour toggles', () => {
  for (const label of ['DSH 窗口在前台时不弹', '专注助手 / 免打扰时也弹']) {
    assert.ok(panelSource.includes(label), `missing toggle: ${label}`)
  }
})

await check('the served panel has a test-notification button', () => {
  assert.ok(panelSource.includes('发送测试通知'), 'missing the test button')
})

await check('the served panel anchors itself to the shell caption menu', () => {
  assert.ok(panelSource.includes('data-windows-menu'), 'no anchor to the 应用/编辑 bar')
  assert.ok(panelSource.includes('TITLEBAR_HEIGHT'), 'no floating fallback')
})

await check('the served panel escapes host text instead of using innerHTML for it', () => {

  assert.ok(panelSource.includes('textContent'), 'expected textContent assignment')
})

console.log('\n[2] the settings API round-trips over HTTP')

await check('GET /config returns the settings and the patch path', async () => {
  const res = await fetch(`${base}/config`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.config.quietWhenFocused, true)
  assert.ok(body.patchPath)
})

await check('POST /config applies a change and it is visible on the next GET', async () => {
  const post = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyDone: false }),
  })
  assert.equal(post.status, 200)
  const posted = await post.json()
  assert.equal(posted.ok, true)
  assert.equal(posted.config.notifyDone, false)

  const after = await (await fetch(`${base}/config`)).json()
  assert.equal(after.config.notifyDone, false, 'the change must persist in memory')
})

await check('POST /config rejects a non-boolean and leaves state alone', async () => {
  const before = await (await fetch(`${base}/config`)).json()
  const res = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyApproval: 'yes' }),
  })
  assert.equal(res.status, 400)
  const after = await (await fetch(`${base}/config`)).json()
  assert.equal(after.config.notifyApproval, before.config.notifyApproval)
})

await check('POST /config rejects malformed JSON without crashing the server', async () => {
  const res = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  })
  assert.equal(res.status, 400)

  assert.equal((await fetch(`${base}/config`)).status, 200)
})

await check('POST /test reports the delivery result', async () => {
  const res = await fetch(`${base}/test`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
})

console.log('\n[3] unknown paths stay 404')

await check('an unregistered path is not served', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/dsh-win-notify/nope`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404)
})

server.close()

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('http e2e OK — the panel and its API work over a real socket')
