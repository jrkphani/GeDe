/**
 * The SES v2 mailer. One `SendEmail` per message, simple content (subject,
 * text and HTML parts); the task role may call `ses:SendEmail` on the
 * domain identity only (`infra/lib/stacks/service-stack.ts`).
 *
 * While SES is in the sandbox (production access pending in ap-southeast-1)
 * only verified recipient addresses are delivered; SES answers
 * `MessageRejected` for any other, which surfaces as a failed send. The route
 * reports a failed send as `delivery: 'failed'` and keeps the row it
 * announces (`delivery.ts`, #121): the mail is the notification, not the grant.
 */
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';

import type { Mailer } from '../deps.js';

export function createSesMailer(client: SESv2Client, options: { fromName: string }): Mailer {
  return {
    async send(mail) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: `${options.fromName} <${mail.from}>`,
          Destination: { ToAddresses: [mail.to] },
          ...(mail.replyTo !== null && { ReplyToAddresses: [mail.replyTo] }),
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: mail.text, Charset: 'UTF-8' },
                Html: { Data: mail.html, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
    },
  };
}
