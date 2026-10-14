export declare class JpegImage {
  opts: { colorTransform?: boolean; tolerantDecoding?: boolean; maxResolutionInMP?: number; maxMemoryUsageInMB?: number };
  width: number;
  height: number;
  components: unknown[];
  adobe: { transformCode: number } | null;
  parse(data: Uint8Array): void;
  getData(width: number, height: number): Uint8Array;
  static resetMaxMemoryUsage(bytes: number): void;
}
