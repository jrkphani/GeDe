import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'playwright-report', 'test-results', 'graphify-out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
              group: ['**/db/*'],
              message: 'Components must act through the store (src/store), not the db layer.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
)
