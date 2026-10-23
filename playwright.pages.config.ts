import { defineConfig } from '@playwright/test';
import { projects } from './tests/playwright-projects';

/**
 * Tests the GitHub Pages build exactly as deployed: built with BASE_PATH
 * into dist-pages/ (`npm run build:pages`) and served under that subpath by
 * scripts/serve-pages.mjs, which mimics GitHub Pages (no extra headers, 404
 * outside the project path).
 */
const basePath = process.env.BASE_PATH ?? '/OpenConverter/';
const port = 4180;

export default defineConfig({
  testDir: 'tests/e2e-pages',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-pages' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}${basePath}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node scripts/serve-pages.mjs --dir dist-pages --base ${basePath} --port ${port}`,
    url: `http://localhost:${port}${basePath}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects,
});
