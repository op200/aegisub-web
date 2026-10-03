import { describe, expect, it } from 'vitest'

import {
  compileMatcher,
  findNext,
  replaceAllMatches,
  replaceInLine,
  replaceNext,
  type SearchReplaceSettings,
} from './searchReplace'
import type { SubtitleCue } from './types'

function cue(id: string, text: string, extra: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    id,
    layer: 0,
    startMs: 0,
    endMs: 1000,
    style: 'Default',
    actor: '',
    marginL: 0,
    marginR: 0,
    marginV: 0,
    effect: '',
    text,
    comment: false,
    extra: {},
    ...extra,
  }
}

function settings(patch: Partial<SearchReplaceSettings> = {}): SearchReplaceSettings {
  return {
    find: '',
    replaceWith: '',
    field: 'text',
    limitTo: 'all',
    matchCase: false,
    useRegex: false,
    ignoreComments: false,
    skipTags: false,
    ...patch,
  }
}

describe('compileMatcher', () => {
  it('大小写不敏感（默认）', () => {
    const matcher = compileMatcher(settings({ find: 'abc' }))
    expect(matcher('xxABCyy', 0)).toMatchObject({ start: 2, end: 5 })
  })

  it('Match case 区分大小写', () => {
    const matcher = compileMatcher(settings({ find: 'abc', matchCase: true }))
    expect(matcher('xxABCyy', 0)).toBeNull()
    expect(matcher('xxabcyy', 0)).toMatchObject({ start: 2, end: 5 })
  })

  it('Skip Override Tags 剥块并把区间映射回原文', () => {
    const matcher = compileMatcher(settings({ find: 'hello', skipTags: true }))
    const value = '{\\pos(1,2)}hello'
    expect(matcher(value, 0)).toMatchObject({ start: 11, end: 16 })
  })

  it('跨块的匹配区间包含中间标签块', () => {
    const matcher = compileMatcher(settings({ find: 'ab', skipTags: true }))
    // 'a' + '{\\i1}' + 'b'：映射应覆盖 a{\i1}b
    expect(matcher('a{\\i1}b', 0)).toMatchObject({ start: 0, end: 7 })
  })
})

describe('findNext', () => {
  const cues = [cue('1', 'one'), cue('2', 'two'), cue('3', 'three two')]

  it('从活动行选区终点起环形查找', () => {
    const s = settings({ find: 'two' })
    const matcher = compileMatcher(s)
    const found = findNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 0,
    })
    expect(found).toMatchObject({ cueId: '2', start: 0, end: 3 })
  })

  it('跳过 Skip Comments 的注释行', () => {
    const withComment = [cue('1', 'target'), cue('2', 'target', { comment: true })]
    const s = settings({ find: 'target', ignoreComments: true })
    const matcher = compileMatcher(s)
    const found = findNext(withComment, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 1,
    })
    expect(found).toBeNull()
  })

  it('Limit to Selected 时只在选中集内查找（需多选）', () => {
    const s = settings({ find: 'two', limitTo: 'selected' })
    const matcher = compileMatcher(s)
    const found = findNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1', '3']),
      fieldStart: 0,
    })
    expect(found).toMatchObject({ cueId: '3', selectionOnly: true })
  })

  it('非 text 字段从下一行开始', () => {
    const styled = [cue('1', 'x', { actor: 'Bob' }), cue('2', 'y', { actor: 'Bob' })]
    const s = settings({ find: 'Bob', field: 'actor' })
    const matcher = compileMatcher(s)
    const found = findNext(styled, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 0,
    })
    expect(found).toMatchObject({ cueId: '2' })
  })
})

describe('replaceInLine / replaceAllMatches', () => {
  it('正则捕获组替换', () => {
    const s = settings({ find: '(\\w+)@(\\w+)', useRegex: true, replaceWith: '$2.$1' })
    const matcher = compileMatcher(s)
    const match = matcher('mail a@b end', 0)
    expect(match).not.toBeNull()
    const result = replaceInLine('mail a@b end', match!, s)
    expect(result.value).toBe('mail b.a end')
  })

  it('replaceAll 计数与结果（Skip Override Tags）', () => {
    const cues = [cue('1', 'a{\\i1}b ab'), cue('2', 'ab')]
    const s = settings({ find: 'ab', replaceWith: 'X', skipTags: true })
    const matcher = compileMatcher(s)
    const { updates, count } = replaceAllMatches(cues, s, matcher, new Set())
    expect(count).toBe(3)
    expect(updates).toEqual([
      { cueId: '1', value: 'X X' },
      { cueId: '2', value: 'X' },
    ])
  })

  it('replaceAll 仅作用于选中行', () => {
    const cues = [cue('1', 'aa'), cue('2', 'aa')]
    const s = settings({ find: 'a', replaceWith: 'b', limitTo: 'selected' })
    const matcher = compileMatcher(s)
    const { updates } = replaceAllMatches(cues, s, matcher, new Set(['2']))
    expect(updates).toEqual([{ cueId: '2', value: 'bb' }])
  })
})

describe('replaceNext', () => {
  it('活动行匹配但未选中：只设选区、不替换', () => {
    const cues = [cue('1', 'hello world')]
    const s = settings({ find: 'world', replaceWith: 'X' })
    const matcher = compileMatcher(s)
    const result = replaceNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 6,
      fieldEnd: 0, // 未选中（起点命中但终点不匹配）
    })
    expect(result.replacement).toBeNull()
    expect(result.found).toMatchObject({ cueId: '1', start: 6, end: 11 })
    expect(result.foundViaLoop).toBe(false)
  })

  it('已选中则替换并继续查找下一处', () => {
    const cues = [cue('1', 'world world')]
    const s = settings({ find: 'world', replaceWith: 'X' })
    const matcher = compileMatcher(s)
    const result = replaceNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 0,
      fieldEnd: 5,
    })
    expect(result.replacement).toEqual({ cueId: '1', value: 'X world' })
    expect(result.found).toMatchObject({ cueId: '1', start: 2, end: 7 })
    expect(result.foundViaLoop).toBe(true)
  })

  it('替换后整圈无匹配：选区落到新插入文本', () => {
    const cues = [cue('1', 'hello')]
    const s = settings({ find: 'hello', replaceWith: 'hi' })
    const matcher = compileMatcher(s)
    const result = replaceNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 0,
      fieldEnd: 5,
    })
    expect(result.replacement).toEqual({ cueId: '1', value: 'hi' })
    expect(result.found).toBeNull()
    expect(result.fallbackSelection).toEqual({ cueId: '1', start: 0, end: 2 })
  })

  it('非 text 字段命中即替换（无选区概念）', () => {
    const cues = [cue('1', 'x', { actor: 'Bob' })]
    const s = settings({ find: 'Bob', replaceWith: 'Alice', field: 'actor' })
    const matcher = compileMatcher(s)
    const result = replaceNext(cues, s, matcher, {
      activeId: '1',
      selectedIds: new Set(['1']),
      fieldStart: 0,
      fieldEnd: 0,
    })
    expect(result.replacement).toEqual({ cueId: '1', value: 'Alice' })
    expect(result.fallbackSelection).toBeNull()
  })
})
