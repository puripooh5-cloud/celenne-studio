# Builds LibRaw (third_party/libraw/LibRaw-<version>) and Celenne's bridge
# (third_party/libraw/celenne_libraw.cpp) to WebAssembly: src/formats/libraw/libraw.mjs + libraw.wasm.
# Needs the Emscripten SDK (default: %USERPROFILE%\emsdk, version below).
#   powershell -ExecutionPolicy Bypass -File scripts/raw/build-libraw.ps1
param([string]$Emsdk = "$env:USERPROFILE\emsdk", [string]$EmsdkVersion = '6.0.11', [string]$LibRaw = '0.22.2')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$src = Join-Path $root "third_party\libraw\LibRaw-$LibRaw"
$build = Join-Path $root 'third_party\libraw\build'
$out = Join-Path $root 'src\formats\libraw'
if (-not (Test-Path $src)) { tar -xzf (Join-Path $root "third_party\libraw\LibRaw-$LibRaw.tar.gz") -C (Join-Path $root 'third_party\libraw') }
& "$Emsdk\emsdk.ps1" activate $EmsdkVersion | Out-Null
. "$Emsdk\emsdk_env.ps1" | Out-Null
New-Item -ItemType Directory -Force $build, $out | Out-Null

# LibRaw's library sources (Makefile.am lib_libraw_a_SOURCES). No threads, no zlib / libjpeg / LCMS:
# deflate and lossy DNGs are decoded by Celenne's own DNG decoder.
$am = Get-Content (Join-Path $src 'Makefile.am') -Raw
$list = [regex]::Match($am, 'lib_libraw_a_SOURCES\s*=([\s\S]*?)\n\n').Groups[1].Value.Replace([string][char]92, ' ')
$sources = $list -split '\s+' | Where-Object { $_ -like 'src/*.cpp' }
$flags = @('-O3', '-fwasm-exceptions', '-DLIBRAW_NOTHREADS', '-DNO_LCMS', '-DNO_JPEG', '-DNO_ZLIB', '-DLIBRAW_NODLL', "-I$src", '-w')
$objs = @()
foreach ($s in $sources) {
  $o = Join-Path $build (($s.Replace('/', '_')) -replace '\.cpp$', '.o')
  if (-not (Test-Path $o) -or (Get-Item (Join-Path $src $s)).LastWriteTime -gt (Get-Item $o).LastWriteTime) {
    & em++ @flags -c (Join-Path $src $s) -o $o
    if ($LASTEXITCODE) { throw "compile failed: $s" }
  }
  $objs += $o
}
$bridge = Join-Path $build 'celenne_libraw.o'
& em++ @flags -c (Join-Path $root 'third_party\libraw\celenne_libraw.cpp') -o $bridge
if ($LASTEXITCODE) { throw 'compile failed: celenne_libraw.cpp' }

# One ES module + .wasm, no file system (files arrive as buffers), memory grows as needed (to 4 GB).
& em++ @flags $objs $bridge -o (Join-Path $out 'libraw.mjs') `
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibRaw "-sENVIRONMENT=web,worker,node" `
  -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB -sSTACK_SIZE=4MB `
  "-sEXPORTED_FUNCTIONS=['_clr_decode','_clr_free','_clr_string','_clr_version','_clr_reference','_malloc','_free']" `
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU16','HEAPF64','UTF8ToString']" `
  "-sINCOMING_MODULE_JS_API=['wasmBinary','locateFile']"
if ($LASTEXITCODE) { throw 'link failed' }
Get-ChildItem $out | Select-Object Name, Length
