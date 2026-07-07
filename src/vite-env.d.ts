/// <reference types="vite/client" />

// Cognito identifiers injected at build time (issue 033) — populated from
// the Auth stack's outputs (deploy/cdk/lib/auth-stack.ts). All optional:
// an unconfigured build is a supported state (local dev, most tests) — see
// src/auth/config.ts.
interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID?: string
  readonly VITE_COGNITO_CLIENT_ID?: string
  readonly VITE_COGNITO_REGION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
