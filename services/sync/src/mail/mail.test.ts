/**
 * Share mail (SHARE-02, DESIGN-SYSTEM §6): the two templates and the SES v2
 * mailer, the latter against a recording fake client — no network.
 */
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { describe, expect, test } from 'vitest';

import { createSesMailer } from './ses.js';
import { senderFor, shareInviteMail, shareMemberMail, SUBJECT_MAX } from './templates.js';

const base = {
  to: 'sembian@example.com',
  from: 'no-reply@gede.work',
  actorName: 'Meenarapan D',
  actorEmail: 'meena@example.com',
  documentTitle: '1Cloudhub - Workscape',
  link: 'https://gede.work/d/6f1b2c3d-0000-4000-8000-00000000e2e0?invite=abc',
};

describe('share mail templates', () => {
  test('SHARE-02 the sender is no-reply at the web origin host', () => {
    expect(senderFor('https://gede.work')).toBe('no-reply@gede.work');
    expect(senderFor('http://localhost:5173')).toBe('no-reply@localhost');
  });

  test('SHARE-02 share.invite names the actor first, says 14 days and the passkey sign-in, and carries the tokened link as text and as the one action', () => {
    const mail = shareInviteMail(base);
    expect(mail.template).toBe('share.invite');
    expect(mail.subject).toBe('Meenarapan D invited you to a GeDe workscape');
    expect(mail.replyTo).toBe('meena@example.com');
    expect(mail.text).toContain('valid for 14 days');
    expect(mail.text).toContain('passkey');
    expect(mail.text).toContain(`Accept invitation: ${base.link}`);
    expect(mail.html).toContain(`<a href="${base.link}">Accept invitation</a>`);
    expect(mail.html.match(/<a /g)).toHaveLength(1);
    // The title is HTML-escaped in the HTML part, verbatim in the text part.
    const scripted = shareInviteMail({ ...base, documentTitle: '<b>bold</b> & co' });
    expect(scripted.html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(scripted.text).toContain('<b>bold</b> & co');
  });

  test('SHARE-02 share.member names the actor and the workscape within 60 characters, falling back to the address and then to "Someone"', () => {
    const mail = shareMemberMail(base);
    expect(mail.template).toBe('share.member');
    expect(mail.subject).toBe('Meenarapan D shared “1Cloudhub - Workscape” with you');
    expect(mail.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(mail.replyTo).toBe('meena@example.com');
    expect(mail.text).toContain(`Open workscape: ${base.link}`);

    const long = shareMemberMail({ ...base, documentTitle: 'x'.repeat(200) });
    expect(long.subject.length).toBe(SUBJECT_MAX);
    expect(long.subject.endsWith('…” with you')).toBe(true);

    const noName = shareMemberMail({ ...base, actorName: null });
    expect(noName.subject.startsWith('meena@example.com shared')).toBe(true);
    const nobody = shareMemberMail({ ...base, actorName: null, actorEmail: null });
    expect(nobody.subject.startsWith('Someone shared')).toBe(true);
    expect(nobody.replyTo).toBeNull();
  });
});

describe('SES v2 mailer', () => {
  test('SHARE-02 sends one SendEmail with simple content, the display-named sender, the recipient and the reply-to', async () => {
    const commands: SendEmailCommand[] = [];
    const client = {
      send: (command: SendEmailCommand) => {
        commands.push(command);
        return Promise.resolve({ MessageId: 'm-1' });
      },
    } as unknown as SESv2Client;
    const mailer = createSesMailer(client, { fromName: 'GeDe' });
    await mailer.send(shareMemberMail(base));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SendEmailCommand);
    expect(commands[0]!.input).toMatchObject({
      FromEmailAddress: 'GeDe <no-reply@gede.work>',
      Destination: { ToAddresses: ['sembian@example.com'] },
      ReplyToAddresses: ['meena@example.com'],
      Content: {
        Simple: {
          Subject: {
            Data: 'Meenarapan D shared “1Cloudhub - Workscape” with you',
            Charset: 'UTF-8',
          },
        },
      },
    });
    // No reply-to when the actor has no address.
    await mailer.send(shareMemberMail({ ...base, actorName: null, actorEmail: null }));
    expect(commands[1]!.input.ReplyToAddresses).toBeUndefined();
  });

  test('SHARE-02 a rejected send (SES sandbox) rejects the promise; nothing is swallowed', async () => {
    const client = {
      send: () => Promise.reject(new Error('MessageRejected: Email address is not verified')),
    } as unknown as SESv2Client;
    await expect(
      createSesMailer(client, { fromName: 'GeDe' }).send(shareMemberMail(base)),
    ).rejects.toThrow('MessageRejected');
  });
});
