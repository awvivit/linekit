import { DECODE_MESSAGE, ImageProcessError } from './limits.ts'
import type { WorkerRequest, WorkerResponse } from './messages.ts'
import type { PreparedPhoto } from './process.ts'

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void
}

const scope = globalThis as unknown as WorkerScope
let photo: PreparedPhoto | null = null

scope.onmessage = (event) => {
  const message = event.data
  void handle(message)
}

async function tracing(): Promise<typeof import('./process.ts')> {
  return import('./process.ts')
}

async function handle(message: WorkerRequest): Promise<void> {
  try {
    const pipeline = await tracing()
    if (message.kind === 'load') {
      photo = await pipeline.preparePhoto(new Uint8Array(message.buffer))
      const preview = await pipeline.buildPreview(photo.raster)
      const bytes = new Uint8Array(preview.bytes)
      scope.postMessage(
        {
          kind: 'loaded',
          id: message.id,
          width: photo.width,
          height: photo.height,
          preview: bytes.buffer,
        },
        [bytes.buffer],
      )
      return
    }
    if (!photo) {
      scope.postMessage({ kind: 'failed', id: message.id, message: 'Choose a photo first.' })
      return
    }
    const svg = pipeline.tracePrepared(photo, message.controls)
    scope.postMessage({ kind: 'traced', id: message.id, svg })
  } catch (error) {
    const text = error instanceof ImageProcessError ? error.message : DECODE_MESSAGE
    scope.postMessage({ kind: 'failed', id: message.id, message: text })
  }
}
