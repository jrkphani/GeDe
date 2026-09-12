import { Banner, Button } from '@gede/ui';
import { pageForStatus } from './catalogue.js';

export interface ErrorBannerProps {
  status: number;
  /** Live meta, e.g. "retrying in 4s" or "elapsed 31s". */
  meta?: string | undefined;
  onRetry?: (() => void) | undefined;
  onWorkOffline?: (() => void) | undefined;
}

/**
 * The banner placement: the document works, a background operation failed.
 * Same catalogue copy as the page, amber for 4xx and red for 5xx.
 */
export function ErrorBanner({ status, meta, onRetry, onWorkOffline }: ErrorBannerProps) {
  const page = pageForStatus(status);
  return (
    <Banner
      tone={page.severity === 5 ? 'danger' : 'warning'}
      cause={page.title}
      remedy={
        <>
          {page.body}
          {meta !== undefined && <span className="gd-mono gd-error-banner__meta"> {meta}</span>}
        </>
      }
      action={
        <span className="gd-error-banner__actions">
          {onRetry && (
            <Button size="sm" variant="primary" onClick={onRetry}>
              {page.cta.label}
            </Button>
          )}
          {onWorkOffline && page.alt.action === 'work-offline' && (
            <Button size="sm" onClick={onWorkOffline}>
              {page.alt.label}
            </Button>
          )}
        </span>
      }
    />
  );
}
