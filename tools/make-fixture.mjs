import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const MENU_STYLE = `
    :host { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 1100;
      height: var(--dsh-windows-titlebar-height); display: flex; align-items: center;
      font-family: var(--dsw-font-family); -webkit-app-region: no-drag; }
    [role=menubar] { display: flex; gap: 2px; }
    button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px;
      background: transparent; color: var(--dsw-alias-label-secondary);
      font: inherit; font-size: 14px; cursor: default; }
    button:hover, button[aria-expanded=true] { background: var(--dsw-alias-interactive-bg-hover);
      color: var(--dsw-alias-label-primary); }
    button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
`

const TOKENS = `
  :root {
    --dsw-font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    --dsw-alias-label-primary: #1f2329;
    --dsw-alias-label-secondary: #5b6472;
    --dsw-alias-interactive-bg-hover: rgba(0, 0, 0, 0.08);
    --dsw-alias-state-business-primary: #4d6bfe;
    --dsh-windows-menu-start: 48px;
    --dsh-windows-titlebar-height: 40px;
    --dsh-windows-titlebar-height-px: 40px;
  }
  html[data-theme='dark'] {
    --dsw-alias-label-primary: #e8eaed;
    --dsw-alias-label-secondary: #9aa4b2;
    --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.12);
  }
  body { margin: 0; height: 100vh; background: var(--dsh-page-bg, #fff); }
  html[data-theme='dark'] body { --dsh-page-bg: #17181c; }
  #shell { position: relative; height: 100vh; }
  #shell-overlay { position: absolute; inset: 0; }
  #seed { padding: 60px 24px; font: 15px var(--dsw-font-family); color: var(--dsw-alias-label-primary); }
`

const MENU_MARKUP = `
  const host = document.createElement('div');
  host.dataset.windowsMenu = '';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(MENU_STYLE)};
  const bar = document.createElement('div');
  bar.setAttribute('role', 'menubar');
  for (const label of ['应用', '编辑']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    bar.append(button);
  }
  shadow.append(style, bar);
  document.body.append(host);
`

const html = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<title>dsh-win-notify panel fixture</title>
<style>${TOKENS}</style>
</head>
<body>
<div id="shell">
  <div id="shell-overlay"></div>
  <div id="seed">Fixture page: mimics the DSH shell chrome so the notification panel can be exercised.</div>
</div>
<script>
${MENU_MARKUP}
</script>
<script>
// Stub the host API so the panel can render without a live DSH host. The
// response shape mirrors GET /dsh-win-notify/config.
window.__DWN_TEST__ = { posted: [] };
window.fetch = function (url, init) {
  const method = (init && init.method) || 'GET';
  if (String(url).indexOf('/dsh-win-notify/config') === 0) {
    if (method === 'POST') {
      let patch = {};
      try { patch = JSON.parse((init && init.body) || '{}') } catch (e) { patch = {} }
      window.__DWN_TEST__.posted.push(patch);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, config: Object.assign({
        notifyApproval: true, notifyQuestion: true, notifyDone: true, notifyError: true,
        notifyBlocked: true, notifyMaxTokens: true, notifyAborted: true,
        notifyUserAbort: false, notifySubagents: false,
        quietWhenFocused: true, showWhenDnd: false, clickToFocus: true,
      }, patch) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      ok: true,
      config: {
        notifyApproval: true, notifyQuestion: true, notifyDone: true, notifyError: true,
        notifyBlocked: true, notifyMaxTokens: true, notifyAborted: true,
        notifyUserAbort: false, notifySubagents: false,
        quietWhenFocused: true, showWhenDnd: false, clickToFocus: true,
      },
      patchPath: 'C:\\\\fixture\\\\cordis.patch.yml',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  if (String(url).indexOf('/dsh-win-notify/test') === 0) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { shown: true } }), { status: 200 }));
  }
  return Promise.reject(new Error('unexpected fetch: ' + url));
};
</script>
<script src="./fixture-panel.js"></script>
</body>
</html>
`

fs.copyFileSync(path.join(root, 'assets', 'panel.js'), path.join(root, 'assets', 'fixture-panel.js'))
fs.writeFileSync(path.join(root, 'assets', 'fixture.html'), html, 'utf8')
console.log('wrote assets/fixture.html (+ assets/fixture-panel.js)')
