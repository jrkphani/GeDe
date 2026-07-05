import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'playwright-report', 'test-results', 'graphify-out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
