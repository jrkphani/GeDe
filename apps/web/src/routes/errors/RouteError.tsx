import { isRouteErrorResponse, useLocation, useRevalidator, useRouteError } from 'react-router';
import { ApiError } from '../../api/client.js';
import { ErrorCell } from './ErrorCell.js';

export interface MappedError {
  status: number;
  requestId: string | undefined;
  attempts: number | undefined;
  owner: string | undefined;
}

/** Thrown `Response`s, API errors and unknown failures all map to a catalogue page. */
export function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    const body = err.body;
    const owner =
      typeof body === 'object' && body !== null && 'owner' in body && typeof body.owner === 'string'
        ? body.owner
        : undefined;
    return { status: err.status, requestId: err.requestId, attempts: err.attempts, owner };
  }
  if (isRouteErrorResponse(err)) {
    return { status: err.status, requestId: undefined, attempts: undefined, owner: undefined };
  }
  if (err instanceof Response) {
    return {
      status: err.status,
      requestId: err.headers.get('x-request-id') ?? undefined,
      attempts: undefined,
      owner: undefined,
    };
  }
  return { status: 500, requestId: undefined, attempts: undefined, owner: undefined };
}

/** Router `errorElement`: full page only because the route could not render at all. */
export function RouteError() {
  const err = useRouteError();
  const location = useLocation();
  const revalidator = useRevalidator();
  const mapped = mapError(err);
  if (mapped.status >= 500 && import.meta.env.DEV) console.error(err);
  return (
    <ErrorCell
      status={mapped.status}
      requestId={mapped.requestId}
      attempts={mapped.attempts}
      owner={mapped.owner}
      returnTo={`${location.pathname}${location.search}${location.hash}`}
      onRetry={() => {
        void revalidator.revalidate();
        window.location.reload();
      }}
    />
  );
}

/** Catch-all route element: unknown addresses are a 404 cell. */
export function NotFound(): never {
  // React Router's convention: a thrown Response becomes a route error response.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw new Response('Not found', { status: 404 });
}
