# Always launch this checkout's package. Never search other installation directories.
[CmdletBinding()]
param(
    [string] $RepositoryRoot,
    [switch] $CheckOnly,
    [switch] $ShowErrors
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
try {
    $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    $manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $configPath = Join-Path $RepositoryRoot 'electron-builder.json5'
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

    # Harness shells may inherit Node mode. Clear it only for the child, then restore it.
    $nodeMode = $env:ELECTRON_RUN_AS_NODE
    try {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $exe -WorkingDirectory $packageRoot -PassThru
        if ($process.WaitForExit(2000) -and $process.ExitCode -ne 0) {
            $exitHex = '0x{0:X8}' -f ([long]$process.ExitCode -band 0xffffffffL)
            throw "Application exited before startup: $exitHex ($($process.ExitCode)). Package: $exe"
        }
        Write-Output "Launched repository package: $exe (PID $($process.Id))"
    } finally {
        if ($null -ne $nodeMode) { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
    }
} catch {
    $failure = $_
    $message = $failure.Exception.Message
    try {
        $logDirectory = Join-Path $RepositoryRoot '.runtime'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $log = Join-Path $logDirectory 'launcher-last-error.log'
        ((Get-Date -Format o) + "`r`n" + $message) | Set-Content -LiteralPath $log -Encoding UTF8
        $message += "`r`n`r`nStartup log: $log"
    } catch {
        # Failure to write diagnostics must not hide the original startup error.
    }
    if ($ShowErrors) {
        try {
            Add-Type -AssemblyName PresentationFramework
            [System.Windows.MessageBox]::Show($message, 'Pagekin startup failed', 'OK', 'Error') | Out-Null
        } catch {
            Write-Warning $message
        }
    }
    throw $failure
}
