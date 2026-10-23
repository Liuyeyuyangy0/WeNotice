# WeNotice 代码签名脚本
#
# 用法（在仓库根目录运行）：
#   1) 使用证书库里的自签名证书（需已导入 CurrentUser\My）：
#        powershell -ExecutionPolicy Bypass -File tools\sign-exe.ps1 -File dist\WeNotice\WeNotice.exe
#   2) 使用 .pfx 文件（正式证书或导出的自签名证书）：
#        powershell -ExecutionPolicy Bypass -File tools\sign-exe.ps1 -File dist\WeNotice\WeNotice.exe -Pfx C:\path\cert.pfx -PfxPassword 你的密码
#
# 说明：
#   - signtool.exe 来自 Windows SDK（C:\Program Files (x86)\Windows Kits\10\bin\...\x64\signtool.exe）。
#   - 自签名证书只在本机（导入了根证书的机器）显示发布者名，不改变 SmartScreen 行为。
#   - 对外分发需要受信任的代码签名证书（OV/EV、SignPath 开源赞助、Azure 工件签名）。

param(
    [Parameter(Mandatory = $true)][string]$File,
    [string]$Pfx = '',
    [string]$PfxPassword = '',
    [string]$Subject = 'CN=WeNotice',
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if (-not $signtool) {
    throw '找不到 signtool.exe，请先安装 Windows SDK（包含代码签名工具）'
}

$target = (Resolve-Path $File).Path
$signArgs = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256')

if ($Pfx) {
    $signArgs += @('/f', (Resolve-Path $Pfx).Path)
    if ($PfxPassword) { $signArgs += @('/p', $PfxPassword) }
} else {
    $cert = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -like "*$Subject*" -and $_.HasPrivateKey } |
        Select-Object -First 1
    if (-not $cert) {
        throw "证书库里找不到 $Subject 的自签名证书；可先按 README 创建，或改用 -Pfx 参数"
    }
    $signArgs += @('/sha1', $cert.Thumbprint)
}

$signArgs += $target

& $signtool.FullName @signArgs
if ($LASTEXITCODE -ne 0) { throw "签名失败，signtool 退出码 $LASTEXITCODE" }

& $signtool.FullName verify /pa /v $target
if ($LASTEXITCODE -ne 0) { throw "签名验证失败，signtool 退出码 $LASTEXITCODE" }

$sig = Get-AuthenticodeSignature $target
Write-Host ("Signed: " + $target + " | status=" + $sig.Status + " | signer=" + $sig.SignerCertificate.Subject)

