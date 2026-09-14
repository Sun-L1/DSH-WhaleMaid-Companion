<#
.SYNOPSIS
  把 DSH Copilot 桌宠装进本机 Harness 的 web profile —— 免重启（live patch）路径。

.DESCRIPTION
  做三件事（全部在 $DSH_HOME 下，即工作区之外）：
    1) 备份 profiles\<profile>\cordis.patch.yml（带时间戳，存到项目 backups\）
    2) 把 plugin\ 复制到 profiles\<profile>\node_modules\@dsh-local\dsh-client-ui-pet\
    3) 在 profiles\<profile>\cordis.patch.yml 里幂等插入一行 insert 条目（放在皮肤插件的
       managed 块之前，避免被它的重写覆盖）

  为什么不用重启：该 patch 文件属于 patchReload: 'live' 的用户层，CLI 会监听并整体重放它
  （apps/cli/src/profile-boot.ts），新增 insert 行会在运行中的进程里挂载成 Loader 行，
  client-modules 随即把该行的 ./client bundle 提供到 /plugins 并重算启动图
  （packages/client/modules/src/index.ts 的 internal/plugin 重扫）。

  本机若关闭了 client-hmr（常见加固做法），浏览器不会自动收到图变化：**装完请刷新页面（F5）**。

.PARAMETER Profile
  profile 名，默认 web。
.PARAMETER DshHome
  DSH_HOME 路径，默认取环境变量 DSH_HOME（再退回 %USERPROFILE%\.dsh）。
.PARAMETER WhatIf
  只打印计划，不写任何东西。
.PARAMETER SkipVerify
  跳过 tools/verify_plugin.mjs 前置校验（不建议）。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$DshHome = $env:DSH_HOME,
    [switch]$WhatIf,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path -Parent
$pluginSource = Join-Path $root 'plugin'
$packageName = '@dsh-local/dsh-client-ui-pet'
$entryId = 'ui-pet'
$markerStart = '# --- dsh-copilot pet (managed by DSH_Copilet; do not edit) ---'
$markerEnd = '# --- end dsh-copilot pet ---'

if (-not $DshHome) {
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
}
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$destRoot = Join-Path (Join-Path $profileDir 'node_modules') '@dsh-local'
$destDir = Join-Path $destRoot 'dsh-client-ui-pet'

Write-Host "DSH Copilot pet install" -ForegroundColor Cyan
Write-Host "  DSH_HOME   : $DshHome"
Write-Host "  profile    : $Profile"
Write-Host "  target     : $profileDir"
Write-Host "  package    : $packageName"
Write-Host "  WhatIf     : $([bool]$WhatIf)"

if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile directory not found: $profileDir (is DSH_HOME correct? is the profile initialized?)"
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginSource 'lib\client.js'))) {
    throw "plugin\lib\client.js missing — run: node tools/build_bundle.mjs"
}

if (-not $SkipVerify) {
    Write-Host "  verifying plugin artifacts ..." -ForegroundColor DarkGray
    & node (Join-Path $root 'tools\verify_plugin.mjs') --quiet
    if ($LASTEXITCODE -ne 0) { throw 'tools/verify_plugin.mjs failed — refusing to install' }
}

# 1) 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Join-Path $root 'backups') $stamp
$patchExists = Test-Path -LiteralPath $patchPath
if (-not $WhatIf) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    if ($patchExists) { Copy-Item -LiteralPath $patchPath -Destination (Join-Path $backupDir 'cordis.patch.yml') -Force }
    $profileManifest = Join-Path $profileDir 'package.json'
    if (Test-Path -LiteralPath $profileManifest) {
        Copy-Item -LiteralPath $profileManifest -Destination (Join-Path $backupDir 'profile-package.json') -Force
    }
    Copy-Item -LiteralPath (Join-Path $pluginSource 'lib\client.js') -Destination (Join-Path $backupDir 'client.js') -Force
}
Write-Host "  backup     : $backupDir" -ForegroundColor DarkGray

# 2) 复制包（镜像式：先删旧文件，再复制 package.json / cordis.patch.yml / lib / src）
$files = @('package.json', 'cordis.patch.yml')
$dirs = @('lib', 'src')
if ($WhatIf) {
    Write-Host "  [WhatIf] would mirror $pluginSource -> $destDir"
} else {
    if (Test-Path -LiteralPath $destDir) { Remove-Item -LiteralPath $destDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $pluginSource $file) -Destination (Join-Path $destDir $file) -Force
    }
    foreach ($dir in $dirs) {
        Copy-Item -LiteralPath (Join-Path $pluginSource $dir) -Destination $destDir -Recurse -Force
    }
    Write-Host "  installed  : $destDir" -ForegroundColor DarkGray
}

# 3) patch 文件：幂等插入
$encoding = New-Object System.Text.UTF8Encoding($false)
$text = if ($patchExists) { [System.IO.File]::ReadAllText($patchPath) } else { '' }
$newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$block = ($markerStart, "- insert:", "    - id: $entryId", "      name: '$packageName'", $markerEnd) -join $newline

if ($text -match "(?m)^\s*-?\s*id:\s*$entryId\s*$" -or $text.Contains($markerStart)) {
    Write-Host "  patch      : entry '$entryId' already present — left untouched" -ForegroundColor Yellow
} else {
    $skinMarker = '# --- dsh-skin managed'
    $index = $text.IndexOf($skinMarker, [System.StringComparison]::Ordinal)
    if ($index -ge 0) {
        $head = $text.Substring(0, $index)
        $tail = $text.Substring($index)
        $updated = $head.TrimEnd("`r", "`n") + $newline + $newline + $block + $newline + $newline + $tail
    } else {
        $updated = $text.TrimEnd("`r", "`n") + $newline + $newline + $block + $newline
    }
    if ($WhatIf) {
        Write-Host "  [WhatIf] would insert into $patchPath :" -ForegroundColor DarkGray
        $block -split "`n" | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    } else {
        $tmp = "$patchPath.dsh-pet.tmp"
        [System.IO.File]::WriteAllText($tmp, $updated, $encoding)
        Move-Item -LiteralPath $tmp -Destination $patchPath -Force
        Write-Host "  patch      : inserted '$entryId' into $patchPath" -ForegroundColor Green
    }
}

Write-Host ''
Write-Host "next: refresh the Harness tab (F5). client-hmr is disabled in this profile, so the" -ForegroundColor Cyan
Write-Host "      page will not pick the new row up on its own." -ForegroundColor Cyan
Write-Host "check: node tools\check_live.mjs            (filesystem + boot-graph probe)" -ForegroundColor Cyan
Write-Host "undo : powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1" -ForegroundColor Cyan
