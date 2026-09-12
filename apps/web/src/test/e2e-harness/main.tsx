/**
 * E2E harness — NOT part of the application bundle.
 *
 * Built only by `e2e/vite.config.ts` (output `e2e/dist/`) and served at
 * `/e2e/harness/?status=<code>`. It mounts the real `ErrorCell` inside a real
 * router with the real runtime config, so Playwright can exercise every
 * catalogue page (400/401/403/404/429/500/503/504) without a backend to throw
 * them. Nothing here is mocked: the 503 page really polls `${apiUrl}/health`;
 * the spec intercepts that request at the network boundary.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@gede/ui/styles.css';
import '../../styles.css';
import { LiveRegion } from '../../announce.js';
import { ConfigError, loadConfig } from '../../config.js';
import { ERROR_STATUSES, isErrorStatus } from '../../routes/errors/catalogue.js';
import { ErrorCell } from '../../routes/errors/ErrorCell.js';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('harness index.html has no #root');
const root = createRoot(rootEl);

const params = new URLSearchParams(window.location.search);
const status = Number(params.get('status'));
const requestId = params.get('requestId') ?? undefined;
const attemptsParam = params.get('attempts');
const attempts = attemptsParam === null ? undefined : Number(attemptsParam);

function Harness() {
  if (!isErrorStatus(status)) {
    return (
      <main>
        <h1>E2E harness</h1>
        <p>Pass one of {ERROR_STATUSES.join(', ')} as ?status=.</p>
      </main>
    );
  }
  return (
    <>
      <LiveRegion />
      <ErrorCell status={status} requestId={requestId} attempts={attempts} />
    </>
  );
}

loadConfig()
  .then(() => {
    const router = createBrowserRouter([{ path: '*', element: <Harness /> }]);
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof ConfigError ? err.message : 'Harness could not start.';
    console.error(err);
    root.render(
      <main className="gd-boot-error">
        <h1>Harness could not start</h1>
        <p>{message}</p>
      </main>,
    );
  });
