# ADR-0006: Installable PWA over Tauri desktop app

- **Status**: Accepted
- **Date**: 2026-07-04

## Context

v1 needs local persistence and zero server cost; v2 adds web-native sync and sharing. Packaging options: Tauri desktop app (SQLite, native shell) vs installable PWA (browser storage, static hosting).

## Decision

**Installable PWA**, statically hosted on S3 + CloudFront (~$0–1/month). PGlite persists to OPFS/IndexedDB. vite-plugin-pwa provides the service worker and manifest.

## Consequences

- Zero-install sharing later; v2 sync is web-native anyway; hosting is the cheapest possible AWS footprint.
- Storage lives in the browser profile — mitigated by explicit JSON export/import as the backup format (SPEC §4.7).
- Tauri remains possible later since the entire app is a web build. Revisit if a hard native requirement appears.
