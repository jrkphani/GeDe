import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router';
import { Skeleton } from '@gede/ui';
import { currentUser, onAuthEvent, signOutLocal, type SessionUser } from './cognito.js';

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
const LAST_DOCUMENT_KEY = 'gede.lastDocument';

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

export interface LastDocument {
  id: string;
  title: string;
}
export function rememberLastDocument(doc: LastDocument): void {
  try {
    localStorage.setItem(LAST_DOCUMENT_KEY, JSON.stringify(doc));
  } catch {
    /* nothing to remember with */
  }
}
export function readLastDocument(): LastDocument | null {
  try {
    const raw = localStorage.getItem(LAST_DOCUMENT_KEY);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'object' && v !== null && 'id' in v && 'title' in v) {
      const { id, title } = v;
      if (typeof id === 'string' && typeof title === 'string') return { id, title };
    }
    return null;
  } catch {
    return null;
  }
}
export function forgetLastDocument(): void {
  try {
    localStorage.removeItem(LAST_DOCUMENT_KEY);
  } catch {
    /* nothing to forget */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const user = await currentUser();
    setState(user ? { status: 'signed-in', user } : { status: 'signed-out' });
    if (user) rememberLastEmail(user.email);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await signOutLocal();
    } finally {
      setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthEvent((event) => {
      if (event === 'signedOut' || event === 'tokenRefresh_failure') {
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
