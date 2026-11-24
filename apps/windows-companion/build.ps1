param([Parameter(Mandatory = $true)][string]$MakeNsis)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$automation = Join-Path (Split-Path -Parent $compiler) 'WPF'
$automationReferences = 'UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll' |
    ForEach-Object { '/r:' + (Join-Path $automation $_) }
$output = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$source = Get-ChildItem $PSScriptRoot -Filter '*.cs' | ForEach-Object { $_.FullName }
$MakeNsis = (Resolve-Path -LiteralPath $MakeNsis).Path
Push-Location $output
try {
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /win32manifest:"$PSScriptRoot\app.manifest" /out:T3Code-LM-Companion.exe /r:System.Windows.Forms.dll $automationReferences /r:System.Drawing.dll /r:System.Net.Http.dll /r:System.Management.dll /r:System.Security.dll /r:System.Web.Extensions.dll $source
    if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
    # 独立生成目录保证 NSIS 的相对路径和成品名称固定。
    Copy-Item -LiteralPath "$PSScriptRoot\setup.nsi" -Destination "$output\setup.nsi" -Force
    & $MakeNsis /INPUTCHARSET UTF8 /V2 "$output\setup.nsi"
    if ($LASTEXITCODE -ne 0) { throw "makensis failed ($LASTEXITCODE)" }
    Get-FileHash -Algorithm SHA256 T3Code-LM-Companion-0.2.5-2-localtest.1-Windows-x64-Setup.exe
}
finally { Pop-Location }
