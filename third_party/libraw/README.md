# LibRaw in Celenne Studio

Celenne Studio uses **LibRaw 0.22.2** (https://www.libraw.org, https://github.com/LibRaw/LibRaw) to
unpack the sensor data of proprietary camera raw files (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW
and others). LibRaw is copyright LibRaw LLC. Celenne Studio uses it under the **GNU Lesser General
Public License, version 2.1** (`LICENSE.LGPL`); LibRaw is also available under the CDDL 1.0
(`LICENSE.CDDL`). See `COPYRIGHT`.

## What is here

| File | What it is |
|---|---|
| `LibRaw-0.22.2.tar.gz` | The unmodified LibRaw source used, as published by LibRaw |
| `celenne_libraw.cpp` | Celenne's small bridge to LibRaw's C API |
| `build-libraw.ps1` | The build script; in the source tree it is `scripts/raw/build-libraw.ps1` |
| `LICENSE.LGPL`, `LICENSE.CDDL`, `COPYRIGHT` | LibRaw's licence texts |

## Building it

LibRaw and the bridge are compiled to WebAssembly with the Emscripten SDK (version 6.0.11). The
script builds without threads, zlib, libjpeg or LittleCMS:

    powershell -ExecutionPolicy Bypass -File scripts/raw/build-libraw.ps1

The result is `src/formats/libraw/libraw.mjs` and `libraw.wasm`.

## Replacing LibRaw in an installed copy

LibRaw is a separate module. In an installed copy it is the file
`resources/app.asar.unpacked/dist/assets/libraw-<hash>.wasm`. To use a modified or newer LibRaw:
1. Build it with the script above, keeping the bridge's exported functions.
2. Replace that file with your `libraw.wasm`, keeping the file name.
