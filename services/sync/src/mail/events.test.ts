/**
 * SES bounce and complaint handling (SHARE-02, ADR-046): the parser against
 * SES's published event shapes, the verdict, and the poller over the fake
 * queue and the fake repo — what it records, what it suppresses, what it
 * withdraws, what it counts, and what it leaves on the queue.
 */
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { METRIC_NAMESPACE } from '../metrics.js';
import { FakeRepo } from '../test/fake-repo.js';
import { FakeMailEventQueue, json, startServer, type TestServer } from '../test/fakes.js';
import { bounceEvent, complaintEvent, mailObject, rejectEvent } from '../test/ses-samples.js';
import {
  MailEventsPoller,
  parseMessage,
  recipientAddress,
  TRANSIENT_BOUNCE_THRESHOLD,
  TRANSIENT_BOUNCE_WINDOW_DAYS,
  verdict,
} from './events.js';

const DAY = 24 * 60 * 60 * 1000;

describe('parseMessage', () => {
  test('SHARE-02 a Permanent bounce is a bounce_permanent for each bounced recipient, at the bounce’s own time, with the whole event as its source', () => {
    const parsed = parseMessage(
      JSON.stringify(bounceEvent('msg-1', ['gone@example.com', 'also@example.com'])),
    );
    expect(parsed.status).toBe('event');
    if (parsed.status !== 'event') return;
    expect(parsed.event).toMatchObject({
      messageId: 'msg-1',
      kind: 'bounce_permanent',
      recipients: ['gone@example.com', 'also@example.com'],
    });
    expect(parsed.event.at.toISOString()).toBe('2026-09-13T01:00:05.000Z');
    expect(parsed.event.source).toMatchObject({ eventType: 'Bounce' });
  });

  test('SHARE-02 Transient and Undetermined bounces are bounce_transient; a complaint names the complainants; a reject names the message’s destinations', () => {
    const transient = parseMessage(
      JSON.stringify(bounceEvent('m', ['full@example.com'], 'Transient')),
    );
    expect(transient).toMatchObject({ status: 'event', event: { kind: 'bounce_transient' } });
    const undetermined = parseMessage(
      JSON.stringify(bounceEvent('m', ['odd@example.com'], 'Undetermined')),
    );
    expect(undetermined).toMatchObject({ status: 'event', event: { kind: 'bounce_transient' } });
    const complaint = parseMessage(JSON.stringify(complaintEvent('m', ['spam@example.com'])));
    expect(complaint).toMatchObject({
      status: 'event',
      event: { kind: 'complaint', recipients: ['spam@example.com'] },
    });
    if (complaint.status === 'event') {
      expect(complaint.event.at.toISOString()).toBe('2026-09-13T02:00:00.000Z');
    }
    const reject = parseMessage(JSON.stringify(rejectEvent('m', ['virus@example.com'])));
    expect(reject).toMatchObject({
      status: 'event',
      event: { kind: 'reject', recipients: ['virus@example.com'] },
    });
    // A reject has no timestamp of its own: the mail's is used.
    if (reject.status === 'event') {
      expect(reject.event.at.toISOString()).toBe('2026-09-13T01:00:00.000Z');
    }
  });

  test('SHARE-02 an SNS envelope is unwrapped, notificationType is read like eventType, and a display-name recipient yields the bare address', () => {
    const inner = { ...bounceEvent('m-env', ['x@example.com']), notificationType: 'Bounce' };
    delete (inner as { eventType?: string }).eventType;
    const envelope = {
      Type: 'Notification',
      MessageId: 'sns-1',
      TopicArn: 'arn:aws:sns:ap-southeast-1:975049998516:gede-prod-ses-events',
      Message: JSON.stringify(inner),
      Timestamp: '2026-09-13T01:00:06.000Z',
    };
    expect(parseMessage(JSON.stringify(envelope))).toMatchObject({
      status: 'event',
      event: { messageId: 'm-env', kind: 'bounce_permanent', recipients: ['x@example.com'] },
    });
    expect(recipientAddress({ emailAddress: 'Sembian <sembian@example.com>' })).toBe(
      'sembian@example.com',
    );
    expect(recipientAddress({ emailAddress: ' plain@example.com ' })).toBe('plain@example.com');
    expect(recipientAddress({ emailAddress: 'not an address' })).toBeUndefined();
    expect(recipientAddress('sembian@example.com')).toBeUndefined();
  });

  test('SHARE-02 Send, Delivery, DeliveryDelay and the like are ignored; anything unreadable is unrecognised with a reason', () => {
    expect(
      parseMessage(JSON.stringify({ eventType: 'Delivery', mail: mailObject('m', ['a@b.c']) })),
    ).toEqual({ status: 'ignored', eventType: 'Delivery' });
    expect(parseMessage(JSON.stringify({ eventType: 'DeliveryDelay' }))).toEqual({
      status: 'ignored',
      eventType: 'DeliveryDelay',
    });
    expect(parseMessage('not json')).toEqual({ status: 'unrecognised', reason: 'not JSON' });
    expect(parseMessage('[1]')).toEqual({ status: 'unrecognised', reason: 'not an object' });
    expect(parseMessage('{}')).toEqual({ status: 'unrecognised', reason: 'no eventType' });
    expect(parseMessage(JSON.stringify({ eventType: 'Bounce' }))).toEqual({
      status: 'unrecognised',
      reason: 'no mail.messageId',
    });
    expect(
      parseMessage(JSON.stringify({ eventType: 'Bounce', mail: mailObject('m', ['a@b.c']) })),
    ).toEqual({ status: 'unrecognised', reason: 'no bounce' });
    expect(
      parseMessage(JSON.stringify({ eventType: 'Wobble', mail: mailObject('m', ['a@b.c']) })),
    ).toEqual({ status: 'unrecognised', reason: 'eventType Wobble' });
    const noTime = bounceEvent('m', ['a@b.c']);
    noTime.bounce.timestamp = 'yesterday';
    noTime.mail.timestamp = '';
    expect(parseMessage(JSON.stringify(noTime))).toEqual({
      status: 'unrecognised',
      reason: 'no timestamp',
    });
  });
});

describe('verdict', () => {
  test('SHARE-02 a hard bounce and a complaint suppress at once; a transient bounce on the third within the window; a reject never', () => {
    expect(verdict('bounce_permanent', 1)).toBe('bounce');
    expect(verdict('complaint', 1)).toBe('complaint');
    expect(verdict('bounce_transient', TRANSIENT_BOUNCE_THRESHOLD - 1)).toBeNull();
    expect(verdict('bounce_transient', TRANSIENT_BOUNCE_THRESHOLD)).toBe('bounce');
    expect(verdict('reject', 99)).toBeNull();
    expect(TRANSIENT_BOUNCE_THRESHOLD).toBe(3);
    expect(TRANSIENT_BOUNCE_WINDOW_DAYS).toBe(30);
  });
});

describe('MailEventsPoller over the fake queue and repo', () => {
  let repo: FakeRepo;
  let queue: FakeMailEventQueue;
  let lines: Record<string, unknown>[];
  let poller: MailEventsPoller;
  let now: Date;

  beforeEach(() => {
    repo = new FakeRepo();
    queue = new FakeMailEventQueue();
    lines = [];
    now = new Date('2026-09-13T03:00:00.000Z');
    const logger = pino(
      { level: 'info' },
      {
        write(chunk: string) {
          for (const line of chunk.split('\n')) {
            if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, unknown>);
          }
        },
      },
    );
    poller = new MailEventsPoller({ queue, repo: repo.mail, logger, now: () => now });
  });

  afterEach(async () => {
    await poller.stop();
  });

  function metricLines(reason: string) {
    return lines.filter((l) => l.MailEvents === 1 && l.Reason === reason);
  }

  test('SHARE-02 a hard bounce records the event, suppresses the address, withdraws its pending invitations with share.invite_withdraw rows by the system, counts one MailEvents datapoint, and deletes the message', async () => {
    const owner = repo.seedUser('sub-owner', 'owner@example.com');
    const docA = repo.seedDocument(owner.id, 'A');
    const docB = repo.seedDocument(owner.id, 'B');
    for (const doc of [docA, docB]) {
      await repo.invites.create({
        documentId: doc.id,
        email: 'Gone@Example.com',
        permission: 'view',
        token: `tok-${doc.id}`,
        expiresAt: new Date(now.getTime() + 14 * DAY),
        invitedBy: owner.id,
      });
    }
    poller.start();
    const receipt = queue.enqueue(JSON.stringify(bounceEvent('msg-hard', ['gone@example.com'])));
    await queue.deletedReceipt(receipt);

    expect(repo.mailEvents.size).toBe(1);
    expect([...repo.mailEvents.values()][0]).toMatchObject({
      messageId: 'msg-hard',
      email: 'gone@example.com',
      kind: 'bounce_permanent',
    });
    const suppression = await repo.mail.suppression('GONE@example.com');
    expect(suppression).toMatchObject({ email: 'gone@example.com', reason: 'bounce' });
    expect(suppression!.firstSeenAt.toISOString()).toBe('2026-09-13T01:00:05.000Z');
    // Both invitations are gone, each with its audit row: system actor, address and reason.
    expect(repo.invitesById.size).toBe(0);
    const withdrawn = repo.auditLog
      .filter((a) => a.action === 'share.invite_withdraw')
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
    expect(withdrawn).toEqual(
      [docA.id, docB.id].sort().map((documentId) => ({
        documentId,
        userId: null,
        action: 'share.invite_withdraw',
        target: 'gone@example.com:bounce',
      })),
    );
    // One EMF datapoint, carrying the message id and the verdict and never the address.
    const [line] = metricLines('bounce_permanent');
    expect(line).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Reason']],
            Metrics: [{ Name: 'MailEvents', Unit: 'Count' }],
          },
        ],
      },
      Reason: 'bounce_permanent',
      MailEvents: 1,
      messageId: 'msg-hard',
      kind: 'bounce_permanent',
      suppressed: 'bounce',
      withdrawn: 2,
      msg: 'ses event',
    });
    expect(JSON.stringify(lines)).not.toContain('gone@example.com');
    expect(poller.stats).toMatchObject({ received: 1, recorded: 1, suppressed: 1, retried: 0 });
  });

  test('SHARE-02 a complaint suppresses with reason complaint; a reject is recorded and counted but suppresses nothing and withdraws nothing', async () => {
    const owner = repo.seedUser('sub-owner', 'owner@example.com');
    const doc = repo.seedDocument(owner.id, 'A');
    await repo.invites.create({
      documentId: doc.id,
      email: 'virus@example.com',
      permission: 'edit',
      token: 'tok-virus',
      expiresAt: new Date(now.getTime() + 14 * DAY),
      invitedBy: owner.id,
    });
    poller.start();
    const r1 = queue.enqueue(JSON.stringify(complaintEvent('msg-c', ['spam@example.com'])));
    const r2 = queue.enqueue(JSON.stringify(rejectEvent('msg-r', ['virus@example.com'])));
    await queue.deletedReceipt(r1);
    await queue.deletedReceipt(r2);
    expect(await repo.mail.suppression('spam@example.com')).toMatchObject({ reason: 'complaint' });
    expect(await repo.mail.suppression('virus@example.com')).toBeUndefined();
    expect(repo.invitesById.size).toBe(1);
    expect(metricLines('complaint')).toHaveLength(1);
    expect(metricLines('reject')).toHaveLength(1);
    expect([...repo.mailEvents.values()].map((e) => e.kind).sort()).toEqual([
      'complaint',
      'reject',
    ]);
  });

  test('SHARE-02 transient bounces suppress on the third within 30 days: older ones do not count, and each is one datapoint', async () => {
    poller.start();
    // One from before the window: recorded, never counted towards the verdict.
    const stale = bounceEvent(
      'msg-t0',
      ['full@example.com'],
      'Transient',
      new Date(now.getTime() - (TRANSIENT_BOUNCE_WINDOW_DAYS + 1) * DAY).toISOString(),
    );
    await queue.deletedReceipt(queue.enqueue(JSON.stringify(stale)));
    const r1 = queue.enqueue(
      JSON.stringify(bounceEvent('msg-t1', ['full@example.com'], 'Transient')),
    );
    await queue.deletedReceipt(r1);
    const r2 = queue.enqueue(
      JSON.stringify(bounceEvent('msg-t2', ['full@example.com'], 'Transient')),
    );
    await queue.deletedReceipt(r2);
    expect(await repo.mail.suppression('full@example.com')).toBeUndefined();
    const r3 = queue.enqueue(
      JSON.stringify(bounceEvent('msg-t3', ['full@example.com'], 'Transient')),
    );
    await queue.deletedReceipt(r3);
    expect(await repo.mail.suppression('full@example.com')).toMatchObject({ reason: 'bounce' });
    expect(metricLines('bounce_transient')).toHaveLength(4);
    expect(metricLines('bounce_transient').map((l) => l.transientBounces)).toEqual([0, 1, 2, 3]);
    expect(poller.stats.suppressed).toBe(1);
  });

  test('SHARE-02 a redelivered message is a no-op: nothing recorded twice, no second datapoint, the suppression kept with its first sighting, and the message still deleted', async () => {
    poller.start();
    const body = JSON.stringify(bounceEvent('msg-dup', ['gone@example.com']));
    await queue.deletedReceipt(queue.enqueue(body));
    const first = await repo.mail.suppression('gone@example.com');
    await queue.deletedReceipt(queue.enqueue(body));
    expect(repo.mailEvents.size).toBe(1);
    expect(metricLines('bounce_permanent')).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'ses event redelivered')).toHaveLength(1);
    expect(await repo.mail.suppression('gone@example.com')).toEqual(first);
    expect(poller.stats).toMatchObject({ received: 2, recorded: 1, duplicates: 1, suppressed: 1 });
    expect(queue.deleted).toHaveLength(2);
  });

  test('SHARE-02 a message the poller cannot read is counted unrecognised, logged and deleted; an ignored event type is deleted quietly', async () => {
    poller.start();
    await queue.deletedReceipt(queue.enqueue('{"eventType":"Bounce"}'));
    await queue.deletedReceipt(
      queue.enqueue(JSON.stringify({ eventType: 'Send', mail: mailObject('m', ['a@b.c']) })),
    );
    expect(metricLines('unrecognised')).toHaveLength(1);
    expect(metricLines('unrecognised')[0]).toMatchObject({ reason: 'no mail.messageId' });
    expect(poller.stats).toMatchObject({ received: 2, unrecognised: 1, recorded: 0 });
    expect(repo.mailEvents.size).toBe(0);
  });

  test('SHARE-02 a database failure leaves the message on the queue for SQS to redeliver; the retry completes it', async () => {
    poller.start();
    repo.failNextMailEvent = true;
    const body = JSON.stringify(bounceEvent('msg-retry', ['gone@example.com']));
    queue.enqueue(body);
    // Not deleted: the poller answered `retry`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue.deleted).toHaveLength(0);
    expect(poller.stats.retried).toBe(1);
    expect(lines.some((l) => l.msg === 'ses event not processed; left for redelivery')).toBe(true);
    // SQS redelivers after the visibility timeout; the fake does it by enqueueing again.
    await queue.deletedReceipt(queue.enqueue(body));
    expect(await repo.mail.suppression('gone@example.com')).toMatchObject({ reason: 'bounce' });
    expect(repo.mailEvents.size).toBe(1);
  });

  test('SHARE-02 a failed receive is logged and retried after a backoff; stop() aborts the long poll and resolves', async () => {
    queue.failNextReceive = true;
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines.some((l) => l.msg === 'ses events receive failed')).toBe(true);
    const stopped = poller.stop();
    await expect(stopped).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatchObject({ msg: 'ses events poller stopped', received: 0 });
  });
});

describe('the poller inside the server', () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  test('SHARE-02 without a queue (local development) no poller exists; with one it runs from boot and stops with the server', async () => {
    server = await startServer();
    expect(server.app.mailEvents).toBeNull();
    expect(server.mailEvents).toBeNull();
    await server.close();

    server = await startServer({}, { withMailEvents: true });
    expect(server.app.mailEvents).not.toBeNull();
    const receipt = server.mailEvents!.enqueue(
      JSON.stringify(complaintEvent('msg-boot', ['spam@example.com'])),
    );
    await server.mailEvents!.deletedReceipt(receipt);
    expect(await server.repo.mail.suppression('spam@example.com')).toMatchObject({
      reason: 'complaint',
    });
    // The health route is unaffected by the poller.
    expect((await json(server, 'GET', '/healthz')).status).toBe(200);
  });
});
