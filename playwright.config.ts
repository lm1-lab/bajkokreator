import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const MS_PLAYWRIGHT_DIR = '/opt/ms-playwright';
const SYSTEM_CHROME_PATH = '/usr/bin/google-chrome';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(MS_PLAYWRIGHT_DIR)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = MS_PLAYWRIGHT_DIR;
}

function resolveChromiumExecutablePath(): string | undefined {
  try {
    const defaultExecutable = chromium.executablePath();
    if (defaultExecutable && fs.existsSync(defaultExecutable)) {
      return undefined;
    }
  } catch {
    // Fall through to explicit binary discovery below.
  }

  if (fs.existsSync(MS_PLAYWRIGHT_DIR)) {
    const entries = fs
      .readdirSync(MS_PLAYWRIGHT_DIR)
      .filter((entry) => /^chromium-\d+$/.test(entry))
      .sort()
      .reverse();

    for (const entry of entries) {
      const candidates = [
        path.join(MS_PLAYWRIGHT_DIR, entry, 'chrome-linux64', 'chrome'),
        path.join(MS_PLAYWRIGHT_DIR, entry, 'chrome-linux', 'chrome'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  if (fs.existsSync(SYSTEM_CHROME_PATH)) {
    return SYSTEM_CHROME_PATH;
  }

  return undefined;
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100';
const executablePath = resolveChromiumExecutablePath();
const e2eDataDir =
  process.env.BAJKOKREATOR_DATA_DIR ||
  path.join(os.tmpdir(), 'bajkokreator-e2e-data');

const playwrightConfig = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 800 },
    locale: 'pl-PL',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
          ...(executablePath ? { executablePath } : {}),
        },
      },
    },
  ],
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'npx next start -p 3100',
          url: 'http://127.0.0.1:3100',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            BAJKOKREATOR_DATA_DIR: e2eDataDir,
            ...(process.env.BAJKOKREATOR_OPS_TOKEN
              ? { BAJKOKREATOR_OPS_TOKEN: process.env.BAJKOKREATOR_OPS_TOKEN }
              : {
                  BAJKOKREATOR_ALLOW_UNAUTHENTICATED_OPS:
                    process.env.BAJKOKREATOR_ALLOW_UNAUTHENTICATED_OPS ?? 'true',
                }),
          },
        },
      }),
});

export default playwrightConfig;
