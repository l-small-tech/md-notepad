/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json's version. */
declare const __APP_VERSION__: string;

/** vite `?inline` asset imports (the seeded theme background images):
 *  the file's contents as a `data:` URL. `vite/client` only types the
 *  bare extension, not the suffixed form. */
declare module '*.webp?inline' {
  const dataUrl: string;
  export default dataUrl;
}
