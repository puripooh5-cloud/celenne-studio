// Emscripten module factory for LibRaw (built by scripts/raw/build-libraw.ps1).
declare const createLibRaw: (options?: { locateFile?: (name: string) => string; wasmBinary?: ArrayBufferView | ArrayBuffer }) => Promise<unknown>;
export default createLibRaw;
