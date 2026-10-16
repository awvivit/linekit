import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:4173'

test('loads under /linekit/ with no console errors or foreign requests', async ({ page }) => {
  const consoleErrors: string[] = []
  const foreignRequests: string[] = []
  const failedRequests: string[] = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message)
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      foreignRequests.push(request.url())
    }
  })
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`.trim())
  })

  const response = await page.goto(`${origin}/linekit/`)
  expect(response?.ok()).toBe(true)

  await expect(page.getByRole('heading', { level: 1, name: 'Linekit' })).toBeVisible()
  await expect(
    page.getByText(
      "Linekit is being built to process images only in your browser. This early version doesn't trace images yet.",
    ),
  ).toBeVisible()

  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(policy).toContain("default-src 'self'")
  expect(policy).toContain("script-src 'self'")
  expect(policy).not.toContain('unsafe-inline')
  expect(policy).not.toContain('unsafe-eval')
  expect(policy ?? '').not.toMatch(/https?:/)

  const headHtml = await page.locator('head').innerHTML()
  const policyIndex = headHtml.indexOf('Content-Security-Policy')
  const scriptIndex = headHtml.indexOf('<script')
  expect(policyIndex).toBeGreaterThan(-1)
  expect(scriptIndex).toBeGreaterThan(policyIndex)

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(overflows).toBe(false)

  expect(await page.locator('script:not([src])').count()).toBe(0)
  expect(await page.locator('style').count()).toBe(0)
  expect(page.url().startsWith(`${origin}/linekit/`)).toBe(true)
  expect(consoleErrors).toEqual([])
  expect(foreignRequests).toEqual([])
  expect(failedRequests).toEqual([])
})
