/**
 * Error page catalogue — copy verbatim from ARCHITECTURE-DIGEST §3.
 * 4xx is amber, 5xx is red; the card's top rule carries that colour.
 */
export const ERROR_STATUSES = [400, 401, 403, 404, 429, 500, 503, 504] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export type ErrorAction =
  | 'go-library'
  | 'paste-link'
  | 'sign-in'
  | 'switch-account'
  | 'request-access'
  | 'open-deleted'
  | 'retry'
  | 'work-offline'
  | 'check-now'
  | 'status-page'
  | 'keep-waiting';

export interface ErrorPage {
  status: ErrorStatus;
  severity: 4 | 5;
  name: string;
  kicker: string;
  title: string;
  body: string;
  cta: { label: string; action: ErrorAction };
  alt: { label: string; action: ErrorAction };
  /** Static meta; dynamic pages override at render time. */
  meta: string;
  /** Reference tag; 500 appends the request id when the server sent one. */
  ref: string;
  /** Where it belongs: full page, banner, or banner-over-skeleton. */
  placement: 'page' | 'banner';
}

export const ERROR_PAGES: Record<ErrorStatus, ErrorPage> = {
  400: {
    status: 400,
    severity: 4,
    name: 'Bad request',
    kicker: 'request',
    title: 'That link is not a workscape',
    body: 'The address is incomplete or has been altered. If you followed it from an email, the link may have been broken across two lines.',
    cta: { label: 'Go to my workscapes', action: 'go-library' },
    alt: { label: 'Paste the link again', action: 'paste-link' },
    meta: 'no request sent',
    ref: 'ref 400·req',
    placement: 'page',
  },
  401: {
    status: 401,
    severity: 4,
    name: 'Unauthenticated',
    kicker: 'session',
    title: 'Your session ended',
    body: 'You were signed out after a period of inactivity, or from another device. Any edits you had made are held on this device and will sync once you are back.',
    cta: { label: 'Sign in', action: 'sign-in' },
    alt: { label: 'Switch account', action: 'switch-account' },
    meta: 'edits held locally',
    ref: 'ref 401·sess',
    placement: 'page',
  },
  403: {
    status: 403,
    severity: 4,
    name: 'No access',
    kicker: 'permission',
    title: 'You do not have access to this workscape',
    body: 'It exists, but you are not on its participant list. The owner can add you; requesting access sends them a single message.',
    cta: { label: 'Request access', action: 'request-access' },
    alt: { label: 'Back to my workscapes', action: 'go-library' },
    meta: 'owner · not shown',
    ref: 'ref 403·wsp',
    placement: 'page',
  },
  404: {
    status: 404,
    severity: 4,
    name: 'Not found',
    kicker: 'address',
    title: 'Nothing at this address',
    body: 'The workscape may have been deleted by its owner. Anything deleted in the last 30 days can still be recovered from Recently Deleted.',
    cta: { label: 'Open Recently Deleted', action: 'open-deleted' },
    alt: { label: 'Go to my workscapes', action: 'go-library' },
    meta: 'nothing to open',
    ref: 'ref 404·nf',
    placement: 'page',
  },
  429: {
    status: 429,
    severity: 4,
    name: 'Too many requests',
    kicker: 'throttled',
    title: 'Slow down for a moment',
    body: 'This document received an unusual number of changes in a short time. Editing resumes automatically in a few seconds; nothing has been lost.',
    cta: { label: 'Retry now', action: 'retry' },
    alt: { label: 'Work offline', action: 'work-offline' },
    meta: 'retrying in 4s',
    ref: 'ref 429·rl',
    placement: 'banner',
  },
  500: {
    status: 500,
    severity: 5,
    name: 'Server error',
    kicker: 'server',
    title: 'Something failed on our side',
    body: 'Your edits are safe on this device and will sync when the service recovers. The failure has been reported automatically with the reference below.',
    cta: { label: 'Retry', action: 'retry' },
    alt: { label: 'Go to my workscapes', action: 'go-library' },
    meta: 'attempt 4 of 4',
    ref: 'ref 500',
    placement: 'page',
  },
  503: {
    status: 503,
    severity: 5,
    name: 'Unavailable',
    kicker: 'maintenance',
    title: 'GeDe is updating',
    body: 'A new version is rolling out. This usually takes under two minutes. This page checks for you and will continue on its own.',
    cta: { label: 'Check now', action: 'check-now' },
    alt: { label: 'Go to status page', action: 'status-page' },
    meta: 'polling · 15s',
    ref: 'ref 503·dep',
    placement: 'page',
  },
  504: {
    status: 504,
    severity: 5,
    name: 'Timeout',
    kicker: 'timeout',
    title: 'This is taking longer than expected',
    body: 'The document is large or the service is busy. The request is still being attempted in the background; you can keep working offline in the meantime.',
    cta: { label: 'Keep waiting', action: 'keep-waiting' },
    alt: { label: 'Work offline', action: 'work-offline' },
    meta: 'elapsed 0s',
    ref: 'ref 504·tmo',
    placement: 'banner',
  },
};

export function isErrorStatus(n: number): n is ErrorStatus {
  return (ERROR_STATUSES as readonly number[]).includes(n);
}

/** Map any HTTP status onto a catalogue page: unknown 4xx → 400, unknown 5xx → 500. */
export function pageForStatus(status: number): ErrorPage {
  if (isErrorStatus(status)) return ERROR_PAGES[status];
  if (status >= 500) return ERROR_PAGES[500];
  return ERROR_PAGES[400];
}

export const POLL_INTERVAL_MS = 15_000;
