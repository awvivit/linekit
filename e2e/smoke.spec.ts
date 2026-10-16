import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

const SECRET = 'LKSECRET_GPS_37.8199_-122.4783_vacation-gps-photo'

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
  await expect(page.getByText('Linekit traces images only in your browser.')).toBeVisible()

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

test('traces an uploaded drawing and downloads an SVG with no photo metadata', async ({ page }) => {
  const consoleErrors: string[] = []
  const foreignRequests: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message)
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin) foreignRequests.push(request.url())
  })

  const sample = await writeSample()
  await page.goto(`${origin}/linekit/`)
  await page.locator('input[type="file"]').setInputFiles(sample)

  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()
  await expect(page.getByLabel('Crop rectangle')).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Line darkness' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Smoothing' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Remove specks' })).toBeVisible()
  const preview = page.getByRole('img', { name: 'Traced line art' })
  await expect(preview).toBeVisible({ timeout: 20_000 })
  await expect(preview).toHaveAttribute('src', /^blob:/)

  await page.getByRole('slider', { name: 'Smoothing' }).fill('60')
  await expect(preview).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download .svg' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('linekit.svg')
  const svgPath = await download.path()
  expect(svgPath).toBeTruthy()
  const svg = readFileSync(svgPath ?? '', 'utf8')
  expect(svg).toContain('<svg')
  expect(svg).toContain('<path')
  expect(svg.toLowerCase()).not.toContain('<script')
  expect(svg.toLowerCase()).not.toContain('foreignobject')
  expect(svg.toLowerCase()).not.toContain('<image')
  expect(svg.toLowerCase()).not.toContain('<metadata')
  expect(svg.toLowerCase()).not.toContain('<title')
  expect(svg.toLowerCase()).not.toContain('<desc')
  expect(svg).not.toContain('<!--')
  expect(svg.toLowerCase()).not.toContain('base64')
  expect(svg).not.toContain(SECRET)
  expect(svg).not.toContain('vacation-gps-photo')
  expect(svg).not.toContain('37.8199')

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(overflows).toBe(false)
  expect(consoleErrors).toEqual([])
  expect(foreignRequests).toEqual([])
})

async function writeSample(): Promise<string> {
  const width = 96
  const height = 64
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  for (let y = 22; y < 42; y += 1) {
    for (let x = 16; x < 80; x += 1) {
      const index = (y * width + x) * 4
      data[index] = 0
      data[index + 1] = 0
      data[index + 2] = 0
    }
  }
  const bytes = await encodePng(
    { width, height, data },
    { text: [{ keyword: 'Comment', value: SECRET }] },
  )
  const directory = mkdtempSync(join(tmpdir(), 'linekit-'))
  const path = join(directory, 'vacation-gps-photo.png')
  writeFileSync(path, bytes)
  return path
}
