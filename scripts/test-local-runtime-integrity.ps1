# Windows regression: real inherited Low labels must be repaired on images only.
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$repair = Join-Path $PSScriptRoot 'repair-local-runtime.ps1'
$fixture = Join-Path $repository ('.runtime\runtime-integrity-tests\' + [guid]::NewGuid().ToString())
$package = Join-Path $fixture 'release\9.8.7\win-unpacked'
New-Item -ItemType Directory -Path $package -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Value '{"version":"9.8.7"}' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fixture 'electron-builder.json5') -Value '{"productName":"Test App"}' -Encoding UTF8
$exe = Join-Path $package 'Test App.exe'
$dll = Join-Path $package 'ffmpeg.dll'
$data = Join-Path $package 'data.txt'
foreach ($file in @($exe, $dll, $data)) { Set-Content -LiteralPath $file -Value 'unchanged fixture bytes' -Encoding UTF8 }
& icacls.exe $package /setintegritylevel '(OI)(CI)L' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not seed Low-label reproduction' }
$dacl = (Get-Acl -LiteralPath $exe).Sddl
$hash = (Get-FileHash -LiteralPath $exe).Hash
& $repair -RepositoryRoot $fixture
foreach ($file in @($exe, $dll)) {
    if ([Pagekin.RuntimeIntegrity]::Label($file) -notmatch ';;;ME\)') { throw "Runtime image still Low: $file" }
}
if ([Pagekin.RuntimeIntegrity]::Label($package) -notmatch ';;;LW\)' -or [Pagekin.RuntimeIntegrity]::Label($data) -notmatch ';;;LW\)') {
    throw 'Repair changed workspace/data integrity labels'
}
if ((Get-Acl -LiteralPath $exe).Sddl -cne $dacl -or (Get-FileHash -LiteralPath $exe).Hash -ne $hash) {
    throw 'Repair changed DACL or executable content'
}
$backup = Get-Content -LiteralPath (Join-Path $fixture '.runtime\runtime-integrity-repair.json') -Raw | ConvertFrom-Json
if ($backup.Count -ne 2) { throw 'Missing original-label recovery evidence' }
Write-Host 'PASS: Low startup images repaired; directory, data, DACL and bytes unchanged'
$second = & $repair -RepositoryRoot $fixture 6>&1 | Out-String
if ($second -notlike '*0 image(s) repaired*') { throw 'Repeated repair was not a no-op' }
Write-Host 'PASS: repeat repair does not change already-correct labels'

# A renamed package cannot escape the exact release directory.
Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Value '{"version":"../../outside"}' -Encoding UTF8
$rejected = $false
try { & $repair -RepositoryRoot $fixture } catch { if ($_.Exception.Message -notlike '*Invalid package version*') { throw }; $rejected = $true }
if (-not $rejected) { throw 'Unsafe version path was accepted' }
Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Value '{"version":"9.8.7"}' -Encoding UTF8
$external = Join-Path $fixture 'external'
New-Item -ItemType Directory -Path $external -Force | Out-Null
Set-Content -LiteralPath (Join-Path $external 'Test App.exe') -Value 'external untouched' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $external 'ffmpeg.dll') -Value 'external untouched' -Encoding UTF8
$junctionVersion = Join-Path $fixture 'release\9.8.8'
New-Item -ItemType Directory -Path $junctionVersion -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $junctionVersion 'win-unpacked') -Target $external | Out-Null
Set-Content -LiteralPath (Join-Path $fixture 'package.json') -Value '{"version":"9.8.8"}' -Encoding UTF8
$rejected = $false
try { & $repair -RepositoryRoot $fixture } catch { if ($_.Exception.Message -notlike '*Refusing reparse path*') { throw }; $rejected = $true }
if (-not $rejected) { throw 'Junction package was accepted' }
Write-Host 'PASS: traversal and junction package paths rejected before changing permissions'
