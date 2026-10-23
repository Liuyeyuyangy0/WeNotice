# WeNotice 便携版打包脚本
# 用法：powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1 [-Version 1.0.0]
# 产物：dist\WeNotice\WeNotice.exe（启动器）+ electron.exe（运行时，保持原名）
#
# 说明：Electron 在部分 Windows 环境下重命名 electron.exe 会导致启动崩溃（0xC0000005），
#       因此这里保留 electron.exe 原名，另编译一个同名启动器 WeNotice.exe 负责拉起应用。

param(
    [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # wenotice/
$electronDir = Join-Path $root 'tools\electron-dist'
$appDir = Join-Path $root 'app'
$distRoot = Join-Path $root 'dist'
$distDir = Join-Path $distRoot 'WeNotice'
$launcherExe = Join-Path $root 'tools\WeNoticeLauncher.exe'
$launcherSrc = Join-Path $root 'tools\launcher.cs'
$iconFile = Join-Path $appDir 'assets\icon.ico'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $electronDir)) { throw "缺少 Electron 运行时：$electronDir（先运行 tools\download-electron.mjs 并解压）" }
if (-not (Test-Path $appDir)) { throw "缺少应用源码：$appDir" }

Write-Host "[1/6] 编译启动器…"
if (-not (Test-Path $csc)) { throw "缺少 C# 编译器：$csc（Windows 自带 .NET Framework 4.x 应包含）" }
& $csc /nologo /target:winexe /win32icon:$iconFile /out:$launcherExe /r:System.dll $launcherSrc
if ($LASTEXITCODE -ne 0) { throw "启动器编译失败（exit=$LASTEXITCODE）" }

Write-Host "[2/6] 清理旧产物…"
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Force $distDir | Out-Null
New-Item -ItemType Directory -Force $distRoot | Out-Null

Write-Host "[3/6] 复制 Electron 运行时（保持 electron.exe 原名）…"
Copy-Item -Path (Join-Path $electronDir '*') -Destination $distDir -Recurse -Force

Write-Host "[4/6] 复制应用代码到 resources\app…"
$appDest = Join-Path $distDir 'resources\app'
New-Item -ItemType Directory -Force $appDest | Out-Null
Copy-Item -Path (Join-Path $appDir '*') -Destination $appDest -Recurse -Force
Remove-Item -Force (Join-Path $distDir 'resources\default_app.asar') -ErrorAction SilentlyContinue

Write-Host "[5/6] 写入启动器 WeNotice.exe…"
Copy-Item -Path $launcherExe -Destination (Join-Path $distDir 'WeNotice.exe') -Force

Write-Host "[6/6] 写入版本与说明…"
$electronVersion = Get-Content (Join-Path $electronDir 'version') -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $distDir 'version.txt') -Value "WeNotice $Version (portable, Electron $electronVersion)" -Encoding UTF8
Copy-Item -Path (Join-Path $root 'README.md') -Destination $distDir -Force -ErrorAction SilentlyContinue

$size = [math]::Round((Get-ChildItem $distDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host ""
Write-Host "打包完成：$distDir"
Write-Host "体积：$size MB，运行：$distDir\WeNotice.exe"
