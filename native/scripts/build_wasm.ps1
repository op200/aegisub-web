# 构建 Aegisub WASM 核心并部署到 public/wasm/。
# 用法: powershell -File native/scripts/build_wasm.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$native = Join-Path $root 'native'

# 1. 加载 Emscripten 环境
$emsdk = $env:EMSDK
if (-not $emsdk -or -not (Test-Path "$emsdk\emsdk.bat")) {
    $emsdk = 'C:\emsdk'
}
if (-not (Test-Path "$emsdk\emsdk.bat")) {
    throw "Emscripten SDK not found at $emsdk. Set EMSDK or install to C:\emsdk."
}
& "$emsdk\emsdk.bat" activate latest *> $null

# 2. 配置 + 编译
Push-Location $native
& "$emsdk\upstream\emscripten\emcmake.bat" cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release *> $null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake configure failed' }
cmake --build build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake build failed' }
Pop-Location

# 3. 部署到 public/wasm/
$pub = Join-Path $root 'public/wasm'
New-Item -ItemType Directory -Force -Path $pub | Out-Null
Copy-Item (Join-Path $native 'build/aegisub_core_wasm.js') (Join-Path $pub 'aegisub_core.js') -Force
Copy-Item (Join-Path $native 'build/aegisub_core_wasm.wasm') (Join-Path $pub 'aegisub_core.wasm') -Force
Write-Host 'WASM core deployed to public/wasm/'
