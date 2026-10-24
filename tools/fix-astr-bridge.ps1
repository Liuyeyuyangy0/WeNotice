# Minimal
# fix-astr-bridge.ps1
# Goal: make AstrWeChat's optional Python Bridge work without touching the system Python.
#
# Why: AstrWeChat ships the Bridge as Python sources (resources\bridge) that must run on
# CPython 3.10 or 3.12 with requirements.txt installed. On Windows PCs where only an
# unsupported Python (e.g. 3.13/3.15) or no Python exists, the Bridge dies at
# "import requests". WeNotice itself does NOT need the Bridge or Python at all.
#
# This script:
#   1. locates AstrWeChat (resources\bridge\requirements.txt),
#   2. reuses an existing CPython 3.10/3.12 when available, otherwise downloads the
#      official "embeddable" CPython 3.12 into a private folder (no system install),
#   3. installs bridge requirements into that interpreter,
#   4. sets the user environment variable WEFLOW_BRIDGE_PYTHON to it,
#   5. prints a verification report + next steps.
#
# Modes:
#   default            install portable Python (if needed) + deps, set WEFLOW_BRIDGE_PYTHON
#   -DepsOnly          install deps into an already installed CPython 3.10/3.12 only
#   -DownloadOnly DIR  download portable Python zip + all wheels into DIR (offline kit),
#                      do not install anything
#   -Offline DIR       offline install: use portable Python zip + wheels already in DIR
#
# Examples (run in PowerShell, no admin required):
#   powershell -ExecutionPolicy Bypass -File tools\fix-astr-bridge.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fix-astr-bridge.ps1 -DownloadOnly D:\bridge-kit
#   powershell -ExecutionPolicy Bypass -File tools\fix-astr-bridge.ps1 -Offline D:\bridge-kit
#
# After success: quit AstrWeChat and start it again (the Bridge reads WEFLOW_BRIDGE_PYTHON).

[CmdletBinding()]
param(
  [string]$AstrWeChatDir = '',
  [string]$PythonDir = '',
  [string]$PythonVersion = '3.12.10',
  [string]$DownloadOnly = '',
  [string]$Offline = '',
  [string]$Wheelhouse = '',
  [switch]$DepsOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DefaultPythonDir = Join-Path $env:LOCALAPPDATA 'WeNotice\runtime\python312'
$RequirementsFallback = @(
  'requests>=2.31.0',
  'pyautogui>=0.9.54',
  'pyperclip>=1.8.2',
  'pygetwindow>=0.0.9',
  'uiautomation>=2.0.17',
  'Pillow>=10.0.0',
  'websockets>=14.0',
  'pydantic-ai-slim[openai,anthropic]==2.51.0'
)
$EmbedSources = @(
  'https://www.python.org/ftp/python/{0}/python-{0}-embed-amd64.zip',
  'https://mirrors.aliyun.com/python-release/windows/python-{0}-embed-amd64.zip',
  'https://mirrors.huaweicloud.com/python/{0}/python-{0}-embed-amd64.zip'
)
$PipIndexes = @(
  'https://pypi.org/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.tuna.tsinghua.edu.cn/simple'
)

function Write-Step([string]$Text) { Write-Host "[*] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[+] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "[-] $Text" -ForegroundColor Red }

# ---------------------------------------------------------------- utilities
function Invoke-Download([string]$Url, [string]$OutFile) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Step "download ($attempt/3): $Url"
    $ok = $false
    try {
      & curl.exe -L --fail --silent --show-error --max-time 900 -o $OutFile $Url
      if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { $ok = $true }
    } catch { $ok = $false }
    if (-not $ok) {
      try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
        if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { $ok = $true }
      } catch { $ok = $false }
    }
    if ($ok) { return $OutFile }
    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds (2 * $attempt)
  }
  throw "download failed: $Url"
}

function Resolve-LocalPath([string]$Path) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  return [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).ProviderPath, $Path))
}

function Get-PipCapablePython {
  if (Test-Path (Join-Path $DefaultPythonDir 'python.exe')) {
    $p = Join-Path $DefaultPythonDir 'python.exe'
    & $p -m pip --version *> $null
    if ($LASTEXITCODE -eq 0) { return $p }
  }
  $found = Find-Python
  if ($found) {
    & $found -m pip --version *> $null
    if ($LASTEXITCODE -eq 0) { return $found }
    try { & $found -m ensurepip --default-pip *> $null; & $found -m pip --version *> $null; if ($LASTEXITCODE -eq 0) { return $found } } catch { }
  }
  return ''
}

function Test-Zip([string]$Path) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $count = $zip.Entries.Count
    $zip.Dispose()
    return $count -gt 0
  } catch { return $false }
}

function Get-FileVersion([string]$Exe) {
  try {
    $out = & $Exe -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0) { return ($out | Select-Object -First 1).Trim() }
  } catch { }
  return ''
}

function Test-Imports([string]$PythonExe) {
  $code = "import requests, pyautogui, pyperclip, pygetwindow, uiautomation, PIL, websockets, pydantic_ai; print('BRIDGE_IMPORTS_OK')"
  $out = & $PythonExe -c $code 2>&1
  return ($out -join "`n") -match 'BRIDGE_IMPORTS_OK'
}

function Find-Python([int[]]$Allowed = @(3, 10, 3, 12)) {
  $candidates = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($v in @('3.12', '3.10')) {
      $p = & py -$v -c "import sys;print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $p) { $candidates += ($p | Select-Object -First 1).Trim() }
    }
  }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    'C:\Python312\python.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
    'C:\Python310\python.exe',
    (Join-Path $env:LOCALAPPDATA 'WeNotice\runtime\python312\python.exe')
  )
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $candidates += (Get-Command python).Source
  }
  foreach ($c in $candidates) {
    if (-not $c -or -not (Test-Path $c)) { continue }
    $ver = Get-FileVersion $c
    if ($ver -eq '3.12' -or $ver -eq '3.10') { return $c }
  }
  return ''
}

function Find-AstrWeChatDir([string]$Configured) {
  if ($Configured -and (Test-Path (Join-Path $Configured 'AstrWeChat.exe'))) { return $Configured }
  $paths = @()
  try {
    foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
      $paths += (Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*AstrWeChat*' } | ForEach-Object {
          if ($_.InstallLocation) { $_.InstallLocation }
          elseif ($_.DisplayIcon) { Split-Path -Parent ($_.DisplayIcon.Trim('"')) }
        })
    }
  } catch { }
  $paths += @('C:\Program Files\astrwechat', 'C:\Program Files\AstrWeChat', 'C:\Program Files (x86)\astrwechat')
  foreach ($p in $paths) {
    if ($p -and (Test-Path (Join-Path $p 'AstrWeChat.exe'))) { return (Resolve-Path $p).Path }
  }
  return ''
}

function Get-Requirements([string]$Dir) {
  $file = Join-Path $Dir 'resources\bridge\requirements.txt'
  if (Test-Path $file) {
    $lines = Get-Content $file | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }
    if ($lines) { return @($lines) }
  }
  return $RequirementsFallback
}

function Install-Deps([string]$PythonExe, [string[]]$Requirements, [string]$IndexUrl, [string]$LocalDir) {
  $pipArgs = @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check')
  if ($LocalDir) {
    $pipArgs += @('--no-index', '--find-links', $LocalDir)
  } elseif ($IndexUrl) {
    $pipArgs += @('-i', $IndexUrl)
  }
  foreach ($req in $Requirements) {
    $pipArgs += @('--upgrade', $req)
  }
  Write-Step ("pip install into {0} ({1} packages)" -f $PythonExe, $Requirements.Count)
  $log = & $PythonExe @pipArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    ($log | Select-Object -Last 20) | ForEach-Object { Write-Host $_ }
    throw "pip install failed (exit $LASTEXITCODE)"
  }
}

function Ensure-Pip([string]$PythonExe, [string]$WorkDir) {
  $hasPip = $false
  try { & $PythonExe -m pip --version *> $null; $hasPip = ($LASTEXITCODE -eq 0) } catch { }
  if ($hasPip) { return $true }
  $getPip = Join-Path $WorkDir 'get-pip.py'
  if (-not (Test-Path $getPip)) { Invoke-Download 'https://bootstrap.pypa.io/get-pip.py' $getPip | Out-Null }
  & $PythonExe $getPip --no-warn-script-location
  if ($LASTEXITCODE -ne 0) { throw 'get-pip.py failed' }
  return $true
}

function Ensure-BuildTools([string]$PythonExe) {
  # Some bridge requirements (pygetwindow/pyrect and friends) ship as sdists whose
  # build backend needs setuptools; the embeddable Python ships without it.
  $code = "import setuptools, wheel; print('BUILD_TOOLS_OK')"
  $out = & $PythonExe -c $code 2>&1
  if (($out -join "`n") -match 'BUILD_TOOLS_OK') { return }
  Write-Step 'installing setuptools/wheel bootstrap'
  $ok = $false
  foreach ($idx in $PipIndexes) {
    try {
      & $PythonExe -m pip install --no-warn-script-location --disable-pip-version-check -i $idx setuptools wheel *> $null
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    } catch { }
  }
  if (-not $ok) { throw 'could not install setuptools/wheel' }
}

function Enable-EmbeddedSite([string]$Dir) {
  $pth = Get-ChildItem $Dir -Filter 'python*._pth' | Select-Object -First 1
  if (-not $pth) { return }
  $content = Get-Content $pth.FullName
  if ($content -notmatch '^import site\s*$') {
    $content += 'import site'
    Set-Content -Path $pth.FullName -Value $content -Encoding ASCII
    Write-Ok "enabled site-packages in $($pth.Name)"
  }
}

function Download-PythonEmbed([string]$Version, [string]$DestDir, [string]$Source) {
  $zip = Join-Path $DestDir ("python-$Version-embed-amd64.zip")
  if (-not (Test-Path $zip) -or -not (Test-Zip $zip)) {
    $sources = if ($Source) { @($Source) } else { $EmbedSources | ForEach-Object { $_ -f $Version } }
    $lastError = $null
    foreach ($url in $sources) {
      try {
        Invoke-Download $url $zip | Out-Null
        if (Test-Zip $zip) { break }
        throw 'zip looks corrupt'
      } catch {
        $lastError = $_.Exception.Message
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not (Test-Path $zip) -or -not (Test-Zip $zip)) { throw "could not download a valid Python $Version embed zip: $lastError" }
  }
  return $zip
}

# ---------------------------------------------------------------- modes
$astr = Find-AstrWeChatDir $AstrWeChatDir
if ($astr) { Write-Ok "AstrWeChat: $astr" } else { Write-Warn 'AstrWeChat not found (pass -AstrWeChatDir); using built-in requirements list' }
$requirements = if ($astr) { Get-Requirements $astr } else { $RequirementsFallback }

if ($DownloadOnly) {
  $dir = Resolve-LocalPath $DownloadOnly
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Step "download-only kit into $dir"
  Download-PythonEmbed $PythonVersion $dir '' | Out-Null
  $wheelDir = Join-Path $dir 'wheels'
  New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null
  $reqFile = Join-Path $dir 'requirements.txt'
  Set-Content -Path $reqFile -Value ($requirements -join "`r`n") -Encoding ASCII
  # Prefer an existing pip-capable interpreter; only bootstrap get-pip into a fresh
  # embed extraction when nothing else is available.
  $pyExe = Get-PipCapablePython
  $tmpPython = Join-Path $dir 'python-extract'
  if (-not $pyExe) {
    if (-not (Test-Path (Join-Path $tmpPython 'python.exe'))) {
      Remove-Item $tmpPython -Recurse -Force -ErrorAction SilentlyContinue
      Expand-Archive -Path (Join-Path $dir ("python-$PythonVersion-embed-amd64.zip")) -DestinationPath $tmpPython -Force
      Enable-EmbeddedSite $tmpPython
      Ensure-Pip (Join-Path $tmpPython 'python.exe') $dir | Out-Null
      Ensure-BuildTools (Join-Path $tmpPython 'python.exe')
    }
    $pyExe = Join-Path $tmpPython 'python.exe'
  } else {
    Write-Ok "using existing pip-capable Python for wheel download: $pyExe"
  }
  $downloaded = $false
  foreach ($idx in $PipIndexes) {
    & $pyExe -m pip download --disable-pip-version-check --dest $wheelDir -i $idx -r $reqFile
    if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
    Write-Warn "pip download failed against $idx, trying next mirror"
  }
  if (-not $downloaded) { throw 'pip download failed against all indexes' }
  # Also ship the pip bootstrap bits so the offline installer can create a working
  # interpreter on a machine that has no Python at all.
  & $pyExe -m pip download --disable-pip-version-check --dest $wheelDir -i $PipIndexes[0] pip setuptools wheel *> $null
  # Pre-build wheels from any sdists (pyautogui's deps ship as tar.gz only) so the
  # offline machine never needs a build backend.
  $builtDir = Join-Path $dir 'wheels-built'
  Remove-Item $builtDir -Recurse -Force -ErrorAction SilentlyContinue
  & $pyExe -m pip wheel --disable-pip-version-check --no-deps --no-build-isolation --no-index --find-links $wheelDir -w $builtDir -r $reqFile
  if ($LASTEXITCODE -ne 0) { Write-Warn 'pip wheel prebuild failed; offline install may need setuptools' }
  if (Test-Path $builtDir) {
    Get-ChildItem $builtDir -Filter '*.whl' | Copy-Item -Destination $wheelDir -Force
    Remove-Item $builtDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $getPip = Join-Path $dir 'get-pip.py'
  if (-not (Test-Path $getPip)) {
    try { Invoke-Download 'https://bootstrap.pypa.io/get-pip.py' $getPip | Out-Null } catch { Write-Warn 'get-pip.py download failed; offline kit will need a machine with pip' }
  }
  $kitScript = Join-Path $dir 'install-offline.ps1'
  @"
# generated by fix-astr-bridge.ps1 -DownloadOnly
param([string]`$PythonDir = "`$env:LOCALAPPDATA\WeNotice\runtime\python312")
`$ErrorActionPreference = 'Stop'
`$here = Split-Path -Parent `$PSCommandPath
`$zip = Get-ChildItem `$here -Filter 'python-*-embed-amd64.zip' | Select-Object -First 1
`$wheelDir = Join-Path `$here 'wheels'
if (-not (Test-Path (Join-Path `$PythonDir 'python.exe'))) {
  if (-not `$zip) { throw 'python embed zip missing in kit' }
  Remove-Item `$PythonDir -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path `$zip.FullName -DestinationPath `$PythonDir -Force
  `$pth = Get-ChildItem `$PythonDir -Filter 'python*._pth' | Select-Object -First 1
  if (`$pth) {
    `$lines = Get-Content `$pth.FullName
    if (`$lines -notmatch '^import site\s*$') { (`$lines + 'import site') | Set-Content `$pth.FullName -Encoding ASCII }
  }
}
`$py = Join-Path `$PythonDir 'python.exe'
& `$py -m pip --version *> `$null
if (`$LASTEXITCODE -ne 0) {
  `$getPip = Join-Path `$here 'get-pip.py'
  if (-not (Test-Path `$getPip)) { throw 'python has no pip and get-pip.py missing in kit' }
  & `$py `$getPip --no-warn-script-location --no-index --find-links `$wheelDir
  if (`$LASTEXITCODE -ne 0) { throw 'get-pip.py failed' }
}
# setuptools is needed if any dependency was shipped as an sdist
& `$py -m pip install --no-index --find-links `$wheelDir pip setuptools wheel --no-warn-script-location 2>`$null | Out-Null
& `$py -m pip install --no-index --find-links `$wheelDir -r (Join-Path `$here 'requirements.txt') --no-warn-script-location
if (`$LASTEXITCODE -ne 0) {
  Write-Warn 'plain offline install failed, retrying with --no-build-isolation'
  & `$py -m pip install --no-index --no-build-isolation --find-links `$wheelDir -r (Join-Path `$here 'requirements.txt') --no-warn-script-location
}
if (`$LASTEXITCODE -ne 0) { throw 'offline pip install failed' }
& `$py -c "import requests, websockets, pyautogui, PIL; print('[+] python imports OK')"
if (`$LASTEXITCODE -ne 0) { throw 'bridge imports still failing' }
[Environment]::SetEnvironmentVariable('WEFLOW_BRIDGE_PYTHON', `$py, 'User')
Write-Host ('[+] WEFLOW_BRIDGE_PYTHON = ' + `$py)
Write-Host '[*] quit and restart AstrWeChat, then click Bridge -> start AstrWeChat'
"@ | Set-Content -Path $kitScript -Encoding UTF8
  Write-Ok "offline kit ready: $dir"
  Write-Ok "copy the whole folder to the target PC, then run install-offline.ps1 there"
  exit 0
}

if ($Offline) {
  $dir = [IO.Path]::GetFullPath($Offline)
  $zip = Get-ChildItem $dir -Filter 'python-*-embed-amd64.zip' | Select-Object -First 1
  if (-not $zip) { throw "no python-*-embed-amd64.zip in $dir" }
  $target = if ($PythonDir) { $PythonDir } else { $DefaultPythonDir }
  if ($Force -or -not (Test-Path (Join-Path $target 'python.exe'))) {
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Expand-Archive -Path $zip.FullName -DestinationPath $target -Force
    Enable-EmbeddedSite $target
  }
  $pyExe = Join-Path $target 'python.exe'
  $reqFile = Join-Path $dir 'requirements.txt'
  $wheels = Join-Path $dir 'wheels'
  & $pyExe -m pip --version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'this offline kit has no pip installed in the embed python; run -DownloadOnly kit install script instead' }
  if (Test-Path $reqFile) {
    $reqs = Get-Content $reqFile | Where-Object { $_.Trim() }
    Install-Deps $pyExe $reqs '' $wheels
  } else {
    Install-Deps $pyExe $requirements '' $wheels
  }
  [Environment]::SetEnvironmentVariable('WEFLOW_BRIDGE_PYTHON', $pyExe, 'User')
  Write-Ok "WEFLOW_BRIDGE_PYTHON = $pyExe"
  if (Test-Imports $pyExe) { Write-Ok 'import check: OK' } else { Write-Warn 'import check failed; run again with -Force or check wheels' }
  Write-Step 'now quit and restart AstrWeChat, then Bridge -> start'
  exit 0
}

if ($DepsOnly) {
  $pyExe = Find-Python
  if (-not $pyExe) { throw 'no CPython 3.10/3.12 found. Run without -DepsOnly to install a private portable 3.12.' }
  Write-Ok "using existing Python: $pyExe ($(Get-FileVersion $pyExe))"
  Ensure-Pip $pyExe $env:TEMP | Out-Null
  Ensure-BuildTools $pyExe
  $installed = $false
  foreach ($idx in $PipIndexes) {
    try { Install-Deps $pyExe $requirements $idx ''; $installed = $true; break } catch { Write-Warn $_.Exception.Message }
  }
  if (-not $installed) { throw 'could not install bridge requirements from any index' }
  [Environment]::SetEnvironmentVariable('WEFLOW_BRIDGE_PYTHON', $pyExe, 'User')
  Write-Ok "WEFLOW_BRIDGE_PYTHON = $pyExe"
  if (Test-Imports $pyExe) { Write-Ok 'import check: OK' } else { Write-Warn 'import check failed' }
  exit 0
}

# default mode: portable python + deps
$target = if ($PythonDir) { $PythonDir } else { $DefaultPythonDir }
$pyExe = Join-Path $target 'python.exe'
$needInstall = $Force -or -not (Test-Path $pyExe)
if (-not $needInstall) {
  $v = Get-FileVersion $pyExe
  if ($v -ne '3.12') { Write-Warn "existing $target has Python '$v' (need 3.12), reinstalling"; $needInstall = $true }
}
if ($needInstall) {
  $work = Join-Path $env:TEMP 'we-notice-bridge-python'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Download-PythonEmbed $PythonVersion $work ''
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Expand-Archive -Path $zip -DestinationPath $target -Force
  Enable-EmbeddedSite $target
  Write-Ok "portable Python $PythonVersion ready: $target"
}
Ensure-Pip $pyExe $target | Out-Null
Ensure-BuildTools $pyExe
$installed = $false
$wheelDir = if ($Wheelhouse) { [IO.Path]::GetFullPath($Wheelhouse) } else { '' }
if ($wheelDir) { New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null }
foreach ($idx in $PipIndexes) {
  try {
    if ($wheelDir) {
      Write-Step "download wheels into $wheelDir"
      $reqFile = Join-Path $target 'requirements.txt'
      Set-Content -Path $reqFile -Value ($requirements -join "`r`n") -Encoding ASCII
      & $pyExe -m pip download --disable-pip-version-check --dest $wheelDir -i $idx -r $reqFile
      if ($LASTEXITCODE -ne 0) { throw 'pip download failed' }
      Install-Deps $pyExe $requirements '' $wheelDir
    } else {
      Install-Deps $pyExe $requirements $idx ''
    }
    $installed = $true
    break
  } catch { Write-Warn $_.Exception.Message }
}
if (-not $installed) { throw 'could not install bridge requirements from any index' }

[Environment]::SetEnvironmentVariable('WEFLOW_BRIDGE_PYTHON', $pyExe, 'User')
$env:WEFLOW_BRIDGE_PYTHON = $pyExe
Write-Ok "WEFLOW_BRIDGE_PYTHON = $pyExe"
if (Test-Imports $pyExe) {
  Write-Ok 'bridge import check: OK'
  Write-Host ''
  Write-Host 'Next steps:' -ForegroundColor Cyan
  Write-Host '  1) Quit AstrWeChat completely (tray -> exit).'
  Write-Host '  2) Start AstrWeChat again; open Bridge page, click "start AstrWeChat".'
  Write-Host '  3) WeNotice itself never needs Python/Bridge; if you only want WeNotice notifications, skip all of this.'
} else {
  Write-Warn 'import check failed. Re-run with -Force, or check the log above.'
  exit 2
}
