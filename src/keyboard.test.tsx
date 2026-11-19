import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { REBUILD_CONFIRM_MESSAGE } from './image/limits.ts'
import { encodePng } from './image/png.ts'

describe('keyboard trace controls', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('moves a perspective corner with arrows, clamps it, and undoes it', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = HTMLElement.prototype.setPointerCapture
    HTMLElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      const corner = screen.getByRole('button', { name: 'Top-left corner' })
      expect(corner).toHaveAttribute('tabindex', '0')
      expect(screen.getByRole('button', { name: 'Bottom-right corner' })).toBeInTheDocument()

      const quad = () => screen.getByLabelText('Crop rectangle').querySelector('.perspective-quad')?.getAttribute('points')
      const undo = screen.getByRole('button', { name: 'Undo' })
      expect(quad()).toBe('0,0 1,0 1,1 0,1')
      fireEvent.keyDown(corner, { key: 'ArrowLeft' })
      expect(quad()).toBe('0,0 1,0 1,1 0,1')
      fireEvent.click(undo)
      expect(screen.queryByRole('button', { name: 'Top-left corner' })).not.toBeInTheDocument()
      expect(undo).toBeDisabled()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      const moved = screen.getByRole('button', { name: 'Top-left corner' })
      fireEvent.keyDown(moved, { key: 'ArrowRight' })
      expect(moved).toHaveAttribute('data-x', '0.01')
      expect(quad()).toBe('0.01,0 1,0 1,1 0,1')
      expect(screen.getByText('Top-left corner, 1% across, 0% down.')).toBeInTheDocument()

      fireEvent.keyDown(moved, { key: 'ArrowRight', shiftKey: true })
      expect(moved).toHaveAttribute('data-x', '0.06')
      fireEvent.click(undo)
      expect(moved).toHaveAttribute('data-x', '0.01')
      fireEvent.click(undo)
      expect(quad()).toBe('0,0 1,0 1,1 0,1')
      fireEvent.click(undo)
      expect(undo).toBeDisabled()
    } finally {
      HTMLElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('keeps a keyboard corner move when Reset restores the sliders', async () => {
    const previousWorker = globalThis.Worker
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      openMore()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      const corner = screen.getByRole('button', { name: 'Top-left corner' })
      fireEvent.keyDown(corner, { key: 'ArrowDown', shiftKey: true })
      const smoothing = screen.getByRole('slider', { name: 'Smoothing' })
      fireEvent.change(smoothing, { target: { value: '70' } })
      fireEvent.click(screen.getByRole('button', { name: 'Reset controls to Auto' }))
      expect(smoothing).toHaveValue('28')
      expect(corner).toHaveAttribute('data-y', '0.05')
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(corner).toHaveAttribute('data-y', '0')
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('adjusts crop handles from the keyboard and cancels with Escape', async () => {
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
      const fullShade = crop.querySelector('.crop-shade')?.getAttribute('d')
      const edge = screen.getByRole('button', { name: 'Left crop edge' })
      expect(edge).toHaveAttribute('tabindex', '0')
      expect(screen.getByRole('button', { name: 'Top crop edge' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Top-left crop corner' })).toBeInTheDocument()

      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(fullShade)
      expect(screen.getByText('Left crop edge, 1% across.')).toBeInTheDocument()
      fireEvent.keyDown(edge, { key: 'Escape' })
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).toBe(fullShade)
      expect(screen.getByText('Crop cancelled.')).toBeInTheDocument()

      fireEvent.keyDown(edge, { key: 'ArrowRight', shiftKey: true })
      const shifted = crop.querySelector('.crop-shade')?.getAttribute('d')
      expect(shifted).not.toBe(fullShade)
      fireEvent.keyDown(edge, { key: 'Enter' })
      fireEvent.keyDown(edge, { key: 'Escape' })
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).toBe(shifted)

      fireEvent.pointerDown(crop, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(crop, { clientX: 80, clientY: 70, pointerId: 1 })
      fireEvent.pointerUp(crop, { pointerId: 1 })
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(shifted)
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('records each crop key press as one undo step', async () => {
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
      const edge = screen.getByRole('button', { name: 'Left crop edge' })
      const undo = screen.getByRole('button', { name: 'Undo' })
      const redo = screen.getByRole('button', { name: 'Redo' })
      expect(undo).toBeDisabled()
      expect(redo).toBeDisabled()

      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      fireEvent.keyDown(edge, { key: 'ArrowRight' })
      const nudged = shade()
      expect(nudged).not.toBe(fullShade)
      expect(undo).toBeEnabled()

      fireEvent.click(undo)
      fireEvent.click(undo)
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
      expect(redo).toBeEnabled()

      fireEvent.click(redo)
      fireEvent.click(redo)
      fireEvent.click(redo)
      expect(shade()).toBe(nudged)
      expect(redo).toBeDisabled()

      fireEvent.keyDown(edge, { key: 'z', ctrlKey: true })
      expect(shade()).not.toBe(nudged)
      expect(shade()).not.toBe(fullShade)
      fireEvent.keyDown(edge, { key: 'z', ctrlKey: true, shiftKey: true })
      expect(shade()).toBe(nudged)

      fireEvent.click(undo)
      fireEvent.click(undo)
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Top-left crop corner' }), {
        key: 'ArrowDown',
        shiftKey: true,
      })
      expect(shade()).not.toBe(fullShade)
      fireEvent.click(undo)
      expect(shade()).toBe(fullShade)
      expect(undo).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('uses the rebuild confirm for a keyboard crop when edits would be lost', async () => {
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
      const fullShade = crop.querySelector('.crop-shade')?.getAttribute('d')
      fireEvent.keyDown(screen.getByRole('button', { name: 'Top crop edge' }), { key: 'ArrowDown' })
      const dialog = screen.getByRole('alertdialog', { name: REBUILD_CONFIRM_MESSAGE })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).toBe(fullShade)
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Top crop edge' }), { key: 'ArrowDown', shiftKey: true })
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(fullShade)
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('leaves eraser marks in place when Reset follows a keyboard corner move', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = HTMLElement.prototype.setPointerCapture
    HTMLElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: lineWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      const preview = await screen.findByRole('listbox', { name: 'Traced lines' })
      openMore()
      const smoothing = screen.getByRole('slider', { name: 'Smoothing' })
      fireEvent.change(smoothing, { target: { value: '80' } })
      fireEvent.click(screen.getByRole('button', { name: 'Eraser' }))
      giveBox(screen.getByRole('img', { name: 'Traced line art' }), 100, 40)
      fireEvent.pointerDown(preview, { clientX: 20, clientY: 10, pointerId: 3 })
      fireEvent.pointerUp(preview, { pointerId: 3 })
      expect(preview.querySelector('.eraser-stroke')).toBeTruthy()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      const corner = screen.getByRole('button', { name: 'Top-left corner' })
      fireEvent.keyDown(corner, { key: 'ArrowRight', shiftKey: true })
      fireEvent.click(screen.getByRole('button', { name: 'Reset controls to Auto' }))

      expect(smoothing).toHaveValue('28')
      expect(corner).toHaveAttribute('data-x', '0.05')
      expect(preview.querySelector('.eraser-stroke')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
    } finally {
      HTMLElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('moves through traced lines and selects one with Enter or Space', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = HTMLElement.prototype.setPointerCapture
    HTMLElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: lineWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      const preview = await screen.findByRole('listbox', { name: 'Traced lines' })
      expect(preview).toHaveAttribute('tabindex', '0')
      expect(preview.querySelector('.selected-stroke')).toBeNull()
      expect(preview.querySelector('.line-target')).toBeNull()

      fireEvent.keyDown(preview, { key: 'ArrowDown' })
      expect(preview).toHaveAttribute('aria-activedescendant', 'traced-line-2')
      expect(preview.querySelector('.line-target')).toBeTruthy()
      expect(screen.getByText('Line 2.')).toBeInTheDocument()
      expect(screen.queryByRole('slider', { name: 'Smooth this line' })).not.toBeInTheDocument()

      fireEvent.keyDown(preview, { key: 'Enter' })
      expect(screen.getByText('Line 2 selected.')).toBeInTheDocument()
      expect(preview.querySelector('.selected-stroke')?.getAttribute('points')).toBe('10,30 80,30')
      expect(screen.getByRole('option', { name: 'Line 2' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('slider', { name: 'Smooth this line' })).toBeInTheDocument()

      fireEvent.keyDown(preview, { key: 'ArrowUp' })
      fireEvent.keyDown(preview, { key: ' ' })
      expect(screen.getByText('Line 1 selected.')).toBeInTheDocument()
      expect(preview.querySelector('.selected-stroke')?.getAttribute('points')).toBe('10,10 80,10')

      fireEvent.keyDown(preview, { key: 'Escape' })
      expect(screen.getByText('Selection cleared.')).toBeInTheDocument()
      expect(preview.querySelector('.selected-stroke')).toBeNull()
      expect(screen.queryByRole('slider', { name: 'Smooth this line' })).not.toBeInTheDocument()

      const image = screen.getByRole('img', { name: 'Traced line art' })
      giveBox(image, 100, 40)
      fireEvent.pointerDown(preview, { clientX: 40, clientY: 30, pointerId: 1 })
      expect(preview.querySelector('.selected-stroke')?.getAttribute('points')).toBe('10,30 80,30')
    } finally {
      HTMLElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })
})

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

function lineWorker() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><path d="M10 10 L80 10"/><path d="M10 30 L80 30"/></svg>'
  const model = {
    width: 100,
    height: 40,
    penWidth: 4,
    kind: 'stroke' as const,
    strokes: [
      {
        id: 1,
        points: [
          { x: 10, y: 10 },
          { x: 80, y: 10 },
        ],
        closed: false,
        smoothing: null,
        source: null,
      },
      {
        id: 2,
        points: [
          { x: 10, y: 30 },
          { x: 80, y: 30 },
        ],
        closed: false,
        smoothing: null,
        source: null,
      },
    ],
  }
  return class FakeWorker extends EventTarget {
    postMessage(data: { kind: string; id: number }) {
      if (data.kind === 'load') {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'loaded', id: data.id, width: 100, height: 40, preview: new ArrayBuffer(8) },
          }),
        )
        return
      }
      this.dispatchEvent(new MessageEvent('message', { data: { kind: 'traced', id: data.id, svg, model } }))
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
