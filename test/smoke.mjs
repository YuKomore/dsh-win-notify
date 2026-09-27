import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin, {
  apply,
  name,
  normalizeConfig,
  escapeXml,
  psLiteral,
  buildToastXml,
  buildPowerShell,
  diagnose,
} from '../lib/index.mjs'
import { DEFAULT_TEMPLATES } from '../lib/defaults.mjs'

const SHOW_TOASTS = process.argv.includes('--toast')

function makeCtx() {
  const listeners = new Map()
  const effects = []
  return {
    listeners,
    effects,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const list = listeners.get(event) || []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    get() { return null },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) handler(...args)
    },
    unload() {
      for (const dispose of effects.reverse()) dispose()
    },
  }
}

const session = (id) => ({ id })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function captureLog(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines
}

const notified = (lines, hook) => lines.some((line) => line.includes(`notify ${hook}`))

function shownCount(lines, hook) {
  for (const line of [...lines].reverse()) {
    const marker = line.indexOf('{"finalStats"')
    if (marker < 0) continue
    try {
      const parsed = JSON.parse(line.slice(marker))
      const byHook = parsed.finalStats && parsed.finalStats.byHook
      return (byHook && Number(byHook[hook])) || 0
    } catch {
      return 0
    }
  }
  return 0
}

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

const TEST_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dwn-smoke-profile-'))
fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'cordis.patch.yml'), [
  '- id: dsh-win-notify',
  '  name: "dsh-win-notify"',
  '  config:',
  '    rateLimitMs: 0',
  '    approvalDelayMs: 40',
  '    questionDelayMs: 40',
  '',
].join('\n'), 'utf8')
process.on('exit', () => {
  try { fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }) } catch {  }
})

const TEST_PROFILE_ROW = {
  rateLimitMs: 0,
  approvalDelayMs: 40,
  questionDelayMs: 40,
}

function writeTestProfile(row) {
  const lines = ['- id: dsh-win-notify', '  name: "dsh-win-notify"', '  config:']
  for (const [key, value] of Object.entries(row)) {
    lines.push(`    ${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
  }
  lines.push('')
  fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'cordis.patch.yml'), lines.join('\n'), 'utf8')
}

writeTestProfile(TEST_PROFILE_ROW)
process.on('exit', () => {
  try { fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }) } catch {  }
})

function boot(config) {
  const overrides = { ...TEST_PROFILE_ROW, ...config }

  writeTestProfile(overrides)

  const ctx = makeCtx()
  const errors = []
  const originalError = console.error
  const savedProfileDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = TEST_PROFILE_DIR
  console.error = (...args) => errors.push(args.join(' '))
  try {
    apply(ctx, overrides)
  } finally {
    console.error = originalError
    if (savedProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = savedProfileDir
  }
  return { ctx, errors }
}

console.log('\n[1] escaping and injection safety')

await check('escapeXml neutralizes XML metacharacters', () => {
  assert.equal(escapeXml('<&>"\''), '&lt;&amp;&gt;&quot;&apos;')
})

await check('escapeXml ampersand is not double-escaped', () => {
  assert.equal(escapeXml('a & b'), 'a &amp; b')
  assert.equal(escapeXml('&amp;'), '&amp;amp;')
})

await check('escapeXml strips characters illegal in XML 1.0', () => {
  assert.equal(escapeXml('a\u0000\u0007b\u001Fc'), 'abc')
  assert.equal(escapeXml('keep\ttab'), 'keep\ttab')
})

await check('psLiteral doubles only the single quote', () => {

  assert.equal(psLiteral("it's"), "'it''s'")
  assert.equal(psLiteral('$env:PATH'), "'$env:PATH'")
  assert.equal(psLiteral('back`tick'), "'back`tick'")
})

await check('a command-substitution payload survives as inert text', () => {
  const attack = "'; Remove-Item C:\\ -Recurse -Force; '"
  const escaped = escapeXml(attack)
  const literal = psLiteral(escaped)
  const roundTrip = literal.slice(1, -1).replace(/''/g, "'")
  assert.equal(roundTrip, escaped)
  assert.ok(!literal.slice(1, -1).includes("';"), 'payload must not close the literal')
})

await check('an XML break-out payload cannot escape the <text> element', () => {
  const attack = '</text></binding></visual></toast><toast><visual><binding template="ToastGeneric"><text>pwn'
  const xml = buildToastXml({ title: attack, body: 'ok' })

  assert.equal((xml.match(/<toast/g) || []).length, 1)

  assert.equal((xml.match(/<\/text>/g) || []).length, 3)
  assert.ok(xml.includes('&lt;/text&gt;'))
  assert.ok(!xml.includes('<text>pwn'), 'the payload must not become markup')
})

await check('the launch attribute is escaped, so a quote cannot inject an attribute', () => {
  const xml = buildToastXml({ title: 't', body: 'b', launch: 'http://x/" onload="evil' })
  assert.ok(!/onload="evil"/.test(xml), 'quote must not terminate the attribute')
  assert.ok(xml.includes('&quot;'))
})

console.log('\n[2] generated PowerShell')

const generated = buildPowerShell({
  title: "标题 with 'quotes' & <tags>",
  body: 'body',
  launch: 'http://127.0.0.1:19387/',
  aumid: 'electron.app.DeepSeek Harness',
  bypassDnd: false,
  foregroundProcesses: ['DeepSeek Harness'],
  foregroundTitles: ['DeepSeek Harness'],
  suppressWhenFocused: true,
  showWhenDnd: false,
})

await check('dynamic text is confined to a quoted literal in the program', () => {

  assert.ok(generated.includes("$xmlText = '<toast"), 'the toast XML must be one quoted literal')
  assert.ok(generated.includes('&apos;'), 'the quote payload must be XML-escaped inside the literal')
  const start = generated.indexOf("$xmlText = '") + "$xmlText = '".length
  const end = generated.indexOf("'\r\n$", start)
  assert.ok(end > start, 'the literal must terminate')
  const literalBody = generated.slice(start, end)
  assert.ok(!/'(?!')/.test(literalBody), 'an un-doubled quote would close the literal early')
})

await check('non-ASCII text survives the UTF-16LE payload round-trip', () => {

  const encoded = Buffer.from(generated, 'utf16le').toString('base64')
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(encoded), 'base64 alphabet only')
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.equal(decoded, generated, 'the program must round-trip byte-for-byte')
  assert.ok(decoded.includes('标题'), 'the Chinese title must survive')
})

await check('only the data literals may hold non-ASCII; the skeleton stays ASCII', () => {

  const lines = generated.split('\r\n').map((line) => {
    if (line.startsWith('$xmlText = ')) return '$xmlText = <data>'
    if (line.startsWith('$aumid = ')) return '$aumid = <data>'
    return line
  })
  const offenders = lines.join('\n').split('\n').filter((line) => /[^\x00-\x7F]/.test(line))
  assert.equal(offenders.length, 0, `non-ASCII outside a data literal: ${JSON.stringify(offenders.slice(0, 3))}`)
})

await check('the script declares all three exit paths', () => {
  assert.ok(generated.includes('exit 11'), 'focused suppression exit')
  assert.ok(generated.includes('exit 12'), 'do-not-disturb suppression exit')
  assert.ok(generated.includes('exit 0'), 'shown exit')
})

await check('progress output is silenced so stderr stays empty', () => {
  assert.ok(generated.startsWith("$ProgressPreference = 'SilentlyContinue'"))
})

await check('the AUMID is a quoted literal, not interpolated', () => {
  assert.ok(generated.includes("$aumid = 'electron.app.DeepSeek Harness'"))
})

console.log('\n[3] config normalization')

await check('defaults are complete', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.quietWhenFocused, true)
  assert.equal(config.notifySubagents, false)
  assert.equal(config.notifyUserAbort, false)
  assert.equal(config.approvalDelayMs, 1200)
  assert.equal(config.doneTitle, DEFAULT_TEMPLATES.doneTitle)
  assert.equal(config.appId, 'electron.app.DeepSeek Harness')
})

await check('garbage values fall back instead of throwing', () => {
  const config = normalizeConfig({ approvalDelayMs: 'nope', enabled: 'yes', appId: 42, focusUrl: null })
  assert.equal(config.approvalDelayMs, 1200)
  assert.equal(config.enabled, true)
  assert.equal(config.appId, 'electron.app.DeepSeek Harness')
  assert.equal(config.focusUrl, 'dsh://open')
})

await check('explicit overrides are honored, including templates', () => {
  const config = normalizeConfig({ notifyDone: false, doneTitle: '搞定了', rateLimitMs: 0, disabledHooks: 'aborted, error' })
  assert.equal(config.notifyDone, false)
  assert.equal(config.doneTitle, '搞定了')
  assert.equal(config.rateLimitMs, 0)
  assert.equal(config.disabledHooks, 'aborted, error')
})

await check('blank template overrides fall back to the default', () => {
  assert.equal(normalizeConfig({ doneTitle: '   ' }).doneTitle, DEFAULT_TEMPLATES.doneTitle)
})

await check('the standard-schema validator never reports issues', () => {
  const validator = plugin.Config['~standard']
  const result = validator.validate({ nonsense: true, approvalDelayMs: 'x' })
  assert.ok(!result.issues, 'a notification plugin must not be able to fail the boot')
  assert.equal(result.value.enabled, true)
  assert.equal(result.value.approvalDelayMs, 1200)
})

await check('the plugin exposes a valid cordis shape', () => {
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, name)
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(plugin.Config['~standard'].version, 1)
})

console.log('\n[4] event decisions')

await check('the plugin subscribes to session/event and session/disposed', () => {
  const { ctx } = boot({})
  assert.ok(ctx.listeners.get('session/event')?.length >= 1)
  assert.ok(ctx.listeners.get('session/disposed')?.length >= 1)
})

await check('a completed turn with assistant output notifies', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-root')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'session/title', data: { title: '重构登录模块' } })
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', s, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '已经改完了，测试通过。' }] } },
    })
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await wait(120)
  })
  assert.ok(notified(lines, 'done'), `expected a done notify, got: ${lines.join(' | ')}`)
  assert.ok(lines.some((line) => line.includes('重构登录模块')), 'the session title must be used')
})

await check('a completed turn without assistant output stays silent', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-empty')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 2 } })
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await wait(60)
  })
  assert.ok(!notified(lines, 'done'), 'an interrupted-and-redriven turn must not notify')
})

await check('an instantly-decided approval does NOT notify (the policy:never case)', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-never')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', reason: 'sandbox escalation' } })
    ctx.emit('session/event', s, { type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } })
    await wait(120)
  })
  assert.ok(!notified(lines, 'approval'), 'an auto-rejected approval must not wake the user')
})

await check('an approval still pending after the grace period DOES notify', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-ask')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'session/title', data: { title: '部署到生产' } })
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'a2', toolName: 'pwsh', reason: 'sandbox escalation' } })
    await wait(150)
  })
  assert.ok(notified(lines, 'approval'), `expected an approval notify, got: ${lines.join(' | ')}`)
  assert.ok(lines.some((line) => line.includes('需要你批准')), 'expected the default approval title')
  assert.ok(lines.some((line) => line.includes('pwsh')), 'expected the tool name in the body')
  assert.ok(lines.some((line) => line.includes('部署到生产')), 'expected the session title in the body')
})

await check('an approval decided just before the deadline is cancelled', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-fast')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'a3', toolName: 'pwsh' } })
    await wait(10)
    ctx.emit('session/event', s, { type: 'approval/decided', data: { id: 'a3', outcome: 'allowed-once' } })
    await wait(150)
  })
  assert.ok(!notified(lines, 'approval'), 'a cancelled approval must not notify')
})

await check('ask_user_question notifies when the answer never comes', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-q')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'session/title', data: { title: '选一个方案' } })
    ctx.emit('session/event', s, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' },
    })
    await wait(150)
  })
  assert.ok(notified(lines, 'question'), `expected a question notify, got: ${lines.join(' | ')}`)
  assert.ok(lines.some((line) => line.includes('选一个方案')), 'expected the session title in the body')
})

await check('a matching tool/result cancels the pending question', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-q2')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9', name: 'ask_user_question' } })
    await wait(10)
    ctx.emit('session/event', s, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c9' } } })
    await wait(150)
  })
  assert.ok(!notified(lines, 'question'), 'an answered question must not notify')
})

await check('an unrelated tool result does not cancel a pending question', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-q3')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'keep', name: 'ask_user_question' } })
    ctx.emit('session/event', s, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'other' } } })
    await wait(150)
  })
  assert.ok(notified(lines, 'question'), 'the question must still fire')
})

await check('a non-question tool call never triggers a question notify', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-other')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'x', name: 'read_file' } })
    await wait(100)
  })
  assert.equal(lines.filter((line) => line.includes('notify')).length, 0)
})

await check('every turn/end reason maps to the right hook', async () => {
  const cases = [
    ['blocked', { kind: 'blocked' }],
    ['max-tokens', { kind: 'max-tokens' }],
    ['error', { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }],
    ['aborted', { kind: 'aborted', reason: { kind: 'parent' } }],
  ]
  for (const [hook, reason] of cases) {
    const { ctx } = boot({ debug: true })
    const lines = await captureLog(async () => {
      ctx.emit('session/event', session(`s-${hook}`), { type: 'turn/end', data: { turn: 1, reason } })
      await wait(60)
    })
    assert.ok(notified(lines, hook), `${hook} should notify, got: ${lines.join(' | ')}`)
  }
})

await check('a user-initiated abort stays silent by default', async () => {
  const { ctx } = boot({ debug: true })
  const lines = await captureLog(async () => {
    ctx.emit('session/event', session('s-skip'), {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    await wait(60)
  })
  assert.ok(!lines.some((line) => line.includes('notify')), 'a user abort must not notify')
})

await check('notifyUserAbort re-enables the user-abort toast', async () => {
  const { ctx } = boot({ debug: true, notifyUserAbort: true })
  const lines = await captureLog(async () => {
    ctx.emit('session/event', session('s-userabort'), {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    await wait(60)
  })
  assert.ok(notified(lines, 'aborted'), 'expected an abort notify')
})

await check('interrupted and forked reasons are ignored', async () => {
  for (const kind of ['interrupted', 'forked']) {
    const { ctx } = boot({ debug: true })
    const lines = await captureLog(async () => {
      ctx.emit('session/event', session(`s-${kind}`), { type: 'turn/end', data: { turn: 1, reason: { kind } } })
      await wait(40)
    })
    assert.ok(!lines.some((line) => line.includes('notify')), `${kind} must not notify`)
  }
})

await check('subagent sessions are skipped unless notifySubagents is set', async () => {
  const { ctx } = boot({ debug: true })
  const child = { id: 's-child', parentId: 's-parent' }
  const lines = await captureLog(async () => {
    ctx.emit('session/event', child, { type: 'approval/asked', data: { id: 'sub1', toolName: 'pwsh' } })
    await wait(100)
    ctx.emit('session/event', session('s-parent'), { type: 'approval/asked', data: { id: 'root1', toolName: 'pwsh' } })
    await wait(100)
  })
  assert.equal(lines.filter((line) => line.includes('notify approval')).length, 1, 'only the root approval may fire')
})

await check('notifySubagents=true lets child sessions through', async () => {
  const { ctx } = boot({ debug: true, notifySubagents: true })
  const child = { id: 's-child2', parentId: 's-parent' }
  const lines = await captureLog(async () => {
    ctx.emit('session/event', child, { type: 'approval/asked', data: { id: 'sub2', toolName: 'pwsh' } })
    await wait(100)
  })
  assert.ok(notified(lines, 'approval'), 'a child approval should fire')
})

await check('disabledHooks suppresses a matching hook only', async () => {
  const { ctx } = boot({ debug: true, disabledHooks: 'blocked' })
  const lines = await captureLog(async () => {
    const s = session('s-disable')
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } })
    await wait(80)
  })
  assert.ok(!notified(lines, 'blocked'), 'blocked is disabled')
  assert.ok(notified(lines, 'max-tokens'), 'max-tokens still fires')
})

await check('notifyDone=false silences the completion toast', async () => {
  const { ctx } = boot({ debug: true, notifyDone: false })
  const s = session('s-nodone')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } })
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await wait(60)
  })
  assert.ok(!lines.some((line) => line.includes('notify')), 'the done toast should be silenced')
})

await check('notifyApproval=false silences approval toasts', async () => {
  const { ctx } = boot({ debug: true, notifyApproval: false })
  const lines = await captureLog(async () => {
    ctx.emit('session/event', session('s-noappr'), { type: 'approval/asked', data: { id: 'na1', toolName: 'pwsh' } })
    await wait(100)
  })
  assert.ok(!notified(lines, 'approval'), 'the approval toast should be silenced')
})

await check('notifyQuestion=false silences question toasts', async () => {
  const { ctx } = boot({ debug: true, notifyQuestion: false })
  const lines = await captureLog(async () => {
    ctx.emit('session/event', session('s-noq'), { type: 'tool/call', data: { callId: 'nq1', name: 'ask_user_question' } })
    await wait(100)
  })
  assert.ok(!notified(lines, 'question'), 'the question toast should be silenced')
})

await check('the rate limit drops a burst', async () => {
  const { ctx } = boot({ debug: true, rateLimitMs: 60000, rateLimitMax: 2 })
  const lines = await captureLog(async () => {
    for (let i = 0; i < 6; i += 1) {
      ctx.emit('session/event', session(`burst-${i}`), {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { message: `boom ${i}`, code: 'X' } } },
      })
    }
    await wait(120)
  })
  assert.equal(lines.filter((line) => line.includes('notify error')).length, 2, 'exactly 2 notifications expected')
})

await check('a malformed event never throws into the host', () => {
  const { ctx, errors } = boot({ debug: true })
  const s = session('s-junk')
  const junk = [
    { type: 'turn/end' },
    { type: 'turn/end', data: null },
    { type: 'turn/end', data: { turn: 1, reason: null } },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message', data: { turn: 1, message: null } },
    { type: 'assistant/message', data: { turn: 1, message: { content: 'not-an-array' } } },
    { type: 'approval/asked' },
    { type: 'tool/call', data: { name: 'ask_user_question' } },
    { type: 'tool/call' },
    { type: 'tool/result', data: {} },
    { type: 'session/title' },
    null,
    undefined,
    {},
    { type: 42, data: 'nope' },
  ]
  for (const event of junk) ctx.emit('session/event', s, event)
  assert.equal(errors.filter((line) => line.includes('handler failed')).length, 0)
})

await check('session/disposed clears state without throwing', () => {
  const { ctx, errors } = boot({})
  ctx.emit('session/disposed', session('s-root'))
  ctx.emit('session/disposed', {})
  ctx.emit('session/disposed', null)
  assert.equal(errors.length, 0)
})

await check('enabled:false registers nothing', () => {
  const { ctx } = boot({ enabled: false })
  assert.equal(ctx.listeners.size, 0)
})

await check('template tokens render into the message', async () => {
  const { ctx } = boot({
    debug: true,
    approvalBody: '工具=%TOOL% 原因=%REASON% 会话=%TITLE%',
    approvalDelayMs: 20,
  })
  const s = session('s-tpl')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'session/title', data: { title: '我的会话' } })
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'tpl1', toolName: 'pwsh', reason: '提权' } })
    await wait(100)
  })
  const line = lines.find((entry) => entry.includes('notify approval'))
  assert.ok(line, 'expected a notify line')
  assert.ok(line.includes('工具=pwsh'), `tool token not rendered: ${line}`)
  assert.ok(line.includes('原因=提权'), `reason token not rendered: ${line}`)
  assert.ok(line.includes('会话=我的会话'), `title token not rendered: ${line}`)
})

await check('an unknown token collapses instead of leaking', async () => {
  const { ctx } = boot({ debug: true, doneBody: 'x%NOPE%y', doneTitle: 'T' })
  const s = session('s-unknown')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'r' }] } } })
    ctx.emit('session/event', s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await wait(60)
  })
  const line = lines.find((entry) => entry.includes('notify done'))
  assert.ok(line && line.includes('"xy"'), `unknown token should vanish: ${line}`)
})

await check('the error body carries the failure message and is truncated', async () => {
  const { ctx } = boot({ debug: true })
  const s = session('s-long')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: 'y'.repeat(500), code: 'X' } } },
    })
    await wait(60)
  })
  const line = lines.find((entry) => entry.includes('notify error')) || ''
  assert.ok(line.includes('yyyy'), 'the failure message must appear')

  const fields = line.match(/"((?:[^"\\]|\\.)*)"/g) || []
  assert.ok(fields.length >= 2, `could not read the fields from: ${line}`)
  const body = JSON.parse(fields[1])
  assert.ok(body.length <= 160, `body should be <=160 chars, was ${body.length}`)
  assert.ok(body.endsWith('…'), 'the body should be marked as truncated')
})

await check('an approval notification resolves its session title from the title event', async () => {
  const { ctx } = boot({ debug: true, approvalDelayMs: 20 })
  const s = session('s-title-order')
  const lines = await captureLog(async () => {

    ctx.emit('session/event', s, { type: 'session/title', data: { title: '构建流水线' } })
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'ti1', toolName: 'pwsh' } })
    await wait(100)
  })
  assert.ok(lines.some((line) => line.includes('构建流水线')), 'the cached title must be used')
})

await check('unload disposes cleanly and pending timers do not fire', async () => {
  const { ctx } = boot({ debug: true, approvalDelayMs: 200 })
  const s = session('s-unload')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'u1', toolName: 'pwsh' } })
    ctx.unload()
    await wait(320)
  })

  assert.equal(shownCount(lines, 'approval'), 0, 'a disposed plugin must not notify')
  assert.ok(lines.some((line) => line.includes('finalStats')), 'dispose should report final stats')
})

await check('turn/start clears a dangling wait from the previous turn', async () => {
  const { ctx } = boot({ debug: true, approvalDelayMs: 30 })
  const s = session('s-dangle')
  const lines = await captureLog(async () => {
    ctx.emit('session/event', s, { type: 'approval/asked', data: { id: 'd1', toolName: 'pwsh' } })
    ctx.emit('session/event', s, { type: 'turn/start', data: { turn: 5 } })
    await wait(80)
  })
  assert.ok(!notified(lines, 'approval'), 'the dangling wait must be dropped')
})

await check('the click target is the app focus deep link, and is overridable', async () => {

  const launchOf = (lines) => {
    const line = lines.find((entry) => entry.includes('notify max-tokens')) || ''
    const fields = line.match(/"((?:[^"\\]|\\.)*)"/g) || []
    return fields.length ? JSON.parse(fields[fields.length - 1]) : null
  }
  const toast = (ctx) => captureLog(async () => {
    ctx.emit('session/event', session('s-url-' + Math.random()), {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    await wait(60)
  })

  const { ctx } = boot({ debug: true })
  assert.equal(launchOf(await toast(ctx)), 'dsh://open', 'default click target')

  const original = process.env.DSH_WEB_URL
  try {
    process.env.DSH_WEB_URL = 'http://127.0.0.1:45678/'
    const { ctx: ctxEnv } = boot({ debug: true })
    assert.equal(launchOf(await toast(ctxEnv)), 'dsh://open', 'DSH_WEB_URL must not override the deep link')
  } finally {
    if (original === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = original
  }

  const { ctx: ctx2 } = boot({ debug: true, focusUrl: 'https://example.test/landing' })
  assert.equal(launchOf(await toast(ctx2)), 'https://example.test/landing')

  const { ctx: ctx3 } = boot({ debug: true, clickToFocus: false })
  assert.equal(launchOf(await toast(ctx3)), '', 'clickToFocus:false must clear the launch uri')
})

if (SHOW_TOASTS) {
  console.log('\n[5] real Windows toasts')
  console.log('  host:', JSON.stringify(diagnose()))
  const variants = [
    { label: 'plain', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } } },
    {
      label: 'hostile-text',
      event: {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { message: '<script>&"\'; Remove-Item C:\\ -Recurse', code: 'X' } } },
      },
    },
  ]
  for (const variant of variants) {
    const ctx = makeCtx()
    apply(ctx, { quietWhenFocused: false, rateLimitMs: 0 })
    const s = session(`live-${variant.label}`)
    ctx.emit('session/event', s, { type: 'session/title', data: { title: `dsh-win-notify 实测 · ${variant.label}` } })
    ctx.emit('session/event', s, variant.event)
    console.log(`  sent: ${variant.label}`)
    await wait(1800)
  }
}

console.log('')
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`all checks passed (plugin id: ${name})`)
