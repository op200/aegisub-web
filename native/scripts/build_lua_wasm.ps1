# 下载并构建 Lua 5.5.1（Automation WASM 后端），产物复制到 public/wasm/lua55.js。
# 用法: powershell -File native/scripts/build_lua_wasm.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$native = Join-Path $root 'native'
$thirdParty = Join-Path $native 'third_party'
$luaVersion = '5.5.1'
$luaDir = Join-Path $thirdParty "lua-$luaVersion"
$tarball = Join-Path $thirdParty "lua-v$luaVersion.tar.gz"
$url = "https://codeload.github.com/lua/lua/tar.gz/refs/tags/v$luaVersion"
# 官方 GitHub tag 归档的 SHA-256（版本变更时必须同步更新）
$sha256 = 'FFED0B0E2987E66B0142491B26C63170FFD2D86E425FF3703799F4933FD91810'

New-Item -ItemType Directory -Force -Path $thirdParty | Out-Null

if (-not (Test-Path (Join-Path $luaDir 'lua.h'))) {
    if (-not (Test-Path $tarball)) {
        Write-Host "downloading Lua $luaVersion ..."
        Invoke-WebRequest -Uri $url -OutFile $tarball
    }
    $actual = (Get-FileHash $tarball -Algorithm SHA256).Hash
    if ($actual -ne $sha256) {
        Remove-Item $tarball -Force
        throw "Lua tarball checksum mismatch: expected $sha256, got $actual"
    }
    # GitHub 归档解压出 lua-5.5.1/，正好是第三个参数指定的目标目录
    tar -xzf $tarball -C $thirdParty
}
if (-not (Test-Path (Join-Path $luaDir 'lua.h'))) {
    throw "Lua source not found at $luaDir"
}

# 加载 Emscripten 环境
$emsdk = $env:EMSDK
if (-not $emsdk -or -not (Test-Path "$emsdk\emsdk.bat")) {
    $emsdk = 'C:\emsdk'
}
if (-not (Test-Path "$emsdk\emsdk.bat")) {
    throw "Emscripten SDK not found at $emsdk. Set EMSDK or install to C:\emsdk."
}
# emsdk/emcmake 的 benign stderr 在 PS 5.1 + Stop 下会被包装成 NativeCommandError
$ErrorActionPreference = 'Continue'
& "$emsdk\emsdk.bat" activate latest *> $null
if ($LASTEXITCODE -ne 0) { throw "emsdk activate failed ($LASTEXITCODE)" }

Push-Location $native
$emcmake = Join-Path $emsdk 'upstream\emscripten\emcmake.bat'
if (-not (Test-Path $emcmake)) { $emcmake = Join-Path $emsdk 'upstream\emscripten\emcmake.exe' }
& $emcmake cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release *> $null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake configure failed' }
$ErrorActionPreference = 'Stop'
cmake --build build --target lua55_wasm
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'cmake build failed' }
Pop-Location

$pub = Join-Path $root 'public/wasm'
New-Item -ItemType Directory -Force -Path $pub | Out-Null
$artifact = Join-Path $native 'build/lua55.js'
if (-not (Test-Path $artifact)) { throw "missing build artifact: $artifact" }
Copy-Item $artifact (Join-Path $pub 'lua55.js') -Force
Write-Host 'Lua 5.5 WASM deployed to public/wasm/lua55.js'
