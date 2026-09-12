import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@gede/ui/styles.css';
import './styles.css';
import { configureAuth } from './auth/cognito.js';
import { ConfigError, loadConfig } from './config.js';
import { routes } from './routes.js';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('index.html has no #root');
const root = createRoot(rootEl);

loadConfig()
  .then((config) => {
    configureAuth(config);
    root.render(
      <StrictMode>
        <RouterProvider router={createBrowserRouter(routes)} />
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    // No config, no app. Say so plainly rather than rendering a broken sign-in.
    const message = err instanceof ConfigError ? err.message : 'GeDe could not start.';
    console.error(err);
    root.render(
      <main className="gd-boot-error">
        <h1>GeDe could not start</h1>
        <p>{message}</p>
      </main>,
    );
  });
