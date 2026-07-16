// esbuild loads .css imports with loader:'text' — the default export is the
// stylesheet source as a string (injected into the overlay's shadow root).
declare module '*.css' {
  const css: string;
  export default css;
}
