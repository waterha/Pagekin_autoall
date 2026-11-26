# Windows-only regression checks. Fixtures stay under the ignored repository .runtime directory.
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'launch-local.ps1'
$builder = Join-Path $PSScriptRoot 'install-local.ps1'
foreach ($script in @($launcher, $builder)) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    if ($script -eq $builder) {
        $copies = $ast.FindAll({ param($node)
            $node -is [System.Management.Automation.Language.CommandAst] -and
            $node.GetCommandName() -in @('Copy-Item', 'Move-Item', 'Remove-Item')
        }, $true)
        if ($copies.Count) { throw 'Build entry must not copy, replace, or remove installations.' }
    }
}

$fixture = Join-Path $repository ('.runtime\local launcher tests\' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Encoding UTF8 -Value '{"version":"9.8.7"}'
Set-Content -LiteralPath (Join-Path $fixture 'electron-builder.json5') -Encoding UTF8 -Value '{"productName":"Test \u4e66\u7ae5"}'
$package = Join-Path $fixture 'release\9.8.7\win-unpacked'
New-Item -ItemType Directory -Path $package -Force | Out-Null
$name = 'Test ' + [char]0x4e66 + [char]0x7ae5 + '.exe'
$expected = Join-Path $package $name
New-Item -ItemType File -Path $expected | Out-Null
$actual = & $launcher -RepositoryRoot $fixture -CheckOnly
if ($actual -cne $expected) { throw "Wrong package target: $actual; expected $expected" }
Write-Host 'PASS: version, Unicode product name, paths with spaces, explicit repository'

# Exercise the real launch call site without starting a GUI in the test.
function Start-Process {
    param($FilePath, $WorkingDirectory, [switch]$PassThru)
    if ($FilePath -cne $expected -or $WorkingDirectory -cne $package) { throw 'Wrong Start-Process target' }
    if ($env:ELECTRON_RUN_AS_NODE) { throw 'Node mode was not cleared for the child' }
    $fake = [pscustomobject]@{ Id = 123; ExitCode = -2147483645 }
    $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($timeout) return $true }
    return $fake
}
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $caughtExit = $false
    try { & $launcher -RepositoryRoot $fixture | Out-Null }
    catch {
        if ($_.Exception.Message -notlike '*0x80000003*') { throw }
        $caughtExit = $true
    }
    if (-not $caughtExit) { throw 'Immediate native exit was silently reported as a successful start.' }
    if ($env:ELECTRON_RUN_AS_NODE -ne '1') { throw 'Parent Node-mode environment was not restored' }
    $log = Join-Path $fixture '.runtime\launcher-last-error.log'
    if (-not (Test-Path -LiteralPath $log)) { throw 'No persistent startup failure log was written' }
    if ((Get-Content -LiteralPath $log -Raw) -notlike '*0x80000003*') { throw 'Startup failure log lost the exit code' }
} finally {
    Remove-Item Function:Start-Process
    if ($null -ne $previousNodeMode) { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
    else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}
Write-Host 'PASS: immediate native exit is reported, logged, and parent environment is restored'

Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Encoding UTF8 -Value '{"version":"9.8.8"}'
$rejected = $false
try { & $launcher -RepositoryRoot $fixture -CheckOnly | Out-Null }
catch {
    if ($_.Exception.Message -notlike '*Repository package not found*9.8.8*') { throw }
    $rejected = $true
}
if (-not $rejected) { throw 'Missing current version must fail, not launch an older or external package.' }
Write-Host 'PASS: missing current version fails closed without external fallback'

Push-Location $fixture
try {
    $defaultTarget = & $launcher -CheckOnly
    if (-not $defaultTarget.StartsWith($repository + '\release\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Default root depended on caller working directory: $defaultTarget"
    }
} finally { Pop-Location }
Write-Host 'PASS: default repository is relative to script, not caller working directory'
Write-Host 'PASS: script syntax and no external installation copy/delete commands'
