/**
 * SES bounce and complaint handling (SHARE-02, ADR-046). What the owner told
 * AWS on the production-access case: bounces and complaints go to an SNS
 * topic; a hard bounce or complaint withdraws the invitation and blocks
 * further mail to that address. This is that, on the service's side:
 *
 *   SES configuration set `gede-<env>` → SNS `gede-<env>-ses-events` → SQS
 *   `gede-<env>-ses-events` (raw delivery) → this poller, on the service task.
 *
 * The poller long-polls the queue (`SES_EVENTS_QUEUE_URL`; unset locally, so
 * no poller runs) and, per event and recipient:
 *
 *   - records the event in `mail_events` — the (message id, address) primary
 *     key makes a redelivered message a no-op, and the count of transient
 *     bounces comes back either way so a redelivery reaches the same verdict;
 *   - decides: a `Permanent` bounce or a complaint suppresses at once; a
 *     `Transient` (or `Undetermined`) bounce suppresses on the third within
 *     `TRANSIENT_BOUNCE_WINDOW_DAYS`; a reject is recorded and counted only —
 *     SES rejects a message for its content (a virus), which says nothing
 *     about the address;
 *   - suppressing writes `mail_suppressions` and withdraws every pending
 *     invitation to the address with a `share.invite_withdraw` row
 *     (`repo.mail.suppress`), after which the invite and resend routes answer
 *     409 `address_suppressed`.
 *
 * Every event is one `GeDe/Sync MailEvents` datapoint by `Reason` (EMF,
 * `metrics.ts`), counted once: not again on a redelivery. Log lines carry the
 * SES message id and the verdict, never the address.
 *
 * A message is deleted from the queue once its events are recorded and its
 * verdicts applied. One the poller cannot read is counted `unrecognised`,
 * logged and deleted — a log line and a datapoint are its whole value, and
 * five redeliveries into the dead-letter queue would add nothing. A message
 * whose processing fails (the database is away) is left alone: SQS redelivers
 * it after the visibility timeout, and after `maxReceiveCount` attempts it
 * lands on the dead-letter queue, whose depth is alarmed (OpsStack).
 */
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { MailEventKind, MailSuppressionReason } from '@gede/db';

import type { Logger } from '../logger.js';
import { count, type MailEventReason } from '../metrics.js';
import type { MailRepo } from '../repo/types.js';

/** Transient bounces within the window before an address is suppressed. */
export const TRANSIENT_BOUNCE_THRESHOLD = 3;
/** The window those bounces are counted in. */
export const TRANSIENT_BOUNCE_WINDOW_DAYS = 30;
/** Wait after a failed `ReceiveMessage` before the next; SQS itself long-polls the successful ones. */
export const RECEIVE_BACKOFF_MS = 5_000;
/** Messages per `ReceiveMessage`; SQS allows at most 10. */
const RECEIVE_BATCH = 10;

/** One message as the queue hands it over; `receipt` is what deletes it. */
export interface QueuedMessage {
  readonly id: string;
  readonly receipt: string;
  readonly body: string;
}

/** The queue, so tests inject a fake: SQS in production (`createSqsEventQueue`). */
export interface MailEventQueue {
  /** Long-poll for a batch; resolves `[]` on a quiet queue. Rejects with `AbortError` when `signal` fires. */
  receive(signal: AbortSignal): Promise<QueuedMessage[]>;
  delete(receipt: string): Promise<void>;
}

export function createSqsEventQueue(
  client: SQSClient,
  queueUrl: string,
  waitSeconds: number,
): MailEventQueue {
  return {
    async receive(signal) {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: RECEIVE_BATCH,
          WaitTimeSeconds: waitSeconds,
        }),
        { abortSignal: signal },
      );
      const messages: QueuedMessage[] = [];
      for (const m of result.Messages ?? []) {
        if (m.MessageId === undefined || m.ReceiptHandle === undefined || m.Body === undefined) {
          continue;
        }
        messages.push({ id: m.MessageId, receipt: m.ReceiptHandle, body: m.Body });
      }
      return messages;
    },
    async delete(receipt) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    },
  };
}

// ---- Parsing ------------------------------------------------------------------

/** An SES event the poller acts on, reduced to what the verdict needs. */
export interface MailEvent {
  readonly messageId: string;
  readonly kind: MailEventKind;
  /** The event's own timestamp (the bounce's, the complaint's, else the mail's). */
  readonly at: Date;
  /** The addresses the event is about; empty when SES named none. */
  readonly recipients: readonly string[];
  /** The event as SES published it (headers and verdict; no message content). */
  readonly source: Record<string, unknown>;
}

export type ParsedMessage =
  | { readonly status: 'event'; readonly event: MailEvent }
  /** A well-formed SES event of a type the poller has nothing to do with (`Send`, `Delivery`, …). */
  | { readonly status: 'ignored'; readonly eventType: string }
  | { readonly status: 'unrecognised'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The address out of an SES recipient string. SES publishes bare addresses
 * in `bouncedRecipients`, `complainedRecipients` and `mail.destination`; a
 * display-name form (`Name <addr>`) is tolerated in case a header is copied.
 */
export function recipientAddress(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = stringField(value, 'emailAddress');
  if (raw === undefined) return undefined;
  const angled = /<([^<>\s]+)>\s*$/u.exec(raw);
  const address = (angled?.[1] ?? raw).trim();
  return address.includes('@') ? address : undefined;
}

function recipientsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const address = recipientAddress(entry);
    if (address !== undefined && !out.includes(address)) out.push(address);
  }
  return out;
}

function destinationsOf(mail: Record<string, unknown>): string[] {
  const list: unknown = mail.destination;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list as unknown[]) {
    const address = recipientAddress({ emailAddress: entry });
    if (address !== undefined && !out.includes(address)) out.push(address);
  }
  return out;
}

function timestampOf(...candidates: (Record<string, unknown> | undefined)[]): Date | undefined {
  for (const record of candidates) {
    if (record === undefined) continue;
    const raw = stringField(record, 'timestamp');
    if (raw === undefined) continue;
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return undefined;
}

/** The SES event types that carry nothing for this poller. */
const IGNORED_EVENT_TYPES = new Set([
  'send',
  'delivery',
  'deliverydelay',
  'open',
  'click',
  'renderingfailure',
  'subscription',
]);

/**
 * Read one queue message. With raw delivery the body is the SES event; an SNS
 * envelope (`Type: Notification`, the event JSON in `Message`) is unwrapped
 * in case the subscription is ever recreated without it. SES's event
 * publishing names the type in `eventType`; the older identity notifications
 * use `notificationType` — both are read.
 */
export function parseMessage(body: string): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { status: 'unrecognised', reason: 'not JSON' };
  }
  if (!isRecord(raw)) return { status: 'unrecognised', reason: 'not an object' };
  if (raw.Type === 'Notification' && typeof raw.Message === 'string') {
    return parseMessage(raw.Message);
  }
  const eventType = stringField(raw, 'eventType') ?? stringField(raw, 'notificationType');
  if (eventType === undefined) return { status: 'unrecognised', reason: 'no eventType' };
  const type = eventType.toLowerCase();
  if (IGNORED_EVENT_TYPES.has(type)) return { status: 'ignored', eventType };
  const mail = isRecord(raw.mail) ? raw.mail : undefined;
  const messageId = mail === undefined ? undefined : stringField(mail, 'messageId');
  if (mail === undefined || messageId === undefined) {
    return { status: 'unrecognised', reason: 'no mail.messageId' };
  }

  const event = (
    kind: MailEventKind,
    detail: Record<string, unknown> | undefined,
    recipients: string[],
  ): ParsedMessage => {
    const at = timestampOf(detail, mail);
    if (at === undefined) return { status: 'unrecognised', reason: 'no timestamp' };
    return { status: 'event', event: { messageId, kind, at, recipients, source: raw } };
  };

  switch (type) {
    case 'bounce': {
      if (!isRecord(raw.bounce)) return { status: 'unrecognised', reason: 'no bounce' };
      const bounceType = stringField(raw.bounce, 'bounceType');
      // `Permanent` is the hard bounce; `Transient` and `Undetermined` are
      // counted towards the threshold rather than acted on at once.
      const kind: MailEventKind =
        bounceType === 'Permanent' ? 'bounce_permanent' : 'bounce_transient';
      return event(kind, raw.bounce, recipientsOf(raw.bounce.bouncedRecipients));
    }
    case 'complaint': {
      if (!isRecord(raw.complaint)) return { status: 'unrecognised', reason: 'no complaint' };
      return event('complaint', raw.complaint, recipientsOf(raw.complaint.complainedRecipients));
    }
    case 'reject': {
      // A reject names no recipient of its own: the message was refused whole.
      const reject = isRecord(raw.reject) ? raw.reject : undefined;
      return event('reject', reject, destinationsOf(mail));
    }
    default:
      return { status: 'unrecognised', reason: `eventType ${eventType}` };
  }
}

// ---- Verdict ------------------------------------------------------------------

/**
 * What one recorded event means for its address, given how many transient
 * bounces the address has within the window (this one included).
 */
export function verdict(
  kind: MailEventKind,
  transientBounces: number,
): MailSuppressionReason | null {
  switch (kind) {
    case 'bounce_permanent':
      return 'bounce';
    case 'bounce_transient':
      return transientBounces >= TRANSIENT_BOUNCE_THRESHOLD ? 'bounce' : null;
    case 'complaint':
      return 'complaint';
    case 'reject':
      return null;
  }
}

const REASON_OF: Record<MailEventKind, MailEventReason> = {
  bounce_permanent: 'bounce_permanent',
  bounce_transient: 'bounce_transient',
  complaint: 'complaint',
  reject: 'reject',
};

// ---- The poller ---------------------------------------------------------------

export interface MailEventsDeps {
  readonly queue: MailEventQueue;
  readonly repo: Pick<MailRepo, 'recordEvent' | 'suppress'>;
  readonly logger: Logger;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

/** What became of one message: delete it, or leave it for SQS to redeliver. */
export type MessageOutcome = 'done' | 'retry';

export interface MailEventsStats {
  /** Messages read from the queue. */
  received: number;
  /** Events recorded for the first time (what the metric counts). */
  recorded: number;
  /** Redelivered events, recognised by their (message id, address) row. */
  duplicates: number;
  /** Suppressions written now (not repeats). */
  suppressed: number;
  /** Messages the poller could not read. */
  unrecognised: number;
  /** Messages left on the queue after a failure. */
  retried: number;
}

/**
 * The service's SES events consumer. `start()` runs the receive loop until
 * `stop()`, which aborts the in-flight long poll and resolves once the
 * message being processed, if any, has finished — inside the shutdown budget.
 */
export class MailEventsPoller {
  readonly stats: MailEventsStats = {
    received: 0,
    recorded: 0,
    duplicates: 0,
    suppressed: 0,
    unrecognised: 0,
    retried: 0,
  };
  private readonly now: () => Date;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly deps: MailEventsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.loop !== null) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.loop !== null) await this.loop;
  }

  private isStopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    const { queue, logger } = this.deps;
    const signal = this.abort.signal;
    while (!this.isStopping()) {
      let messages: QueuedMessage[];
      try {
        messages = await queue.receive(signal);
      } catch (error) {
        if (this.isStopping()) break;
        logger.error({ err: error }, 'ses events receive failed');
        await sleep(RECEIVE_BACKOFF_MS, signal);
        continue;
      }
      for (const message of messages) {
        if (this.isStopping()) break;
        this.stats.received += 1;
        if ((await this.process(message)) === 'done') {
          try {
            await queue.delete(message.receipt);
          } catch (error) {
            // Left on the queue: its events are recorded, so the redelivery is a no-op.
            logger.warn({ err: error, queueMessageId: message.id }, 'ses event not deleted');
          }
        }
      }
    }
    logger.info(this.stats, 'ses events poller stopped');
  }

  /**
   * One message: parse, then per recipient record → verdict → suppress. A
   * failure part-way leaves the message for redelivery; what was recorded
   * stays recorded and is recognised as a duplicate next time, and a
   * suppression is idempotent, so the retry completes the rest.
   */
  async process(message: QueuedMessage): Promise<MessageOutcome> {
    const { repo, logger } = this.deps;
    const parsed = parseMessage(message.body);
    if (parsed.status === 'ignored') {
      logger.debug(
        { queueMessageId: message.id, eventType: parsed.eventType },
        'ses event ignored',
      );
      return 'done';
    }
    if (parsed.status === 'unrecognised') {
      this.stats.unrecognised += 1;
      count(
        logger,
        'MailEvents',
        'unrecognised',
        { queueMessageId: message.id, reason: parsed.reason },
        'ses event not understood',
      );
      return 'done';
    }
    const { event } = parsed;
    const since = new Date(
      this.now().getTime() - TRANSIENT_BOUNCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      for (const email of event.recipients) {
        const outcome = await repo.recordEvent({
          messageId: event.messageId,
          email,
          kind: event.kind,
          at: event.at,
          source: event.source,
          since,
        });
        const reason = verdict(event.kind, outcome.transientBounces);
        let withdrawn = 0;
        let suppressed = false;
        if (reason !== null) {
          const result = await repo.suppress({
            email,
            reason,
            at: event.at,
            source: event.source,
          });
          withdrawn = result.withdrawn.length;
          suppressed = result.created;
          if (suppressed) this.stats.suppressed += 1;
        }
        const context = {
          messageId: event.messageId,
          kind: event.kind,
          transientBounces: outcome.transientBounces,
          suppressed: reason,
          withdrawn,
        };
        if (outcome.recorded) {
          this.stats.recorded += 1;
          count(logger, 'MailEvents', REASON_OF[event.kind], context, 'ses event');
        } else {
          this.stats.duplicates += 1;
          logger.info(context, 'ses event redelivered');
        }
      }
      if (event.recipients.length === 0) {
        logger.warn(
          { messageId: event.messageId, kind: event.kind },
          'ses event names no recipient',
        );
      }
      return 'done';
    } catch (error) {
      this.stats.retried += 1;
      logger.error(
        { err: error, messageId: event.messageId, kind: event.kind },
        'ses event not processed; left for redelivery',
      );
      return 'retry';
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
