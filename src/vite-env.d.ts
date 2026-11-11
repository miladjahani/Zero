/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the panel worker API, e.g. https://my-panel.workers.dev/api */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
