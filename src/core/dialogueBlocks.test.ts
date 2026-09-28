// 翻译助手移植测试：对齐 ass_dialogue.cpp ParseTags / dialog_translation.cpp 的可见语义
import { describe, expect, it } from 'vitest'

import {
  commitDialogueBlock,
  isBadBlock,
  parseDialogueBlocks,
  stepDialogueBlock,
  type DialogueBlock,
} from './dialogueBlocks'

const plain = (text: string): DialogueBlock => ({ type: 'plain', text })

describe('parseDialogueBlocks（AssDialogue::ParseTags）', () => {
  it('按花括号拆块并保留原始文本（override 含反斜杠、comment 不含）', () => {
    expect(parseDialogueBlocks('Yes, I {\\i1}am{\\i0} here.')).toEqual([
      plain('Yes, I '),
      { type: 'override', text: '{\\i1}' },
      plain('am'),
      { type: 'override', text: '{\\i0}' },
      plain(' here.'),
    ])
    expect(parseDialogueBlocks('a{comment}b')).toEqual([
      plain('a'),
      { type: 'comment', text: '{comment}' },
      plain('b'),
    ])
  })

  it('空行得到单个空 plain 块', () => {
    expect(parseDialogueBlocks('')).toEqual([plain('')])
  })

  it('未闭合的 { 按纯文本处理（VSFilter 语义）', () => {
    // find('{', cur + 1) 跳过当前位置，故 "a" 与 "{\\i1 b" 各成一块
    expect(parseDialogueBlocks('a{\\i1 b')).toEqual([plain('a'), plain('{\\i1 b')])
  })

  it('\\p 后的花括号外文本为 drawing 块，\\p0 恢复 plain', () => {
    expect(parseDialogueBlocks('{\\p1}m 0 0 l 1 1{\\p0}text')).toEqual([
      { type: 'override', text: '{\\p1}' },
      { type: 'drawing', text: 'm 0 0 l 1 1' },
      { type: 'override', text: '{\\p0}' },
      plain('text'),
    ])
  })

  it('\\t(...) 内嵌套的 \\p 不改变绘图级别，\\pbo 不误判为 \\p', () => {
    expect(parseDialogueBlocks('{\\t(\\p1)}text')).toEqual([
      { type: 'override', text: '{\\t(\\p1)}' },
      plain('text'),
    ])
    expect(parseDialogueBlocks('{\\pbo10}x')).toEqual([
      { type: 'override', text: '{\\pbo10}' },
      plain('x'),
    ])
  })
})

describe('isBadBlock（bad_block）', () => {
  it('非 plain 恒不可翻译；空白 plain 仅在 Skip Whitespace 打开时跳过', () => {
    expect(isBadBlock({ type: 'override', text: '{\\i1}' }, false)).toBe(true)
    expect(isBadBlock({ type: 'drawing', text: 'm 0 0' }, false)).toBe(true)
    expect(isBadBlock(plain('  \t'), true)).toBe(true)
    expect(isBadBlock(plain('  \t'), false)).toBe(false)
    expect(isBadBlock(plain('　'), true)).toBe(true) // 全角空格（Unicode 空白）
    expect(isBadBlock(plain('x'), true)).toBe(false)
  })
})

describe('stepDialogueBlock（NextBlock/PrevBlock）', () => {
  const cues = [
    { text: 'a{\\i1}b' }, // 0: plain "a" / override / plain "b"
    { text: '  ' }, // 1: 空白行（Skip Whitespace 下整行跳过）
    { text: '{\\p1}m 0 0' }, // 2: override / drawing —— 无可翻译块
    { text: 'last' }, // 3
  ]

  it('块内向后/向前移动', () => {
    const blocks = parseDialogueBlocks(cues[0].text)
    expect(stepDialogueBlock(cues, 0, blocks, 0, 1, true)).toEqual({
      lineIndex: 0,
      blockIndex: 2,
    })
    expect(stepDialogueBlock(cues, 0, blocks, 2, -1, true)).toEqual({
      lineIndex: 0,
      blockIndex: 0,
    })
  })

  it('跨行跳过不可翻译行，直到文档边界返回 null', () => {
    const blocks = parseDialogueBlocks(cues[0].text)
    expect(stepDialogueBlock(cues, 0, blocks, 2, 1, true)).toEqual({
      lineIndex: 3,
      blockIndex: 0,
    })
    expect(stepDialogueBlock(cues, 3, parseDialogueBlocks(cues[3].text), 0, 1, true)).toBeNull()
    expect(stepDialogueBlock(cues, 0, blocks, 0, -1, true)).toBeNull()
  })

  it('Skip Whitespace 关闭时空白块参与翻译', () => {
    const blocks = parseDialogueBlocks(cues[0].text)
    expect(stepDialogueBlock(cues, 0, blocks, 2, 1, false)).toEqual({
      lineIndex: 1,
      blockIndex: 0,
    })
  })
})

describe('commitDialogueBlock', () => {
  it('替换当前块并拼回整行（其余块原文保留）', () => {
    const blocks = parseDialogueBlocks('a{\\i1}b')
    const { blocks: updated, text } = commitDialogueBlock(blocks, 0, '译{\\b1}文')
    expect(text).toBe('译{\\b1}文{\\i1}b')
    // 用户输入的花括号不重新拆块（源码替换为单个 AssDialogueBlockPlain）
    expect(updated[0]).toEqual(plain('译{\\b1}文'))
  })
})
