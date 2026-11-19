import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

const shots = '/opt/cursor/artifacts'

test('keyboard reaches perspective corners, crop handles, and traced lines', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message)
  })

  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBars())
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'More controls' }).click()
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()

  const crop = page.getByLabel('Crop rectangle')
  const shade = () => crop.locator('.crop-shade').getAttribute('d')
  const fullShade = await shade()
  await page.getByRole('button', { name: 'Copy SVG code' }).focus()
  await page.keyboard.press('Tab')
  const topLeftCrop = page.getByRole('button', { name: 'Top-left crop' })
  await expect(topLeftCrop).toBeFocused()
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowRight')
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.keyboard-live')).toHaveText('Top-left crop, 20% across, 20% down.')
  if (testInfo.project.name === 'desktop') {
    mkdirSync(shots, { recursive: true })
    await page.locator('.original-stage').screenshot({ path: join(shots, 'linekit-keyboard-crop.png') })
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.keyboard-live')).toHaveText('Crop cancelled.')
  expect(await shade()).toBe(fullShade)

  const box = await crop.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7)
  await page.mouse.up()
  expect(await shade()).not.toBe(fullShade)

  await page.getByRole('button', { name: 'Reset crop' }).click()
  expect(await shade()).toBe(fullShade)

  await page.getByRole('checkbox', { name: 'Fix perspective' }).click()
  await page.getByRole('button', { name: 'Copy SVG code' }).focus()
  await page.keyboard.press('Tab')
  const corner = page.getByRole('button', { name: 'Top-left corner' })
  await expect(corner).toBeFocused()
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowRight')
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowDown')
  await expect(corner).toHaveAttribute('data-x', '0.2')
  await expect(corner).toHaveAttribute('data-y', '0.2')
  await expect(page.locator('.keyboard-live')).toHaveText('Top-left corner, 20% across, 20% down.')
  if (testInfo.project.name === 'desktop') {
    await page.locator('.original-stage').screenshot({ path: join(shots, 'linekit-keyboard-corner.png') })
  }
  const undo = page.getByRole('button', { name: 'Undo' })
  for (let step = 0; step < 8; step += 1) await undo.click()
  await expect(corner).toHaveAttribute('data-x', '0')
  await expect(corner).toHaveAttribute('data-y', '0')

  const lines = page.getByRole('radio', { name: 'Lines', exact: true })
  if ((await lines.getAttribute('aria-checked')) !== 'true') {
    await lines.click()
  }
  const preview = page.getByRole('listbox', { name: 'Traced lines' })
  await expect(preview).toBeVisible({ timeout: 20_000 })
  await page.getByRole('radio', { name: 'Lines', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(preview).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const selected = preview.locator('.selected-stroke')
  await expect(selected).toHaveCount(1)
  await expect(page.locator('.keyboard-live')).toContainText('selected.')
  if (testInfo.project.name === 'desktop') {
    await page.locator('.result-figure').screenshot({ path: join(shots, 'linekit-keyboard-line.png') })
  }
  await page.keyboard.press('Escape')
  await expect(selected).toHaveCount(0)
  await expect(page.locator('.keyboard-live')).toHaveText('Selection cleared.')
  expect(consoleErrors).toEqual([])
})

async function writeBars(): Promise<string> {
  const width = 240
  const height = 120
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  fill(data, width, 24, 28, 200, 48)
  fill(data, width, 24, 76, 200, 96)
  const bytes = await encodePng({ width, height, data })
  const directory = mkdtempSync(join(tmpdir(), 'linekit-keys-'))
  const path = join(directory, 'bars.png')
  writeFileSync(path, bytes)
  return path
}

function fill(data: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * width + x) * 4
      data[index] = 12
      data[index + 1] = 12
      data[index + 2] = 12
      data[index + 3] = 255
    }
  }
}
