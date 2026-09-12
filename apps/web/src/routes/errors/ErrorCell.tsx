import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import { Button, TextField, Wordmark } from '@gede/ui';
import { announce } from '../../announce.js';
import { forgetLastEmail, rememberReturnTo } from '../../auth/session.js';
import { getConfig } from '../../config.js';
import { POLL_INTERVAL_MS, pageForStatus, type ErrorAction, type ErrorPage } from './catalogue.js';

export interface ErrorCellProps {
  status: number;
  /** Server request id, shown in the reference for support. */
  requestId?: string | undefined;
  /** Attempts made before this page (500 meta). */
  attempts?: number | undefined;
  /** Owner name from a 403 body, when the server sends one. */
  owner?: string | undefined;
  /** Re-run the failed request (Retry / Check now / Keep waiting). */
  onRetry?: (() => void) | undefined;
  /** Path the user was trying to reach; 401 remembers it. */
  returnTo?: string | undefined;
  /** Health endpoint polled by the 503 page. Default `{apiUrl}/health`. */
  healthUrl?: string | undefined;
  className?: string | undefined;
}

/** Is the API back? A 2xx from the health endpoint means yes. */
async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

const ULID_PATH = /^\/d\/[0-9A-HJKMNP-TV-Z]{26}(?:[/?#].*)?$/i;

/** Accept a full URL or a path; returns the app path or null when it is not a workscape link. */
export function parseWorkscapeLink(raw: string, origin: string): string | null {
  const text = raw.trim().replace(/\s+/g, '');
  if (text === '') return null;
  let path = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      if (u.origin !== origin) return null;
      path = `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return null;
    }
  }
  return ULID_PATH.test(path) ? path : null;
}

function refFor(page: ErrorPage, requestId: string | undefined): string {
  if (page.status === 500) return `ref 500·${requestId?.slice(0, 6) ?? 'err'}`;
  return page.ref;
}

/**
 * The error is a cell on the grid: column ruler A B C, row ruler 1 2 {code} 4 5,
 * the status code where a row number would be. Title says what happened,
 * body what it means, one button what to do.
 */
export function ErrorCell({
  status,
  requestId,
  attempts,
  owner,
  onRetry,
  returnTo,
  healthUrl,
  className,
}: ErrorCellProps) {
  const page = pageForStatus(status);
  const navigate = useNavigate();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(4);
  const [polling, setPolling] = useState(false);
  const startedAt = useRef(Date.now());

  const config = safeConfig();
  const statusUrl = config?.statusUrl ?? null;
  const health = healthUrl ?? (config ? `${config.apiUrl}/health` : null);

  const checkNow = useCallback(async () => {
    if (health === null) return;
    setPolling(true);
    const ok = await isHealthy(health);
    setPolling(false);
    if (ok) {
      announce('GeDe is back. Reloading.');
      if (onRetry) onRetry();
      else window.location.reload();
    }
  }, [health, onRetry]);

  // 503: poll every 15 s; the button only shortcuts the next poll.
  useEffect(() => {
    if (page.status !== 503) return undefined;
    const id = window.setInterval(() => {
      void checkNow();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [page.status, checkNow]);

  // 429: live countdown then automatic retry. 504: live elapsed timer.
  useEffect(() => {
    if (page.status !== 429 && page.status !== 504) return undefined;
    const id = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(id);
          onRetry?.();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [page.status, onRetry]);

  const ref = refFor(page, requestId);
  const meta = (() => {
    switch (page.status) {
      case 403:
        return owner !== undefined ? `owner · ${owner}` : page.meta;
      case 429:
        return countdown > 0 ? `retrying in ${countdown}s` : 'retrying';
      case 500:
        return `attempt ${attempts ?? 1} of 4`;
      case 504:
        return `elapsed ${elapsed}s`;
      default:
        return page.meta;
    }
  })();

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(ref);
      announce('Reference copied');
    } catch {
      announce(`Reference ${ref}`);
    }
  };

  const act = (action: ErrorAction) => {
    switch (action) {
      case 'go-library':
        void navigate('/');
        return;
      case 'open-deleted':
        void navigate('/?view=deleted');
        return;
      case 'sign-in':
        if (returnTo !== undefined) rememberReturnTo(returnTo);
        void navigate('/sign-in');
        return;
      case 'switch-account':
        forgetLastEmail();
        if (returnTo !== undefined) rememberReturnTo(returnTo);
        void navigate('/sign-in');
        return;
      case 'paste-link':
        setPasteOpen(true);
        return;
      case 'retry':
      case 'keep-waiting':
        if (onRetry) onRetry();
        else window.location.reload();
        return;
      case 'check-now':
        void checkNow();
        return;
      case 'status-page':
        if (statusUrl !== null) window.open(statusUrl, '_blank', 'noopener');
        return;
      case 'work-offline':
        void navigate('/');
        return;
      case 'request-access':
        // No access-request endpoint exists yet (Architecture §3 lists it as an addition).
        return;
    }
  };

  const disabledReason = (action: ErrorAction): string | undefined => {
    if (action === 'request-access') return 'Access requests are not available yet';
    if (action === 'status-page' && statusUrl === null) return 'No status page is configured';
    if (action === 'check-now' && health === null) return 'No API is configured';
    return undefined;
  };

  const submitPaste = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const path = parseWorkscapeLink(pasted, window.location.origin);
    if (path === null) {
      setPasteError('That is not a GeDe workscape link');
      return;
    }
    void navigate(path);
  };

  return (
    <main
      className={clsx('gd-error', `gd-error--sev${page.severity}`, className)}
      aria-labelledby="gd-error-title"
    >
      <div className="gd-error__lattice" aria-hidden="true">
        <div className="gd-error__corner" />
        <div className="gd-error__cols">
          {['A', 'B', 'C'].map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="gd-error__rows">
          {['1', '2', String(page.status), '4', '5'].map((r, i) => (
            <span key={r} className={clsx({ 'gd-error__row--code': i === 2 })}>
              {r}
            </span>
          ))}
        </div>
      </div>
      <article className="gd-error__cell">
        <header className="gd-error__header">
          <Wordmark size={20} />
          <span className="gd-mono gd-error__code">
            {page.status} · {page.name}
          </span>
        </header>
        <span className="gd-error__kicker">{page.kicker}</span>
        <h1 id="gd-error-title" className="gd-error__title">
          {page.title}
        </h1>
        <p className="gd-error__body">{page.body}</p>
        <div className="gd-error__actions">
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              act(page.cta.action);
            }}
            disabled={disabledReason(page.cta.action) !== undefined}
            title={disabledReason(page.cta.action)}
            loading={page.status === 503 && polling}
            loadingLabel="Checking…"
          >
            {page.cta.label}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              act(page.alt.action);
            }}
            disabled={disabledReason(page.alt.action) !== undefined}
            title={disabledReason(page.alt.action)}
          >
            {page.alt.label}
          </Button>
        </div>
        {pasteOpen && (
          <form className="gd-error__paste" onSubmit={submitPaste}>
            <TextField
              label="Workscape link"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteError(undefined);
              }}
              error={pasteError}
              autoFocus
              inputMode="url"
              autoComplete="off"
              placeholder="https://gede.1cloudhub.com/d/…"
            />
            <Button type="submit" variant="primary" disabled={pasted.trim() === ''}>
              Open
            </Button>
          </form>
        )}
        <footer className="gd-error__footer">
          <span className="gd-mono gd-error__meta">{meta}</span>
          <button
            type="button"
            className="gd-mono gd-error__ref"
            onClick={() => void copyRef()}
            title="Copy reference"
          >
            {ref}
          </button>
        </footer>
      </article>
    </main>
  );
}

function safeConfig() {
  try {
    return getConfig();
  } catch {
    return null;
  }
}
