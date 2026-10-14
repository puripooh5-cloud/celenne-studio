# Benchmark

```bash
npm run benchmark             # 4000 × 3000 documents
npm run benchmark -- --quick  # 2000 × 1500
```

`scripts/benchmark.ts` runs headless in Node and measures the engine paths that dominate interactive performance. Results go to [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md).

| Measurement | Why it matters |
|---|---|
| Display tile render (256², 11 layers + 2 adjustments) | Cost of refreshing the canvas after an edit; must stay well under a frame for small edits |
| Full composite at 25 % (pyramid level 2) | Zoomed-out redraws and navigator/thumbnail updates |
| PSD export / import (8- and 16-bit) | Save / open time, including compression and the flattened composite |
| Gaussian blur (exact kernel and box approximation) | Filter throughput (also representative of layer-effect blurs) |
| Undoable raster edit, undo + redo | Tile snapshot overhead of the history system |
| History memory after 10 edits | Copy-on-write efficiency |
| Brush dab emission | Stroke processing overhead, excluding compositing |
| Liquify dab | Interactive warp responsiveness on a large proxy |

## GPU compositing

When a WebGPU adapter is available (headless Dawn through the `webgpu` dev dependency), the benchmark also times the GPU compositor until the GPU has finished: a display tile with the layers already uploaded, the full view at 25 %, the first render (which compiles the shaders and uploads the layer tiles), and the Gaussian Blur on-canvas preview — each next to the same work on the CPU. Without an adapter these rows are skipped.

## Not measured here

- **Viewport drawing** (texture uploads of CPU tiles, LUT shading) needs a browser. In the app, the frame loop draws cached tiles every frame and spends at most 12 ms (6 ms while painting) per frame rendering new tiles, so interaction stays responsive while tiles refine progressively.
- **Worker overhead** for filters (one structured clone of the working region per filter).

## Reference results

Measured on an Intel Core i9-13950HX (32 threads) with Node 24, 4000 × 3000 documents. See [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) for the latest run.

| Operation | Time |
|---|---|
| Display tile, 11 layers + 2 adjustments | ≈ 12 ms |
| Composite at 25 % | 250–400 ms (8/16-bit) |
| PSD export | ≈ 2.2 s (8-bit), ≈ 5 s (16-bit) |
| PSD import | ≈ 0.2 s (8-bit), ≈ 1.3 s (16-bit) |
| Gaussian blur 2048², σ = 4 / σ = 40 | ≈ 0.26 s each |
| Undo + redo of a 512² edit | < 1 ms |
