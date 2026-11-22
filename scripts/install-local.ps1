# 书童：打包 + 安装到固定目录，装完就能用快捷方式启动最新版。
# 用法（在 D:\Idea\Pagekin_autoall 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
#
# 为什么要装到独立目录：Electron 从构建目录（含 node_modules 的仓库）里直接启动时，
# 会在宿主的 node_modules 里解析依赖并立刻退出。装到 D:\Pagekin\app 后不受仓库影响。

[CmdletBinding()]
param(
    [string] $RepositoryRoot = 'D:\Idea\Pagekin_autoall',
    [string] $InstallDir = 'D:\Pagekin\app',
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not (Test-Path -LiteralPath $RepositoryRoot)) {
    throw "Repository not found: $RepositoryRoot"
}

$packageRoot = Join-Path $RepositoryRoot 'release\1.4.0\win-unpacked'

# 1) 构建（除非明确跳过）
if (-not $SkipBuild) {
    Write-Step 'Typecheck, build renderer/main, and package'
    Push-Location $RepositoryRoot
    try {
        # electron-builder 在这里没有网络时无法下载 Electron；优先用仓库里已装好的运行时。
        $localElectron = 'node_modules\.pnpm\electron@44.9.3\node_modules\electron\dist'
        $builderArgs = @('exec', 'electron-builder', '--win', 'dir', '--x64')
        if (Test-Path -LiteralPath (Join-Path $RepositoryRoot $localElectron)) {
            $builderArgs += "--config.electronDist=$localElectron"
        }

        & pnpm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
        & pnpm exec vite build
        if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
        & pnpm @builderArgs
        if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $packageRoot '书童.exe'))) {
    throw "Packaged app not found: $packageRoot"
}

# 2) 装到固定目录：先装到临时目录再整体替换，避免半新半旧
Write-Step "Install to $InstallDir"
$staging = "$InstallDir.staging"
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item -Path (Join-Path $packageRoot '*') -Destination $staging -Recurse -Force

if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
Move-Item -LiteralPath $staging -Destination $InstallDir

$exe = Join-Path $InstallDir '书童.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Install failed: $exe" }

# 3) 校验产物：原生模块与安全助手都要在
Push-Location $RepositoryRoot
try {
    & node scripts/verify-win-package.mjs $InstallDir
    if ($LASTEXITCODE -ne 0) { throw 'package verification failed' }
} finally {
    Pop-Location
}

Write-Step 'Done'
Write-Host "Installed: $exe"
Write-Host "已装好，双击「启动书童」即可。"
