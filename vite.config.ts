/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

// PGlite ships its own WASM assets; pre-bundling breaks their resolution.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Manifest only for now (issue 000) — no SW registration until the
      // update-UX from TECH_STACK §6.2 lands with the shell.
      injectRegister: false,
      // PGlite's WASM engine (~9 MB) is loaded on demand, never precached —
      // excluding it keeps `npm run build`'s SW generation under the limit.
      workbox: { globIgnores: ['**/*.wasm'] },
      manifest: {
        name: 'GeDe',
        short_name: 'GeDe',
        description: 'Generative design process tool',
        theme_color: '#FBFAF7',
        background_color: '#FBFAF7',
        display: 'standalone',
        icons: [],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // `amazon-cognito-identity-js` (issue 033) pulls in the `buffer` package,
    // which assumes a Node-style `global` — Vite's browser build target
    // doesn't polyfill this the way webpack's did. Aliasing to `globalThis`
    // is the standard, minimal fix (no full Node polyfill needed elsewhere).
    global: 'globalThis',
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
  },
})
