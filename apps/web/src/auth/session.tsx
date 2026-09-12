import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router';
import { Skeleton } from '@gede/ui';
import { bindVerifiedEmail, getMe } from '../api/me.js';
import { bindUserLocale, unbindUserLocale } from '../locale.js';
import { currentUser, idToken, onAuthEvent, signOutLocal, type SessionUser } from './cognito.js';

export type SessionState =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; user: SessionUser };

export interface Session {
  state: SessionState;
  /** Re-read the Cognito session (after a sign-in completes). */
  refresh: () => Promise<void>;
  /** AUTH-09: local sign-out; clears memory and revokes the refresh token. */
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

const RETURN_TO_KEY = 'gede.returnTo';
const LAST_EMAIL_KEY = 'gede.lastEmail';

export function rememberReturnTo(path: string): void {
  try {
    sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    /* no session storage: the user lands in the library instead */
  }
}

export function takeReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    return v !== null && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}

export function rememberLastEmail(email: string): void {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch {
    /* nothing to remember with */
  }
}
export function readLastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}
export function forgetLastEmail(): void {
  try {
    localStorage.removeItem(LAST_EMAIL_KEY);
  } catch {
    /* nothing to forget */
  }
}

/**
 * @deprecated Import from `../last-document.js`. Kept so the document shell
 * on `main` keeps compiling until it moves to the new module.
 */
export { rememberLastDocument, type LastDocument } from '../last-document.js';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  // Which sign-in the in-flight profile fetch belongs to; a later sign-out or
  // a different user makes an older answer irrelevant.
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    const user = await currentUser();
    const mine = ++epoch.current;
    if (!user) {
      unbindUserLocale();
      setState({ status: 'signed-out' });
      return;
    }
    rememberLastEmail(user.email);
    // I18N-05: the user's own locale, first from this device, then from the server.
    bindUserLocale(user.sub);
    setState({ status: 'signed-in', user });
    getMe()
      .then(async (me) => {
        if (epoch.current !== mine) return;
        bindUserLocale(user.sub, me.locale);
        // SHARE-02: the service knows this account by `sub` only until the ID
        // token binds its verified address; that binding is what converts a
        // pending invitation into a share on first sign-in.
        if (me.email === null) {
          const token = await idToken();
          if (token !== null && epoch.current === mine) await bindVerifiedEmail(token);
        }
      })
      .catch(() => {
        /* the profile is a nicety; the local choice already applies */
      });
  }, []);

  const signOut = useCallback(async () => {
    epoch.current += 1;
    try {
      await signOutLocal();
    } finally {
      unbindUserLocale();
      setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthEvent((event) => {
      if (event === 'signedOut' || event === 'tokenRefresh_failure') {
        epoch.current += 1;
        unbindUserLocale();
        setState({ status: 'signed-out' });
      } else if (event === 'signedIn' || event === 'signInWithRedirect') {
        void refresh();
      }
    });
  }, [refresh]);

  const value = useMemo<Session>(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession() needs a <SessionProvider>');
  return ctx;
}

/** AUTH-01: unauthenticated visits remember where they were headed. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === 'loading') {
    return (
      <div className="gd-app__loading" aria-label="Checking your session">
        <Skeleton active rows={4} statusLabel="Checking your session" />
      </div>
    );
  }
  if (state.status === 'signed-out') {
    rememberReturnTo(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to="/sign-in" replace />;
  }
  return <>{children}</>;
}
