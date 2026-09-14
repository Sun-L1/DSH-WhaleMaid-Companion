<#
.SYNOPSIS
  卸载 DSH Copilot 桌宠：移除 patch 行 + 删除已安装的包目录。

.DESCRIPTION
  幂等：不存在就什么都不做。备份保留在 backups\ 下，不会被删除。
  卸载后同样需要刷新页面（F5）才能让已加载的行消失。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$DshHome = $env:DSH_HOME,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path -Parent
$entryId = 'ui-pet'
$markerStart = '# --- dsh-copilot pet (managed by DSH_Copilet; do not edit) ---'
$markerEnd = '# --- end dsh-copilot pet ---'

if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$destDir = Join-Path (Join-Path (Join-Path $profileDir 'node_modules') '@dsh-local') 'dsh-client-ui-pet'

Write-Host "DSH Copilot pet uninstall" -ForegroundColor Cyan
Write-Host "  profile : $Profile"
Write-Host "  target  : $profileDir"

# 1) patch 行
if (Test-Path -LiteralPath $patchPath) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $text = [System.IO.File]::ReadAllText($patchPath)
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $patterns = @(
        "(?s)" + [regex]::Escape($markerStart) + ".*?" + [regex]::Escape($markerEnd) + "\s*",
        "(?ms)^- insert:\s*\r?\n\s*- id: $entryId\s*\r?\n\s*name: '[^']+'\s*\r?\n?"
    )
    $updated = $text
    foreach ($pattern in $patterns) {
        $updated = [regex]::Replace($updated, $pattern, '')
    }
    $updated = $updated -replace "(\r?\n){3,}", "$newline$newline"
    if ($updated -eq $text) {
        Write-Host "  patch  : no '$entryId' entry found — nothing to remove" -ForegroundColor Yellow
    } elseif ($WhatIf) {
        Write-Host "  [WhatIf] would rewrite $patchPath (remove '$entryId' row)" -ForegroundColor DarkGray
    } else {
        $tmp = "$patchPath.dsh-pet.tmp"
        [System.IO.File]::WriteAllText($tmp, $updated, $encoding)
        Move-Item -LiteralPath $tmp -Destination $patchPath -Force
        Write-Host "  patch  : removed '$entryId' row" -ForegroundColor Green
    }
} else {
    Write-Host "  patch  : $patchPath not found — skipped" -ForegroundColor Yellow
}

# 2) 已安装的包目录
if (Test-Path -LiteralPath $destDir) {
    if ($WhatIf) {
        Write-Host "  [WhatIf] would delete $destDir" -ForegroundColor DarkGray
    } else {
        Remove-Item -LiteralPath $destDir -Recurse -Force
        Write-Host "  files  : deleted $destDir" -ForegroundColor Green
    }
    $parent = Split-Path -Parent $destDir
    if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force | Select-Object -First 1)) {
        if (-not $WhatIf) { Remove-Item -LiteralPath $parent -Force }
        Write-Host "  files  : removed empty $parent" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  files  : $destDir not found — skipped" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'refresh the Harness tab (F5) to unload the row from the running page.' -ForegroundColor Cyan
