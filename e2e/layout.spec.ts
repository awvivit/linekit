import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { encodePng } from '../src/image/png.ts'

const origin = 'http://127.0.0.1:4173'

const layouts = [
  { name: '375', width: 375, height: 812, tabs: true },
  { name: '390', width: 390, height: 844, tabs: true },
  { name: '768 portrait', width: 768, height: 1024, tabs: false },
  { name: '1024 landscape', width: 1024, height: 768, tabs: false },
  { name: '1280', width: 1280, height: 720, tabs: false },
] as const

for (const layout of layouts) {
  test(`layout at ${layout.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Viewports are set by the test')

    const foreign: string[] = []
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => {
      consoleErrors.push(error.message)
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin !== origin) foreign.push(request.url())
    })

    await page.setViewportSize({ width: layout.width, height: layout.height })
    await page.goto(`${origin}/linekit/`)

    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    expect(viewport ?? '').toContain('width=device-width')
    expect(viewport ?? '').toContain('viewport-fit=cover')
    expect(viewport ?? '').not.toMatch(/user-scalable\s*=\s*no/i)
    expect(viewport ?? '').not.toMatch(/maximum-scale\s*=\s*1(?:\.0+)?\b/i)

    const sample = await writeSketch()
    await page.locator('input[type="file"]').setInputFiles(sample)
    await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()

    if (layout.tabs) {
      await expect(page.getByRole('tablist', { name: 'Trace' })).toBeVisible()
      await expect(page.getByRole('tab')).toHaveCount(3)
      await expectPhoneLayout(page)
    } else {
      await expect(page.getByRole('tablist')).toHaveCount(0)
      await expectWideLayout(page)
    }

    expect(await overflowsX(page)).toBe(false)
    expect(consoleErrors).toEqual([])
    expect(foreign).toEqual([])

    if (process.env.LINEKIT_SCREENSHOTS === '1' && (layout.width === 375 || layout.width === 1280)) {
      await saveShots(page, layout.width)
    }
  })
}

async function expectPhoneLayout(page: Page) {
  const photoTab = page.getByRole('tab', { name: 'Photo', exact: true })
  const adjustTab = page.getByRole('tab', { name: 'Adjust', exact: true })
  const resultTab = page.getByRole('tab', { name: 'Result', exact: true })

  await expect(photoTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Photo' })).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Adjust' })).toBeHidden()
  await expect(adjustTab).toHaveAttribute('aria-controls', 'panel-adjust')

  const bar = await page.getByRole('tablist', { name: 'Trace' }).boundingBox()
  const viewport = page.viewportSize()
  expect(bar).toBeTruthy()
  expect(viewport).toBeTruthy()
  if (!bar || !viewport) return
  expect(Math.abs(bar.y + bar.height - viewport.height)).toBeLessThanOrEqual(1)
  expect(bar.width).toBeLessThanOrEqual(viewport.width + 1)

  const rules = await stylesheetText(page)
  expect(rules).toContain('safe-area-inset-bottom')
  expect(rules).toContain('safe-area-inset-left')
  expect(rules).toContain('safe-area-inset-right')

  const photoSrc = await page.getByRole('img', { name: 'Original photo' }).getAttribute('src')
  expect(photoSrc).toBeTruthy()
  await expectAlignedCrop(page)

  const shade = page.locator('.crop-shade')
  const fullShade = await shade.getAttribute('d')
  await drawCrop(page)
  const croppedShade = await shade.getAttribute('d')
  expect(croppedShade).toBeTruthy()
  expect(croppedShade).not.toBe(fullShade)

  await adjustTab.click()
  await expect(adjustTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Adjust' })).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Photo' })).toBeHidden()
  const live = page.getByRole('img', { name: 'Live preview' })
  await expect(live).toBeVisible({ timeout: 20_000 })
  const pin = await live.evaluate((element) => {
    const frame = element.closest('.live-preview')
    return frame ? getComputedStyle(frame).position : ''
  })
  expect(pin).toBe('sticky')
  const liveBox = await live.boundingBox()
  const slider = page.getByRole('slider', { name: 'Smoothing' })
  const sliderBox = await slider.boundingBox()
  expect(liveBox && sliderBox && liveBox.y < sliderBox.y).toBe(true)

  await slider.fill('73')
  await expect(slider).toHaveValue('73')
  await expectTapTargets(page)

  await resultTab.click()
  await expect(page.getByRole('tabpanel', { name: 'Result' })).toBeVisible()
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible()
  await expectTouchZoom(traced)
  await expectTapTargets(page)

  await photoTab.click()
  await expect(page.getByRole('img', { name: 'Original photo' })).toHaveAttribute('src', photoSrc ?? '')
  await expect(shade).toHaveAttribute('d', croppedShade ?? '')
  await expectTapTargets(page)

  await adjustTab.click()
  await expect(slider).toHaveValue('73')

  await photoTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(adjustTab).toBeFocused()
  await expect(adjustTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Adjust' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(resultTab).toBeFocused()
  await expect(resultTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(photoTab).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(resultTab).toBeFocused()
  await page.keyboard.press('Home')
  await expect(photoTab).toBeFocused()
  await expect(photoTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Tab')
  await expect(page.locator('input[type="file"]')).toBeFocused()

  await expect(page.getByRole('img', { name: 'Original photo' })).toHaveAttribute('src', photoSrc ?? '')
  expect(await overflowsX(page)).toBe(false)
  await adjustTab.click()
  await expect(slider).toHaveValue('73')
}

async function expectWideLayout(page: Page) {
  await expect(page.getByRole('img', { name: 'Original photo' })).toBeVisible()
  await expect(page.getByLabel('Crop rectangle')).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Line darkness' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Smoothing' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Remove specks' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Clean up lines' })).toBeVisible()
  const traced = page.getByRole('img', { name: 'Traced line art' })
  await expect(traced).toBeVisible({ timeout: 20_000 })
  await expectTouchZoom(traced)
  await expectAlignedCrop(page)

  const stages = page.locator('.stage')
  await expect(stages).toHaveCount(2)
  const photo = await stages.nth(0).boundingBox()
  const svg = await stages.nth(1).boundingBox()
  expect(photo).toBeTruthy()
  expect(svg).toBeTruthy()
  if (!photo || !svg) return
  expect(photo.height).toBeGreaterThan(120)
  expect(svg.height).toBeGreaterThan(120)
  expect(Math.abs(photo.width - svg.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(photo.height - svg.height)).toBeLessThanOrEqual(2)
  expect(svg.x).toBeGreaterThan(photo.x + photo.width - 2)
  const photoImg = await page.getByRole('img', { name: 'Original photo' }).boundingBox()
  const tracedBox = await traced.boundingBox()
  expect(photoImg).toBeTruthy()
  expect(tracedBox).toBeTruthy()
  if (photoImg && tracedBox) {
    expect(photoImg.width > photo.width * 0.9 || photoImg.height > photo.height * 0.9).toBe(true)
    expect(tracedBox.width > svg.width * 0.9 || tracedBox.height > svg.height * 0.9).toBe(true)
    expect(Math.abs(photoImg.height - tracedBox.height)).toBeLessThanOrEqual(8)
    expect(Math.abs(photoImg.width - tracedBox.width)).toBeLessThanOrEqual(8)
  }

  const photoSrc = await page.getByRole('img', { name: 'Original photo' }).getAttribute('src')
  const smoothing = page.getByRole('slider', { name: 'Smoothing' })
  await smoothing.fill('73')
  await page.getByRole('slider', { name: 'Line darkness' }).focus()
  await page.keyboard.press('Tab')
  await expect(smoothing).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('slider', { name: 'Remove specks' })).toBeFocused()
  await expect(smoothing).toHaveValue('73')
  await expect(page.getByRole('img', { name: 'Original photo' })).toHaveAttribute('src', photoSrc ?? '')
  await expect(traced).toBeVisible()

  const scrolling = await page.evaluate(() => {
    const root = document.documentElement
    return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1
  })
  expect(scrolling).toBe(false)
  await expectTapTargets(page)
}

async function expectTapTargets(page: Page) {
  const targets = page.locator(
    'button:visible, a:visible, input[type="range"]:visible, input[type="checkbox"]:visible, input[type="file"]:visible, [role="tab"]:visible',
  )
  const count = await targets.count()
  expect(count).toBeGreaterThan(0)
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index)
    const box = await target.boundingBox()
    const label = await target.evaluate((element) => element.getAttribute('aria-label') || element.id || element.tagName)
    expect(box, label).toBeTruthy()
    if (!box) continue
    expect(box.width, label).toBeGreaterThanOrEqual(44)
    expect(box.height, label).toBeGreaterThanOrEqual(44)
  }
}

async function expectAlignedCrop(page: Page) {
  const photo = await page.getByRole('img', { name: 'Original photo' }).boundingBox()
  const crop = await page.getByLabel('Crop rectangle').boundingBox()
  expect(photo).toBeTruthy()
  expect(crop).toBeTruthy()
  if (!photo || !crop) return
  expect(Math.abs(photo.x - crop.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(photo.y - crop.y)).toBeLessThanOrEqual(2)
  expect(Math.abs(photo.width - crop.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(photo.height - crop.height)).toBeLessThanOrEqual(2)
}

async function expectTouchZoom(traced: Locator) {
  const touch = await traced.evaluate((element) => getComputedStyle(element).touchAction)
  expect(touch).not.toBe('none')
  const cropTouch = await traced
    .page()
    .locator('.crop-layer')
    .evaluate((element) => getComputedStyle(element).touchAction)
  expect(cropTouch).toBe('none')
}

async function drawCrop(page: Page) {
  const crop = page.getByLabel('Crop rectangle')
  const box = await crop.boundingBox()
  if (!box) throw new Error('Crop rectangle has no box')
  await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.22)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.8)
  await page.mouse.up()
}

async function overflowsX(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
}

async function stylesheetText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const chunks: string[] = []
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) chunks.push(rule.cssText)
      } catch {
        chunks.push('')
      }
    }
    return chunks.join('\n')
  })
}

async function saveShots(page: Page, width: number) {
  const directory = '/opt/cursor/artifacts/screenshots'
  mkdirSync(directory, { recursive: true })
  if (width === 1280) {
    await page.screenshot({ path: join(directory, 'linekit-1280.png') })
    return
  }
  await page.getByRole('tab', { name: 'Photo', exact: true }).click()
  await page.screenshot({ path: join(directory, 'linekit-375-photo.png') })
  await page.getByRole('tab', { name: 'Adjust', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Live preview' })).toBeVisible()
  await page.screenshot({ path: join(directory, 'linekit-375-adjust.png') })
  await page.getByRole('tab', { name: 'Result', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Traced line art' })).toBeVisible()
  await page.screenshot({ path: join(directory, 'linekit-375-result.png') })
}

async function writeSketch(): Promise<string> {
  const width = 360
  const height = 270
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  line(data, width, height, 70, 150, 180, 70)
  line(data, width, height, 180, 70, 290, 150)
  line(data, width, height, 90, 150, 270, 150)
  line(data, width, height, 90, 150, 90, 230)
  line(data, width, height, 270, 150, 270, 230)
  line(data, width, height, 90, 230, 270, 230)
  line(data, width, height, 160, 230, 160, 180)
  line(data, width, height, 210, 230, 210, 180)
  line(data, width, height, 160, 180, 210, 180)
  const bytes = await encodePng({ width, height, data })
  const directory = mkdtempSync(join(tmpdir(), 'linekit-layout-'))
  const path = join(directory, 'sketch.png')
  writeFileSync(path, bytes)
  return path
}

function line(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps
    dot(data, width, height, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 4)
  }
}

function dot(data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue
      const index = (y * width + x) * 4
      data[index] = 22
      data[index + 1] = 22
      data[index + 2] = 22
      data[index + 3] = 255
    }
  }
}
