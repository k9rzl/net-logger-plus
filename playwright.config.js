import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from 'playwright/test';

// One throw-away data directory per run, shared with the worker processes through the environment.
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-e2e-'));

const APP = 'http://127.0.0.1:3200';
const QRZ = 'http://127.0.0.1:3201';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  workers: 1, // tests share one server and hand out unique callsigns from a counter
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: APP,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-qrz.js',
      url: `${QRZ}/health`,
      reuseExistingServer: false,
      env: { FAKE_QRZ_PORT: '3201' },
    },
    {
      command: 'node src/server.js',
      url: `${APP}/api/me`,
      reuseExistingServer: false,
      env: {
        PORT: '3200',
        BASE_URL: APP,
        DEV_LINKS: '1',
        TRUST_PROXY: '1', // lets each test identify itself with X-Forwarded-For, so rate limits stay per-test
        DATA_FILE: path.join(process.env.E2E_DATA_DIR, 'db.json'),
        QRZ_USERNAME: 'e2e',
        QRZ_PASSWORD: 'e2e',
        QRZ_BASE_URL: `${QRZ}/xml/current/`,
        // Make sure a developer's local .env cannot redirect the test run at real services.
        MONGODB_URI: '',
        MAIL_WEBHOOK_URL: '',
        QRZ_REQUIRE: '0',
        NODE_ENV: 'development',
        SESSION_SECRET: '',
      },
    },
  ],
});
