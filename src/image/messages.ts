import type { TraceControls } from './limits.ts'

export type LoadMessage = {
  kind: 'load'
  id: number
  buffer: ArrayBuffer
}

export type TraceMessage = {
  kind: 'trace'
  id: number
  controls: TraceControls
}

export type WorkerRequest = LoadMessage | TraceMessage

export type WorkerResponse =
  | {
      kind: 'loaded'
      id: number
      width: number
      height: number
      preview: ArrayBuffer
    }
  | { kind: 'traced'; id: number; svg: string }
  | { kind: 'failed'; id: number; message: string }
