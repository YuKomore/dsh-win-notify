<#
Gives toasts the app identity "DeepSeek Harness" instead of the raw AppUserModelID.

Windows attributes a notification by finding the Start-menu shortcut whose
System.AppUserModel.ID equals the toast's AUMID, and renders the app name and the
small header icon from that shortcut. The shortcut DSH creates has no such
property, so without this step the toast header reads
"electron.app.DeepSeek Harness".

Also points the shortcut's icon at assets\app.ico, which is what supplies the
small header glyph: that slot is about 16 logical pixels and Windows will not
downsample a large PNG for it, so a multi-resolution .ico is required.

Run once after installing the plugin, and again after an app update (the installer
recreates the shortcut and drops the property).

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-app-identity.ps1
#>
[CmdletBinding()]
param(
  [string]$AppUserModelId = 'electron.app.DeepSeek Harness'
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'set-shortcut-aumid.ps1'
$appIcon = Join-Path $pluginRoot 'assets\app.ico'

if (-not (Test-Path -LiteralPath $appIcon)) {
  Write-Warning "no icon at $appIcon; the header glyph will fall back to a generic one"
  $appIcon = ''
}

$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk'
if (-not (Test-Path -LiteralPath $shortcut)) {
  Write-Warning @"
Start-menu shortcut not found:
  $shortcut
Launch DeepSeek Harness once (or pin it to Start), then run this again.
"@
  exit 1
}

if ($appIcon) {
  & $helper -ShortcutPath $shortcut -AppUserModelId $AppUserModelId -IconPath $appIcon
} else {
  & $helper -ShortcutPath $shortcut -AppUserModelId $AppUserModelId
}

Write-Output ''
Write-Output 'Done. Restart DeepSeek Harness so new toasts pick up the identity.'
