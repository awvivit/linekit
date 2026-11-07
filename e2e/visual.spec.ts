import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Raster } from '../src/image/limits.ts'
import { encodePng } from '../src/image/png.ts'
import { cartoonSample, tileSample } from '../src/image/samples.ts'

const directory = '/opt/cursor/artifacts'

test('captures Auto, Full trace, More controls, and before-and-after views', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Viewports are set inside this test')
  mkdirSync(directory, { recursive: true })
  const cartoon = await writeRaster(cartoonSample(), 'cartoon.png')
  const tiles = await writeRaster(tileSample(), 'tiles.png')

  await shoot(page, cartoon, 'cartoon', { width: 1280, height: 800 })
  await shoot(page, cartoon, 'cartoon', { width: 390, height: 844 })
  await shoot(page, tiles, 'tiles', { width: 1280, height: 800 })
  await shoot(page, tiles, 'tiles', { width: 390, height: 844 })
})

async function shoot(page: Page, file: string, art: 'cartoon' | 'tiles', viewport: { width: number; height: number }) {
  const suffix = viewport.width < 768 ? 'mobile' : 'desktop'
  await page.setViewportSize(viewport)
  await page.goto('/linekit/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.locator('input[type="file"]').setInputFiles(file)
  const note = page.locator('#auto-choice')
  await expect(note).toContainText('Auto picked Full trace with', { timeout: 20_000 })
  await expect(note).toContainText('colors')
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('img', { name: 'Traced line art' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Export' })).toBeVisible()
  if (art === 'cartoon') {
    await page.screenshot({ path: join(directory, `linekit-auto-simple-${suffix}.png`) })
    await page.getByRole('radio', { name: 'Full trace', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Full trace', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(note).toContainText('Auto picked Full trace with')
    await page.screenshot({ path: join(directory, `linekit-full-trace-${suffix}.png`) })
  }
  await page.getByRole('button', { name: 'More controls' }).click()
  const colors = page.getByRole('slider', { name: 'Number of colors' })
  const reset = page.getByRole('button', { name: 'Reset controls to Auto' })
  await expect(colors).toBeVisible()
  await expect(reset).toBeVisible()
  if (art === 'cartoon') {
    await page.locator('#more-controls').screenshot({ path: join(directory, `linekit-more-controls-${suffix}.png`) })
  }
  await page.getByRole('img', { name: 'Original photo' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Traced line art' })).toBeVisible()
  await page.screenshot({
    path: join(directory, `linekit-compare-${art}-${suffix}.png`),
    fullPage: viewport.width < 768,
  })
}

async function writeRaster(raster: Raster, name: string): Promise<string> {
  const bytes = await encodePng(raster)
  const folder = mkdtempSync(join(tmpdir(), 'linekit-visual-'))
  const path = join(folder, name)
  writeFileSync(path, bytes)
  return path
}
