import { defineConfig } from '@playwright/test';

/**
 * Regenerates tests/fixtures/images.ts (base64-encoded image fixtures).
 * Run with: npx playwright test -c tests/fixtures/playwright.fixtures.config.ts
 * Uses Chromium's encoders (WebKit cannot encode WebP).
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'generate-fixtures.spec.ts',
  use: { browserName: 'chromium', launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined } },
});
