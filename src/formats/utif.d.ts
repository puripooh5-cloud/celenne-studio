declare module 'utif2' {
  export interface IFD {
    width: number;
    height: number;
    data: Uint8Array;
    [tag: string]: unknown;
  }
  export function decode(buff: ArrayBuffer | Uint8Array, prm?: unknown): IFD[];
  export function decodeImage(buff: ArrayBuffer | Uint8Array, img: IFD, ifds?: IFD[]): void;
  export function toRGBA8(img: IFD): Uint8Array;
  export function encodeImage(rgba: ArrayBuffer | Uint8Array, w: number, h: number, metadata?: Record<string, unknown>): ArrayBuffer;
  const UTIF: {
    decode: typeof decode;
    decodeImage: typeof decodeImage;
    toRGBA8: typeof toRGBA8;
    encodeImage: typeof encodeImage;
  };
  export default UTIF;
}
