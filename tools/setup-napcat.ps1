<#
.SYNOPSIS
    WeNotice QQ 数据源一键安装/修复脚本（生成可用的 NapCat 便携环境）

.DESCRIPTION
    把踩过的坑全部自动化：
      1. 解出便携 QQ 9.9.33-52230（官方 CDN 安装包 + 7zr，无需安装、不污染系统）
      2. 解压 NapCat 到 QQ 的 resources\app\napcat（自动识别/重下被截断的 zip）
      3. 恢复 QQ 原始 package.json 入口（避免 QQ 校验“文件已损坏”）
      4. 同步 NapCat 自带的新版注入器（NapCatWinBootMain.exe / Hook.dll）
      5. 写 WebUI 配置（127.0.0.1:6099 + 随机 token）
      6. 生成自动提权的 napcat.bat（ASCII + CRLF，避免 cmd 解析错误）
    安装完成后双击 napcat.bat → UAC 点“是”→ 手机 QQ 扫码 → WebUI 建 WebSocket
    服务器 127.0.0.1:3001 → WeNotice 设置里启用 QQ 数据源。

.EXAMPLE
    # 全新安装（联网下载）
    pwsh -File tools\setup-napcat.ps1

    # 用本地已有文件安装（离线/复用，避免重复下载）
    pwsh -File tools\setup-napcat.ps1 -QQInstaller .\QQ.exe -NapCatZip .\NapCat.Shell.zip -SevenZip .\7z.exe

    # 只修复现有安装（bat、webui、注入器、package.json）
    pwsh -File tools\setup-napcat.ps1 -InstallDir C:\Users\LiuYe\NapCat -Repair
#>
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'NapCat'),
    [string]$QQInstaller = '',
    [string]$NapCatZip = '',
    [string]$SevenZip = '',
    [switch]$Repair,
    [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NapCatUrl = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest'
$QQUrl = 'https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/497e2f1f/QQ_9.9.33_260813_x64_01.exe'
$QQExpectedVersion = '9.9.33-52230'

function Write-Step([string]$Text) { Write-Host ''; Write-Host ("==> " + $Text) -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host ("  [ok] " + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host ("  [warn] " + $Text) -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host ("  [error] " + $Text) -ForegroundColor Red; exit 1 }

function Download-File([string]$Url, [string]$OutFile, [string]$Name) {
    if (Test-Path $OutFile) {
        Write-Ok ("$Name 已存在（" + [math]::Round((Get-Item $OutFile).Length / 1MB, 1) + " MB），跳过下载")
        return
    }
    $dir = Split-Path -Parent $OutFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $tmp = "$OutFile.downloading"
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host ("  下载 $Name：" + $Url)
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 --connect-timeout 20 -o $tmp $Url | Out-Null
        if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail "下载 $Name 失败（curl 退出码 $LASTEXITCODE）。网络受限时可手动下载后通过参数指定本地文件。" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    }
    if (-not (Test-Path $tmp)) { Fail "下载 $Name 后找不到文件。" }
    $size = (Get-Item $tmp).Length
    if ($size -lt 1MB) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail "下载 $Name 明显偏小（$size 字节），可能被截断，请重试。" }
    Move-Item $tmp $OutFile -Force
    Write-Ok ("$Name 下载完成（" + [math]::Round($size / 1MB, 1) + " MB）")
}

function Find-VersionDir([string]$Root) {
    $versions = Join-Path $Root 'versions'
    if (-not (Test-Path $versions)) { return $null }
    $dirs = Get-ChildItem $versions -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+-\d+$' }
    return ($dirs | Sort-Object Name -Descending | Select-Object -First 1)
}

function Count-Files([string]$Dir) {
    if (-not (Test-Path $Dir)) { return 0 }
    return (Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Write-AsciiCrlf([string]$Path, [string]$Text) {
    $normalized = ($Text -replace "`r`n", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($Path, $normalized, [System.Text.Encoding]::ASCII)
}

function Ensure-SimpleNapcatZip([string]$Path) {
    # 返回 true 表示 zip 可用（体积 >30MB 且能列出 napcat.mjs）
    if (-not (Test-Path $Path)) { return $false }
    if ((Get-Item $Path).Length -lt 30MB) { return $false }
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tar) { return $true }
    $list = & $tar.Source -tf $Path 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return [bool]($list | Where-Object { $_ -match 'napcat\.mjs$' } | Select-Object -First 1)
}

function New-SelfElevatingBat([string]$BatPath, [string]$VersionName) {
    $bat = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator privileges, please click YES in the UAC dialog...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set "NAPCAT_PATCH_PACKAGE=%~dp0versions\NAPCAT_VER\resources\app\napcat\qqnt.json"
set "NAPCAT_LOAD_PATH=%~dp0versions\NAPCAT_VER\resources\app\napcat\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%~dp0NapCatWinBootHook.dll"
set "NAPCAT_MAIN_PATH=%~dp0versions\NAPCAT_VER\resources\app\napcat\napcat.mjs"
"%~dp0NapCatWinBootMain.exe" "%~dp0QQ.exe" "%~dp0NapCatWinBootHook.dll"
echo.
echo NapCat exited. If this was unexpected, send a screenshot of the error above.
pause
'@
    Write-AsciiCrlf $BatPath $bat.Replace('NAPCAT_VER', $VersionName)
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor DarkCyan
Write-Host '  WeNotice QQ 数据源（NapCat 便携版）安装脚本' -ForegroundColor DarkCyan
Write-Host '=============================================' -ForegroundColor DarkCyan
Write-Host ("  安装目录：" + $InstallDir)

# 如果安装目录在 DSH 工作区里，托盘/桌面程序可能受限，这里只提示不阻断
$versionDir = Find-VersionDir $InstallDir
$installed = ($versionDir -ne $null) -and (Test-Path (Join-Path $InstallDir 'QQ.exe'))
if ($versionDir) { $napcatApp = Join-Path $versionDir.FullName 'resources\app\napcat' } else { $napcatApp = $null }
$napcatOk = $napcatApp -and (Test-Path (Join-Path $napcatApp 'napcat.mjs')) -and ((Count-Files $napcatApp) -ge 300)
$doBase = (-not $installed) -or ($Repair -and -not $installed)
$doNapcat = (-not $napcatOk) -or ($Repair -and -not $napcatOk)

if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force $InstallDir | Out-Null }
$cacheDir = Join-Path $InstallDir '.cache'
if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Force $cacheDir | Out-Null }

# ---------------------------------------------------------------- 1) 便携 QQ
if (-not $installed) {
    Write-Step '准备 7-Zip（仅用于解开 QQ 安装包）'
    if ($SevenZip -and (Test-Path $SevenZip)) {
        $sevenZipExe = (Resolve-Path $SevenZip).Path
        Write-Ok "使用指定的 7z：$sevenZipExe"
    } else {
        $sevenZipExe = Join-Path $cacheDir '7zr.exe'
        if (-not (Test-Path $sevenZipExe)) {
            if ($NoDownload) { Fail '缺少 7zr.exe，请用 -SevenZip 指定本地 7zr.exe/7z.exe。' }
            Download-File 'https://www.7-zip.org/a/7zr.exe' $sevenZipExe '7zr.exe'
        } else { Write-Ok "使用缓存中的 7zr：$sevenZipExe" }
    }

    Write-Step '准备 QQ 9.9.33-52230 安装包（官方 CDN）'
    if ($QQInstaller -and (Test-Path $QQInstaller)) {
        $qqInstallerPath = (Resolve-Path $QQInstaller).Path
        Write-Ok "使用本地 QQ 安装包：$qqInstallerPath"
    } else {
        $qqInstallerPath = Join-Path $cacheDir 'QQ_9.9.33-52230_x64.exe'
        if (-not (Test-Path $qqInstallerPath)) {
            if ($NoDownload) { Fail '缺少 QQ 安装包，请用 -QQInstaller 指定本地 QQ.exe。' }
            Download-File $QQUrl $qqInstallerPath 'QQ 9.9.33 安装包'
        } else { Write-Ok "使用缓存中的 QQ 安装包：$qqInstallerPath" }
    }

    Write-Step '解压 QQ 到安装目录（约 1.2 GB，请稍候）'
    if (Test-Path $InstallDir) {
        Write-Warn2 "安装目录不完整，先清空：$InstallDir"
        Remove-Item $InstallDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    $tmpExtract = Join-Path $InstallDir '.extract'
    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
    & $sevenZipExe x $qqInstallerPath ("-o" + $tmpExtract) -y | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "QQ 安装包解压失败（7z 退出码 $LASTEXITCODE）。" }
    $filesDir = Join-Path $tmpExtract 'Files'
    if (-not (Test-Path (Join-Path $filesDir 'versions'))) {
        $found = Get-ChildItem $tmpExtract -Recurse -Filter 'versions' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $filesDir = $found.Parent.FullName } else { Fail 'QQ 安装包解压后找不到 Files\versions 目录，请确认安装包完整。' }
    }
    Get-ChildItem $filesDir | ForEach-Object { Move-Item $_.FullName $InstallDir -Force }
    Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
    $versionDir = Find-VersionDir $InstallDir
    if (-not $versionDir) { Fail '找不到 versions\9.9.x-xxxxx 目录，请检查 QQ 版本。' }
    Write-Ok ("QQ 便携目录完成，版本：" + $versionDir.Name)
    if ($versionDir.Name -ne $QQExpectedVersion) {
        Write-Warn2 ("QQ 版本是 " + $versionDir.Name + "，而 NapCat 包对应 " + $QQExpectedVersion + "，可能不兼容；建议使用 QQ_9.9.33 安装包")
    }
}

# ---------------------------------------------------------------- 2) NapCat
$versionDir = Find-VersionDir $InstallDir
if (-not $versionDir) { Fail '安装目录里没有 QQ 版本目录，无法继续。' }
$napcatApp = Join-Path $versionDir.FullName 'resources\app\napcat'
$napcatOk = (Test-Path (Join-Path $napcatApp 'napcat.mjs')) -and ((Count-Files $napcatApp) -ge 300)
if (-not $napcatOk) {
    Write-Step '准备 NapCat.Shell.zip'
    if ($NapCatZip -and (Test-Path $NapCatZip)) {
        $napcatZipPath = (Resolve-Path $NapCatZip).Path
        Write-Ok "使用本地 NapCat 包：$napcatZipPath"
        if (-not (Ensure-SimpleNapcatZip $napcatZipPath)) { Fail '本地 NapCat 包不完整（<30MB 或缺少 napcat.mjs），请重新下载。' }
    } else {
        $napcatZipPath = Join-Path $cacheDir 'NapCat.Shell.zip'
        if (-not (Ensure-SimpleNapcatZip $napcatZipPath)) {
            Remove-Item $napcatZipPath -Force -ErrorAction SilentlyContinue
            if ($NoDownload) { Fail '缺少可用的 NapCat.Shell.zip，请用 -NapCatZip 指定本地文件。' }
            Write-Host '  查询 GitHub 最新 NapCat release...'
            $headers = @{ 'User-Agent' = 'WeNotice-Setup'; 'Accept' = 'application/vnd.github+json' }
            $release = Invoke-RestMethod -Uri $NapCatUrl -Headers $headers
            $asset = $release.assets | Where-Object { $_.name -eq 'NapCat.Shell.zip' } | Select-Object -First 1
            if (-not $asset) { Fail '最新 release 中找不到 NapCat.Shell.zip。' }
            Write-Ok ("最新版本：" + $release.tag_name + "，NapCat.Shell.zip " + [math]::Round($asset.size / 1MB, 1) + " MB")
            Download-File $asset.browser_download_url $napcatZipPath 'NapCat.Shell.zip'
            if (-not (Ensure-SimpleNapcatZip $napcatZipPath)) { Fail '下载的 NapCat 包不完整，请重试。' }
        } else { Write-Ok "使用缓存中的 NapCat 包：$napcatZipPath" }
    }

    Write-Step '解压 NapCat 到 QQ 的 resources\app\napcat'
    Remove-Item $napcatApp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $napcatApp | Out-Null
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        & $tar.Source -xf $napcatZipPath -C $napcatApp
        if ($LASTEXITCODE -ne 0) { Fail "解压 NapCat 失败（tar 退出码 $LASTEXITCODE）。" }
    } else {
        Expand-Archive -Path $napcatZipPath -DestinationPath $napcatApp -Force
    }
    if (-not (Test-Path (Join-Path $napcatApp 'napcat.mjs'))) {
        $inner = Get-ChildItem $napcatApp -Recurse -Filter 'napcat.mjs' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($inner -and ($inner.DirectoryName -ne $napcatApp)) {
            Get-ChildItem $inner.DirectoryName | ForEach-Object { Move-Item $_.FullName $napcatApp -Force }
            Remove-Item $inner.DirectoryName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $files = Count-Files $napcatApp
    if (-not (Test-Path (Join-Path $napcatApp 'napcat.mjs')) -or $files -lt 300) { Fail ("NapCat 解压不完整（" + $files + " 个文件）。请删除缓存后重试。") }
    Write-Ok ("NapCat 解压完成（" + $files + " 个文件）")
} else {
    Write-Ok 'NapCat 已安装，跳过解压'
}

# ---------------------------------------------------------------- 3) 修复与配置
Write-Step '校验并修复配置'
$appDir = Join-Path $versionDir.FullName 'resources\app'
$appPackage = Join-Path $appDir 'package.json'
if (Test-Path $appPackage) {
    $raw = Get-Content $appPackage -Raw
    $pkg = $raw | ConvertFrom-Json
    if ($pkg.main -ne './application.asar/app_launcher/index.js') {
        $pkg.main = './application.asar/app_launcher/index.js'
        Write-Utf8NoBom $appPackage ($pkg | ConvertTo-Json -Depth 10)
        Write-Ok '已恢复 QQ package.json 的原始 main 入口'
    } else {
        Write-Ok 'QQ package.json 入口正常'
    }
} else {
    Write-Warn2 '找不到 QQ 的 package.json，安装可能不完整'
}

$napcatConfig = Join-Path $napcatApp 'config'
if (-not (Test-Path $napcatConfig)) { New-Item -ItemType Directory -Force $napcatConfig | Out-Null }
$webuiFile = Join-Path $napcatConfig 'webui.json'
$webuiToken = ''
if (Test-Path $webuiFile) {
    try { $webuiToken = [string](Get-Content $webuiFile -Raw | ConvertFrom-Json).token } catch { $webuiToken = '' }
}
if (-not $webuiToken) {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $webuiToken = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}
Write-Utf8NoBom $webuiFile ([ordered]@{ host = '127.0.0.1'; port = 6099; token = $webuiToken } | ConvertTo-Json -Compress)
Write-Ok ("WebUI 配置已写入（token=" + $webuiToken + "）")

foreach ($f in @('NapCatWinBootMain.exe', 'NapCatWinBootHook.dll')) {
    $src = Join-Path $napcatApp $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $InstallDir $f) -Force }
}
Write-Ok '已同步 NapCat 自带的注入器（NapCatWinBootMain.exe / NapCatWinBootHook.dll）'

$batFile = Join-Path $InstallDir 'napcat.bat'
New-SelfElevatingBat $batFile $versionDir.Name
Write-Ok ("启动脚本：" + $batFile)

try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $desktop '启动 NapCat（管理员）.lnk'))
    $lnk.TargetPath = $batFile
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Description = 'NapCat QQ 数据源（WeNotice）'
    $lnk.Save()
    Write-Ok '已创建桌面快捷方式「启动 NapCat（管理员）.lnk」'
} catch {
    Write-Warn2 ("创建快捷方式失败：" + $_.Exception.Message)
}

# ---------------------------------------------------------------- 4) 汇总
$webuiUrl = 'http://127.0.0.1:6099/webui?token=' + $webuiToken
Write-Host ''
Write-Host '=============================================' -ForegroundColor Green
Write-Host '  安装/修复完成！接下来只需 3 步：' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  1) 双击启动（自动请求管理员权限，UAC 点“是”）：' -ForegroundColor Yellow
Write-Host ('     ' + $batFile)
Write-Host '  2) 黑窗口出现二维码后，用手机 QQ 扫码登录' -ForegroundColor Yellow
Write-Host '  3) 登录成功后打开 WebUI，新建 WebSocket 服务器（127.0.0.1:3001）：' -ForegroundColor Yellow
Write-Host ('     ' + $webuiUrl)
Write-Host ''
Write-Host '  然后打开 WeNotice → 设置 → 数据源 → 启用 QQ 消息接收，地址 ws://127.0.0.1:3001' -ForegroundColor Yellow
Write-Host ''
Write-Host '  注意：NapCat 登录会占用该 QQ 账号（电脑端 QQ 会掉线）；建议用小号。' -ForegroundColor DarkGray
Write-Host '        不想掉线可关注后续「QQ 本地数据库只读」方案（不登录、只读本机记录）。' -ForegroundColor DarkGray
Write-Host ''
