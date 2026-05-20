// @ts-ignore
import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.scroll.test.ts',
  use: {
    headless: true,
  },
  // Ensure dist is built before running
  webServer: undefined,
});
