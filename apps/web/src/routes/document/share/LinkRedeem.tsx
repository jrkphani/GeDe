import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Skeleton } from '@gede/ui';

import { acceptInvite, redeemLink } from '../../../api/shares.js';

/** The query keys a shared link carries: `k` from Copy link, `invite` from the invitation mail. */
export const LINK_KEY_PARAM = 'k';
export const INVITE_TOKEN_PARAM = 'invite';

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
    const present = key !== null ? redeemLink(id, key) : acceptInvite(id, invite ?? '');
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
