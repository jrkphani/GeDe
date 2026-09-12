import { Outlet, type RouteObject } from 'react-router';
import { ToastProvider, TooltipProvider } from '@gede/ui';
import { LiveRegion } from './announce.js';
import { RequireAuth, SessionProvider } from './auth/session.js';
import { useLocale } from './locale.js';
import { DocumentShell } from './routes/document/DocumentShell.js';
import { LinkRedeem } from './routes/document/share/LinkRedeem.js';
import { NotFound, RouteError } from './routes/errors/RouteError.js';
import { Library } from './routes/library/Library.js';
import { SignIn } from './routes/sign-in/SignIn.js';
import { SignedOut } from './routes/signed-out/SignedOut.js';
import { TourController } from './routes/tour/TourController.js';

/**
 * App shell: session, live region (A11Y-05), locale on the root, providers,
 * and the guided tour, which spans the library and the document (ONB-05).
 */
export function AppShell() {
  useLocale();
  return (
    <SessionProvider>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <LiveRegion />
          <Outlet />
          <TourController />
        </ToastProvider>
      </TooltipProvider>
    </SessionProvider>
  );
}

/**
 * The shell itself could not render (providers, locale): nothing above it
 * carries a live region, so this last-resort boundary brings its own.
 */
function ShellError() {
  return (
    <>
      <LiveRegion />
      <RouteError />
    </>
  );
}

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    errorElement: <ShellError />,
    children: [
      {
        // A11Y-05: the catalogue pages are the shell's `Outlet`, not a replacement for it,
        // so "Reference copied" reaches the same live region as every other announcement.
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
                <LinkRedeem>
                  <DocumentShell />
                </LinkRedeem>
              </RequireAuth>
            ),
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
