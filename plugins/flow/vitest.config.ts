import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['engine-tests/**/*.test.ts', '.dork/extensions/**/__tests__/**/*.test.ts'],
    globals: false,
  },
});
