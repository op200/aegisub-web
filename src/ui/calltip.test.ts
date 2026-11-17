import { describe, expect, it } from 'vitest'

import { calltipAt } from './calltip'

// 移植自 Aegisub/tests/tests/calltip_provider.cpp
describe('getCalltip', () => {
  it('empty line', () => {
    expect(calltipAt('', 0)).toBeNull()
  })

  it('no override blocks', () => {
    expect(calltipAt('hello', 0)).toBeNull()
  })

  it('cursor outside of block', () => {
    expect(calltipAt('{\\b1}hello', 6)).toBeNull()
  })

  it('basic cursor on tag', () => {
    expect(calltipAt('{\\b1}hello', 3)).toEqual({
      text: '\\bWeight',
      highlightStart: 2,
      highlightEnd: 8,
      tagPosition: 2,
    })
  })

  it('two arg', () => {
    expect(calltipAt('{\\pos(100,100)}hello', 3)).toMatchObject({
      text: '\\pos(X,Y)',
      highlightStart: 5,
      highlightEnd: 6,
      tagPosition: 2,
    })
    expect(calltipAt('{\\pos(100,100)}hello', 9)).toMatchObject({
      text: '\\pos(X,Y)',
      highlightStart: 5,
      highlightEnd: 6,
    })
    expect(calltipAt('{\\pos(100,100)}hello', 10)).toMatchObject({
      text: '\\pos(X,Y)',
      highlightStart: 7,
      highlightEnd: 8,
    })
    expect(calltipAt('{\\pos(100,100)}hello', 14)).toMatchObject({
      text: '\\pos(X,Y)',
      highlightStart: 7,
      highlightEnd: 8,
    })
    expect(calltipAt('{\\pos(100,100)}hello', 15)).toBeNull()
  })

  it('overloads', () => {
    expect(calltipAt('{\\clip(m)}', 3)).toMatchObject({
      text: '\\clip(Command)',
      highlightStart: 6,
      highlightEnd: 13,
    })
    expect(calltipAt('{\\clip(1, m)}', 3)).toMatchObject({
      text: '\\clip(Scale,Command)',
      highlightStart: 6,
      highlightEnd: 11,
    })
    expect(calltipAt('{\\clip(1, m)}', 10)).toMatchObject({
      text: '\\clip(Scale,Command)',
      highlightStart: 12,
      highlightEnd: 19,
    })
  })

  it('too many args', () => {
    expect(calltipAt('{\\pos(100,100,100)}hello', 15)).toBeNull()
    expect(calltipAt('{\\pos(100,100,100)}hello', 3)).toMatchObject({
      text: '\\pos(X,Y)',
      highlightStart: 5,
      highlightEnd: 6,
    })
  })

  it('unknown tag', () => {
    expect(calltipAt('{\\foo(100,100,100)}hello', 3)).toBeNull()
    expect(calltipAt('{\\toolong(100,100,100)}hello', 3)).toBeNull()
  })
})
