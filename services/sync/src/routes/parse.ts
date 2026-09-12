/**
 * Request parsing shared by the `/api` route files: zod schemas become the
 * 400 of the error contract, with the issues as `details`.
 */
import { z } from 'zod';

import { AppError } from '../errors.js';

export const documentId = z.string().uuid();

/**
 * A one-line human label. Control characters are refused up front: Postgres
 * `text` cannot hold NUL (the insert fails and would surface as a 500), and a
 * title or name has no use for the rest of `\p{Cc}` either.
 */
export const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^\P{Cc}*$/u, 'Control characters are not allowed');

/**
 * An address as an invitation accepts it (SHARE-02): one line, at most 254
 * characters, one `@` with something either side, no whitespace. Stored as
 * `citext`, so case is the recipient's; the check here is shape only —
 * deliverability is SES's answer.
 */
export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, 'That is not an email address');

export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  what: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'bad_request',
      `That ${what} is not valid`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function parseId(params: unknown): string {
  const result = z.object({ id: documentId }).safeParse(params);
  if (!result.success) throw new AppError(400, 'bad_request', 'That link is not a workscape');
  return result.data.id;
}

export const NOT_FOUND = () => new AppError(404, 'not_found', 'Nothing at this address');
