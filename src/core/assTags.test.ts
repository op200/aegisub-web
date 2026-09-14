import { describe, expect, it } from 'vitest'

import {
  assOverrideColor,
  blockAtPos,
  findTag,
  normalizePos,
  parseBlocks,
  setTag,
  tagBool,
  tagColorHex,
} from './assTags'

describe('parseBlocks', () => {
  it('splits plain/override/plain', () => {
    expect(parseBlocks('abc{\\b1}def')).toEqual([
      { type: 'plain', text: 'abc' },
      { type: 'override', text: '{\\b1}', tags: [{ name: '\\b', params: '1' }] },
      { type: 'plain', text: 'def' },
    ])
  })

  it('treats brace groups without backslash as comments', () => {
    expect(parseBlocks('a{note}b')).toEqual([
      { type: 'plain', text: 'a' },
      { type: 'comment', text: '{note}' },
      { type: 'plain', text: 'b' },
    ])
  })

  it('treats unclosed override as plain text', () => {
    // 源码 goto plain 后仍按"到下一个 { 或结尾"切分：'{\b1' 自成一块
    expect(parseBlocks('a{\\b1')).toEqual([
      { type: 'plain', text: 'a' },
      { type: 'plain', text: '{\\b1' },
    ])
  })

  it('marks text after \\p as drawing', () => {
    const blocks = parseBlocks('{\\p1}m 0 0 l 10 10{\\p0}x')
    expect(blocks[0].type).toBe('override')
    expect(blocks[1].type).toBe('drawing')
    expect(blocks[3].type).toBe('plain')
  })

  it('splits tags honoring parenthesis depth', () => {
    const blocks = parseBlocks('{\\pos(400,300)\\b1}')
    expect(blocks[0].type).toBe('override')
    if (blocks[0].type !== 'override') return
    expect(blocks[0].tags).toEqual([
      { name: '\\pos', params: '(400,300)' },
      { name: '\\b', params: '1' },
    ])
  })
})

describe('positions', () => {
  it('blockAtPos maps plain positions to block indices', () => {
    const text = 'ab{\\i1}cd'
    // "ab" → block 0；"cd" → block 2；紧贴块前的光标算块内
    expect(blockAtPos(text, 0)).toBe(0)
    expect(blockAtPos(text, 2)).toBe(1)
    expect(blockAtPos(text, 3)).toBe(2)
  })

  it('normalizePos strips override block characters', () => {
    // 源码 normalize_pos：'}' 本身不计入（计数时 in_block 仍为真）
    expect(normalizePos('ab{\\i1}cd', 8)).toBe(3)
    expect(normalizePos('ab{\\i1}cd', 0)).toBe(0)
  })
})

describe('setTag', () => {
  it('inserts a new block into plain text at the cursor', () => {
    const result = setTag('abcdef', '\\b', '1', 3, 3)
    expect(result.text).toBe('abc{\\b1}def')
    expect(result.shift).toBe(5)
  })

  it('replaces the existing tag param inside the block at the cursor', () => {
    const result = setTag('a{\\b1\\i1}bcd', '\\b', '0', 1, 4)
    expect(result.text).toBe('a{\\b0\\i1}bcd')
    expect(result.shift).toBe(0)
  })

  it('removes duplicate tags of the same name', () => {
    const result = setTag('a{\\b1\\i1\\b0}x', '\\b', '1', 1, 4)
    expect(result.text).toBe('a{\\b1\\i1}x')
    expect(result.shift).toBe(-3)
  })

  it('replaces \\1c when setting \\c', () => {
    const result = setTag('x{\\1c&HFF&}y', '\\c', '&HFF00&', 1, 4)
    expect(result.text).toBe('x{\\1c&HFF00&}y')
    expect(result.shift).toBe(1)
  })

  it('appends the tag when the block does not have it', () => {
    const result = setTag('a{\\i1}bc', '\\b', '1', 1, 4)
    expect(result.text).toBe('a{\\i1\\b1}bc')
    expect(result.shift).toBe(3)
  })

  it('falls back across comment blocks to the previous block', () => {
    // 光标紧贴注释块前：block_at_pos 落到 COMMENT → 向前回退到 PLAIN，
    // orig_pos 退到最近的 '{'（源码 rfind），新块插在注释块之前
    const result = setTag('a{note}bc', '\\b', '1', 1, 1)
    expect(result.text).toBe('a{\\b1}{note}bc')
    expect(result.shift).toBe(5)
  })

  it('appends into the override block when the cursor sits at its start', () => {
    const result = setTag('{\\b1}ab', '\\i', '1', 0, 0)
    expect(result.text).toBe('{\\b1\\i1}ab')
    expect(result.shift).toBe(3)
  })
})

describe('helpers', () => {
  it('reads bool params', () => {
    expect(tagBool('1', false)).toBe(true)
    expect(tagBool('0', true)).toBe(false)
    expect(tagBool('', true)).toBe(true)
    expect(tagBool('bogus', false)).toBe(false)
  })

  it('reads colors as #RRGGBB', () => {
    expect(tagColorHex('&HFF0000&')).toBe('#0000ff')
    expect(tagColorHex('16711680')).toBe('#0000ff')
    expect(tagColorHex('none')).toBeNull()
  })

  it('formats override colors as &HBBGGRR&', () => {
    expect(assOverrideColor('#ff0000')).toBe('&H0000FF&')
  })

  it('finds tags searching backwards across blocks', () => {
    const blocks = parseBlocks('{\\b1}a{\\i1}b')
    expect(findTag(blocks, 2, '\\i')?.params).toBe('1')
    expect(findTag(blocks, 2, '\\b')?.params).toBe('1')
    expect(findTag(blocks, 2, '\\s')).toBeNull()
    // 同块后者覆盖前者
    const dup = parseBlocks('{\\b1\\b0}a')
    expect(findTag(dup, 0, '\\b')?.params).toBe('0')
  })
})
