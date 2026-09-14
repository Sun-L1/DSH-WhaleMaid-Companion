<#
.SYNOPSIS
  改完桌宠代码后，让运行中的 Harness 重新挂载这一行（换新 rev），无需重启 dsh。

.DESCRIPTION
  背景：client-modules 在 reconcile 时把 bundle 内容快照进内存，行一旦存在就复用；
  内容变化只有 client-hmr 会通知它重新哈希，而关闭 client-hmr（常见加固做法）的 profile
  拿不到这个通知。因此"重挂载"是让新 bundle 生效的免重启路径：

    1) 把 patch 里的 ui-pet 行临时置为 disabled: true（Loader 卸载该 fiber）
    2) 等一会（等重扫/重算图完成）
    3) 去掉 disabled（新行带着新 rev 与新的内容快照重新挂载）

  然后请硬刷新页面（Ctrl+Shift+R）：bundle 响应带 immutable 缓存头，普通 F5 可能命中旧缓存。

  前置：先跑 node tools/build_bundle.mjs（或 --check）生成最新产物。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$DshHome = $env:DSH_HOME,
    [int]$DelayMs = 600
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path -Parent
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$patchPath = Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $patchPath)) { throw "patch file not found: $patchPath" }
& node (Join-Path $root 'tools\build_bundle.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'bundle drifted from sources — rebuild with: node tools/build_bundle.mjs' }

# 同步新产物到 profile（否则重挂载的还是旧文件）
$pluginSource = Join-Path $root 'plugin'
$destDir = Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'node_modules\@dsh-local\dsh-client-ui-pet'
if (-not (Test-Path -LiteralPath $destDir)) { throw "not installed: $destDir — run tools\install_live.ps1 first" }
Copy-Item -LiteralPath (Join-Path $pluginSource 'lib\client.js') -Destination (Join-Path $destDir 'lib\client.js') -Force
Copy-Item -LiteralPath (Join-Path $pluginSource 'src\assets.gen.json') -Destination (Join-Path $destDir 'src\assets.gen.json') -Force
Write-Host "synced plugin -> $destDir" -ForegroundColor DarkGray

$encoding = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($patchPath)
if (-not $text.Contains("id: ui-pet")) { throw "no ui-pet row in $patchPath — run tools\install_live.ps1 first" }

# 在 insert 行下插入 disabled: true，稍后再移除
$needle = "      name: '@dsh-local/dsh-client-ui-pet'"
if (-not $text.Contains($needle)) { throw "unexpected patch layout: cannot find $needle" }
$disabled = $text.Replace($needle, "$needle`n      disabled: true")
[System.IO.File]::WriteAllText($patchPath, $disabled, $encoding)
Write-Host 'row disabled — waiting for the loader to unload it ...' -ForegroundColor DarkGray
Start-Sleep -Milliseconds $DelayMs
[System.IO.File]::WriteAllText($patchPath, $text, $encoding)
Write-Host 'row re-enabled — hard refresh the page now (Ctrl+Shift+R)' -ForegroundColor Green
