import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

test('mouse-drag erase leaves a mark and can be undone', async ({ page }) => {
  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBar())
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible({ timeout: 20_000 })
  await expect(traced).toHaveAttribute('draggable', 'false')

  await page.getByRole('button', { name: 'More controls' }).click()
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()
  await page.getByRole('button', { name: 'Eraser' }).click()
  await traced.scrollIntoViewIfNeeded()
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
  const undo = page.getByRole('button', { name: 'Undo' })
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(page.getByRole('figure', { name: 'SVG' }).locator('.eraser-stroke')).toHaveCount(0)
  await expect(undo).toBeDisabled()
})

test('touch erase uses the pointer path and can be undone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Touch is covered by the mobile project')
  await page.goto('/linekit/')
  await page.locator('input[type="file"]').setInputFiles(await writeBar())
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'More controls' }).click()
  await page.getByRole('button', { name: 'Eraser' }).click()
  await traced.scrollIntoViewIfNeeded()
  const box = await traced.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  const y = box.y + box.height / 2
  const start = box.x + box.width * 0.25
  const end = box.x + box.width * 0.75
  await traced.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 4,
    isPrimary: true,
    buttons: 1,
    clientX: start,
    clientY: y,
  })
  await traced.dispatchEvent('pointermove', {
    pointerType: 'touch',
    pointerId: 4,
    isPrimary: true,
    buttons: 1,
    clientX: end,
    clientY: y,
  })
  await traced.dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 4,
    isPrimary: true,
    buttons: 0,
    clientX: end,
    clientY: y,
  })
  const mark = page.getByRole('figure', { name: 'SVG' }).locator('.eraser-stroke')
  await expect(mark).toHaveAttribute('points', /\d/)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(mark).toHaveCount(0)
})

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
