export type History<T> = {
  past: T[]
  present: T
  future: T[]
}

const HISTORY_LIMIT = 40

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

export function commitHistory<T>(
  history: History<T>,
  next: T,
  equals: (left: T, right: T) => boolean = Object.is,
): History<T> {
  if (equals(history.present, next)) return history
  return {
    past: trim([...history.past, history.present]),
    present: next,
    future: [],
  }
}

/** Replace the current value without opening a new undo step. */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  if (Object.is(history.present, next)) return history
  return { past: history.past, present: next, future: history.future }
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1]
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: trim([...history.past, history.present]),
    present: next,
    future: history.future.slice(1),
  }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}

function trim<T>(items: T[]): T[] {
  return items.length > HISTORY_LIMIT ? items.slice(items.length - HISTORY_LIMIT) : items
}
