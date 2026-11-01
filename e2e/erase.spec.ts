import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

test('mouse-drag erase leaves a mark and can be undone', async ({ page }) => {
  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBar())
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible({ timeout: 20_000 })
  await showTab(page, 'Result')
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible({ timeout: 20_000 })
  await expect(traced).toHaveAttribute('draggable', 'false')

  await showTab(page, 'Adjust')
  await page.getByRole('button', { name: 'Eraser' }).click()
  await showTab(page, 'Result')
  const box = await traced.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 12 })
  await page.mouse.up()

  const mark = page.getByRole('figure', { name: 'SVG' }).locator('.eraser-stroke')
  await expect(mark).toHaveAttribute('points', /\d/)
  await expect.poll(async () => mark.evaluate((node) => (node as SVGGeometryElement).getBBox().width)).toBeGreaterThan(8)
  await showTab(page, 'Adjust')
  const undo = page.getByRole('button', { name: 'Undo' })
  await expect(undo).toBeEnabled()
  await undo.click()
  await showTab(page, 'Result')
  await expect(page.getByRole('figure', { name: 'SVG' }).locator('.eraser-stroke')).toHaveCount(0)
  await showTab(page, 'Adjust')
  await expect(undo).toBeDisabled()
})

async function showTab(page: Page, name: 'Adjust' | 'Result') {
  const tab = page.getByRole('tab', { name, exact: true })
  if ((await tab.count()) === 0) return
  if ((await tab.getAttribute('aria-selected')) === 'true') return
  await tab.click()
}

async function writeBar(): Promise<string> {
  const width = 120
  const height = 48
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  for (let y = 18; y < 30; y += 1) {
    for (let x = 12; x < 108; x += 1) {
      const index = (y * width + x) * 4
      data[index] = 0
      data[index + 1] = 0
      data[index + 2] = 0
    }
  }
  const bytes = await encodePng({ width, height, data })
  const directory = mkdtempSync(join(tmpdir(), 'linekit-erase-'))
  const path = join(directory, 'bar.png')
  writeFileSync(path, bytes)
  return path
}
