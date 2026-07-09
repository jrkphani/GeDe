# 061: Notify the invitee that they've been invited (email or in-app) — today there is zero signal

- **Status**: SHIPPED (in-app notification via 060 + honest relabel) — email delivery deferred (blocked on SES prod access)
- **Milestone**: M9 (Identity & tenancy) — invitee experience, complements 060
- **Severity**: Medium — UX gap. Sharing can't reach "the intended users" if those users are never told they were invited.
- **Requested by**: tester (`meenarapand-max` / project owner), 2026-07-09: *"I would like an email notification or something to indicate that I have been invited to a new project."*

## Resolution

Two of the three fix directions below are done; email is intentionally deferred:

1. **In-app notification — DELIVERED by 060.** `src/components/PendingInvitations.tsx` renders an "Invitations · N" badge/popover in the app-bar so a signed-in user immediately sees pending invites addressed to their email, with Accept/Decline. This satisfies "or something to indicate I've been invited" for anyone who signs in. No further work needed here — see `docs/issues/done/060-invitee-accept-flow-unwired.md`.
2. **Relabel "Resend" — DONE (this pass).** The owner-side Share panel (`src/components/WorkspaceMembers.tsx`) called the expiry-bump action "Resend", implying an email was (re)sent. It's now **"Extend"** (button text) / `Extend invitation expiry for {email}` (aria-label), truthfully describing what `resendInvitation` (`src/db/invitations.ts`) actually does — bump `expiresAt`, no email. The underlying store action/DB function keeps its `resendInvitation` name (internal API, not user-facing copy). Covered by `src/components/WorkspaceMembers.test.tsx` ("extending an invitation keeps it pending" — also asserts no control reads "Resend" anymore).
3. **Email notification — NOT built, deferred.** Reaching invitees who are *not* already signed in (the tester's literal ask) requires real outbound email. This remains blocked on infrastructure this pass didn't stand up:
   - **SES production access** — an AWS-support request/approval process (sandbox SES can only send to pre-verified recipient addresses, unusable for arbitrary invitee emails).
   - **A sender-identity/domain decision** — which domain or address invitations should send *from*, plus DKIM/SPF/verification for it.
   - Once those two are in place: a send on the invite write-path (or a dedicated notify Lambda triggered by the invitation insert), a template (recipient, subject, deep link to sign-in/accept), a unit test with the SES client mocked, and a guarded integration test behind an env flag (same pattern as the live pgWriteStore test) so CI doesn't require real SES.

**What remains**: stand up SES (prod access + sender identity) and wire the notify send — no code changes needed for the in-app/relabel scope, which is done.

## Symptom (as originally filed — now addressed for signed-in users, see Resolution)

When an owner invites someone (Share → email → role → Invite), the invited person received **no notification** — no email arrived, and there was no in-app signal. The invite existed only as a pending row the owner saw in their own Share panel. The invitee had no way to *know* they were invited unless they happened to sign in and stumble on it.

Additionally, the owner-side Share panel showed a **"Resend"** button that implied an email was (re)sent — but `resendInvitation` only **extends the invitation's expiry** (`src/db/invitations.ts`, 035); no email is ever sent. The label was misleading. (Fixed — see Resolution, item 2.)

## Root cause

The sharing feature (035) was built as an **in-app invitation model with no delivery channel** — there was no SES (or any email) integration, and no in-app notification/inbox at the time. 060 added the in-app inbox; SES/email is still absent by design (see below).

## Fix direction

1. **In-app notification — DONE (060).** An invitee-facing "Invitations" inbox/badge (`PendingInvitations.tsx`) so a signed-in user immediately sees pending invites addressed to their email. Satisfies "indicate that I have been invited" for users who sign in.
2. **Email notification (true outreach) — DEFERRED, BLOCKED.** On invite, send an email to the address (e.g. Amazon SES) with a deep link to sign in / accept. This is what reaches users who are **not** already signed in — the tester's literal ask. **Blocked on:** (a) SES production access — an AWS-support request/approval process (SES sandbox can only send to pre-verified recipients, which doesn't work for arbitrary invitee emails), and (b) a sender-identity/domain decision (which domain/address to send from, plus DKIM/SPF verification). Once unblocked: a send on the write-path (or a dedicated notify Lambda triggered by the invitation insert), and templating (recipient, subject, deep link).
3. **Relabel "Resend" — DONE (this pass).** Renamed the owner-side action to "Extend" / `Extend invitation expiry for {email}` so it no longer implies an email was sent. If/when real email delivery lands, a genuine "Resend" (re-send the email) can be added as a distinct action.

## Test-first plan

- **In-app:** ~~a test that a signed-in user with a pending invite to their email sees a notification/badge~~ — covered by 060's `PendingInvitations.test.tsx`.
- **Email (if pursued):** a unit test of the notify function (composes the correct recipient/subject/deep-link) with the SES client mocked; a guarded integration test behind an env flag (like the pgWriteStore live test) so CI doesn't require real SES. **Not started** — blocked per item 2 above.
- **Relabel:** a component test asserting the owner-side control no longer reads "Resend" — done in `src/components/WorkspaceMembers.test.tsx` ("extending an invitation keeps it pending (honest label…)").

## Dependencies / ordering

Was done **with/after 060** as planned — both concerned the invitee's experience and share one invitee-facing invitations surface. 060 shipped the in-app half; this issue closed out the relabel and formally deferred the email/SES half rather than leaving it as ambiguous "not yet implemented".

**References**: 055 (sharing bug), 060 (invitee accept flow — the surface this notification feeds into), 035 (invitations model; `resendInvitation` = expiry extension, the mislabeled "Resend"), `docs/DEPLOYMENT.md §9` (no email infra exists today — still true). Relates to a full close of **GitHub issue #8** (in-app half closed; email half remains open pending SES access).
