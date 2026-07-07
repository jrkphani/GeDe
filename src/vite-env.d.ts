/// <reference types="vite/client" />

// Custom env vars (issue 032): typed here rather than left as `any` off
// Vite's default permissive `ImportMetaEnv` fallback, so src/sync/config.ts's
// reads are real string types, not an eslint `no-unsafe-*` escape hatch.
// `strictImportMetaEnv` opts out of vite/client's `Record<string, any>`
// fallback (see node_modules/vite/types/importMeta.d.ts) so ImportMetaEnv is
// exactly BASE_URL/MODE/DEV/PROD/SSR plus the properties declared below.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_SYNC_ENABLED?: string
  readonly VITE_SYNC_URL?: string
}
