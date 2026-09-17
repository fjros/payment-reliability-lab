import { defineConfig } from 'vitest/config';

const dockerBacked = {
  globalSetup: ['tests/harness/global-postgres.ts'],
  testTimeout: 60_000,
  hookTimeout: 120_000,
};

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], ...dockerBacked } },
      { test: { name: 'mcp', include: ['tests/mcp/**/*.test.ts'], ...dockerBacked } },
    ],
  },
});
