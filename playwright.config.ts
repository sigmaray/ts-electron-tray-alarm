import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright configuration for Electron E2E tests
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run Electron tests sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Use one worker for Electron
  reporter: 'html',
  use: {
    baseURL: 'file://',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 800, height: 900 },
  },

  projects: [
    {
      name: 'electron',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 800, height: 900 },
      },
    },
  ],
});

