import { defineConfig } from '@playwright/test';

/**
 * Browser tests run against the BUILT static viewer served by `vite preview`: no API, worker,
 * database, MCP server or model is running, which is exactly the claim under test.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite preview --config web/vite.config.ts --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
