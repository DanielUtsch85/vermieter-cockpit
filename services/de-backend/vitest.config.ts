import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Drops the per-file test schemas after all files ran (see the file for why not per file).
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
