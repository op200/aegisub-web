import { describe, expect, it } from 'vitest'

import { Karaoke, parseKaraokeSyllables, roundCs } from './karaoke'

describe('parseKaraokeSyllables（ass_karaoke.cpp）', () => {
  it('拆分 \\k 音节，\\K 归一化为 \\kf，时间链连续', () => {
    const syllables = parseKaraokeSyllables('{\\k20}ka{\\kf10}ra{\\K5}oke', 10000)
    expect(syllables).toHaveLength(3)
    expect(syllables[0]).toMatchObject({
      tagType: '\\k',
      startMs: 10000,
      durationMs: 200,
      text: 'ka',
    })
    expect(syllables[1]).toMatchObject({
      tagType: '\\kf',
      startMs: 10200,
      durationMs: 100,
      text: 'ra',
    })
    expect(syllables[2]).toMatchObject({
      tagType: '\\kf',
      startMs: 10300,
      durationMs: 50,
      text: 'oke',
    })
  })

  it('非卡拉OK标签按偏移保留在当前音节上（源码语义：渲染等价前移）', () => {
    const syllables = parseKaraokeSyllables('{\\i1\\k10}ab{\\c&HFF&\\k10}cd', 0)
    expect(syllables).toHaveLength(2)
    expect(syllables[0].ovrTags.get(0)).toBe('{\\i1}')
    expect(syllables[0].ovrTags.get(2)).toBe('{\\c&HFF&}')
    expect(syllables[1].ovrTags.size).toBe(0)
  })

  it('无 \\k 行 → 单个 duration=0 音节', () => {
    const syllables = parseKaraokeSyllables('plain text', 5000)
    expect(syllables).toHaveLength(1)
    expect(syllables[0]).toMatchObject({ durationMs: 0, text: 'plain text', startMs: 5000 })
  })
})

describe('Karaoke（libaegisub karaoke.cpp）', () => {
  it('fromLine 归一化末音节补齐 + 空格自动切分', () => {
    const karaoke = Karaoke.fromLine('{\\k10}hello world', 0, 2000)
    expect(karaoke.syllables.length).toBeGreaterThanOrEqual(2)
    const total = karaoke.syllables.reduce((sum, syl) => sum + syl.durationMs, 0)
    expect(total).toBe(2000)
  })

  it('addSplit 按字节比例分配时长（round_cs）', () => {
    const karaoke = new Karaoke()
    karaoke.syllables = [
      { tagType: '\\k', startMs: 0, durationMs: 100, text: 'abcd', ovrTags: new Map() },
    ]
    karaoke.addSplit(0, 2)
    expect(karaoke.syllables).toHaveLength(2)
    expect(karaoke.syllables[0].text).toBe('ab')
    expect(karaoke.syllables[1].text).toBe('cd')
    // 50/50 → 50ms/50ms
    expect(karaoke.syllables[0].durationMs).toBe(50)
    expect(karaoke.syllables[1].durationMs).toBe(50)
    expect(karaoke.syllables[1].startMs).toBe(50)
  })

  it('setStartTime 只影响相邻两个音节且 10ms 取整', () => {
    const karaoke = new Karaoke()
    karaoke.syllables = [
      { tagType: '\\k', startMs: 0, durationMs: 100, text: 'a', ovrTags: new Map() },
      { tagType: '\\k', startMs: 100, durationMs: 100, text: 'b', ovrTags: new Map() },
      { tagType: '\\k', startMs: 200, durationMs: 100, text: 'c', ovrTags: new Map() },
    ]
    karaoke.setStartTime(1, roundCs(153)) // → 150
    expect(karaoke.syllables[0].durationMs).toBe(150)
    expect(karaoke.syllables[1].startMs).toBe(150)
    expect(karaoke.syllables[1].durationMs).toBe(50)
    expect(karaoke.syllables[2].startMs).toBe(200)
  })

  it('removeSplit 并回前一音节', () => {
    const karaoke = new Karaoke()
    karaoke.syllables = [
      { tagType: '\\k', startMs: 0, durationMs: 50, text: 'a', ovrTags: new Map() },
      { tagType: '\\k', startMs: 50, durationMs: 50, text: 'b', ovrTags: new Map() },
    ]
    karaoke.removeSplit(1)
    expect(karaoke.syllables).toHaveLength(1)
    expect(karaoke.syllables[0].text).toBe('ab')
    expect(karaoke.syllables[0].durationMs).toBe(100)
  })

  it('getText 序列化 (d+5)/10 并插回标签', () => {
    const karaoke = new Karaoke()
    karaoke.syllables = [
      {
        tagType: '\\k',
        startMs: 0,
        durationMs: 105,
        text: 'ka',
        ovrTags: new Map([[0, '{\\i1}']]),
      },
      { tagType: '\\kf', startMs: 105, durationMs: 95, text: 'ra', ovrTags: new Map() },
    ]
    expect(karaoke.getText()).toBe('{\\k11}{\\i1}ka{\\kf10}ra')
  })

  it('setTagType 全部音节统一', () => {
    const karaoke = new Karaoke()
    karaoke.syllables = [
      { tagType: '\\k', startMs: 0, durationMs: 50, text: 'a', ovrTags: new Map() },
      { tagType: '\\kf', startMs: 50, durationMs: 50, text: 'b', ovrTags: new Map() },
    ]
    karaoke.setTagType('\\ko')
    expect(karaoke.getText()).toBe('{\\ko5}a{\\ko5}b')
  })
})
