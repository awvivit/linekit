import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

test('a filter drag previews without clearing edits', async ({ page }) => {
  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBar())
  await expect(page.getByRole('img', { name: 'Traced line art' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'More controls' }).click()
  await page.getByRole('checkbox', { name: 'Straighten shapes' }).click()
  const slider = page.getByRole('slider', { name: 'Pick up faint lines' })
  const undo = page.getByRole('button', { name: 'Undo' })
  await expect(undo).toBeEnabled()

  await dragSlider(page, slider)
  await page.mouse.up()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
  await expect(undo).toBeEnabled()
  await expect(slider).not.toHaveValue('62')
})

async function dragSlider(page: Page, slider: Locator) {
  const box = await slider.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 8, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 8, y, { steps: 10 })
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
  const directory = mkdtempSync(join(tmpdir(), 'linekit-confirm-'))
  const path = join(directory, 'bar.png')
  writeFileSync(path, bytes)
  return path
}
