import { configValidator } from '../lib/config.mjs'
import { apply } from '../lib/index.mjs'
import { ROUTE_PREFIX } from '../lib/serve.mjs'

const seen = []

function host() {
  const routes = []
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const ctx = {
    routes,
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (name) => (name === 'webServer' ? webServer : null),
    inject: () => ({ dispose() {} }),
  }
  return ctx
}

async function bootAndRead(env) {
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    const ctx = host()
    apply(ctx, configValidator['~standard'].validate({}).value)
    const route = ctx.routes.find((r) => r.path === ROUTE_PREFIX + '/config')
    if (!route) return '(no /config route mounted)'

    const res = { code: 0, headers: null, body: '', writeHead(c, h) { this.code = c; this.headers = h }, end(t) { this.body = t || '' } }
    const req = { method: 'GET', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' }, on() {}, destroy() {} }
    await route.handler(req, res)
    const parsed = JSON.parse(res.body)
    return parsed.patchPath
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const cases = [
  {
    label: 'DSH_PROFILE_DIR set (the normal case)',
    env: { DSH_PROFILE_DIR: 'C:\\Users\\YuKomore\\.dsh\\profiles\\desktop' },
    expectPath: true,
  },
  {
    label: 'DSH_PROFILE_DIR missing, fallback to DSH_HOME + DSH_PROFILE',
    env: {
      DSH_PROFILE_DIR: undefined,
      DSH_HOME: 'C:\\Users\\YuKomore\\.dsh',
      DSH_PROFILE: 'desktop',
    },
    expectPath: true,
  },
  {
    label: 'DSH_PROFILE_DIR empty string, fallback to DSH_PROFILE',
    env: { DSH_PROFILE_DIR: '', DSH_HOME: 'C:\\Users\\YuKomore\\.dsh', DSH_PROFILE: 'desktop' },
    expectPath: true,
  },
  {
    label: 'a profile name that does not exist is rejected',
    env: { DSH_PROFILE_DIR: 'C:\\no\\such\\profile', DSH_HOME: undefined, DSH_PROFILE: undefined },
    expectPath: false,
  },
  {

    label: 'nothing set: no path, but the panel still mounts',
    env: { DSH_PROFILE_DIR: undefined, DSH_PROFILE: undefined, DSH_HOME: undefined },
    expectPath: false,
  },
]

let failures = 0
for (const item of cases) {
  const result = await bootAndRead(item.env)
  const mounted = result !== '(no /config route mounted)'
  const hasPath = Boolean(result)
  const ok = mounted && hasPath === item.expectPath
  if (!ok) failures += 1
  seen.push({ label: item.label, patchPath: result, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${item.label}`)
  console.log(`         mounted=${mounted} path=${JSON.stringify(result)} (expected path: ${item.expectPath})`)
}

console.log('')
if (failures) {
  console.log(`FAILED: ${failures} case(s)`)
  process.exit(1)
}
console.log('profile path resolution OK in every case')
