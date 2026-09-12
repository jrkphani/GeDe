import { test } from './fixtures/test.js';

/**
 * Document-shell journeys need a signed-in session: `/d/:id` sits behind
 * `RequireAuth`, and the shell then opens a y-websocket room on the sync
 * service. Neither exists in this suite — there is no backend, and faking a
 * Cognito session in the browser would be an invented fixture (root rule 8).
 * The RESP-02 behaviour is covered by the unit test in
 * `src/routes/document/DocumentShell.test.tsx`; the journey below is recorded
 * so the gap stays visible in the report until OTP sign-in is automated
 * against a test pool.
 */
test.describe('document shell', () => {
  test.skip(
    true,
    'needs an authenticated session and a running sync service; no session is faked (see file comment)',
  );

  test('RESP-02 below 768 px the document shell says "View only on phone" and renders no edit affordance', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto('/d/01J8Z2Q5X0Y3K7N4M6P9R2S5T8');
    // Would assert: the text "View only on phone", no toolbar, no contenteditable, no textbox.
  });
});
