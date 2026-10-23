import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run real conversions in a real browser against the
// production build (`npm run build` first). Set PW_CHROMIUM_PATH to use a
// preinstalled Chromium instead of Playwright's downloaded one.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: 'list',
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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } },
  ],
});
