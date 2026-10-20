import { defineConfig } from 'vitest/config';

/** The panel's tests render React in a DOM; everything else stays in Node. */
const UI_TESTS = '.dork/extensions/**/ui/__tests__/**/*.test.ts';

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'node',
          include: ['.dork/extensions/**/__tests__/**/*.test.ts'],
          exclude: [UI_TESTS, '**/node_modules/**'],
          globals: false,
        },
      },
      {
        test: {
          name: 'dom',
          include: [UI_TESTS],
          environment: 'jsdom',
          setupFiles: ['.dork/extensions/roadmap/ui/__tests__/setup.ts'],
          globals: false,
        },
      },
    ],
  },
});
