/**
 * Custom metrics without an agent: CloudWatch's embedded metric format (EMF).
 * A log line that carries an `_aws` envelope is turned into a metric by
 * CloudWatch Logs on ingestion — the `awslogs` driver the task uses forwards
 * stdout as-is — so a pino line here becomes a datapoint in `GeDe/Sync`
 * with no metric filter to keep in step (#99). Every refusal the WebSocket
 * layer makes is one of these, dimensioned by reason, so an attack or a
 * misbehaving client shows up on the dashboard and can be alarmed on.
 *
 * The line is still an ordinary log line: `msg`, the request context and the
 * pino base fields are all there. Metric values and dimension values sit at
 * the top level, as EMF requires.
 */
import type { Logger } from './logger.js';

export const METRIC_NAMESPACE = 'GeDe/Sync';

/** One count in `GeDe/Sync`, dimensioned by `Reason`. */
export type MetricName =
  /** A WebSocket frame, update or join the service refused; `Reason` says why. */
  | 'WsRefusals'
  /** A connection closed because its permission changed or ended between checks (#104). */
  | 'WsRevocations'
  /** An account erasure that could not delete the Cognito identity (#111). */
  | 'UserErasureIdentityFailures'
  /** A share mail SES refused; the row it announced stands (#121). `Reason` is the template. */
  | 'InviteMailFailures';

export type RefusalReason =
  | 'message_too_big'
  | 'document_too_large'
  | 'slow_consumer'
  | 'too_many_rooms'
  | 'too_many_sockets'
  | 'too_many_sockets_for_user'
  | 'malformed'
  | 'rate_limited'
  | 'bytes_rate_limited'
  | 'revoked'
  | 'permission_changed'
  | 'permission_ended'
  | 'token_expired'
  | 'document_gone'
  | 'identity_delete_failed'
  | 'share.invite'
  | 'share.member';

export interface EmfEnvelope {
  Timestamp: number;
  CloudWatchMetrics: {
    Namespace: string;
    Dimensions: string[][];
    Metrics: { Name: string; Unit: 'Count' }[];
  }[];
}

/** The fields an EMF count line carries beside the ordinary log context. */
export interface CountLine {
  _aws: EmfEnvelope;
  Reason: RefusalReason;
  [metric: string]: unknown;
}

export function countLine(name: MetricName, reason: RefusalReason, at = Date.now()): CountLine {
  return {
    _aws: {
      Timestamp: at,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Reason']],
          Metrics: [{ Name: name, Unit: 'Count' }],
        },
      ],
    },
    Reason: reason,
    [name]: 1,
  };
}

/**
 * Log one count. `context` is the usual structured context (document id,
 * user id, sizes); it must never carry a token or an update payload.
 */
export function count(
  logger: Pick<Logger, 'info'>,
  name: MetricName,
  reason: RefusalReason,
  context: Record<string, unknown>,
  msg: string,
): void {
  logger.info({ ...context, ...countLine(name, reason) }, msg);
}
