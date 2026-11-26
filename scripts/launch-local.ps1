# Always launch this checkout's package. Never search other installation directories.
[CmdletBinding()]
param(
    [string] $RepositoryRoot,
    [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$configPath = Join-Path $RepositoryRoot 'electron-builder.json5'
# productName is a JSON string in the builder configuration; do not hardcode a machine path or app name.
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
$match = [regex]::Match($config, '"productName"\s*:\s*("(?:\\.|[^"\\])*")')
if (-not $match.Success) { throw "Missing productName in $configPath" }
$productName = ConvertFrom-Json -InputObject $match.Groups[1].Value
$packageRoot = Join-Path $RepositoryRoot "release\$($manifest.version)\win-unpacked"
$exe = Join-Path $packageRoot "$productName.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Repository package not found: $exe. Run scripts\install-local.ps1 first."
}
if ($CheckOnly) {
    Write-Output $exe
    return
}

# Harness shells may inherit Node mode. Clear it only for the child, then restore our environment.
$nodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $exe -WorkingDirectory $packageRoot -PassThru
    Write-Output "Started repository package: $exe (PID $($process.Id))"
} finally {
    if ($null -ne $nodeMode) { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
}
