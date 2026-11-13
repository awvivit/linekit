import { CleanupTimeoutError, DECODE_MESSAGE, ImageProcessError, type TraceControls } from './limits.ts'
import type { WorkerResponse } from './messages.ts'
import type { PreparedPhoto, TraceDocument } from './process.ts'

export type LoadedPhoto = {
  width: number
  height: number
  preview: Uint8Array
}

export class TraceCancelled extends Error {
  constructor() {
    super('Trace cancelled.')
    this.name = 'TraceCancelled'
  }
}

export type TraceSession = {
  load: (buffer: ArrayBuffer) => Promise<LoadedPhoto>
  trace: (controls: TraceControls) => Promise<TraceDocument>
  /** Drop any trace that is still running and start a fresh worker. */
  cancel: () => void
  dispose: () => void
}

export function createTraceSession(): TraceSession {
  if (typeof Worker !== 'function') {
    return createLocalSession()
  }
  try {
    return createWorkerSession()
  } catch {
    return createLocalSession()
  }
}

function createLocalSession(): TraceSession {
  let photo: PreparedPhoto | null = null
  return {
    async load(buffer) {
      const { preparePhoto, buildPreview } = await import('./process.ts')
      photo = await preparePhoto(new Uint8Array(buffer))
      const preview = await buildPreview(photo.raster)
      return { width: photo.width, height: photo.height, preview: preview.bytes }
    },
    async trace(controls) {
      if (!photo) throw new ImageProcessError('decode', 'Choose a photo first.')
      const { tracePreparedDocument } = await import('./process.ts')
      return tracePreparedDocument(photo, controls)
    },
    cancel() {},
    dispose() {
      photo = null
    },
  }
}

function createWorkerSession(): TraceSession {
  let nextId = 0
  let generation = 0
  let retained: ArrayBuffer | null = null
  let ready = false
  const pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void }>()
  let worker = spawn()

  return {
    async load(buffer) {
      retained = buffer.slice(0)
      ready = false
      const copy = retained.slice(0)
      const response = await post({ kind: 'load', id: ++nextId, buffer: copy }, [copy])
      if (response.kind === 'failed') throw new ImageProcessError('decode', response.message)
      if (response.kind !== 'loaded') throw new ImageProcessError('decode', DECODE_MESSAGE)
      ready = true
      return { width: response.width, height: response.height, preview: new Uint8Array(response.preview) }
    },
    async trace(controls) {
      if (pending.size > 0) restart()
      const token = generation
      if (!ready) {
        if (!retained) throw new ImageProcessError('decode', 'Choose a photo first.')
        const copy = retained.slice(0)
        const response = await post({ kind: 'load', id: ++nextId, buffer: copy }, [copy])
        if (token !== generation) throw new TraceCancelled()
        if (response.kind === 'failed') throw new ImageProcessError('decode', response.message)
        if (response.kind !== 'loaded') throw new ImageProcessError('decode', DECODE_MESSAGE)
        ready = true
      }
      if (token !== generation) throw new TraceCancelled()
      const response = await post({ kind: 'trace', id: ++nextId, controls })
      if (token !== generation) throw new TraceCancelled()
      if (response.kind === 'timeout') throw new CleanupTimeoutError()
      if (response.kind === 'failed') throw new ImageProcessError('decode', response.message)
      if (response.kind !== 'traced') throw new ImageProcessError('decode', DECODE_MESSAGE)
      return {
        svg: response.svg,
        model: response.model ?? null,
        plan: response.plan ?? {
          mode: 'lines',
          colorCount: 2,
          smoothNoise: 0,
          edgeDetail: 0,
          evenLighting: false,
          faintLines: controls.darkness,
          smoothing: controls.smoothing,
          specks: controls.specks,
          summary: 'Auto picked Lines.',
        },
        resolved: response.resolved ?? 'lines',
      }
    },
    cancel() {
      if (pending.size === 0) return
      restart()
    },
    dispose() {
      worker.terminate()
      pending.clear()
      retained = null
      ready = false
    },
  }

  function spawn(): Worker {
    let next: Worker
    try {
      next = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      throw error instanceof Error ? error : new Error('Worker unavailable')
    }
    next.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      const waiter = pending.get(response.id)
      if (!waiter) return
      pending.delete(response.id)
      waiter.resolve(response)
    })
    next.addEventListener('error', () => {
      for (const waiter of pending.values()) {
        waiter.reject(new ImageProcessError('decode', DECODE_MESSAGE))
      }
      pending.clear()
    })
    return next
  }

  function restart(): void {
    generation += 1
    worker.terminate()
    for (const waiter of pending.values()) {
      waiter.reject(new TraceCancelled())
    }
    pending.clear()
    ready = false
    worker = spawn()
  }

  function post(
    message: { kind: 'load'; id: number; buffer: ArrayBuffer } | { kind: 'trace'; id: number; controls: TraceControls },
    transfer?: Transferable[],
  ): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject })
      worker.postMessage(message, transfer ?? [])
    })
  }
}
