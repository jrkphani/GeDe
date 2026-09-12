import { Outlet, type RouteObject } from 'react-router';
import { ToastProvider, TooltipProvider } from '@gede/ui';
import { LiveRegion } from './announce.js';
import { RequireAuth, SessionProvider } from './auth/session.js';
import { useLocale } from './locale.js';
import { DocumentShell } from './routes/document/DocumentShell.js';
import { NotFound, RouteError } from './routes/errors/RouteError.js';
import { Library } from './routes/library/Library.js';
import { SignIn } from './routes/sign-in/SignIn.js';
import { SignedOut } from './routes/signed-out/SignedOut.js';

/** App shell: session, live region (A11Y-05), locale on the root, providers. */
export function AppShell() {
  useLocale();
  return (
    <SessionProvider>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <LiveRegion />
          <Outlet />
        </ToastProvider>
      </TooltipProvider>
    </SessionProvider>
  );
}

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { path: '/sign-in', element: <SignIn /> },
      { path: '/signed-out', element: <SignedOut /> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <Library />
          </RequireAuth>
        ),
      },
      {
        path: '/d/:id',
        element: (
          <RequireAuth>
            <DocumentShell />
          </RequireAuth>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];
