import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { REBUILD_CONFIRM_MESSAGE } from './image/limits.ts'
import { encodePng } from './image/png.ts'

describe('pointer crop undo', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('records a multi-move mouse drag as one undo step', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      const crop = screen.getByLabelText('Crop rectangle')
      giveBox(crop)
      const shade = () => crop.querySelector('.crop-shade')?.getAttribute('d')
      const fullShade = shade()
      const undo = screen.getByRole('button', { name: 'Undo' })
      const redo = screen.getByRole('button', { name: 'Redo' })
      expect(undo).toBeDisabled()
      expect(redo).toBeDisabled()

      dragCrop(crop, [
        [10, 12],
        [18, 20],
        [28, 32],
        [40, 44],
        [55, 58],
        [70, 66],
        [84, 78],
      ])
      const dragged = shade()
      expect(dragged).not.toBe(fullShade)
      expect(undo).toBeEnabled()
      expect(redo).toBeDisabled()

      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
      expect(redo).toBeEnabled()

      fireEvent.click(redo)
      expect(shade()).toBe(dragged)
      expect(redo).toBeDisabled()
      expect(undo).toBeEnabled()

      fireEvent.keyDown(crop, { key: 'z', ctrlKey: true })
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
      fireEvent.keyDown(crop, { key: 'z', ctrlKey: true, shiftKey: true })
      expect(shade()).toBe(dragged)
      expect(redo).toBeDisabled()

      dragCrop(crop, [
        [40, 40],
        [46, 44],
        [52, 49],
        [58, 54],
      ])
      const moved = shade()
      expect(moved).not.toBe(dragged)
      fireEvent.click(undo)
      expect(shade()).toBe(dragged)
      expect(undo).toBeEnabled()
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('adds no undo step when the drag ends where it started', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      const crop = screen.getByLabelText('Crop rectangle')
      giveBox(crop)
      const shade = () => crop.querySelector('.crop-shade')?.getAttribute('d')
      const fullShade = shade()
      const undo = screen.getByRole('button', { name: 'Undo' })

      dragCrop(crop, [[16, 18]])
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()

      dragCrop(crop, [
        [14, 16],
        [30, 36],
        [48, 52],
        [14, 16],
      ])
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()

      const edge = screen.getByRole('button', { name: 'Left crop edge' })
      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      const nudged = shade()
      expect(nudged).not.toBe(fullShade)
      dragCrop(crop, [
        [50, 50],
        [62, 58],
        [70, 64],
        [50, 50],
      ])
      expect(shade()).toBe(nudged)
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('records a touch drag as one undo step', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      const crop = screen.getByLabelText('Crop rectangle')
      giveBox(crop)
      const shade = () => crop.querySelector('.crop-shade')?.getAttribute('d')
      const fullShade = shade()
      const undo = screen.getByRole('button', { name: 'Undo' })
      const redo = screen.getByRole('button', { name: 'Redo' })

      dragCrop(
        crop,
        [
          [12, 14],
          [22, 24],
          [36, 40],
          [51, 55],
          [68, 72],
        ],
        'touch',
      )
      const dragged = shade()
      expect(dragged).not.toBe(fullShade)
      expect(undo).toBeEnabled()

      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
      expect(redo).toBeEnabled()

      fireEvent.click(redo)
      expect(shade()).toBe(dragged)
      expect(redo).toBeDisabled()

      fireEvent.keyDown(crop, { key: 'z', ctrlKey: true })
      expect(shade()).toBe(fullShade)
      fireEvent.keyDown(crop, { key: 'z', ctrlKey: true, shiftKey: true })
      expect(shade()).toBe(dragged)

      const edge = screen.getByRole('button', { name: 'Left crop edge' })
      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      expect(shade()).not.toBe(dragged)
      fireEvent.keyDown(edge, { key: 'Escape' })
      expect(shade()).toBe(dragged)
      expect(undo).toBeEnabled()
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('keeps the rebuild confirm when a drag would clear edits', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Straighten shapes' }))
      const crop = screen.getByLabelText('Crop rectangle')
      giveBox(crop)
      const shade = () => crop.querySelector('.crop-shade')?.getAttribute('d')
      const fullShade = shade()
      const undo = screen.getByRole('button', { name: 'Undo' })
      const straighten = screen.getByRole('checkbox', { name: 'Straighten shapes' })

      dragCrop(crop, [
        [10, 12],
        [24, 30],
        [48, 55],
        [80, 76],
      ])
      expect(screen.getByRole('alertdialog', { name: REBUILD_CONFIRM_MESSAGE })).toBeInTheDocument()
      expect(shade()).toBe(fullShade)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(shade()).toBe(fullShade)
      expect(straighten).toBeChecked()
      fireEvent.click(undo)
      expect(straighten).not.toBeChecked()
      expect(undo).toBeDisabled()
      expect(shade()).toBe(fullShade)

      fireEvent.click(straighten)
      dragCrop(crop, [
        [12, 16],
        [30, 34],
        [52, 58],
        [70, 74],
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(shade()).not.toBe(fullShade)
      expect(straighten).toBeChecked()
      expect(undo).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('records one undo step when the drag ends with pointercancel', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      const crop = screen.getByLabelText('Crop rectangle')
      giveBox(crop)
      const shade = () => crop.querySelector('.crop-shade')?.getAttribute('d')
      const fullShade = shade()
      const undo = screen.getByRole('button', { name: 'Undo' })
      const redo = screen.getByRole('button', { name: 'Redo' })

      dragCrop(
        crop,
        [
          [11, 13],
          [24, 28],
          [41, 46],
          [63, 70],
        ],
        'mouse',
        'cancel',
      )
      const dragged = shade()
      expect(dragged).not.toBe(fullShade)

      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
      fireEvent.click(redo)
      expect(shade()).toBe(dragged)
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })
})

function dragCrop(
  crop: Element,
  points: ReadonlyArray<readonly [number, number]>,
  pointerType: 'mouse' | 'touch' = 'mouse',
  end: 'up' | 'cancel' = 'up',
) {
  const first = points[0]
  if (!first) throw new Error('drag needs a point')
  const pointer = { pointerId: 1, pointerType }
  fireEvent.pointerDown(crop, { ...pointer, clientX: first[0], clientY: first[1] })
  for (const point of points.slice(1)) {
    fireEvent.pointerMove(crop, { ...pointer, clientX: point[0], clientY: point[1] })
  }
  const last = points[points.length - 1] ?? first
  const finish = end === 'cancel' ? fireEvent.pointerCancel : fireEvent.pointerUp
  finish(crop, { ...pointer, clientX: last[0], clientY: last[1] })
}

function openMore() {
  const button = screen.getByRole('button', { name: 'More controls' })
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
}

function silentWorker() {
  return class FakeWorker extends EventTarget {
    postMessage(data: { kind: string; id: number }) {
      if (data.kind !== 'load') return
      this.dispatchEvent(
        new MessageEvent('message', {
          data: { kind: 'loaded', id: data.id, width: 2, height: 2, preview: new ArrayBuffer(8) },
        }),
      )
    }

    terminate() {}
  }
}

function giveBox(element: Element, width = 100, height = 100) {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {}
      },
    }) as DOMRect
}

async function openBlankPhoto(): Promise<void> {
  const data = new Uint8ClampedArray(16).fill(255)
  const png = await encodePng({ width: 2, height: 2, data })
  const file = new File([new Uint8Array(png)], 'drawing.png', { type: 'image/png' })
  const input = screen.getByLabelText(/choose a photo or drop it here/i)
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  fireEvent.change(input)
  await act(async () => {
    await Promise.resolve()
  })
}
