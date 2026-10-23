import { devices, type Project } from '@playwright/test';

/**
 * Browser projects shared by the root and GitHub Pages (subpath) suites.
 * PW_CHROMIUM_PATH lets a preinstalled Chromium be used instead of
 * Playwright's download. Firefox and WebKit need `npx playwright install`.
 */
const chromiumPath = process.env.PW_CHROMIUM_PATH || undefined;

export const projects: Project[] = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: chromiumPath } } },
  { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: { executablePath: chromiumPath } } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
];
