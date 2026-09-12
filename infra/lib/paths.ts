import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo root (parent of `infra/`). Used as the Docker build context and for `apps/web/dist`. */
export const REPO_ROOT = path.resolve(here, '../..');

/** `infra/` itself. */
export const INFRA_ROOT = path.resolve(here, '..');

/** Stand-in assets used only when a sibling workspace has not been built at synth time. */
export const PLACEHOLDER_WEB_DIR = path.join(INFRA_ROOT, 'assets', 'placeholder', 'web');
export const PLACEHOLDER_SYNC_DIR = path.join(INFRA_ROOT, 'assets', 'placeholder', 'sync');

/** Lambda source of the custom resource that creates the live suite's Cognito user (`AuthStack`). */
export const E2E_USER_HANDLER_DIR = path.join(INFRA_ROOT, 'assets', 'e2e-user');
/** Lambda source of the pool's pre-authentication trigger (binds the e2e user to the gede-e2e client). */
export const PRE_AUTH_HANDLER_DIR = path.join(INFRA_ROOT, 'assets', 'pre-auth');
/** Entry of the pool's custom-message trigger (branded, localised codes); bundled with @gede/mail by esbuild at synth. */
export const CUSTOM_MESSAGE_HANDLER_ENTRY = path.join(
  INFRA_ROOT,
  'assets',
  'custom-message',
  'index.mjs',
);
/** `@gede/mail` source, aliased into the custom-message bundle so synth never reads a stale dist. */
export const MAIL_PACKAGE_ENTRY = path.join(REPO_ROOT, 'packages', 'mail', 'src', 'index.ts');
/** The root lockfile: `NodejsFunction` derives the project root and package manager from it. */
export const ROOT_LOCKFILE = path.join(REPO_ROOT, 'package-lock.json');

export const SYNC_DOCKERFILE = 'services/sync/Dockerfile';
export const WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');

export function repoFileExists(relative: string): boolean {
  return existsSync(path.join(REPO_ROOT, relative));
}

export function dirExists(absolute: string): boolean {
  return existsSync(absolute);
}
