import { DECODE_MESSAGE, ImageProcessError } from './limits.ts'
import type { WorkerRequest, WorkerResponse } from './messages.ts'
import { preparePhoto, tracePrepared, type PreparedPhoto } from './process.ts'

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

const scope = globalThis as unknown as WorkerScope
let photo: PreparedPhoto | null = null

scope.onmessage = (event) => {
  const message = event.data
  void handle(message)
}

async function handle(message: WorkerRequest): Promise<void> {
  try {
    if (message.kind === 'load') {
      photo = await preparePhoto(new Uint8Array(message.buffer))
      scope.postMessage({ kind: 'loaded', id: message.id, width: photo.width, height: photo.height })
      return
    }
    if (!photo) {
      scope.postMessage({ kind: 'failed', id: message.id, message: 'Choose a photo first.' })
      return
    }
    const svg = tracePrepared(photo, message.controls)
    scope.postMessage({ kind: 'traced', id: message.id, svg })
  } catch (error) {
    const text = error instanceof ImageProcessError ? error.message : DECODE_MESSAGE
    scope.postMessage({ kind: 'failed', id: message.id, message: text })
  }
}
