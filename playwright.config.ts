import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

/**
 * Конфигурация Playwright для E2E тестов Electron приложения
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Electron приложение должно запускаться последовательно
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Один воркер для Electron
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

