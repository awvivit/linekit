import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { site } from './brand.ts'
import { CLEANUP_BUDGET_MS, CLEANUP_TIMEOUT_MESSAGE, NO_LINES_MESSAGE } from './image/limits.ts'
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

  it('cancels an in-flight trace before starting the next one', async () => {
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
      fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '70' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      const firstTrace = events.indexOf('trace')
      const terminated = events.indexOf('terminate', firstTrace + 1)
      const secondTrace = events.indexOf('trace', terminated + 1)
      expect(firstTrace).toBeGreaterThanOrEqual(0)
      expect(terminated).toBeGreaterThan(firstTrace)
      expect(secondTrace).toBeGreaterThan(terminated)
    } finally {
      vi.useRealTimers()
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
    }
  })
})

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
