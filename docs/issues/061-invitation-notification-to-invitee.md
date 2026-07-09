# 061: Notify the invitee that they've been invited (email or in-app) — today there is zero signal

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy) — invitee experience, complements 060
- **Severity**: Medium — UX gap. Sharing can't reach "the intended users" if those users are never told they were invited.
- **Requested by**: tester (`meenarapand-max` / project owner), 2026-07-09: *"I would like an email notification or something to indicate that I have been invited to a new project."*

## Symptom

When an owner invites someone (Share → email → role → Invite), the invited person receives **no notification** — no email arrives, and there's no in-app signal. The invite exists only as a pending row the owner sees in their own Share panel. The invitee has no way to *know* they were invited unless they happen to sign in and stumble on it.

Additionally, the owner-side Share panel shows a **"Resend"** button that implies an email is (re)sent — but `resendInvitation` only **extends the invitation's expiry** (`src/db/invitations.ts`, 035); no email is ever sent. The label is misleading.

## Root cause

The sharing feature (035) was built as an **in-app invitation model with no delivery channel** — there is no SES (or any email) integration, and no in-app notification/inbox. Invitations are DB rows surfaced to the *owner*; nothing pushes them to the *invitee*.

## Fix direction (not yet implemented — choose one or both)

1. **In-app notification (cheaper, no new infra):** an invitee-facing "Invitations" inbox/badge (pairs naturally with 060's accept surface) so a signed-in user immediately sees pending invites addressed to their email. This alone satisfies "indicate that I have been invited" for users who sign in.
2. **Email notification (true outreach):** on invite, send an email to the address (e.g. Amazon SES) with a deep link to sign in / accept. This is what reaches users who are **not** already signed in — the tester's literal ask. Requires: an SES identity + verified sending domain (or sandbox recipients while unverified), a send on the write-path (or a dedicated notify Lambda triggered by the invitation insert), and templating.
3. **Relabel "Resend":** until real email exists, rename the owner-side action (e.g. "Extend expiry") so it doesn't imply an email was sent; once email lands, "Resend" can actually re-send.

## Test-first plan

- **In-app:** a test that a signed-in user with a pending invite to their email sees a notification/badge (overlaps 060 — coordinate so they share one invitee surface).
- **Email (if pursued):** a unit test of the notify function (composes the correct recipient/subject/deep-link) with the SES client mocked; a guarded integration test behind an env flag (like the pgWriteStore live test) so CI doesn't require real SES.
- **Relabel:** a component test asserting the owner-side control no longer reads "Resend" (or only does so once email delivery is wired).

## Dependencies / ordering

Best done **with or after 060** — both concern the invitee's experience and should share a single invitee-facing invitations surface rather than building two. 061's in-app option (1) is essentially 060's notification half; the email option (2) is the additive outreach the tester asked for.

**References**: 055 (sharing bug), 060 (invitee accept flow — the surface this notification feeds into), 035 (invitations model; `resendInvitation` = expiry extension, the mislabeled "Resend"), `docs/DEPLOYMENT.md §9` (no email infra exists today). Relates to a full close of **GitHub issue #8**.
