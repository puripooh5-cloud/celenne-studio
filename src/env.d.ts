/** Build-time constants injected by Vite (vite.config.ts `define`). */
declare const __APP_VERSION__: string;

declare module 'hyphen' {
  const createHyphenator: (patterns: unknown, options?: { hyphenChar?: string; minWordLength?: number; async?: boolean; debug?: boolean; exceptions?: unknown }) => (text: string) => string;
  export default createHyphenator;
}
declare module 'hyphen/patterns/en-us' {
  const patterns: unknown;
  export default patterns;
}
