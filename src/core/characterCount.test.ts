import { describe, expect, it } from 'vitest'

import {
  IGNORE_BLOCKS,
  IGNORE_PUNCTUATION,
  IGNORE_WHITESPACE,
  characterCount,
  indexOfCharacter,
  maxLineLength,
} from './characterCount'

// 对照 libaegisub/common/character_count.cpp 的行为
describe('characterCount', () => {
  it('按 grapheme cluster 计数', () => {
    expect(characterCount('abc')).toBe(3)
    // 组合字符与 ZWJ emoji 各算一个字符
    expect(characterCount('e\u0301')).toBe(1)
    expect(characterCount('👨‍👩‍👧‍👦')).toBe(1)
    expect(characterCount('🇨🇳')).toBe(1)
  })

  it('忽略空白与标点', () => {
    expect(characterCount('a b, c!', IGNORE_WHITESPACE)).toBe(5)
    expect(characterCount('a b, c!', IGNORE_PUNCTUATION)).toBe(5)
    expect(characterCount('a b, c!', IGNORE_WHITESPACE | IGNORE_PUNCTUATION)).toBe(3)
  })

  it('忽略 override 块', () => {
    expect(characterCount('{\\b1}hello', IGNORE_BLOCKS)).toBe(5)
    expect(characterCount('a{\\b1}b', IGNORE_BLOCKS)).toBe(2)
    // 未闭合块按普通字符计数（含 {）
    expect(characterCount('a{b', IGNORE_BLOCKS)).toBe(3)
  })

  it('忽略空白时 \\h / \\N / \\n 不再计入反斜杠', () => {
    expect(characterCount('a\\hb', IGNORE_WHITESPACE)).toBe(2)
    expect(characterCount('a\\Nb', IGNORE_WHITESPACE)).toBe(2)
  })

  it('indexOfCharacter 按字符边界取 UTF-16 偏移', () => {
    expect(indexOfCharacter('a👨‍👩‍👧‍👦b', 0)).toBe(0)
    expect(indexOfCharacter('a👨‍👩‍👧‍👦b', 1)).toBe(1)
    expect(indexOfCharacter('a👨‍👩‍👧‍👦b', 2)).toBe(1 + '👨‍👩‍👧‍👦'.length)
  })
})

describe('maxLineLength', () => {
  it('分行并跳过 override 块与绘图', () => {
    expect(maxLineLength('hello')).toBe(5)
    expect(maxLineLength('{\\b1}hello')).toBe(5)
    expect(maxLineLength('one\\Ntwo')).toBe(3)
    expect(maxLineLength('one\\ntwo')).toBe(3)
    expect(maxLineLength('ab{\\p1}m 0 0 l 10 0}c')).toBe(2)
    expect(maxLineLength('ab{\\p1}m 0 0 l 10 0}{\\p0}c')).toBe(3)
  })

  it('\\h 在忽略空白时不计', () => {
    expect(maxLineLength('a\\hb')).toBe(3)
    expect(maxLineLength('a\\hb', IGNORE_WHITESPACE)).toBe(2)
    expect(maxLineLength('a b', IGNORE_WHITESPACE)).toBe(2)
  })

  it('未闭合 override 块不产生 TEXT', () => {
    expect(maxLineLength('a{\\b1')).toBe(1)
  })
})
