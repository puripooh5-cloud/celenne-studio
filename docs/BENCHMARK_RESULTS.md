# Benchmark results

Generated 2026-10-01T10:31:35.755Z by `npm run benchmark`.

Machine: 13th Gen Intel(R) Core(TM) i9-13950HX, 32 threads, 32 GB RAM, Node v24.16.0. Document size 4000×3000. GPU: nvidia lovelace D3D12 driver version 32.0.16.1088.

| Operation | Time | Notes |
|---|---|---|
| Build 8-bit document (11 layers) | 417.8 ms | 4000×3000 |
| Display tiles, level 0 (8-bit) | 24.3 ms | 256×256 tile, 11 layers + 2 adjustments |
| Full composite at 25% (level 2, 8-bit) | 252.5 ms | 1000×750 |
| PSD export (8-bit) | 2009.8 ms | layers + composite, 2.9 MB |
| PSD import (8-bit) | 173.8 ms | full decode |
| Build 16-bit document (11 layers) | 540.7 ms | 4000×3000 |
| Display tiles, level 0 (16-bit) | 30.3 ms | 256×256 tile, 11 layers + 2 adjustments |
| Full composite at 25% (level 2, 16-bit) | 333.4 ms | 1000×750 |
| PSD export (16-bit) | 5318.5 ms | layers + composite, 69.6 MB |
| PSD import (16-bit) | 1321.3 ms | full decode |
| Gaussian blur σ=2 (2048², RGBA float) | 539.3 ms | separable exact kernel |
| Gaussian blur σ=4 (2048², RGBA float) | 247.1 ms | 3-pass box approximation |
| Gaussian blur σ=40 (2048², RGBA float) | 376.6 ms | 3-pass box approximation |
| Undoable raster edit (512² region) | 4.3 ms | tile snapshot + write |
| Undo + redo of that edit | 0.1 ms | restores shared tiles |
| History memory (10 edits) | 20.0 MB | copy-on-write tiles |
| Brush dab emission (10,000 px stroke) | 2.2 ms | spacing 10%, smoothing on, 4767 dabs |
| Liquify forward-warp dab (brush 200 px) | 2.2 ms | proxy 1400×1000 |
| GPU display tile, level 0, first render (8-bit) | 2639.8 ms | one-time: compiles the GPU shaders, uploads the layer tiles |
| GPU display tile, level 0 (8-bit) | 0.7 ms | layers already on the GPU (e.g. after an opacity or adjustment change) |
| GPU full view at 25% (level 2, 8-bit) | 4.1 ms | 1000×750, all tiles |
| CPU full view at 25% (level 2, 8-bit) | 104.2 ms | same tiles on the CPU, for comparison |
| GPU display tile, level 0, first render (16-bit) | 74.9 ms | uploads the layer tiles |
| GPU display tile, level 0 (16-bit) | 0.4 ms | layers already on the GPU (e.g. after an opacity or adjustment change) |
| GPU full view at 25% (level 2, 16-bit) | 2.9 ms | 1000×750, all tiles |
| CPU full view at 25% (level 2, 16-bit) | 107.2 ms | same tiles on the CPU, for comparison |
| GPU Gaussian blur preview σ=2 (2048²) | 19.6 ms | on-canvas preview, 64 display tiles |
| GPU Gaussian blur preview σ=4 (2048²) | 29.3 ms | on-canvas preview, 64 display tiles |
| GPU Gaussian blur preview σ=40 (2048²) | 46.6 ms | on-canvas preview, 64 display tiles |
| CPU Gaussian blur preview σ=2 (2048²) | 972.4 ms | the same preview on the CPU, for comparison |
| CPU Gaussian blur preview σ=40 (2048²) | 1724.9 ms | the same preview on the CPU, for comparison |
