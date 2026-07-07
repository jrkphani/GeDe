/// <reference types="vite/client" />

// Opt out of vite/client's permissive `Record<string, any>` ImportMetaEnv
// fallback (issue 032) so custom env reads are real string types, not an
// eslint `no-unsafe-*` escape hatch. ImportMetaEnv is then exactly
// BASE_URL/MODE/DEV/PROD/SSR plus the properties declared below.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  // Cognito identifiers injected at build time (issue 033) — populated from
  // the Auth stack's outputs (deploy/cdk/lib/auth-stack.ts). All optional:
  // an unconfigured build is a supported state (local dev, most tests) — see
  // src/auth/config.ts.
  readonly VITE_COGNITO_USER_POOL_ID?: string
  readonly VITE_COGNITO_CLIENT_ID?: string
  readonly VITE_COGNITO_REGION?: string
  // Electric sync config (issue 032) — see src/sync/config.ts.
  readonly VITE_SYNC_ENABLED?: string
  readonly VITE_SYNC_URL?: string
}
