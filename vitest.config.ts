import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Point every test file at a throwaway state directory, so no test can
    // write into the user's real ~/.claudekishmish.
    setupFiles: ['test/setup.ts'],
  },
});
