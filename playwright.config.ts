import { defineConfig, devices } from '@playwright/test'

const desktop = devices['Desktop Chrome']
const mobile = devices['Pixel 5']
if (!desktop || !mobile) {
  throw new Error('Playwright device descriptors are missing')
}

const origin = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `${origin}/linekit/`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: `${origin}/linekit/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...desktop } },
    { name: 'mobile', use: { ...mobile } },
  ],
})
