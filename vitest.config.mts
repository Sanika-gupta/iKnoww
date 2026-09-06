import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Scenario tests drive the simulator with compressed time; the whole suite
    // is expected to stay under a minute.
    testTimeout: 20_000,
  },
});
