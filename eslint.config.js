import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dev-dist',
      'node_modules',
      'playwright-report',
      'test-results',
      'graphify-out',
      // Transient agent worktrees + local Claude state live under .claude/ and
      // are untracked; never lint their source copies (their paths don't match
      // the src/** exemption blocks below, so they'd false-positive).
      '.claude',
      // The CDK deploy app (issue 040) is a fully separate TS project with
      // its own package.json/tsconfig/lint setup — it is never linted by
      // the root gate (`npm run verify`), only by its own `deploy/cdk`
      // tooling in CI. See deploy/cdk/README.md.
      'deploy',
    ],
  },
  js.configs.recommended,
  // Type-aware linting (issue 020): the powerful no-unsafe-*/no-floating-promises
  // family that guards the "guarantee typesafety" goal.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `() => void somePromise()` in event handlers is idiomatic fire-and-forget.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Interpolating a number is safe and readable (`${index + 1}`).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Conflicts with a valid callback API shape: `() => Promise<boolean> | void`
      // (EditableGrid cell onCommit — a handler may fire-and-forget or await).
      '@typescript-eslint/no-invalid-void-type': 'off',
      // We prefer the explicit `firstOrThrow`/guard pattern over `!`, so don't
      // let this rule push `as T` casts toward non-null assertions.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
    },
  },
  // Classic, stable hooks rules only. react-hooks v7's compiler-based rules
  // (set-state-in-effect, refs, incompatible-library) false-positive on the
  // deliberate guided-start state machine and on TanStack Table, so we don't
  // adopt recommended-latest wholesale.
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // JS config files (eslint.config.js) aren't part of a TS program — turn the
  // type-checked rules off for them so the parser doesn't error.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  // Test stubs and jsdom polyfills (test/setup.ts) are legitimately empty no-ops.
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-empty-function': 'off' },
  },
  // jsdom polyfills patch APIs the DOM lib types say always exist, so the
  // feature-detection guards read as "always truthy" to the type-checker.
  {
    files: ['src/test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  {
    // Issue 001 acceptance criterion: components never touch the database
    // directly — all writes flow through the store's mutation layer.
    files: ['src/components/**/*.{ts,tsx}', 'src/App.tsx'],
    ignores: ['src/components/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // `**/db/**` (not `/db/*`) also catches deep imports like db/migrations/*.
              group: ['**/db/**'],
              message: 'Components must act through the store (src/store), not the db layer.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Issue 020: new UI flows through the shared primitive layer (src/components/ui).
    // Raw HTML controls and third-party UI libs are wrapped once in ui/, so they
    // are forbidden elsewhere in components. Scoped OUT of ui/ (where the wrapping
    // lives) and EditableGrid (the shared grid primitive that owns its own cells,
    // like a shadcn DataTable). Repeats the db pattern so this block — which wins
    // for these files — doesn't drop the layer-boundary rule.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/**',
      'src/components/**/*.test.{ts,tsx}',
      'src/components/EditableGrid.tsx',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/**'],
              message: 'Components must act through the store (src/store), not the db layer.',
              allowTypeImports: true,
            },
            {
              group: ['@radix-ui/*', 'cmdk'],
              message:
                'Wrap third-party UI primitives in src/components/ui and import from there, not directly.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: 'Use <Button> from @/components/ui/button, not a raw <button>.',
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message: 'Use <Input>/<InlineEdit>/<PhantomInput> from @/components/ui, not a raw <input>.',
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: 'Build a combobox from ui/command + ui/popover, not a raw <select>.',
        },
      ],
    },
  },
)
