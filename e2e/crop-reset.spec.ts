import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CROP_HANDLE_LABELS, CROP_HANDLES } from '../src/frame-keys.ts'
import { encodePng } from '../src/image/png.ts'

const viewports = [
  { width: 1280, height: 720 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
] as const

for (const viewport of viewports) {
  test(`Reset crop stays clear of the crop handles at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Viewports are set by the test')

    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/linekit/')
    await page.locator('input[type="file"]').setInputFiles(await writeFrame())
    await expect(page.getByRole('img', { name: 'Traced line art' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'More controls' }).click()

    const crop = page.getByLabel('Crop rectangle')
    await expect(crop).toBeVisible()
    const shade = crop.locator('.crop-shade')
    const fullShade = await shade.getAttribute('d')
    expect(fullShade).toBeTruthy()

    await expectResetClearOfCrop(page, viewport)

    const box = await crop.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2)
    await page.mouse.up()
    expect(await shade.getAttribute('d')).not.toBe(fullShade)
    await expectResetClearOfCrop(page, viewport)

    await page.getByRole('button', { name: 'Reset crop' }).click()
    await expect(shade).toHaveAttribute('d', fullShade ?? '')
    await expectResetClearOfCrop(page, viewport)

    await page.getByRole('button', { name: 'Left crop edge' }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('checkbox', { name: 'Fix perspective' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Reset crop' })).toBeFocused()
  })
}

async function expectResetClearOfCrop(page: Page, viewport: { width: number; height: number }) {
  const reset = page.getByRole('button', { name: 'Reset crop' })
  await reset.scrollIntoViewIfNeeded()
  const resetBox = await reset.boundingBox()
  expect(resetBox, 'Reset crop').toBeTruthy()
  if (!resetBox) return

  const overlapped: string[] = []
  for (const handle of CROP_HANDLES) {
    const label = CROP_HANDLE_LABELS[handle]
    const handleBox = await page.getByRole('button', { name: label }).boundingBox()
    expect(handleBox, label).toBeTruthy()
    if (!handleBox) continue
    if (intersects(resetBox, handleBox)) overlapped.push(label)
  }
  expect(overlapped, `${viewport.width}x${viewport.height}`).toEqual([])

  const cropEdge = await page.locator('.crop-box-outer').boundingBox()
  expect(cropEdge, 'crop box').toBeTruthy()
  if (!cropEdge) return
  expect(intersects(resetBox, cropEdge), `${viewport.width}x${viewport.height} crop edge`).toBe(false)
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

type Box = { x: number; y: number; width: number; height: number }

async function writeFrame(): Promise<string> {
  const width = 360
  const height = 270
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  const bytes = await encodePng({ width, height, data })
  const directory = mkdtempSync(join(tmpdir(), 'linekit-crop-reset-'))
  const path = join(directory, 'frame.png')
  writeFileSync(path, bytes)
  return path
}
