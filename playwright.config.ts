import { defineConfig } from '@playwright/test';
import { projects } from './tests/playwright-projects';

/**
 * End-to-end tests against the production build served at "/"
 * (`npm run build` first). For the GitHub Pages subpath build see
 * playwright.pages.config.ts.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects,
});
