import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 90000,
  expect: {timeout: 15000},
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
    viewport: {width: 1440, height: 1040},
    launchOptions: {executablePath: process.env.PLAYWRIGHT_EXECUTABLE || (existsSync(edge) ? edge : undefined)},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
