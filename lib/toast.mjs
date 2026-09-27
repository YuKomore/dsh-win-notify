import { spawn } from 'node:child_process'

export const EXIT_SHOWN = 0
export const EXIT_SKIPPED = 10
export const EXIT_FOCUSED = 11
export const EXIT_DND = 12

// Do not reorder: `&` must be replaced first, and the control characters that
// XML 1.0 forbids must be dropped. Leaving them in makes LoadXml throw
// 0xC00CE513 while PowerShell still exits 0, so the toast vanishes silently.
export function escapeXml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
}

// Single quotes only: inside a PowerShell single-quoted literal nothing is
// interpolated, so `$`, backticks and `$(...)` stay inert. Never use double quotes.
export function psLiteral(value) {
  return "'" + String(value === null || value === undefined ? '' : value).replace(/'/g, "''") + "'"
}

export function oneLine(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

// The schema wants a URI: a bare `C:\...` parses but is not a valid URI and the
// shell then renders no image at all.
export function toFileUrl(filePath) {
  const text = String(filePath === null || filePath === undefined ? '' : filePath).trim()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  const normalized = text.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized
  return 'file://' + encodeURI(withSlash).replace(/[?#]/g, (ch) => (ch === '?' ? '%3F' : '%23'))
}

export function buildToastXml({ title, body, launch, icon, bypassDnd }) {
  const attrs = []
  if (launch) attrs.push(`activationType="protocol" launch="${escapeXml(launch)}"`)
  else attrs.push('activationType="foreground"')
  if (bypassDnd) attrs.push('scenario="reminder"')
  const lines = [
    `<toast ${attrs.join(' ')}>`,
    '  <visual>',
    '    <binding template="ToastGeneric">',
    `      <text>${escapeXml(title)}</text>`,
  ]
  if (body) lines.push(`      <text>${escapeXml(body)}</text>`)
  const iconUrl = toFileUrl(icon)
  if (iconUrl) {
    lines.push(`      <image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(iconUrl)}"/>`)
  }
  lines.push(
    '      <text placement="attribution">DeepSeek Harness</text>',
    '    </binding>',
    '  </visual>',
    '</toast>',
  )
  return lines.join('\n')
}

export function buildPowerShell(opts) {
  const xml = buildToastXml({
    title: opts.title,
    body: opts.body,
    launch: opts.launch,
    icon: opts.icon,
    bypassDnd: opts.bypassDnd,
  })
  const procList = (opts.foregroundProcesses || []).map((n) => psLiteral(n)).join(',')
  const titleList = (opts.foregroundTitles || []).map((n) => psLiteral(n)).join(',')
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class DshNotifyProbe {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);',
    '}',
    "'@",
    `$xmlText = ${psLiteral(xml)}`,
    `$aumid = ${psLiteral(opts.aumid)}`,
    `$procNames = @(${procList})`,
    `$titleParts = @(${titleList})`,
    '$dnd = 0',
    'try {',
    '  $q = 0',
    '  [void][DshNotifyProbe]::SHQueryUserNotificationState([ref]$q)',
    '  if ($q -eq 6) { $dnd = 1 }',
    '} catch { $dnd = 0 }',
    '$hwnd = [DshNotifyProbe]::GetForegroundWindow()',
    '$fgPid = [uint32]0',
    '$fgTitle = ""',
    '$fgName = ""',
    'if ($hwnd -ne [IntPtr]::Zero) {',
    '  [void][DshNotifyProbe]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)',
    '  $buf = New-Object System.Text.StringBuilder 512',
    '  [void][DshNotifyProbe]::GetWindowTextW($hwnd, $buf, 512)',
    '  $fgTitle = $buf.ToString()',
    '  try { $fgName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { $fgName = "" }',
    '}',
    '$focused = 0',
    'foreach ($n in $procNames) { if ($n -ne "" -and $fgName -eq $n) { $focused = 1 } }',
    'if ($focused -eq 0) {',
    '  foreach ($p in $titleParts) { if ($p -ne "" -and $fgTitle -like ("*" + $p + "*")) { $focused = 1 } }',
    '}',
    'if ($fgName -eq "powershell" -or $fgName -eq "pwsh") { $focused = 0 }',
    opts.suppressWhenFocused
      ? 'if ($focused -eq 1) { Write-Output ("focused=1;dnd=" + $dnd + ";skip=focused"); exit 11 }'
      : '$null = $focused',
    opts.showWhenDnd
      ? '$null = $dnd'
      : 'if ($dnd -eq 1) { Write-Output ("focused=" + $focused + ";dnd=1;skip=dnd"); exit 12 }',
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
    '[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xmlText)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)',
    '$notifier.Show($toast)',
    'Write-Output ("focused=" + $focused + ";dnd=" + $dnd + ";shown=1")',
    'exit 0',
  ].join('\r\n')
}

// -EncodedCommand takes UTF-16LE base64: Chinese text survives regardless of the
// console codepage, and because it is not a script file it bypasses
// ExecutionPolicy entirely. The skeleton is ASCII; all data lives in the
// single-quoted literals built above.
export function runPowerShell(opts) {
  return new Promise((resolve) => {
    const script = buildPowerShell(opts)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({ shown: false, focused: false, dnd: false, exitCode: -1, stderr: String(error && error.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch {  }
    }, Math.max(1000, Number(opts.timeoutMs) || 15000))
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const exit = Number(exitCode)
      resolve({
        shown: exit === EXIT_SHOWN && /shown=1/.test(stdout),
        skipped: exit === EXIT_SKIPPED || exit === EXIT_FOCUSED || exit === EXIT_DND,
        focused: /focused=1/.test(stdout),
        dnd: /dnd=1/.test(stdout),
        exitCode: Number.isFinite(exit) ? exit : -1,
        stdout: stdout.trim().slice(0, 400),
        stderr: stderr.trim().slice(0, 800),
      })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ shown: false, focused: false, dnd: false, exitCode: -1, stderr: String(error && error.message) })
    })
    child.on('close', finish)
  })
}

export function renderTemplate(template, vars) {
  return String(template === null || template === undefined ? '' : template)
    .replace(/%([A-Z_]+)%/g, (_match, key) => {
      const value = vars[key]
      return value === null || value === undefined ? '' : String(value)
    })
}
