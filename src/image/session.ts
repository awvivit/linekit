import { DECODE_MESSAGE, ImageProcessError, type TraceControls } from './limits.ts'
import type { WorkerResponse } from './messages.ts'
import type { PreparedPhoto } from './process.ts'

export type TraceSession = {
  load: (buffer: ArrayBuffer) => Promise<{ width: number; height: number }>
  trace: (controls: TraceControls) => Promise<string>
  dispose: () => void
}

export function createTraceSession(): TraceSession {
  if (typeof Worker !== 'function') {
    return createLocalSession()
  }
  try {
    const worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' })
    return createWorkerSession(worker)
  } catch {
    return createLocalSession()
  }
}

function createLocalSession(): TraceSession {
  let photo: PreparedPhoto | null = null
  return {
    async load(buffer) {
      const { preparePhoto } = await import('./process.ts')
      photo = await preparePhoto(new Uint8Array(buffer))
      return { width: photo.width, height: photo.height }
    },
    async trace(controls) {
      if (!photo) throw new ImageProcessError('decode', 'Choose a photo first.')
      const { tracePrepared } = await import('./process.ts')
      return tracePrepared(photo, controls)
    },
    dispose() {
      photo = null
    },
  }
}

function createWorkerSession(worker: Worker): TraceSession {
  let nextId = 0
  const pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void }>()

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    waiter.resolve(response)
  })
  worker.addEventListener('error', () => {
    for (const waiter of pending.values()) {
      waiter.reject(new ImageProcessError('decode', DECODE_MESSAGE))
    }
    pending.clear()
  })

  return {
    async load(buffer) {
      const response = await post({ kind: 'load', id: ++nextId, buffer }, [buffer])
      if (response.kind === 'failed') throw new ImageProcessError('decode', response.message)
      if (response.kind !== 'loaded') throw new ImageProcessError('decode', DECODE_MESSAGE)
      return { width: response.width, height: response.height }
    },
    async trace(controls) {
      const response = await post({ kind: 'trace', id: ++nextId, controls })
      if (response.kind === 'failed') throw new ImageProcessError('decode', response.message)
      if (response.kind !== 'traced') throw new ImageProcessError('decode', DECODE_MESSAGE)
      return response.svg
    },
    dispose() {
      worker.terminate()
      pending.clear()
    },
  }

  function post(message: { kind: 'load'; id: number; buffer: ArrayBuffer } | { kind: 'trace'; id: number; controls: TraceControls }, transfer?: Transferable[]) {
    return new Promise<WorkerResponse>((resolve, reject) => {
      pending.set(message.id, { resolve, reject })
      worker.postMessage(message, transfer ?? [])
    })
  }
}
