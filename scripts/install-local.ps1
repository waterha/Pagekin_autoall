# Compatibility entry point: build and verify in this repository, without copying an install.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
[CmdletBinding()]
param(
    [string] $RepositoryRoot,
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$packageRoot = Join-Path $RepositoryRoot "release\$($manifest.version)\win-unpacked"

Push-Location $RepositoryRoot
try {
    if (-not $SkipBuild) {
        Write-Host '==> Build package inside the repository'
        & pnpm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
        & pnpm exec vite build
        if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }

        $builderArgs = @('exec', 'electron-builder', '--win', 'dir', '--x64', '--publish', 'never')
        $localElectron = Join-Path $RepositoryRoot 'node_modules\electron\dist'
        if (Test-Path -LiteralPath $localElectron) {
            $builderArgs += "--config.electronDist=$localElectron"
        }
        & pnpm @builderArgs
        if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
    }

    & node scripts/verify-win-package.mjs $packageRoot
    if ($LASTEXITCODE -ne 0) { throw 'package verification failed' }
    Write-Host "Verified repository package: $packageRoot"
    Write-Host 'No external installation was created. Run scripts\launch-local.ps1 to start this package.'
} finally {
    Pop-Location
}
