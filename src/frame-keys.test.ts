import { describe, expect, it } from 'vitest'
import { FULL_CROP } from './image/limits.ts'
import {
  CROP_HANDLES,
  CROP_HANDLE_LABELS,
  CORNER_LABELS,
  CROP_CANCELLED,
  SELECTION_CLEARED,
  cropNote,
  lineNote,
  lineSelectedNote,
  moveLine,
  nudgeCrop,
  nudgePoint,
  pointNote,
} from './frame-keys.ts'

describe('perspective keyboard nudge', () => {
  it('moves a corner by a small step and a shift step', () => {
    expect(nudgePoint({ x: 0.2, y: 0.3 }, 'ArrowRight', false)).toEqual({ x: 0.21, y: 0.3 })
    expect(nudgePoint({ x: 0.2, y: 0.3 }, 'ArrowUp', true)).toEqual({ x: 0.2, y: 0.25 })
  })

  it('clamps a corner to the image', () => {
    expect(nudgePoint({ x: 0, y: 0.4 }, 'ArrowLeft', true)).toBeNull()
    expect(nudgePoint({ x: 0.98, y: 1 }, 'ArrowDown', false)).toBeNull()
    expect(nudgePoint({ x: 0.98, y: 0.4 }, 'ArrowRight', true)).toEqual({ x: 1, y: 0.4 })
  })

  it('ignores keys that are not arrows', () => {
    expect(nudgePoint({ x: 0.2, y: 0.2 }, 'Enter', false)).toBeNull()
    expect(nudgePoint({ x: 0.2, y: 0.2 }, 'a', true)).toBeNull()
  })
})

describe('crop keyboard nudge', () => {
  it('pulls each edge in from a full photo', () => {
    expect(nudgeCrop(FULL_CROP, 'w', 'ArrowRight', false)).toEqual({ x: 0.01, y: 0, width: 0.99, height: 1 })
    expect(nudgeCrop(FULL_CROP, 'n', 'ArrowDown', true)).toEqual({ x: 0, y: 0.05, width: 1, height: 0.95 })
    expect(nudgeCrop(FULL_CROP, 'e', 'ArrowLeft', false)).toEqual({ x: 0, y: 0, width: 0.99, height: 1 })
    expect(nudgeCrop(FULL_CROP, 's', 'ArrowUp', false)).toEqual({ x: 0, y: 0, width: 1, height: 0.99 })
  })

  it('moves a corner along the arrow and keeps the opposite sides', () => {
    const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
    expect(nudgeCrop(crop, 'nw', 'ArrowLeft', false)).toEqual({ x: 0.19, y: 0.2, width: 0.41, height: 0.4 })
    expect(nudgeCrop(crop, 'se', 'ArrowDown', true)).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.45 })
  })

  it('stops at the image and at the minimum crop size', () => {
    expect(nudgeCrop(FULL_CROP, 'w', 'ArrowLeft', false)).toBeNull()
    const thin = { x: 0, y: 0, width: 0.02, height: 0.5 }
    expect(nudgeCrop(thin, 'e', 'ArrowLeft', false)).toBeNull()
    expect(nudgeCrop(thin, 'w', 'ArrowRight', true)).toBeNull()
  })

  it('names every corner and edge in tab order', () => {
    expect(CROP_HANDLES.map((handle) => CROP_HANDLE_LABELS[handle])).toEqual([
      'Top-left crop corner',
      'Top crop edge',
      'Top-right crop corner',
      'Right crop edge',
      'Bottom-right crop corner',
      'Bottom crop edge',
      'Bottom-left crop corner',
      'Left crop edge',
    ])
    expect(CORNER_LABELS.topLeft).toBe('Top-left corner')
    expect(CORNER_LABELS.bottomRight).toBe('Bottom-right corner')
  })
})

describe('line keyboard movement', () => {
  it('steps through lines and stops at the ends', () => {
    expect(moveLine(0, 3, 'ArrowDown')).toBe(1)
    expect(moveLine(0, 3, 'ArrowRight')).toBe(1)
    expect(moveLine(2, 3, 'ArrowDown')).toBeNull()
    expect(moveLine(2, 3, 'ArrowLeft')).toBe(1)
    expect(moveLine(1, 3, 'Home')).toBe(0)
    expect(moveLine(0, 3, 'End')).toBe(2)
    expect(moveLine(0, 3, 'Enter')).toBeNull()
  })

  it('uses the short status phrases', () => {
    expect(pointNote('Top-left corner', { x: 0.05, y: 0 })).toBe('Top-left corner, 5% across, 0% down.')
    expect(cropNote('w', { x: 0.01, y: 0, width: 0.99, height: 1 })).toBe('Left crop edge, 1% across.')
    expect(cropNote('n', { x: 0, y: 0.05, width: 1, height: 0.95 })).toBe('Top crop edge, 5% down.')
    expect(lineNote(1)).toBe('Line 2.')
    expect(lineSelectedNote(1)).toBe('Line 2 selected.')
    expect(SELECTION_CLEARED).toBe('Selection cleared.')
    expect(CROP_CANCELLED).toBe('Crop cancelled.')
  })
})
