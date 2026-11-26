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
