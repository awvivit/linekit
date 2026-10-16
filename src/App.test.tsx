import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { site } from './brand.ts'
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

  it('shows the SVG safety failure from the worker', async () => {
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

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't make a safe SVG from this photo.")
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker })
      globalThis.postMessage = previousPostMessage
    }
  })
})
