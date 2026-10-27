import { describe, expect, it } from 'vitest'

import { parseKaraokeSyllables, type KaraokeSyllable } from './karaoke'
import { KaraokeMatcher, autoMatchKaraoke } from './karaokeMatcher'
import { strippedText } from './dialogueBlocks'

describe('autoMatchKaraoke（karaoke_matcher.cpp AutoMatchKaraoke）', () => {
  it('空源返回零', () => {
    expect(autoMatchKaraoke([], '')).toEqual({ sourceLength: 0, destinationLength: 0 })
    expect(autoMatchKaraoke([], 'a').sourceLength).toBe(0)
  })

  it('空目标：源全部归入匹配', () => {
    expect(autoMatchKaraoke(['a', 'b'], '')).toEqual({ sourceLength: 2, destinationLength: 0 })
  })

  it('空源音节不占目标字符', () => {
    expect(autoMatchKaraoke(['', 'b'], 'cc')).toEqual({ sourceLength: 1, destinationLength: 0 })
  })

  it('目标不匹配时选首个字符', () => {
    expect(autoMatchKaraoke(['a', 'b'], 'cc')).toEqual({ sourceLength: 1, destinationLength: 1 })
  })

  it('相同文本整段匹配', () => {
    expect(autoMatchKaraoke(['abc', 'de'], 'abcde')).toEqual({
      sourceLength: 1,
      destinationLength: 3,
    })
  })

  it('匹配忽略大小写与全半角', () => {
    expect(autoMatchKaraoke(['abc', 'de'], 'ABCDE')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['ab', 'cd'], 'ａｂc')).toEqual({ sourceLength: 1, destinationLength: 2 })
  })

  it('源与目标空白按源码语义处理', () => {
    expect(autoMatchKaraoke([' abc', 'de'], 'abcde')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['abc ', 'de'], 'abcde')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['abc ', 'de'], ' abcde')).toEqual({ sourceLength: 1, destinationLength: 4 })
    expect(autoMatchKaraoke(['abc ', 'de'], 'ab c de')).toEqual({ sourceLength: 1, destinationLength: 5 })
  })

  it('目标长度以字形簇计数', () => {
    expect(autoMatchKaraoke(['∫∫', 'de'], '∫∫a')).toEqual({ sourceLength: 1, destinationLength: 2 })
  })

  it('单假名匹配罗马字', () => {
    expect(autoMatchKaraoke(['rode'], 'ろ')).toEqual({ sourceLength: 1, destinationLength: 1 })
    expect(autoMatchKaraoke(['rode'], 'ロ')).toEqual({ sourceLength: 1, destinationLength: 1 })
    expect(autoMatchKaraoke(['romajide'], 'ろまじ')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['kya', 'e'], 'きゃe')).toEqual({ sourceLength: 1, destinationLength: 2 })
    expect(autoMatchKaraoke(['kya'], 'きゃ')).toEqual({ sourceLength: 1, destinationLength: 2 })
  })

  it('源内空白：字符之间可跳过，字符内部断开', () => {
    expect(autoMatchKaraoke(['ro ma jide'], 'ろまじ')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['r om aj ide'], 'ろまじ')).toEqual({ sourceLength: 1, destinationLength: 1 })
  })

  it('目标仅剩一个字符时吞掉全部源', () => {
    expect(autoMatchKaraoke(['a', 'b', 'c'], 'ろ')).toEqual({ sourceLength: 3, destinationLength: 1 })
  })

  it('向前看：忽略空音节、只看目标 3 个字符', () => {
    expect(autoMatchKaraoke(['ab', 'ro'], 'eeろ')).toEqual({ sourceLength: 1, destinationLength: 2 })
    expect(autoMatchKaraoke(['ab', '', 'ro'], 'eeろ')).toEqual({ sourceLength: 1, destinationLength: 2 })
    expect(autoMatchKaraoke(['ab', '', '', '', '', '', 'ro'], 'eeろ')).toEqual({
      sourceLength: 1,
      destinationLength: 2,
    })
    expect(autoMatchKaraoke(['abc', '', 'ro'], 'eeeろ')).toEqual({ sourceLength: 1, destinationLength: 3 })
    expect(autoMatchKaraoke(['abcd', '', 'ro'], 'eeeeろ')).toEqual({ sourceLength: 1, destinationLength: 1 })
  })

  it('向前看：按距离均分源音节', () => {
    expect(autoMatchKaraoke(['a', 'b', 'ro'], 'eeろ')).toEqual({ sourceLength: 1, destinationLength: 1 })
    expect(autoMatchKaraoke(['a', 'b', 'c', 'ro'], 'eeろ')).toEqual({ sourceLength: 2, destinationLength: 1 })
    expect(autoMatchKaraoke(['a', 'b', 'c', 'd', 'ro'], 'eeろ')).toEqual({ sourceLength: 2, destinationLength: 1 })
    expect(autoMatchKaraoke(['a', 'b', 'c', 'd', 'f', 'ro'], 'eeろ')).toEqual({
      sourceLength: 3,
      destinationLength: 1,
    })
    expect(autoMatchKaraoke(['a', 'b', 'c', 'd', 'f', 'ro'], ' eeろ')).toEqual({
      sourceLength: 3,
      destinationLength: 2,
    })
  })

  it('向前看：多字符假名与大小写', () => {
    expect(autoMatchKaraoke(['aa', 'kya'], 'eeきゃ')).toEqual({ sourceLength: 1, destinationLength: 2 })
    expect(autoMatchKaraoke(['aa', 'kyan'], 'eeきゃ')).toEqual({ sourceLength: 1, destinationLength: 2 })
    expect(autoMatchKaraoke(['Oh... ', 'Nan', 'ka ', 'ta', 'ri', 'nai'], 'Oh…なんか足りない')).toEqual({
      sourceLength: 1,
      destinationLength: 3,
    })
  })

  it('は/へ 的读音特例', () => {
    expect(autoMatchKaraoke(['Bo', 'ku', 'wa'], '僕は')).toEqual({ sourceLength: 2, destinationLength: 1 })
    expect(autoMatchKaraoke(['Bo', 'ku', 'e'], '僕へ')).toEqual({ sourceLength: 2, destinationLength: 1 })
    expect(autoMatchKaraoke(['shi', 'tta', ''], '知った')).toEqual({ sourceLength: 1, destinationLength: 1 })
    expect(autoMatchKaraoke(['tta', ''], 'った')).toEqual({ sourceLength: 2, destinationLength: 2 })
  })
})

function syllables(spec: [number, string][], start = 100, tagType: '\\k' | '\\kf' | '\\ko' = '\\k') {
  let time = start
  return spec.map(([duration, text]) => {
    const syllable: KaraokeSyllable = {
      tagType,
      startMs: time,
      durationMs: duration,
      text,
      ovrTags: new Map(),
    }
    time += duration
    return syllable
  })
}

describe('KaraokeMatcher（karaoke_matcher.cpp）', () => {
  it('初始选择与增减选择长度', () => {
    const matcher = new KaraokeMatcher()
    matcher.setInputData(syllables([[100, 'a'], [200, 'b'], [300, 'c'], [400, 'd']]), 'abcd')

    expect(matcher.currentSourceSelection().map((s) => s.text)).toEqual(['a'])
    expect(matcher.currentDestinationSelection()).toBe('a')

    expect(matcher.decreaseSourceMatch()).toBe(true)
    expect(matcher.currentSourceSelection()).toEqual([])

    expect(matcher.increaseSourceMatch()).toBe(true)
    expect(matcher.increaseSourceMatch()).toBe(true)
    expect(matcher.increaseSourceMatch()).toBe(true)
    expect(matcher.increaseSourceMatch()).toBe(true)
    expect(matcher.currentSourceSelection().map((s) => s.text)).toEqual(['a', 'b', 'c', 'd'])
    expect(matcher.increaseSourceMatch()).toBe(false)

    expect(matcher.increaseDestinationMatch()).toBe(true)
    expect(matcher.currentDestinationSelection()).toBe('ab')
  })

  it('逐组接受与撤销', () => {
    const matcher = new KaraokeMatcher()
    matcher.setInputData(syllables([[100, '1'], [200, '2'], [300, '3'], [400, '4']]), 'abcd')

    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('{\\k10}a')
    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('{\\k10}a{\\k20}b{\\k30}c{\\k40}d')
    expect(matcher.acceptMatch()).toBe(false)

    expect(matcher.undoMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('{\\k10}a{\\k20}b{\\k30}c')
    expect(matcher.currentSourceSelection().map((s) => s.text)).toEqual(['4'])
    expect(matcher.currentDestinationSelection()).toBe('d')

    expect(matcher.undoMatch()).toBe(true)
    expect(matcher.undoMatch()).toBe(true)
    expect(matcher.undoMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('')
    expect(matcher.undoMatch()).toBe(false)
  })

  it('空源与空目标不可接受', () => {
    const matcher = new KaraokeMatcher()
    matcher.setInputData([], '')
    expect(matcher.acceptMatch()).toBe(false)
    expect(matcher.undoMatch()).toBe(false)
    expect(matcher.increaseSourceMatch()).toBe(false)
    expect(matcher.increaseDestinationMatch()).toBe(false)
  })

  it('自动匹配逐组推进（Link 后自动匹配下一组）', () => {
    const source = parseKaraokeSyllables('{\\k10}ro{\\k20}ma{\\k30}ji', 0)
    const matcher = new KaraokeMatcher()
    matcher.setInputData(source, 'ろまじ')
    matcher.autoMatchJapanese()
    expect(matcher.currentDestinationSelection()).toBe('ろ')
    expect(matcher.acceptMatch()).toBe(true)
    matcher.autoMatchJapanese()
    expect(matcher.currentDestinationSelection()).toBe('ま')
    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('{\\k10}ろ{\\k20}ま')
    matcher.autoMatchJapanese()
    expect(matcher.acceptMatch()).toBe(true)
    expect(matcher.getOutputLine()).toBe('{\\k10}ろ{\\k20}ま{\\k30}じ')
    expect(matcher.remainingSource()).toBe(0)
    expect(matcher.remainingDestination()).toBe(0)
  })
})

describe('strippedText（AssDialogue::GetStrippedText）', () => {
  it('仅保留 plain 块', () => {
    expect(strippedText('{\\i1}Hello {\\i0}world')).toBe('Hello world')
    expect(strippedText('{comment}text{\\p1}m 0 0 l 1 1')).toBe('text')
    expect(strippedText('')).toBe('')
  })
})
