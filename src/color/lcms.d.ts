declare module 'lcms-wasm' {
  export interface LcmsModule {
    cmsOpenProfileFromMem(data: Uint8Array, size: number): number;
    cmsCloseProfile(h: number): void;
    cmsCreate_sRGBProfile(): number;
    cmsCreateLab4Profile(whitePoint: number | null): number;
    cmsGetColorSpace(h: number): number;
    cmsCreateTransform(src: number, srcFmt: number, dst: number, dstFmt: number, intent: number, flags: number): number;
    cmsCreateProofingTransform(src: number, srcFmt: number, dst: number, dstFmt: number, proof: number, intent: number, proofIntent: number, flags: number): number;
    cmsDeleteTransform(t: number): void;
    cmsDoTransform(t: number, input: ArrayLike<number>, n: number): Float64Array | Uint8Array | Uint16Array;
    cmsGetProfileInfoASCII(h: number, info: number, lang: string, country: string): string;
  }
  export function instantiate(opts?: { locateFile?: (name: string) => string }): Promise<LcmsModule>;
  export const TYPE_RGB_DBL: number;
  export const TYPE_CMYK_DBL: number;
  export const TYPE_GRAY_DBL: number;
  export const TYPE_Lab_DBL: number;
  export const TYPE_RGB_8: number;
  export const INTENT_PERCEPTUAL: number;
  export const INTENT_RELATIVE_COLORIMETRIC: number;
  export const INTENT_SATURATION: number;
  export const INTENT_ABSOLUTE_COLORIMETRIC: number;
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number;
  export const cmsFLAGS_SOFTPROOFING: number;
  export const cmsFLAGS_HIGHRESPRECALC: number;
  export const cmsInfoDescription: number;
}

declare module 'lcms-wasm/dist/lcms.wasm?url' {
  const url: string;
  export default url;
}
