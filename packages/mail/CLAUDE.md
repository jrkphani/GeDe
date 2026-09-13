# packages/mail — conventions

Every email GeDe sends: the one-time codes Cognito delivers (`signUpCode`, `signInCode`,
`emailChangeCode`) and the share mail the sync service sends (`share.member`, `share.invite`),
one layout, six locales. Consumed by `services/sync` (SES) and by the Cognito custom-message
trigger (`infra/assets/custom-message`). Read the root `CLAUDE.md` first.

## Rules

- **Framework-free and dependency-free.** No imports from React, the DOM, Node modules or
  any package: the module is bundled into a Lambda and into the sync image as is. `lib` is
  `ES2023` only.
- **No literal colour, radius or font outside `src/generated/palette.ts`.** That file is
  written by `npm run generate -w packages/mail` from `packages/tokens/src/tokens.css`
  (light from `:root`, dark from the `[data-theme="dark"]` swap, `var()` chains resolved);
  `palette.test.ts` fails when it drifts, `check-literals` skips that directory and scans the
  rest of the package. After a token change: regenerate, re-run the tests, commit both.
- **One layout** (`layout.ts`): 600 px column, table markup, inline styles, a `<style>` block
  carrying only the dark swap under `prefers-color-scheme`, `color-scheme` meta, the brand
  mark as the hosted `https://gede.work/icon-192.png` (Gmail drops data URIs), body copy at
  16 px, the live amber on the code and nowhere else, one `<a>` at most, a footer that says
  why the mail arrived. No web fonts, no `@import`, no images beyond the mark.
- **Catalogue** (`src/messages/*.ts`): the same keys and `{placeholders}` in every locale
  (`catalogue.test.ts`), product names (GeDe, workscape, passkey) untranslated, voice per
  DESIGN-SYSTEM §6 (sentence case, no "!", buttons are verbs). A new string goes into all
  six files in the same PR.
- **Subjects** stay within `SUBJECT_MAX` (60): fixed subjects by test, share subjects by
  `subjectFor`, which trims the `{title}` on a grapheme boundary.
- **Cognito's placeholder** (`{####}`) is passed in as the `code` and must appear exactly
  once in the HTML and once in the text (`render.test.ts`); the HTML stays under 20,000
  characters.
- **Everything a person typed is escaped** in the HTML part (`escapeHtml`) and verbatim in the
  text part. `link` included.

## Commands

```bash
npm run generate -w packages/mail        # tokens.css → src/generated/palette.ts
npm test -w packages/mail                # catalogue, palette, i18n, render (+ file snapshots)
npx vitest run --project mail -u         # accept changed snapshots after a deliberate change
node packages/mail/scripts/screenshots.mjs   # docs/mail-previews/*.png from the snapshots
```

The snapshots in `src/__snapshots__` are the rendered mail per kind × locale (`.html` and
`.txt`); review a diff there like a diff in the templates.
