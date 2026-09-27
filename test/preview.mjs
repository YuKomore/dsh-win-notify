import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPowerShell } from '../lib/toast.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.resolve(here, '..', 'assets')
const bodyLogo = path.join(assets, 'toast-logo.png')

console.log('app identity icon :', path.join(assets, 'app.ico'), '(via the Start-menu shortcut)')
console.log('body logo         :', fs.existsSync(bodyLogo) ? bodyLogo : '(not generated)')

const base = {
  aumid: 'electron.app.DeepSeek Harness',
  bypassDnd: false,
  foregroundProcesses: ['DeepSeek Harness'],
  foregroundTitles: ['DeepSeek Harness'],

  suppressWhenFocused: false,
  showWhenDnd: true,
  timeoutMs: 15000,
}

const cases = [
  {
    title: '\u9700\u8981\u4f60\u6279\u51c6',
    body: 'pwsh sandbox escalation \u2014 \u91cd\u6784\u767b\u5f55\u6a21\u5757',
    launch: 'http://127.0.0.1:19387/',

    icon: '',
  },
  {
    title: '\u4efb\u52a1\u5b8c\u6210',
    body: '\u5bf9\u7167\u7ec4\uff1a\u8fd9\u4e00\u6761\u6253\u5f00\u4e86\u6b63\u6587\u5927\u56fe\u6807',
    launch: 'http://127.0.0.1:19387/',
    icon: bodyLogo,
  },
  {
    title: '\u4efb\u52a1\u51fa\u9519',
    body: '\u5bf9\u7167\u7ec4\uff1a\u65e0\u6b63\u6587\u56fe\u6807 + \u7279\u6b8a\u5b57\u7b26 <&>"\'',
    launch: '',
    icon: '',
  },
]

for (const item of cases) {
  const result = await runPowerShell({ ...base, ...item })
  console.log('sent ' + JSON.stringify(item.title) + ' bodyLogo=' + (item.icon ? 'yes' : 'no') + ' -> ' + JSON.stringify({
    shown: result.shown,
    exit: result.exitCode,
    stderr: result.stderr || undefined,
  }))
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

console.log('')
console.log('\u4e09\u6761\u5df2\u53d1\u51fa\uff1a\u7b2c 1\u30013 \u6761\u662f\u9ed8\u8ba4\u5916\u89c2\uff08\u65e0\u6b63\u6587\u5927\u56fe\u6807\uff09\uff0c\u7b2c 2 \u6761\u662f\u6253\u5f00\u6b63\u6587\u5927\u56fe\u6807\u7684\u5bf9\u7167\u3002')
