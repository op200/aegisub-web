import { describe, expect, it } from 'vitest'

import { readVisualOverrides, setOverride, setPosition } from './assVisual'

describe('ASS visual overrides', () => {
  it('reads positioning and transforms from override blocks', () => {
    expect(
      readVisualOverrides(
        '{\\pos(320,240)\\fscx125\\fscy80\\frz30\\frx10\\fry20\\clip(1,2,3,4)}Text',
      ),
    ).toEqual({
      pos: { x: 320, y: 240 },
      move: undefined,
      org: undefined,
      scaleX: 125,
      scaleY: 80,
      rotationZ: 30,
      rotationX: 10,
      rotationY: 20,
      fax: 0,
      fay: 0,
      clip: { inverse: false, x1: 1, y1: 2, x2: 3, y2: 4 },
    })
  })

  it('adds and replaces overrides while preserving other tags', () => {
    expect(setOverride('{\\b1}Text', 'fscx', '125')).toBe('{\\fscx125\\b1}Text')
    expect(setOverride('{\\b1\\fscx80}Text', 'fscx', '125')).toBe('{\\b1\\fscx125}Text')
    expect(setPosition('{\\move(0,0,10,10)\\b1}Text', 12, 34)).toBe('{\\pos(12,34)\\b1}Text')
  })
})
