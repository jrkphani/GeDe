/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REGION?: string;
  readonly VITE_USER_POOL_ID?: string;
  readonly VITE_USER_POOL_CLIENT_ID?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_APPLE_DOMAIN?: string;
  readonly VITE_STATUS_URL?: string;
}
