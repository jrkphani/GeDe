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

export const SYNC_DOCKERFILE = 'services/sync/Dockerfile';
export const WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');

export function repoFileExists(relative: string): boolean {
  return existsSync(path.join(REPO_ROOT, relative));
}

export function dirExists(absolute: string): boolean {
  return existsSync(absolute);
}
