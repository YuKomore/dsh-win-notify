import { runPowerShell, buildToastXml } from '../lib/toast.mjs'

const AUMID = 'electron.app.DeepSeek Harness'

function historyCount(aumid) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    `$aumid = '${aumid.replace(/'/g, "''")}'`,
    '$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)',
    'try { $h = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid); Write-Output ("COUNT=" + $h.Count) }',
    'catch { Write-Output ("ERR=" + $_.Exception.Message) }',
  ].join('\r\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', () => resolve(out.trim()))
    })
  })
}

const before = await historyCount(AUMID)
console.log('history before :', before)

const stamp = new Date().toISOString().slice(11, 19)
const result = await runPowerShell({
  title: 'dsh-win-notify 投递验证',
  body: `时间 ${stamp} <&>"' 特殊字符与中文`,
  launch: 'http://127.0.0.1:19387/',
  aumid: AUMID,
  bypassDnd: false,
  foregroundProcesses: ['DeepSeek Harness'],
  foregroundTitles: ['DeepSeek Harness'],
  suppressWhenFocused: false,
  showWhenDnd: true,
  timeoutMs: 15000,
})
console.log('plugin result  :', JSON.stringify(result))

await new Promise((r) => setTimeout(r, 1200))
const after = await historyCount(AUMID)
console.log('history after  :', after)

function countOf(output) {
  const match = output.match(/COUNT=(.*)/)
  if (!match) return -1
  return match[1].trim().split(/\s+/).filter(Boolean).length
}

const beforeN = countOf(before)
const afterN = countOf(after)
console.log('')
console.log(beforeN >= 0 && afterN > beforeN
  ? `PASS: the shell recorded the toast (${beforeN} -> ${afterN})`
  : `INCONCLUSIVE: history ${beforeN} -> ${afterN}`)
