import { defineConfig, devices } from '@playwright/test';

// An optional executable override is useful on constrained CI machines.
// Normally Playwright's own installed browsers are used unchanged.
const chromiumExecutable = process.env.PDF_TEST_CHROMIUM_PATH;
const chromiumLaunchOptions = chromiumExecutable
  ? { executablePath: chromiumExecutable, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
  : undefined;

export default defineConfig({
  testDir: './tests/integration',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
