/**
 * SAMPLE SES event payloads for tests (ADR-046), in the shape the developer
 * guide documents under "Examples of event data that Amazon SES publishes to
 * Amazon SNS": the `mail` object with its message id and headers, then the
 * event's own object (`bounce`, `complaint`, `reject`). Values are made up;
 * the shape is SES's.
 */

export function mailObject(messageId: string, destination: string[]) {
  return {
    timestamp: '2026-09-13T01:00:00.000Z',
    source: 'GeDe <no-reply@gede.work>',
    sourceArn: 'arn:aws:ses:ap-southeast-1:975049998516:identity/gede.work',
    sendingAccountId: '975049998516',
    messageId,
    destination,
    headersTruncated: false,
    headers: [
      { name: 'From', value: 'GeDe <no-reply@gede.work>' },
      { name: 'To', value: destination.join(', ') },
      { name: 'Subject', value: 'Alice A invited you to a GeDe workscape' },
    ],
    commonHeaders: {
      from: ['GeDe <no-reply@gede.work>'],
      to: destination,
      messageId,
      subject: 'Alice A invited you to a GeDe workscape',
    },
    tags: { 'ses:configuration-set': ['gede-prod'], 'ses:caller-identity': ['gede-prod-task'] },
  };
}

export function bounceEvent(
  messageId: string,
  recipients: string[],
  bounceType: 'Permanent' | 'Transient' | 'Undetermined' = 'Permanent',
  timestamp = '2026-09-13T01:00:05.000Z',
) {
  return {
    eventType: 'Bounce',
    bounce: {
      bounceType,
      bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
      bouncedRecipients: recipients.map((emailAddress) => ({
        emailAddress,
        action: bounceType === 'Permanent' ? 'failed' : 'delayed',
        status: bounceType === 'Permanent' ? '5.1.1' : '4.2.2',
        diagnosticCode:
          bounceType === 'Permanent'
            ? 'smtp; 550 5.1.1 user unknown'
            : 'smtp; 452 4.2.2 mailbox full',
      })),
      timestamp,
      feedbackId: '0100017f0000-feedback-000000',
      reportingMTA: 'dsn; a8-70.smtp-out.amazonses.com',
    },
    mail: mailObject(messageId, recipients),
  };
}

export function complaintEvent(messageId: string, recipients: string[]) {
  return {
    eventType: 'Complaint',
    complaint: {
      complainedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
      timestamp: '2026-09-13T02:00:00.000Z',
      feedbackId: '0100017f0000-feedback-000001',
      userAgent: 'Mozilla/5.0',
      complaintFeedbackType: 'abuse',
      arrivalDate: '2026-09-13T01:00:10.000Z',
    },
    mail: mailObject(messageId, recipients),
  };
}

export function rejectEvent(messageId: string, recipients: string[]) {
  return {
    eventType: 'Reject',
    reject: { reason: 'Bad content' },
    mail: mailObject(messageId, recipients),
  };
}
