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
      // GetLineOutline/GetLineShadow/GetLineAlignment：无样式时回退 0
      outlineX: 0,
      outlineY: 0,
      shadowX: 0,
      shadowY: 0,
      alignment: 0,
      clip: { inverse: false, x1: 1, y1: 2, x2: 3, y2: 4 },
    })
  })

  it('adds and replaces overrides while preserving other tags', () => {
    // SetOverride：首个覆写块内删除同名/互删标签后追加到块尾（AddTag）
    expect(setOverride('{\\b1}Text', 'fscx', '125')).toBe('{\\b1\\fscx125}Text')
    expect(setOverride('{\\b1\\fscx80}Text', 'fscx', '125')).toBe('{\\b1\\fscx125}Text')
    expect(setPosition('{\\move(0,0,10,10)\\b1}Text', 12, 34)).toBe('{\\b1\\pos(12,34)}Text')
  })

  it('prepends a new override block when the first block is plain or comment', () => {
    // 首块非覆写块：整体前插 {tag value}，注释块原样保留
    expect(setOverride('Text', 'pos', '(1,2)')).toBe('{\\pos(1,2)}Text')
    expect(setOverride('{comment}Text', 'pos', '(1,2)')).toBe('{\\pos(1,2)}{comment}Text')
  })
})
