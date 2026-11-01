import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { site } from './brand.ts'
import {
  CLEANUP_BUDGET_MS,
  CLEANUP_TIMEOUT_MESSAGE,
  CROP_RESET_MESSAGE,
  NO_LINES_LEFT_MESSAGE,
  NO_LINES_LEFT_UNDO_MESSAGE,
  NO_LINES_MESSAGE,
  REBUILD_CONFIRM_MESSAGE,
} from './image/limits.ts'
import { encodePng } from './image/png.ts'

describe('App', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the product name and the privacy intent', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: site.name })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Privacy' })).toHaveTextContent(
      'Privacy. Linekit traces images only in your browser.',
    )
    expect(screen.getByLabelText(/choose a photo or drop it here/i)).toBeInTheDocument()
    expect(document.title).toBe(site.name)
  })

  it('traces a photo in the worker', async () => {
    const previousWorker = globalThis.Worker
    const previousPostMessage = globalThis.postMessage
    const replies = new EventTarget()
    class FakeWorker extends EventTarget {
      constructor(_url: string | URL, _options?: WorkerOptions) {
        super()
        replies.addEventListener('message', (event) => {
          const detail = (event as CustomEvent<unknown>).detail
          this.dispatchEvent(new MessageEvent('message', { data: detail }))
        })
      }

      postMessage(data: unknown) {
        const handler = globalThis.onmessage
        if (typeof handler === 'function') handler.call(window, { data } as MessageEvent)
      }

      terminate() {}
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    globalThis.postMessage = ((message: unknown) => {
      replies.dispatchEvent(new CustomEvent('message', { detail: message }))
    }) as typeof globalThis.postMessage

    try {
      await import('./image/trace.worker.ts')
      render(<App />)
      const data = new Uint8ClampedArray(16).fill(255)
      data[0] = 0
      data[1] = 0
      data[2] = 0
      const png = await encodePng({ width: 2, height: 2, data })
      const file = new File([new Uint8Array(png)], 'drawing.png', { type: 'image/png' })
      const input = screen.getByLabelText(/choose a photo or drop it here/i)
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      fireEvent.change(input)

      expect(await screen.findByRole('img', { name: 'Traced line art' })).toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'Clean up lines' })).toBeChecked()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
      globalThis.postMessage = previousPostMessage
    }
  })

  it('shows the SVG safety failure from the worker', async () => {
    const previousWorker = globalThis.Worker
    class FakeWorker extends EventTarget {
      constructor(_url: string | URL, _options?: WorkerOptions) {
        super()
      }

      postMessage(data: { kind: string; id: number }) {
        if (data.kind === 'load') {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                kind: 'loaded',
                id: data.id,
                width: 2,
                height: 2,
                preview: new Uint8Array([137, 80, 78, 71]).buffer,
              },
            }),
          )
          return
        }
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'failed', id: data.id, message: "Couldn't make a safe SVG from this photo." },
          }),
        )
      }

      terminate() {}
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })

    try {
      render(<App />)
      const data = new Uint8ClampedArray(16).fill(255)
      const png = await encodePng({ width: 2, height: 2, data })
      const file = new File([new Uint8Array(png)], 'drawing.png', { type: 'image/png' })
      const input = screen.getByLabelText(/choose a photo or drop it here/i)
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      fireEvent.change(input)

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't make a safe SVG from this photo.")
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('says when a photo has no lines', async () => {
    const previousWorker = globalThis.Worker
    class FakeWorker extends EventTarget {
      postMessage(data: { kind: string; id: number }) {
        if (data.kind === 'load') {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: { kind: 'loaded', id: data.id, width: 2, height: 2, preview: new ArrayBuffer(8) },
            }),
          )
          return
        }
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'traced', id: data.id, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>' },
          }),
        )
      }

      terminate() {}
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    try {
      render(<App />)
      await openBlankPhoto()
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NO_LINES_MESSAGE))
      expect(screen.getByRole('status')).not.toHaveTextContent('No lines left')
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('terminates a cleanup that takes too long and turns the switch off', async () => {
    const previousWorker = globalThis.Worker
    const events: string[] = []
    class FakeWorker extends EventTarget {
      postMessage(data: { kind: string; id: number }) {
        events.push(data.kind)
        if (data.kind !== 'load') return
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'loaded', id: data.id, width: 2, height: 2, preview: new ArrayBuffer(8) },
          }),
        )
      }

      terminate() {
        events.push('terminate')
      }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    vi.useFakeTimers()
    try {
      render(<App />)
      await openBlankPhoto()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(events).toContain('trace')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLEANUP_BUDGET_MS)
      })
      expect(events).toContain('terminate')
      expect(screen.getByRole('checkbox', { name: 'Clean up lines' })).not.toBeChecked()
      expect(screen.getByRole('status')).toHaveTextContent(CLEANUP_TIMEOUT_MESSAGE)
    } finally {
      vi.useRealTimers()
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('shows the editing controls and undoes a toggle', async () => {
    const previousWorker = globalThis.Worker
    class FakeWorker extends EventTarget {
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
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    try {
      render(<App />)
      await openBlankPhoto()
      expect(await screen.findByRole('checkbox', { name: 'Straighten shapes' })).toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'Close gaps' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'false')
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
      expect(screen.getByRole('checkbox', { name: 'Fix perspective' })).toBeInTheDocument()
      expect(screen.queryByRole('slider', { name: 'Smooth this line' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Straighten shapes' }))
      expect(screen.getByRole('slider', { name: 'Straighten tolerance' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Close gaps' }))
      expect(screen.getByRole('slider', { name: 'Gap size' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.queryByRole('slider', { name: 'Gap size' })).not.toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).not.toBeChecked()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).not.toBeChecked()
      fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true })
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('says when edits remove every traced line', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = Element.prototype.setPointerCapture
    Element.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: lineWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      const traced = await screen.findByRole('img', { name: 'Traced line art' })
      giveBox(traced, 100, 40)
      expect(screen.getByRole('status')).not.toHaveTextContent('No lines')
      fireEvent.click(screen.getByRole('button', { name: 'Eraser' }))
      fireEvent.pointerDown(traced, { clientX: 50, clientY: 10, pointerId: 1 })
      fireEvent.pointerCancel(traced, { pointerId: 1 })
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
      fireEvent.change(screen.getByRole('slider', { name: 'Line darkness' }), { target: { value: '80' } })
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      fireEvent.pointerDown(traced, { clientX: 50, clientY: 10, pointerId: 2 })
      fireEvent.lostPointerCapture(traced, { pointerId: 2 })
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
      fireEvent.pointerDown(traced, { clientX: 50, clientY: 10, pointerId: 1 })
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(NO_LINES_LEFT_MESSAGE))
      fireEvent.pointerUp(traced, { pointerId: 1 })
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NO_LINES_LEFT_UNDO_MESSAGE))
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('No lines'))
    } finally {
      Element.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('asks before a rebuild that would drop edits, once per drag', async () => {
    const previousWorker = globalThis.Worker
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      const darkness = await screen.findByRole('slider', { name: 'Line darkness' })
      fireEvent.change(darkness, { target: { value: '70' } })
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(darkness).toHaveValue('70')

      fireEvent.click(screen.getByRole('checkbox', { name: 'Straighten shapes' }))
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
      fireEvent.change(darkness, { target: { value: '80' } })
      const dialog = screen.getByRole('alertdialog', { name: REBUILD_CONFIRM_MESSAGE })
      expect(dialog).toBeInTheDocument()
      expect(darkness).toHaveValue('70')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
      fireEvent.keyDown(dialog, { key: 'Tab' })
      expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
      fireEvent.keyDown(dialog, { key: 'Tab' })
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(darkness).toHaveValue('70')
      expect(screen.getByRole('checkbox', { name: 'Straighten shapes' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()

      fireEvent.click(screen.getByRole('checkbox', { name: 'Clean up lines' }))
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('checkbox', { name: 'Clean up lines' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()

      fireEvent.pointerDown(darkness)
      fireEvent.change(darkness, { target: { value: '81' } })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
      fireEvent.change(darkness, { target: { value: '90' } })
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      expect(darkness).toHaveValue('70')
      fireEvent.pointerUp(darkness)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(darkness).toHaveValue('90')
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('resets an existing crop when perspective is fixed', async () => {
    const previousWorker = globalThis.Worker
    const previousCapture = SVGSVGElement.prototype.setPointerCapture
    SVGSVGElement.prototype.setPointerCapture = () => {}
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: silentWorker() })
    try {
      render(<App />)
      await openBlankPhoto()
      const crop = await screen.findByLabelText('Crop rectangle')
      giveBox(crop)
      const fullShade = crop.querySelector('.crop-shade')?.getAttribute('d')
      drawCrop(crop, 10, 10, 80, 70)
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(fullShade)
      expect(screen.queryByRole('status')).not.toHaveTextContent(CROP_RESET_MESSAGE)
      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      expect(screen.getByRole('status')).toHaveTextContent(CROP_RESET_MESSAGE)
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).toBe(fullShade)
      drawCrop(crop, 30, 25, 80, 70)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(screen.queryByRole('status')).not.toHaveTextContent(CROP_RESET_MESSAGE)
      expect(crop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(fullShade)

      cleanup()
      render(<App />)
      await openBlankPhoto()
      const nextCrop = await screen.findByLabelText('Crop rectangle')
      giveBox(nextCrop)
      const nextFull = nextCrop.querySelector('.crop-shade')?.getAttribute('d')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Fix perspective' }))
      expect(screen.queryByRole('status')).not.toHaveTextContent(CROP_RESET_MESSAGE)
      drawCrop(nextCrop, 20, 15, 75, 60)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(nextCrop.querySelector('.crop-shade')?.getAttribute('d')).not.toBe(nextFull)
      fireEvent.pointerDown(nextCrop, { clientX: 3, clientY: 3, pointerId: 1 })
      fireEvent.pointerMove(nextCrop, { clientX: 30, clientY: 24, pointerId: 1 })
      fireEvent.pointerUp(nextCrop, { pointerId: 1 })
      expect(screen.getByRole('status')).toHaveTextContent(CROP_RESET_MESSAGE)
      expect(nextCrop.querySelector('.crop-shade')?.getAttribute('d')).toBe(nextFull)
    } finally {
      SVGSVGElement.prototype.setPointerCapture = previousCapture
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })

  it('terminates the worker that is tracing when a slider moves', async () => {
    const previousWorker = globalThis.Worker
    const workers: FakeWorker[] = []
    let nextWorkerId = 1
    class FakeWorker extends EventTarget {
      readonly id = nextWorkerId++
      terminated = false
      traces = 0

      constructor(_url?: string | URL, _options?: WorkerOptions) {
        super()
        workers.push(this)
      }

      postMessage(data: { kind: string; id: number }) {
        if (data.kind === 'trace') this.traces += 1
        if (data.kind !== 'load') return
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'loaded', id: data.id, width: 2, height: 2, preview: new ArrayBuffer(8) },
          }),
        )
      }

      terminate() {
        this.terminated = true
      }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    vi.useFakeTimers()
    try {
      render(<App />)
      await openBlankPhoto()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      const inFlight = workers.filter((worker) => worker.traces > 0)
      expect(inFlight).toHaveLength(1)
      const first = inFlight[0]
      expect(first?.terminated).toBe(false)
      fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '70' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(first?.terminated).toBe(true)
      const stillTracing = workers.filter((worker) => worker.traces > 0 && !worker.terminated)
      expect(stillTracing).toHaveLength(1)
      expect(stillTracing[0]?.id).not.toBe(first?.id)
    } finally {
      vi.useRealTimers()
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })
})

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

function lineWorker() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><path d="M40 10 L60 10"/></svg>'
  const model = {
    width: 100,
    height: 40,
    penWidth: 4,
    kind: 'stroke' as const,
    strokes: [
      {
        id: 1,
        points: [
          { x: 40, y: 10 },
          { x: 60, y: 10 },
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

function drawCrop(crop: Element, x0: number, y0: number, x1: number, y1: number) {
  fireEvent.pointerDown(crop, { clientX: x0, clientY: y0, pointerId: 1 })
  fireEvent.pointerMove(crop, { clientX: x1, clientY: y1, pointerId: 1 })
  fireEvent.pointerUp(crop, { pointerId: 1 })
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
