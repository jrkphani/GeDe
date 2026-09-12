import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mail',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
