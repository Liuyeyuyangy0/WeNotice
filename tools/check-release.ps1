# WeNotice release gate — 发布前/构建后检查
#
# 用法：
#   pwsh tools\check-release.ps1 -Stage pre              # 提交后/发版前：语法、版本号、CHANGELOG
#   pwsh tools\check-release.ps1 -Stage post             # 构建后：版本文件、zip、sha256、签名
#   pwsh tools\check-release.ps1 -Stage post -Version 1.3.5-beta.1
#
# CI 中用 ci.yml 跑 -Stage pre；release.yml 在构建前跑 -Stage pre、构建后可再跑 -Stage post。
# Node 不可用时可通过 -NodeExe 指定（本机可用 DSH 自带 node.exe 绝对路径）。

param(
    [ValidateSet('pre', 'post')]
    [string]$Stage = 'pre',
    [string]$Version = '',
    [string]$NodeExe = 'node',
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$failures = New-Object System.Collections.Generic.List[string]
function Fail([string]$msg) {
    $failures.Add($msg) | Out-Null
    Write-Host "FAIL: $msg" -ForegroundColor Red
}
function Pass([string]$msg) { Write-Host "ok: $msg" }

# ---------- 1. app/package.json + 版本号 ----------
$pkgPath = Join-Path $Root 'app\package.json'
$pkg = $null
if (-not (Test-Path $pkgPath)) {
    Fail "missing app/package.json"
} else {
    try {
        $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Pass "app/package.json is valid JSON"
    } catch {
        Fail "app/package.json is not valid JSON: $_"
    }
}
if ($pkg) {
    $pkgVersion = [string]$pkg.version
    if (-not $Version) { $Version = $pkgVersion }
    $base = $Version -replace '-[^-]*$', ''
    $pkgBase = $pkgVersion -replace '-[^-]*$', ''
    if ($base -ne $pkgBase) {
        Fail "version mismatch: app/package.json=$pkgVersion, requested=$Version"
    } elseif ($Version -match '-') {
        Pass "prerelease $Version (package.json base $pkgVersion)"
    } else {
        Pass "package.json version=$pkgVersion"
    }
}
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$') {
    Fail "invalid version syntax: '$Version' (expected X.Y.Z or X.Y.Z-beta.N)"
} else {
    Pass "version syntax: $Version"
}

# ---------- 2. node --check 全部源文件 ----------
$appDir = Join-Path $Root 'app'
$toolsDir = Join-Path $Root 'tools'
$jsFiles = @()
if (Test-Path $appDir) {
    $jsFiles += @(Get-ChildItem -Path $appDir -Recurse -File | Where-Object {
            $_.Extension -eq '.js' -and $_.FullName -notmatch '[\\/]node_modules[\\/]'
        })
}
if (Test-Path $toolsDir) {
    $jsFiles += @(Get-ChildItem -Path $toolsDir -File | Where-Object { $_.Extension -in '.js', '.mjs' })
}
$checkFailed = @()
foreach ($f in $jsFiles) {
    & $NodeExe --check $f.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $checkFailed += $f.FullName }
}
if ($checkFailed.Count -gt 0) {
    foreach ($f in $checkFailed) { Fail "node --check failed: $f" }
} else {
    Pass "node --check passed for $($jsFiles.Count) file(s)"
}

# ---------- 3. CHANGELOG 条目 ----------
$changelogPath = Join-Path $Root 'CHANGELOG.md'
if (-not (Test-Path $changelogPath)) {
    Fail "missing CHANGELOG.md"
} else {
    $changelog = Get-Content $changelogPath -Raw -Encoding UTF8
    $baseVersion = $Version -replace '-[^-]*$', ''
    $hasExact = $changelog -match ('(?m)^##\s+v' + [regex]::Escape($Version))
    $hasBase = $changelog -match ('(?m)^##\s+v' + [regex]::Escape($baseVersion))
    if ($hasExact) {
        Pass "CHANGELOG has v$Version"
    } elseif ($hasBase) {
        if ($Version -match '-') { Pass "CHANGELOG has v$baseVersion (prerelease)" }
        else { Fail "CHANGELOG entry for v$Version missing (only v$baseVersion found)" }
    } else {
        Fail "CHANGELOG entry for v$Version missing"
    }
}

# ---------- 4. 构建产物（仅 post 阶段） ----------
if ($Stage -eq 'post') {
    $versionTxt = Join-Path $Root 'dist\WeNotice\version.txt'
    if (-not (Test-Path $versionTxt)) {
        Fail "missing dist\WeNotice\version.txt (run tools\build-portable.ps1 first)"
    } elseif ((Get-Content $versionTxt -Raw -Encoding UTF8) -notmatch [regex]::Escape($Version)) {
        Fail "dist\WeNotice\version.txt does not mention $Version"
    } else {
        Pass "dist version.txt ok"
    }

    $zipPath = Join-Path $Root "dist\WeNotice-portable-$Version.zip"
    if (-not (Test-Path $zipPath)) {
        Fail "missing zip: $zipPath"
    } else {
        $size = (Get-Item $zipPath).Length
        if ($size -lt 100MB) {
            Fail "zip suspiciously small: $size bytes"
        } else {
            Pass "zip size ok ($([math]::Round($size / 1MB, 1)) MB)"
        }
        $shaPath = "$zipPath.sha256"
        if (-not (Test-Path $shaPath)) {
            Fail "missing $shaPath"
        } else {
            $expected = ((Get-Content $shaPath -Raw -Encoding UTF8).Trim() -split '\s+')[0].ToLower()
            $actual = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
            if ($expected -ne $actual) { Fail "sha256 mismatch for zip" }
            else { Pass "sha256 matches" }
        }
    }

    $exePath = Join-Path $Root 'dist\WeNotice\WeNotice.exe'
    if (-not (Test-Path $exePath)) {
        Fail "missing dist\WeNotice\WeNotice.exe"
    } else {
        $sig = Get-AuthenticodeSignature $exePath
        if ($sig.Status -eq 'Valid') {
            Pass "launcher signature: Valid ($($sig.SignerCertificate.Subject))"
        } else {
            Write-Host "warn: launcher signature status=$($sig.Status) — 本地测试可忽略；对外发布的正式包应签名" -ForegroundColor Yellow
        }
    }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host "CHECK FAILED ($($failures.Count) issue(s), stage=$Stage, version=$Version)" -ForegroundColor Red
    exit 1
}
Write-Host "CHECK PASSED (stage=$Stage, version=$Version)" -ForegroundColor Green
exit 0
