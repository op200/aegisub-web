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
# emsdk/emcmake 的 benign stderr（"Setting environment variables:" 等）在 PS 5.1 +
# $ErrorActionPreference='Stop' 下会被包装成 NativeCommandError，需降级捕获
$ErrorActionPreference = 'Continue'
& "$emsdk\emsdk.bat" activate latest *> $null
if ($LASTEXITCODE -ne 0) { throw "emsdk activate failed ($LASTEXITCODE)" }

# 2. 配置 + 编译
Push-Location $native
# emsdk 6.x 起 emcmake 为 exe（旧版为 bat），两者兼容
$emcmake = Join-Path $emsdk 'upstream\emscripten\emcmake.bat'
if (-not (Test-Path $emcmake)) { $emcmake = Join-Path $emsdk 'upstream\emscripten\emcmake.exe' }
& $emcmake cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release *> $null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake configure failed' }
$ErrorActionPreference = 'Stop'
cmake --build build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake build failed' }
Pop-Location

# 3. 部署到 public/wasm/
$pub = Join-Path $root 'public/wasm'
New-Item -ItemType Directory -Force -Path $pub | Out-Null
Copy-Item (Join-Path $native 'build/aegisub_core_wasm.js') (Join-Path $pub 'aegisub_core.js') -Force
# SINGLE_FILE=1：wasm 内嵌进单个 JS，独立 .wasm 仅在旧配置下存在
$wasmFile = Join-Path $native 'build/aegisub_core_wasm.wasm'
if (Test-Path $wasmFile) {
    Copy-Item $wasmFile (Join-Path $pub 'aegisub_core.wasm') -Force
}
Write-Host 'WASM core deployed to public/wasm/'
