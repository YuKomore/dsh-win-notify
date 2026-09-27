import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FIELDS, configValidator, normalizeConfig } from './config.mjs'
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TOKENS } from './defaults.mjs'
import { installPanelInjection, installRoutes } from './serve.mjs'
import { createStore } from './store.mjs'
import { oneLine, renderTemplate, runPowerShell } from './toast.mjs'

export { CONFIG_FIELDS, normalizeConfig } from './config.mjs'

export const name = 'dsh-win-notify'

export const inject = []

const LOG_PREFIX = '[dsh-win-notify]'

const ASK_USER_TOOL = 'ask_user_question'

const QUNS_QUIET_TIME = 6

// The one URI the desktop shell handles: `app.setAsDefaultProtocolClient('dsh')`
// plus an `open-url` listener that accepts exactly `dsh://open` to restore and
// focus the window. Do NOT point this at http://127.0.0.1:<port>/ — that is the
// web UI, it opens in the browser instead of the app, and it answers 401 because
// the shell appends an auth token to the URL it passes over IPC.
const DEFAULT_FOCUS_URL = 'dsh://open'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BODY_LOGO_FALLBACK = path.join(PACKAGE_ROOT, 'assets', 'toast-logo.png')

function isDisabled(list, hook) {
  return String(list || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .includes(hook)
}

function firstText(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return ''
}

// Every shape DSH has used for a tool-call identity, probed in order, because
// the field moved between versions (tool/result carries it on message.toolCallId).
function callIdOf(event) {
  const data = (event && event.data) || {}
  const message = data.message
  if (Array.isArray(message && message.content)) {
    for (const block of message.content) {
      if (block && (block.toolCallId || block.tool_call_id)) {
        return String(block.toolCallId || block.tool_call_id)
      }
    }
  }
  return firstText([
    message && message.callId,
    message && message.toolCallId,
    message && message.tool_call_id,
    data.callId,
    data.call_id,
    data.toolCallId,
    data.id,
  ])
}

function toolNameOf(event) {
  const data = (event && event.data) || {}
  const message = data.message
  let fromBlocks = ''
  if (Array.isArray(message && message.content)) {
    for (const block of message.content) {
      if (block && block.type === 'tool-call' && block.name) fromBlocks = String(block.name)
    }
  }
  return firstText([data.name, data.toolName, fromBlocks, message && message.name])
}

function describeReason(reason) {
  if (!reason || typeof reason !== 'object') return ''
  if (reason.kind === 'error') {
    const failure = reason.error || {}
    return firstText([failure.message, failure.code]) || 'error'
  }
  if (reason.kind === 'aborted') {
    const cause = reason.reason || {}
    return cause.reason ? `${cause.kind}: ${cause.reason}` : firstText([cause.kind]) || 'aborted'
  }
  return firstText([reason.kind]) || ''
}

function createNotifier(ctx, liveConfig) {
  const config = liveConfig
  const log = (...parts) => {
    if (config.debug) {
      try { console.log(LOG_PREFIX, ...parts) } catch {  }
    }
  }

  const sessionTitles = new Map()

  const lastAssistant = new Map()

  const pending = new Map()

  const recent = []

  let inFlight = 0
  let disposed = false

  const stats = { considered: 0, shown: 0, suppressed: 0, failed: 0, skipped: 0, byHook: {} }

  const foregroundProcesses = String(config.foregroundProcesses || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const foregroundTitles = String(config.foregroundTitles || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  function resolveFocusUrl() {
    if (!config.clickToFocus) return ''
    const configured = String(config.focusUrl || '').trim()
    if (configured && configured !== DEFAULT_FOCUS_URL) return configured
    return DEFAULT_FOCUS_URL
  }

  function rememberTitle(session, explicit) {
    const id = session && session.id ? String(session.id) : ''
    let title = firstText([explicit])
    if (!title) {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
      if (service && typeof service.get === 'function' && session) {
        try {
          const snapshot = service.get(session)
          title = firstText([
            typeof snapshot === 'string' ? snapshot : '',
            snapshot && snapshot.title,
            snapshot && snapshot.text,
          ])
        } catch {  }
      }
    }
    if (!title && session) {
      title = firstText([
        session.name,
        session.title,
        session.label,
        session.summary && session.summary.title,
        session.meta && session.meta.title,
      ])
    }
    if (title && id) {
      sessionTitles.set(id, title.slice(0, 120))
      if (sessionTitles.size > 200) {
        const oldest = sessionTitles.keys().next().value
        sessionTitles.delete(oldest)
      }
    }
    if (title) return title
    return (id && sessionTitles.get(id)) || ''
  }

  function titleFor(session) {
    if (session && session.id) {
      const id = String(session.id)
      if (sessionTitles.has(id)) return sessionTitles.get(id)
    }
    return '当前会话'
  }

  function sessionAllowed(session) {
    if (config.notifySubagents) return true
    if (!session || typeof session !== 'object') return true

    const owner = firstText([
      session.parentId,
      session.ownerId,
      session.parent && session.parent.id,
      session.owner && session.owner.id,
      session.meta && session.meta.parentId,
    ])
    if (owner) return false
    if (session.kind === 'subagent' || session.role === 'subagent') return false
    return true
  }

  function rateLimitOk() {
    const windowMs = Math.max(0, Number(config.rateLimitMs) || 0)
    if (windowMs === 0) return true
    const max = Math.max(1, Number(config.rateLimitMax) || 6)
    const now = Date.now()
    while (recent.length && now - recent[0] > windowMs) recent.shift()
    return recent.length < max
  }

  // Off by default: the header already shows the app name and its own icon, so a
  // second large copy of the same artwork is redundant. `iconPath` opts in.
  function resolveIcon() {
    const configured = String(config.iconPath || '').trim()
    if (configured === '' || configured === '-') return ''
    if (configured === 'bundled') {
      try {
        if (fs.statSync(BODY_LOGO_FALLBACK).isFile()) return BODY_LOGO_FALLBACK
        console.warn(`${LOG_PREFIX} bundled logo missing at ${BODY_LOGO_FALLBACK}`)
      } catch {
        console.warn(`${LOG_PREFIX} bundled logo missing at ${BODY_LOGO_FALLBACK}`)
      }
      return ''
    }
    try {
      if (fs.statSync(configured).isFile()) return configured
      console.warn(`${LOG_PREFIX} iconPath is not a file, ignoring: ${configured}`)
    } catch {
      console.warn(`${LOG_PREFIX} iconPath not found, ignoring: ${configured}`)
    }
    return ''
  }

  function notify({ title, body, hook, session }) {
    if (disposed) return
    stats.considered += 1
    if (inFlight >= Math.max(1, Number(config.maxConcurrent) || 2)) {
      stats.skipped += 1
      log('drop (helper busy)', hook)
      return
    }
    if (!rateLimitOk()) {
      stats.skipped += 1
      log('drop (rate limit)', hook)
      return
    }
    recent.push(Date.now())
    if (hook) stats.byHook[hook] = (stats.byHook[hook] || 0) + 1

    const finalTitle = oneLine(title, 64) || 'DeepSeek Harness'
    const finalBody = oneLine(body, 160)
    const launch = resolveFocusUrl()
    inFlight += 1
    log('notify', hook, JSON.stringify(finalTitle), JSON.stringify(finalBody), JSON.stringify(launch))
    runPowerShell({
      title: finalTitle,
      body: finalBody,
      launch,
      icon: resolveIcon(),
      aumid: String(config.appId || 'electron.app.DeepSeek Harness'),
      bypassDnd: !!config.bypassDnd,
      foregroundProcesses,
      foregroundTitles,
      suppressWhenFocused: !!config.quietWhenFocused,
      showWhenDnd: !!config.showWhenDnd,
      timeoutMs: Math.max(3000, Number(config.helperTimeoutMs) || 15000),
    }).then((result) => {
      inFlight -= 1
      if (result.shown) {
        stats.shown += 1
      } else if (result.skipped) {
        stats.suppressed += 1
      } else {
        stats.failed += 1
        try {
          console.error(`${LOG_PREFIX} toast failed (exit ${result.exitCode}): ${result.stderr || 'no stderr'}`)
        } catch {  }
      }
    }, () => {
      inFlight -= 1
      stats.failed += 1
    })
  }

  function render(key, session, extras) {
    const template = config[key] || DEFAULT_TEMPLATES[key] || ''
    return renderTemplate(template, {
      TITLE: titleFor(session),
      TOOL: '',
      REASON: '',
      TURN: '',
      REPLY: '',
      ERROR: '',
      ...extras,
    })
  }

  function fire({ hook, session, titleKey, bodyKey, tool, reason, turn, error }) {
    if (isDisabled(config.disabledHooks, hook)) {
      stats.skipped += 1
      return
    }
    const extras = {
      TOOL: tool || '',
      REASON: reason || '',
      TURN: turn === undefined || turn === null ? '' : String(turn),
      ERROR: error || '',
    }
    notify({
      title: render(titleKey, session, extras),
      body: render(bodyKey, session, extras),
      hook,
      session,
    })
  }

  function observe(event, handler) {
    try {
      const disposer = ctx.on(event, handler)
      if (typeof disposer === 'function') {
        try { ctx.effect(() => disposer) } catch {  }
      }
    } catch (error) {
      try {
        console.error(`${LOG_PREFIX} could not subscribe to "${event}": ${String(error && error.message)}`)
      } catch {  }
    }
  }

  function replySnippet(message) {
    const content = (message && message.content) || []
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      if (parts.join(' ').length > 200) break
    }
    return oneLine(parts.join(' '), 120)
  }

  function clearPending(session, kind) {
    const sessionId = session && session.id ? String(session.id) : ''
    for (const [key, entry] of [...pending.entries()]) {
      if (kind && entry.kind !== kind) continue
      if (session && (!entry.session || String(entry.session.id) !== sessionId)) continue
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(key)
    }
  }

// DSH logs approval/asked + approval/decided for EVERY request, and under policy
// `never` the decision is an immediate auto-reject with no human involved. So hold
// each ask for approvalDelayMs and only notify if it is still unanswered — that is
// precisely the case where someone is actually being waited on.
function onApprovalAsked(session, data) {
    if (!config.notifyApproval) {
      stats.skipped += 1
      return
    }
    if (!sessionAllowed(session)) {
      stats.skipped += 1
      return
    }
    const id = firstText([data && data.id]) || `approval-${Date.now()}`
    if (pending.has(id)) return
    const delay = Math.max(0, Number(config.approvalDelayMs))
    const entry = {
      kind: 'approval',
      session,
      tool: firstText([data && data.toolName]),
      reason: firstText([data && data.reason]),
      timer: null,
    }
    entry.timer = setTimeout(() => {
      pending.delete(id)

      fire({
        hook: 'approval',
        session: entry.session,
        titleKey: 'approvalTitle',
        bodyKey: 'approvalBody',
        tool: entry.tool,
        reason: entry.reason,
      })
    }, delay)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
    pending.set(id, entry)
  }

  function onApprovalDecided(data) {
    const id = firstText([data && data.id])
    if (!id) {
      clearPending(null, 'approval')
      return
    }
    const entry = pending.get(id)
    if (!entry || entry.kind !== 'approval') return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(id)
  }

  function onToolCall(session, event) {
    if (!config.notifyQuestion) {
      return
    }
    if (toolNameOf(event) !== ASK_USER_TOOL) return
    if (!sessionAllowed(session)) {
      stats.skipped += 1
      return
    }
    const id = callIdOf(event) || `question-${Date.now()}`
    if (pending.has(id)) return
    const delay = Math.max(0, Number(config.questionDelayMs))
    const entry = { kind: 'question', session, timer: null }
    entry.timer = setTimeout(() => {
      pending.delete(id)
      fire({
        hook: 'question',
        session: entry.session,
        titleKey: 'questionTitle',
        bodyKey: 'questionBody',
      })
    }, delay)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
    pending.set(id, entry)
  }

  function onToolResult(event) {
    const id = callIdOf(event)
    if (!id) {
      clearPending(null, 'question')
      return
    }
    const entry = pending.get(id)
    if (!entry || entry.kind !== 'question') return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(id)
  }

  function onTurnEnd(session, data) {
    const reason = (data && data.reason) || {}
    const kind = firstText([reason.kind])
    const turn = data && data.turn
    const sessionId = session && session.id ? String(session.id) : ''
    const remembered = sessionId ? lastAssistant.get(sessionId) : undefined
    const snippet = remembered && remembered.turn === turn ? remembered.text : ''

    for (const [key, entry] of [...pending.entries()]) {
      if (!sessionId || (entry.session && entry.session.id === sessionId)) {
        if (entry.timer) clearTimeout(entry.timer)
        pending.delete(key)
      }
    }

    if (kind === 'completed') {
      if (!config.notifyDone) {
        stats.skipped += 1
        return
      }

      if (!snippet) {
        stats.skipped += 1
        return
      }
      if (!sessionAllowed(session)) {
        stats.skipped += 1
        return
      }
      fire({
        hook: 'done',
        session,
        titleKey: 'doneTitle',
        bodyKey: 'doneBody',
        reason: snippet,
        turn,
      })
      return
    }
    if (kind === 'aborted') {
      const cause = firstText([reason.reason && reason.reason.kind])
      if (cause === 'user' && !config.notifyUserAbort) {
        stats.skipped += 1
        return
      }
      if (!config.notifyAborted) {
        stats.skipped += 1
        return
      }
      if (!sessionAllowed(session)) {
        stats.skipped += 1
        return
      }
      fire({
        hook: 'aborted',
        session,
        titleKey: 'abortedTitle',
        bodyKey: 'abortedBody',
        reason: describeReason(reason),
        turn,
      })
      return
    }
    if (!sessionAllowed(session)) {
      stats.skipped += 1
      return
    }
    if (kind === 'blocked') {
      if (!config.notifyBlocked) {
        stats.skipped += 1
        return
      }
      fire({
        hook: 'blocked',
        session,
        titleKey: 'blockedTitle',
        bodyKey: 'blockedBody',
        reason: '被阻止',
        turn,
      })
      return
    }
    if (kind === 'max-tokens') {
      if (!config.notifyMaxTokens) {
        stats.skipped += 1
        return
      }
      fire({
        hook: 'max-tokens',
        session,
        titleKey: 'maxTokensTitle',
        bodyKey: 'maxTokensBody',
        turn,
      })
      return
    }
    if (kind === 'error') {
      if (!config.notifyError) {
        stats.skipped += 1
        return
      }
      fire({
        hook: 'error',
        session,
        titleKey: 'errorTitle',
        bodyKey: 'errorBody',
        error: describeReason(reason),
        turn,
      })
      return
    }

    stats.skipped += 1
  }

  function onSessionEvent(session, event) {
    try {
      if (disposed) return
      const type = String((event && event.type) || '')
      const data = (event && event.data) || {}
      switch (type) {
        case 'session/title':
          rememberTitle(session, firstText([data.title]))
          return
        case 'assistant/message': {
          const id = session && session.id ? String(session.id) : ''
          if (!id) return
          lastAssistant.set(id, { turn: data.turn, text: replySnippet(data.message) })
          if (lastAssistant.size > 200) {
            const oldest = lastAssistant.keys().next().value
            lastAssistant.delete(oldest)
          }
          return
        }
        case 'approval/asked':
          onApprovalAsked(session, data)
          return
        case 'approval/decided':
        case 'approval/policy':
          onApprovalDecided(data)
          return
        case 'tool/call':
          onToolCall(session, event)
          return
        case 'tool/result':
          onToolResult(event)
          return
        case 'turn/start':

          clearPending(session)
          return
        case 'turn/end':
          onTurnEnd(session, data)
          return
        default:
          return
      }
    } catch (error) {
      try {
        console.error(`${LOG_PREFIX} handler failed for "${event && event.type}": ${String(error && error.message)}`)
      } catch {  }
    }
  }

  observe('session/event', onSessionEvent)

  observe('session/disposed', (session) => {
    try {
      const id = session && session.id ? String(session.id) : ''
      if (!id) return
      sessionTitles.delete(id)
      lastAssistant.delete(id)
      clearPending(session)
    } catch {  }
  })

  return {
    stats,

    sendTest() {
      const title = oneLine(config.testTitle || 'DSH 测试通知', 64)
      const body = oneLine(config.testBody || '如果你看到这条通知，说明系统通知通道正常。', 160)
      return runPowerShell({
        title,
        body,
        launch: resolveFocusUrl(),
        icon: resolveIcon(),
        aumid: String(config.appId || 'electron.app.DeepSeek Harness'),
        bypassDnd: false,
        foregroundProcesses,
        foregroundTitles,
        suppressWhenFocused: false,
        showWhenDnd: true,
        timeoutMs: Math.max(3000, Number(config.helperTimeoutMs) || 15000),
      })
    },
    dispose() {
      disposed = true
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      pending.clear()
      sessionTitles.clear()
      lastAssistant.clear()
      return stats
    },
  }
}

// DSH_PROFILE_DIR is authoritative but is not guaranteed to reach the host
// process. Without the fallback the settings store is silently absent and panel
// edits never persist, so each candidate is verified to exist rather than trusted.
function resolveProfileDir() {
  const candidates = []
  const fromEnv = firstText([process.env.DSH_PROFILE_DIR])
  if (fromEnv) candidates.push(fromEnv)

  const dshHome = firstText([process.env.DSH_HOME]) || path.join(os.homedir(), '.dsh')
  const profileName = firstText([process.env.DSH_PROFILE])
  if (profileName) candidates.push(path.join(dshHome, 'profiles', profileName))

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
    } catch {  }
  }
  return ''
}

export function apply(ctx, rawConfig) {

  const liveConfig = normalizeConfig(rawConfig)
  const config = liveConfig

  const log = (...parts) => {
    try { console.log(LOG_PREFIX, ...parts) } catch {  }
  }
  const debugLog = (...parts) => {
    if (config.debug) log(...parts)
  }

  if (!config.enabled) {

    log('disabled by config')
    return
  }
  if (process.platform !== 'win32') {
    log(`skipped: native Windows toasts need win32 (this host is ${process.platform})`)
    return
  }

  const pluginRoot = ctx && ctx.root ? ctx.root : ctx

  installPanelInjection(pluginRoot, debugLog)

  let notifier
  try {
    notifier = createNotifier(ctx, liveConfig)
  } catch (error) {
    log(`failed to start: ${String(error && error.message)}`)
    return
  }

  let store = null
  try {
    const profileDir = resolveProfileDir()
    if (!profileDir) {
      log('no profile directory resolved; settings cannot be persisted')
    } else {
      store = createStore({
        patchPath: path.join(profileDir, 'cordis.patch.yml'),
        pluginId: name,
        log: debugLog,
      })
      const loaded = store.load()
      if (!loaded.found) {

        log(`no "${name}" row in ${store.patchPath}; changes will not persist`)
      } else if (loaded.config) {

        for (const key of Object.keys(CONFIG_FIELDS)) {
          if (Object.prototype.hasOwnProperty.call(loaded.config, key)) {
            const expected = CONFIG_FIELDS[key][0]
            const value = loaded.config[key]
            const okType = expected === 'boolean' ? typeof value === 'boolean'
              : expected === 'number' ? Number.isFinite(value)
                : typeof value === 'string'
            if (okType) liveConfig[key] = value
          }
        }
        debugLog('settings loaded from', store.patchPath)
      }
    }
  } catch (error) {
    log('settings store unavailable:', String(error && error.message))
  }

  let disposeRoutes = null

  const mountRoutes = (routeCtx) => {
    try {
      const disposer = installRoutes(routeCtx, {
        getConfig: () => ({ ...liveConfig }),
        applyConfig: (patch) => {
          Object.assign(liveConfig, patch)
          return { ...liveConfig }
        },
        store,
        sendTest: () => notifier.sendTest(),
        log,
      })
      if (typeof disposer === 'function' && disposeRoutes === null) disposeRoutes = disposer
      return typeof disposer === 'function'
    } catch (error) {
      log('could not mount the settings panel routes:', String(error && error.message))
      return false
    }
  }

  // The synchronous attempt normally fails and that is expected: with `inject` empty
  // this runs before the host provides webServer. Registering only here leaves the
  // routes 404ing; ctx.inject defers until the service exists, which is what mounts them.
  if (!mountRoutes(ctx)) {
    try {
      ctx.inject(['webServer'], (scope) => {
        mountRoutes(scope)
      })
    } catch (error) {
      log('webServer never became available:', String(error && error.message))
    }
  }

  try {
    ctx.effect(() => () => {
      if (typeof disposeRoutes === 'function') {
        try { disposeRoutes() } catch {  }
      }
      const finalStats = notifier.dispose()
      if (config.debug) {

        try { console.log(`${LOG_PREFIX} stopped`, JSON.stringify({ finalStats })) } catch {  }
      }
    })
  } catch {  }

  log(
    `active — approval=${config.notifyApproval} question=${config.notifyQuestion}`
    + ` done=${config.notifyDone} error=${config.notifyError} quietWhenFocused=${config.quietWhenFocused}`,
  )
}

export function diagnose() {
  const result = {
    ok: true,
    node: process.version,
    platform: process.platform,
    powershell: '',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  }
  if (process.platform !== 'win32') {
    result.ok = false
    result.powershell = `not windows (${process.platform})`
    return result
  }
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    })
    result.powershell = String(probe.stdout || '').trim() || `exit ${probe.status}`
    if (probe.error || probe.status !== 0) result.ok = false
  } catch (error) {
    result.ok = false
    result.powershell = String(error && error.message)
  }
  return result
}

export { escapeXml, psLiteral, buildToastXml, buildPowerShell } from './toast.mjs'

export default {
  name,
  inject,
  apply,
  Config: configValidator,
}
