/**
 * English (United States) — the reference catalogue: every other locale carries exactly
 * these keys, with the same `{placeholders}` (`catalogue.test.ts`).
 *
 * Voice (DESIGN-SYSTEM §6): plain, specific, sentence case; no "!", no emoji; buttons are
 * verbs. Product names (GeDe, workscape, passkey) stay as written in every locale.
 * Subjects stay within 60 characters once the placeholders are filled (`SUBJECT_MAX`).
 */
export const messages = {
  // The one-time codes Cognito sends. `{code}` is Cognito's placeholder and appears once.
  'signUpCode.subject': 'Your GeDe sign-up code',
  'signUpCode.heading': 'Confirm your email address',
  'signUpCode.body': 'Enter this code in GeDe to finish creating your account.',
  'signUpCode.expires': 'The code works once and expires in 24 hours.',
  'signUpCode.why':
    'You received this email because this address was used to create a GeDe account. If that was not you, ignore this email; nothing changes without the code.',

  'signInCode.subject': 'Your GeDe sign-in code',
  'signInCode.heading': 'Sign in to GeDe',
  'signInCode.body': 'Enter this code to sign in.',
  'signInCode.expires': 'The code works once and expires in 10 minutes.',
  'signInCode.why':
    'You received this email because someone asked to sign in to GeDe with this address. If that was not you, ignore this email; nothing changes without the code.',

  'emailChangeCode.subject': 'Confirm your new GeDe email address',
  'emailChangeCode.heading': 'Confirm your new email address',
  'emailChangeCode.body':
    'Enter this code in GeDe to confirm the change. Your previous address keeps working until you do.',
  'emailChangeCode.expires': 'The code works once and expires in 24 hours.',
  'emailChangeCode.why':
    'You received this email because a GeDe account asked to switch to this address. If that was not you, ignore this email; nothing changes without the code.',

  'code.label': 'Your code',

  // Share mail from services/sync. `{actor}` is the sharer's name, else address, else "Someone".
  'share.member.subject': '{actor} shared “{title}” with you',
  'share.member.heading': '{actor} shared a workscape with you',
  'share.member.body': '{actor} shared the workscape “{title}” with you on GeDe.',
  'share.member.next':
    'Open it with the button below. Sign in with your passkey or a code sent to this address.',
  'share.member.action': 'Open workscape',
  'share.member.why':
    'You received this email because {actor} shared a workscape with this address on GeDe.',

  'share.invite.subject': '{actor} invited you to a GeDe workscape',
  'share.invite.heading': '{actor} invited you to a workscape',
  'share.invite.body': '{actor} invited you to the workscape “{title}” on GeDe.',
  'share.invite.next':
    'The invitation is valid for {days} days. Accept it with the button below, then create your account with this address: GeDe signs in with a passkey or a code by email, so there is no password to choose.',
  'share.invite.action': 'Accept invitation',
  'share.invite.why':
    'You received this email because {actor} invited this address to a workscape on GeDe.',

  'share.someone': 'Someone',

  // Layout
  'layout.linkFallback': 'If the button does not open, copy this link into your browser:',
  'layout.sentTo': 'This email was sent to {email}.',
  'layout.footer': 'GeDe, the text-oriented spreadsheet.',
} as const;
