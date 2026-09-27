(function () {
  'use strict'

  if (window.__dshWinNotifyMounted) return
  window.__dshWinNotifyMounted = true

  var API = '/dsh-win-notify'
  var Z = 2147483000

  var TITLEBAR_HEIGHT = 40

  var SCENARIOS = [
    { key: 'notifyApproval', label: '需要我审批时', hint: '智能体请求授权，真的在等你点时' },
    { key: 'notifyQuestion', label: '智能体提问时', hint: '用 ask_user_question 等你选答案' },
    { key: 'notifyDone', label: '任务完成时', hint: '一轮回复结束、轮到你说话' },
    { key: 'notifyError', label: '任务出错时', hint: '模型报错、请求失败' },
    { key: 'notifyBlocked', label: '任务被阻止时', hint: '步骤被策略拦下' },
    { key: 'notifyMaxTokens', label: '输出被截断时', hint: '达到模型最大输出长度' },
    { key: 'notifyAborted', label: '任务被中断时', hint: '父级回收 / 钩子 / 应用退出导致的中断' },
    { key: 'notifyUserAbort', label: '我自己按了停止时', hint: '默认关闭，避免自己刚停就被通知' },
    { key: 'notifySubagents', label: '子代理也通知', hint: '默认关闭，只通知主会话' }
  ]

  var OPTIONS = [
    { key: 'quietWhenFocused', label: 'DSH 窗口在前台时不弹', hint: '推荐开启；关闭后每次都会弹' },
    { key: 'showWhenDnd', label: '专注助手 / 免打扰时也弹', hint: '默认关闭，尊重系统免打扰' },
    { key: 'clickToFocus', label: '点击通知打开 DSH 界面', hint: '' }
  ]

  // Isolation is limited to the box model. Do not add `:host{all:initial}` or a bare
  // `*{font-family:...}` reset: the shell's caption buttons inherit
  // `font-family: var(--dsw-font-family)` and their colour from design tokens, and
  // those resets made this button a different size, a different face and black on a
  // dark theme. The values below mirror the preload's own `button` rule exactly.
  var CSS = [
    ':host{position:static;margin:0;padding:0;border:0;background:none}',
    '.launch,.panel,.float{box-sizing:border-box}',

    '.launch{position:fixed;top:0;left:0;z-index:' + Z + ';display:flex;align-items:center;gap:6px;',
    'height:28px;padding:0 10px;border:0;border-radius:6px;',
    'background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);',
    'font-family:var(--dsw-font-family,inherit);font-size:14px;font-style:normal;font-weight:400;',
    'line-height:1;cursor:default;user-select:none;-webkit-app-region:no-drag}',
    '.launch:hover,.launch[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
    'color:var(--dsw-alias-label-primary,#1f2329)}',
    '.launch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}',
    '.launch[hidden]{display:none}',
    '.float{position:fixed;z-index:' + Z + ';display:flex;align-items:center;gap:6px;top:48px;right:14px;',
    'height:28px;padding:0 10px;border-radius:8px;cursor:pointer;user-select:none;',
    'background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
    'font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:1}',
    '.float:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit)}',
    '.panel{position:fixed;z-index:' + (Z + 1) + ';width:340px;max-height:74vh;overflow:auto;',
    'background:var(--dsh-win-notify-bg,#ffffff);color:var(--dsh-win-notify-fg,#1f2329);',
    'font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);',
    'border:1px solid rgba(127,127,127,.28);border-radius:12px;',
    'box-shadow:0 12px 32px rgba(0,0,0,.22);padding:12px 4px 8px;display:none;font-size:13px}',
    '.panel.open{display:block}',
    '.hd{display:flex;align-items:center;justify-content:space-between;padding:0 12px 8px;',
    'border-bottom:1px solid rgba(127,127,127,.18);margin-bottom:6px}',
    '.hd b{font-size:14px;font-weight:600}',
    '.hd button{all:unset;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:.6;font-size:16px;line-height:1}',
    '.hd button:hover{opacity:1;background:rgba(127,127,127,.16)}',
    '.sec{padding:8px 12px 2px;font-size:11px;letter-spacing:.04em;opacity:.55;text-transform:uppercase}',
    '.row{display:flex;align-items:flex-start;gap:10px;padding:6px 12px;border-radius:8px;cursor:pointer}',
    '.row:hover{background:rgba(127,127,127,.1)}',
    '.row .txt{flex:1;min-width:0}',
    '.row .lbl{display:block;line-height:1.35}',
    '.row .hint{display:block;font-size:11px;opacity:.55;line-height:1.4;margin-top:1px}',
    '.sw{flex:none;width:36px;height:20px;border-radius:999px;background:rgba(127,127,127,.35);',
    'position:relative;transition:background .15s;margin-top:1px}',
    '.sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
    'background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}',
    '.row.on .sw{background:#4d6bfe}',
    '.row.on .sw::after{transform:translateX(16px)}',
    '.ft{display:flex;gap:8px;padding:10px 12px 4px;border-top:1px solid rgba(127,127,127,.18);margin-top:6px}',
    '.ft button{all:unset;cursor:pointer;flex:1;text-align:center;padding:7px 8px;border-radius:8px;',
    'font-size:12px;background:rgba(127,127,127,.16)}',
    '.ft button:hover{background:rgba(127,127,127,.26)}',
    '.ft button.primary{background:#4d6bfe;color:#fff}',
    '.ft button.primary:hover{background:#3f5ae0}',
    '.ft button[disabled]{opacity:.5;cursor:default}',
    '.note{padding:6px 12px 2px;font-size:11px;opacity:.6;line-height:1.5}',
    '.note.err{color:#e5484d;opacity:.9}',
  ].join('')

  var LAUNCH_LABEL = '通知'

  function fetchState() {
    return fetch(API + '/config', { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  function saveState(patch) {
    return fetch(API + '/config', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok || !body.ok) throw new Error((body && body.error) || 'HTTP ' + r.status)
        return body
      })
    })
  }

  function sendTest() {
    return fetch(API + '/test', { method: 'POST', credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok || !body.ok) throw new Error((body && body.error) || 'HTTP ' + r.status)
        return body
      })
    })
  }

  function theme() {
    var root = document.documentElement
    var attr = (root.getAttribute('data-theme') || root.getAttribute('data-color-scheme') || '').toLowerCase()
    if (attr.indexOf('dark') >= 0) return 'dark'
    if (attr.indexOf('light') >= 0) return 'light'
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch (error) {
      return 'light'
    }
  }

  var host
  var root
  var panel
  var launch

  var head
  var body
  var foot
  var status
  var testBtn
  var state = null
  var busy = false
  var openSeq = 0

  function build() {
    host = document.createElement('div')
    host.id = 'dsh-win-notify-root'
    host.style.cssText = 'all:initial;position:static'
    root = host.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = CSS
    root.appendChild(style)

    launch = document.createElement('div')
    launch.className = 'launch'
    launch.hidden = true
    launch.setAttribute('role', 'button')
    launch.setAttribute('tabindex', '0')
    launch.setAttribute('aria-label', '通知设置')
    launch.setAttribute('aria-expanded', 'false')
    launch.title = '通知设置'
    launch.textContent = LAUNCH_LABEL
    launch.addEventListener('click', function (event) {
      event.stopPropagation()
      toggle()
    })
    launch.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
    })
    root.appendChild(launch)

    panel = document.createElement('div')
    panel.className = 'panel'
    panel.addEventListener('click', function (event) { event.stopPropagation() })
    root.appendChild(panel)

    // The panel shell is built once and never discarded; render() only replaces the
    // toggle list inside it. Creating `status` lazily in render() used to crash
    // open(), which reports progress *before* its fetch resolves — leaving the panel
    // open but completely empty, with no error visible anywhere.
    head = document.createElement('div')
    head.className = 'hd'
    var title = document.createElement('b')
    title.textContent = 'Windows 通知'
    var closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '×'
    closeBtn.setAttribute('aria-label', '关闭')
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', close)
    head.appendChild(title)
    head.appendChild(closeBtn)
    panel.appendChild(head)

    body = document.createElement('div')
    body.className = 'body'
    panel.appendChild(body)

    foot = document.createElement('div')
    foot.className = 'ft'
    testBtn = document.createElement('button')
    testBtn.type = 'button'
    testBtn.className = 'primary'
    testBtn.textContent = '发送测试通知'
    testBtn.addEventListener('click', function () {
      if (busy) return
      busy = true
      testBtn.disabled = true
      setStatus('正在发送…')
      sendTest().then(function () {
        setStatus('已发送。若没看到，请检查系统「设置 → 系统 → 通知」里 DeepSeek Harness 是否被关闭。')
      }, function (error) {
        setStatus('发送失败：' + error.message, true)
      }).then(function () {
        busy = false
        testBtn.disabled = false
      })
    })
    foot.appendChild(testBtn)
    panel.appendChild(foot)

    status = document.createElement('div')
    status.className = 'note'
    status.textContent = '改动会写入 profile 的 cordis.patch.yml，立即生效。'
    panel.appendChild(status)

    document.addEventListener('click', function () { close() })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close()
    })
    window.addEventListener('resize', place)

    document.body.appendChild(host)
    applyTheme()
  }

  function applyTheme() {
    var dark = theme() === 'dark'
    panel.style.setProperty('--dsh-win-notify-bg', dark ? '#1f2126' : '#ffffff')
    panel.style.setProperty('--dsh-win-notify-fg', dark ? '#e8eaed' : '#1f2329')
  }

  // The shell's own 应用 / 编辑 bar: an element carrying `data-windows-menu`, injected
  // by the Electron preload into an open shadow root shortly after the page loads.
  function menuElement() {
    try {
      return document.querySelector('[data-windows-menu]')
    } catch (error) {
      return null
    }
  }

  function shellButton() {
    var menu = menuElement()
    var shadow = menu && menu.shadowRoot
    if (!shadow) return null
    try {
      return shadow.querySelector('button')
    } catch (error) {
      return null
    }
  }

  function place() {
    var menu = menuElement()
    if (menu) {
      var box = menu.getBoundingClientRect()

      if (box.width > 0) {
        launch.className = 'launch'
        launch.style.left = Math.round(box.right) + 'px'
        launch.style.right = 'auto'

        // Copy the sibling's own vertical offset: the caption buttons are centred in a
        // taller bar, so assuming top:0 leaves this one sitting about 6px high.
        var sibling = shellButton()
        if (sibling) {
          var sib = sibling.getBoundingClientRect()
          launch.style.top = Math.round(sib.top) + 'px'
        } else {
          launch.style.top = '0'
        }
        launch.hidden = false
        if (panel.classList.contains('open')) positionPanel()
        return true
      }
    }
    launch.className = 'float'
    launch.style.top = (TITLEBAR_HEIGHT + 8) + 'px'
    launch.style.right = '14px'
    launch.style.left = 'auto'
    launch.hidden = false
    if (panel.classList.contains('open')) positionPanel()
    return false
  }

  function positionPanel() {
    var box = launch.getBoundingClientRect()
    var width = 340
    var maxLeft = window.innerWidth - width - 8
    var left = Math.max(8, Math.min(maxLeft, box.left))
    panel.style.left = left + 'px'
    panel.style.top = Math.round(box.bottom + 6) + 'px'
  }

  function open() {
    applyTheme()
    place()
    panel.classList.add('open')
    launch.setAttribute('aria-expanded', 'true')
    positionPanel()
    setStatus('正在读取设置…')

    openSeq += 1
    var seq = openSeq
    fetchState().then(function (body) {
      if (seq !== openSeq) return
      state = body
      render()
      setStatus('')
    }, function (error) {
      if (seq !== openSeq) return
      setStatus('读取设置失败：' + error.message + '（宿主路由是否已注册？）', true)
    })
  }

  function close() {
    if (panel) panel.classList.remove('open')
    if (launch) launch.setAttribute('aria-expanded', 'false')
  }

  function toggle() {
    if (panel.classList.contains('open')) close()
    else open()
  }

  function setStatus(text, isError) {
    if (!status) return
    status.textContent = text || ''
    status.className = 'note' + (isError ? ' err' : '')
  }

  function render() {
    if (!state) return
    var config = state.config || {}
    body.textContent = ''

    body.appendChild(section('哪些情况通知我'))
    for (var i = 0; i < SCENARIOS.length; i += 1) {
      body.appendChild(toggleRow(SCENARIOS[i], !!config[SCENARIOS[i].key]))
    }

    body.appendChild(section('弹窗行为'))
    for (var j = 0; j < OPTIONS.length; j += 1) {
      body.appendChild(toggleRow(OPTIONS[j], !!config[OPTIONS[j].key]))
    }
  }

  function section(text) {
    var el = document.createElement('div')
    el.className = 'sec'
    el.textContent = text
    return el
  }

  function toggleRow(item, on) {
    var row = document.createElement('div')
    row.className = 'row' + (on ? ' on' : '')
    row.setAttribute('role', 'switch')
    row.setAttribute('aria-checked', on ? 'true' : 'false')
    row.tabIndex = 0

    var txt = document.createElement('div')
    txt.className = 'txt'
    var lbl = document.createElement('span')
    lbl.className = 'lbl'
    lbl.textContent = item.label
    txt.appendChild(lbl)
    if (item.hint) {
      var hint = document.createElement('span')
      hint.className = 'hint'
      hint.textContent = item.hint
      txt.appendChild(hint)
    }

    var sw = document.createElement('div')
    sw.className = 'sw'

    row.appendChild(txt)
    row.appendChild(sw)

    function flip() {
      if (busy) return
      var next = !row.classList.contains('on')
      row.classList.toggle('on', next)
      row.setAttribute('aria-checked', next ? 'true' : 'false')
      busy = true
      var patch = {}
      patch[item.key] = next
      setStatus('正在保存…')
      saveState(patch).then(function () {
        if (state && state.config) state.config[item.key] = next
        setStatus('已保存。')
      }, function (error) {
        row.classList.toggle('on', !next)
        row.setAttribute('aria-checked', !next ? 'true' : 'false')
        setStatus('保存失败：' + error.message, true)
      }).then(function () { busy = false })
    }

    row.addEventListener('click', flip)
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip() }
    })
    return row
  }

  function keepAligned() {
    var last = -1

    function sync() {
      var menu = menuElement()
      var right = menu ? Math.round(menu.getBoundingClientRect().right) : -1
      if (right !== last) {
        last = right
        place()
      }
    }
    try {
      var observer = new MutationObserver(sync)
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'data-windows-menu'],
      })
    } catch (error) {  }

    var ticks = 0
    var timer = setInterval(function () {
      ticks += 1
      sync()
      if (ticks > 20) clearInterval(timer)
    }, 250)
    sync()
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    try {
      build()
      place()
      keepAligned()
    } catch (error) {
      try { console.error('[dsh-win-notify] panel mount failed:', error) } catch (e) {  }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
