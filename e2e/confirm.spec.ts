import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

test('mid-drag clear warning restores focus to the slider', async ({ page }) => {
  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBar())
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible({ timeout: 20_000 })
  await showTab(page, 'Adjust')
  await page.getByRole('checkbox', { name: 'Straighten shapes' }).click()
  const slider = page.getByRole('slider', { name: 'Line darkness' })

  await dragSlider(page, slider)
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect(slider).toBeFocused()

  await dragSlider(page, slider)
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.mouse.up()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(slider).toBeFocused()

  await dragSlider(page, slider)
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.mouse.up()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(slider).toBeFocused()
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
  const directory = mkdtempSync(join(tmpdir(), 'linekit-confirm-'))
  const path = join(directory, 'bar.png')
  writeFileSync(path, bytes)
  return path
}
