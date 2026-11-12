/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google AdSense H5 Games publisher id, e.g. "ca-pub-1234567890123456". Enables AdSense when set at build time. */
  readonly VITE_ADSENSE_CLIENT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
