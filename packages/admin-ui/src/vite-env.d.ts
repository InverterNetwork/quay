/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUAY_API_BASE_URL?: string;
}

interface Window {
  __QUAY_API_BASE_URL__?: string;
}
