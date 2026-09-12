import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Skeleton } from '@gede/ui';

import { bindVerifiedEmail, getMe } from '../../../api/me.js';
import { acceptInvite, redeemLink } from '../../../api/shares.js';
import { idToken } from '../../../auth/cognito.js';

/** The query keys a shared link carries: `k` from Copy link, `invite` from the invitation mail. */
export const LINK_KEY_PARAM = 'k';
export const INVITE_TOKEN_PARAM = 'invite';

/**
 * SHARE-02: an invitation converts only for the account that holds its
 * address, and the service learns the address from the ID token alone
 * (`PATCH /api/me { idToken }`). `SessionProvider` presents it after sign-in,
 * but in the background, after this route has rendered — so a new account
 * arriving from the mail would present the invitation first and be told to
 * finish signing in, then land on 403 while the binding converts it moments
 * later. The address is therefore bound here first whenever the profile has
 * none. The binding itself converts every pending invitation for the
 * address; the accept that follows is then answered 409 (already used) and
 * dropped like any refusal, and the shell opens as for any participant.
 * Nothing here is a bearer for anything else; the service does the deciding.
 */
async function ensureEmailBound(): Promise<void> {
  const me = await getMe();
  if (me.email !== null) return;
  const token = await idToken();
  if (token !== null) await bindVerifiedEmail(token);
}

/**
 * Wraps the document route (one line in `routes.tsx`). A signed-in visitor
 * arriving with `?k=<token>` (SHARE-01, "anyone with the link") or
 * `?invite=<token>` (SHARE-02, the invitation mail) presents it to the
 * service first, which turns it into a share; then the shell opens as for
 * any participant and the token leaves the address bar. A token the service
 * refuses is dropped the same way and the shell answers as it would without
 * one (403 for a stranger), so a stale link never loops.
 */
export function LinkRedeem({ children }: { children: ReactNode }) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const key = params.get(LINK_KEY_PARAM);
  const invite = params.get(INVITE_TOKEN_PARAM);
  const pending = key !== null || invite !== null;
  const [settled, setSettled] = useState(!pending);

  useEffect(() => {
    if (!pending) return undefined;
    let cancelled = false;
    const present =
      key !== null
        ? redeemLink(id, key)
        : ensureEmailBound()
            .catch(() => {
              /* unbound for now: the accept below says so, and the session binds it later */
            })
            .then(() => acceptInvite(id, invite ?? ''));
    present
      .catch(() => {
        /* refused or unreachable: the shell decides what the visitor sees */
      })
      .finally(() => {
        if (cancelled) return;
        setParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete(LINK_KEY_PARAM);
            next.delete(INVITE_TOKEN_PARAM);
            return next;
          },
          { replace: true },
        );
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
    // The params object changes identity on every render; the tokens are what matter.
  }, [id, key, invite, pending, setParams]);

  if (!settled) {
    return (
      <Skeleton active rows={3} statusLabel="Opening shared workscape">
        {null}
      </Skeleton>
    );
  }
  return children;
}
