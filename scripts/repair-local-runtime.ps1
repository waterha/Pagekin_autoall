# Restore ordinary integrity labels on this checkout's two startup images only.
# Do not relabel the workspace, change its DACL, or disable Chromium's sandbox.
[CmdletBinding()]
param([string] $RepositoryRoot)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
$config = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'electron-builder.json5') -Raw -Encoding UTF8
$nameMatch = [regex]::Match($config, '"productName"\s*:\s*("(?:\\.|[^"\\])*")')
if (-not $nameMatch.Success) { throw 'Missing productName' }
$productName = ConvertFrom-Json -InputObject $nameMatch.Groups[1].Value
if ($productName -match '[\\/:]' -or $productName -in @('', '.', '..')) { throw 'Invalid productName' }
$packageRoot = Join-Path $RepositoryRoot "release\$($manifest.version)\win-unpacked"
$images = @((Join-Path $packageRoot "$productName.exe"), (Join-Path $packageRoot 'ffmpeg.dll'))
# Reject junctions/symlinks before touching any image, including ancestor components.
foreach ($image in $images) {
    $item = Get-Item -LiteralPath $image -Force
    if ($item.PSIsContainer) { throw "Expected a runtime file: $image" }
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse path: $($item.FullName)" }
        $item = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
    }
}

if (-not ('Pagekin.RuntimeIntegrity' -as [type])) {
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace Pagekin {
    public static class RuntimeIntegrity {
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
        static extern uint GetNamedSecurityInfo(string name, int kind, uint flags,
            IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
            IntPtr descriptor, uint revision, uint flags, out IntPtr text, out uint length);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        public static string Label(string path) {
            IntPtr descriptor, text = IntPtr.Zero;
            uint result = GetNamedSecurityInfo(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero,
                IntPtr.Zero, IntPtr.Zero, out descriptor);
            if (result != 0) throw new Win32Exception((int)result);
            try {
                uint length;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x10, out text, out length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return Marshal.PtrToStringUni(text);
            } finally { if (text != IntPtr.Zero) LocalFree(text); LocalFree(descriptor); }
        }
    }
}
'@
}

$changes = @()
foreach ($image in $images) {
    $label = [Pagekin.RuntimeIntegrity]::Label($image)
    # Missing labels default to Medium. Preserve ordinary Medium/High labels.
    if ($label -notmatch '\(ML;[^)]*;;;(?:LW|UN|S-1-16-(?:0|4096))\)') { continue }
    $dacl = (Get-Acl -LiteralPath $image).Sddl
    $changes += [pscustomobject]@{ File = $image; PreviousLabel = $label }
    $logDirectory = Join-Path $RepositoryRoot '.runtime'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $changes | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $logDirectory 'runtime-integrity-repair.json') -Encoding UTF8
    & icacls.exe $image /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restore runtime integrity: $image" }
    if ([Pagekin.RuntimeIntegrity]::Label($image) -notmatch '\(ML;[^)]*;;;ME\)' -or (Get-Acl -LiteralPath $image).Sddl -cne $dacl) {
        throw "Runtime integrity verification failed: $image"
    }
    Write-Host "Restored runtime image integrity: $([IO.Path]::GetFileName($image))"
}
Write-Host "Runtime integrity verified; $($changes.Count) image(s) repaired."
