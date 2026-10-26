/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_THREAD_HISTORY_WINDOW_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
