/**
 * 移植自源码 tests/tests/dialogue_lexer.cpp 与 tests/tests/syntax_highlight.cpp。
 * 差异：web 侧无拼写检查器（源码 ss::SPELLING 分支），故期望值里 SPELLING 归入 NORMAL。
 */
import { describe, expect, it } from 'vitest'

import { tokenizeAss, tokenizeDialogueBody, type AssSyntaxType } from './assHighlight'

/** 与源码 tok_str 宏等价的 token 断言（含相邻同类合并校验） */
function expectTokens(text: string, karaokeTemplater: boolean, expected: [string, number][]) {
  const tokens = tokenizeDialogueBody(text, karaokeTemplater)
  expect(tokens.map((t) => [t.type, t.length])).toEqual(expected)
  expect(tokens.reduce((sum, t) => sum + t.length, 0)).toBe(text.length)
}

/** 与源码 expect_style 等价的高亮断言 */
function expectStyles(
  text: string,
  karaokeTemplater: boolean,
  expected: [AssSyntaxType, number][],
) {
  const segments = tokenizeAss(text, karaokeTemplater)
  expect(segments.map((s) => [s.type, s.text.length])).toEqual(expected)
  // 高亮层必须与 textarea 文本逐字符对齐（丢字会整体错位）
  expect(segments.map((s) => s.text).join('')).toBe(text)
}

describe('tokenizeDialogueBody', () => {
  it('空文本', () => {
    expect(tokenizeDialogueBody('')).toEqual([])
  })

  it('普通文本与换行', () => {
    expectTokens('hello there', false, [['TEXT', 11]])
    expectTokens('hello\\Nthere', false, [
      ['TEXT', 5],
      ['LINE_BREAK', 2],
      ['TEXT', 5],
    ])
    expectTokens('hello\\n\\h\\kthere', false, [
      ['TEXT', 5],
      ['LINE_BREAK', 4],
      ['TEXT', 7],
    ])
  })

  it('基础覆盖标签', () => {
    expectTokens('{\\b1}bold text{\\b0}', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 1],
      ['OVR_END', 1],
      ['TEXT', 9],
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 1],
      ['OVR_END', 1],
    ])

    expectTokens('{\\fnComic Sans MS}text', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 2],
      ['ARG', 5],
      ['WHITESPACE', 1],
      ['ARG', 4],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['OVR_END', 1],
      ['TEXT', 4],
    ])

    expectTokens('{\\pos(0,0)}a', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['ARG', 1],
      ['ARG_SEP', 1],
      ['ARG', 1],
      ['CLOSE_PAREN', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])

    expectTokens('{\\pos( 0 , 0 )}a', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG_SEP', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['CLOSE_PAREN', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])

    expectTokens('{\\c&HFFFFFF&\\2c&H0000FF&\\3c&H000000&}a', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 9],
      ['TAG_START', 1],
      ['TAG_NAME', 2],
      ['ARG', 9],
      ['TAG_START', 1],
      ['TAG_NAME', 2],
      ['ARG', 9],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])

    expectTokens('{\\t(0,100,\\clip(1, m 0 0 l 10 10 10 20))}a', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['OPEN_PAREN', 1],
      ['ARG', 1],
      ['ARG_SEP', 1],
      ['ARG', 3],
      ['ARG_SEP', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 4],
      ['OPEN_PAREN', 1],
      ['ARG', 1],
      ['ARG_SEP', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['CLOSE_PAREN', 2],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
  })

  it('相邻同类 token 不合并的条件（标签边界）', () => {
    expectTokens('{\\b\\b', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
    ])
  })

  it('空白', () => {
    expectTokens('{ \\ fn Comic Sans MS }asd', false, [
      ['OVR_BEGIN', 1],
      ['WHITESPACE', 1],
      ['TAG_START', 1],
      ['WHITESPACE', 1],
      ['TAG_NAME', 2],
      ['WHITESPACE', 1],
      ['ARG', 5],
      ['WHITESPACE', 1],
      ['ARG', 4],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['WHITESPACE', 1],
      ['OVR_END', 1],
      ['TEXT', 3],
    ])
  })

  it('覆盖块内非标签文本按注释 token', () => {
    expectTokens('{a}b', false, [
      ['OVR_BEGIN', 1],
      ['COMMENT', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])

    expectTokens('{a\\b}c', false, [
      ['OVR_BEGIN', 1],
      ['COMMENT', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
  })

  it('畸形覆盖块', () => {
    expectTokens('}', false, [['TEXT', 1]])
    expectTokens('{{', false, [
      ['OVR_BEGIN', 1],
      ['ERROR', 1],
    ])
    expectTokens('{\\pos(0,0}a', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['ARG', 1],
      ['ARG_SEP', 1],
      ['ARG', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
    expectTokens('{\\b1\\}asdf', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 1],
      ['TAG_START', 1],
      ['OVR_END', 1],
      ['TEXT', 4],
    ])
  })

  it('非模板行不识别卡拉OK模板语法', () => {
    expectTokens('{\\pos($x, $y)\\fs!10 + 10!}abc', false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['ARG', 2],
      ['ARG_SEP', 1],
      ['WHITESPACE', 1],
      ['ARG', 2],
      ['CLOSE_PAREN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 2],
      ['ARG', 3],
      ['WHITESPACE', 1],
      ['ARG', 1],
      ['WHITESPACE', 1],
      ['ARG', 3],
      ['OVR_END', 1],
      ['TEXT', 3],
    ])

    expectTokens("{\\b1!'}'!a", false, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 3],
      ['OVR_END', 1],
      ['TEXT', 3],
    ])
  })

  it('模板行识别 $变量', () => {
    expectTokens('$a', true, [['KARAOKE_VARIABLE', 2]])
    expectTokens('{\\pos($x,$y)}a', true, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['KARAOKE_VARIABLE', 2],
      ['ARG_SEP', 1],
      ['KARAOKE_VARIABLE', 2],
      ['CLOSE_PAREN', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
    expectTokens('{\\fn$fn}a', true, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 2],
      ['KARAOKE_VARIABLE', 3],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
    expectTokens('{foo$bar}', true, [
      ['OVR_BEGIN', 1],
      ['COMMENT', 3],
      ['KARAOKE_VARIABLE', 4],
      ['OVR_END', 1],
    ])
    expectTokens('{foo$bar', true, [
      ['OVR_BEGIN', 1],
      ['COMMENT', 3],
      ['KARAOKE_VARIABLE', 4],
    ])
  })

  it('模板行识别 !表达式!', () => {
    expectTokens('!5!', true, [['KARAOKE_TEMPLATE', 3]])
    expectTokens('!5', true, [['TEXT', 2]])
    expectTokens('!x * 10!', true, [['KARAOKE_TEMPLATE', 8]])
    expectTokens('{\\pos(!x + 1!, $y)}a', true, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 3],
      ['OPEN_PAREN', 1],
      ['KARAOKE_TEMPLATE', 7],
      ['ARG_SEP', 1],
      ['WHITESPACE', 1],
      ['KARAOKE_VARIABLE', 2],
      ['CLOSE_PAREN', 1],
      ['OVR_END', 1],
      ['TEXT', 1],
    ])
    expectTokens("{\\b1!'}'!a", true, [
      ['OVR_BEGIN', 1],
      ['TAG_START', 1],
      ['TAG_NAME', 1],
      ['ARG', 1],
      ['KARAOKE_TEMPLATE', 5],
      ['ARG', 1],
    ])
  })
})

describe('tokenizeAss', () => {
  it('空文本', () => {
    expectStyles('', false, [])
  })

  it('绘图（\\clip 与 \\p1）', () => {
    expectStyles(
      'incorrect{\\clip(m 10 10 l 20 20 c)\\p1}m 10 10 b 0 0 0 100 100 0{\\p}correct',
      false,
      [
        ['NORMAL', 9],
        ['OVERRIDE', 1],
        ['PUNCTUATION', 1],
        ['TAG', 4],
        ['PUNCTUATION', 1],
        ['DRAWING_CMD', 1],
        ['NORMAL', 1],
        ['DRAWING_X', 2],
        ['NORMAL', 1],
        ['DRAWING_Y', 2],
        ['NORMAL', 1],
        ['DRAWING_CMD', 1],
        ['NORMAL', 1],
        ['DRAWING_X', 2],
        ['NORMAL', 1],
        ['DRAWING_Y', 2],
        ['NORMAL', 1],
        ['DRAWING_CMD', 1],
        ['PUNCTUATION', 2],
        ['TAG', 1],
        ['PARAMETER', 1],
        ['OVERRIDE', 1],
        ['DRAWING_CMD', 1],
        ['NORMAL', 1],
        ['DRAWING_X', 2],
        ['NORMAL', 1],
        ['DRAWING_Y', 2],
        ['NORMAL', 1],
        ['DRAWING_CMD', 1],
        ['NORMAL', 1],
        ['DRAWING_X', 1],
        ['NORMAL', 1],
        ['DRAWING_Y', 1],
        ['NORMAL', 1],
        ['DRAWING_X', 1],
        ['NORMAL', 1],
        ['DRAWING_Y', 3],
        ['NORMAL', 1],
        ['DRAWING_ENDPOINT_X', 4],
        ['DRAWING_ENDPOINT_Y', 1],
        ['OVERRIDE', 1],
        ['PUNCTUATION', 1],
        ['TAG', 1],
        ['OVERRIDE', 1],
        ['NORMAL', 7],
      ],
    )
  })

  it('绘图缺少起始 m 时全部按错误着色', () => {
    expectStyles('{\\p1}l 100 100 0 100', false, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 1],
      ['PARAMETER', 1],
      ['OVERRIDE', 1],
      ['ERROR', 1],
      ['NORMAL', 1],
      ['ERROR', 3],
      ['NORMAL', 1],
      ['ERROR', 3],
      ['NORMAL', 1],
      ['ERROR', 1],
      ['NORMAL', 1],
      ['ERROR', 3],
    ])
  })

  it('嵌套标签与绘图坐标', () => {
    expectStyles('{\\t(0, 0, \\clip(0,0,10,10)}clipped text', false, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 1],
      ['PUNCTUATION', 1],
      ['PARAMETER', 1],
      ['PUNCTUATION', 1],
      ['NORMAL', 1],
      ['PARAMETER', 1],
      ['PUNCTUATION', 1],
      ['NORMAL', 1],
      ['PUNCTUATION', 1],
      ['TAG', 4],
      ['PUNCTUATION', 1],
      ['PARAMETER', 1],
      ['PUNCTUATION', 1],
      ['PARAMETER', 1],
      ['PUNCTUATION', 1],
      ['PARAMETER', 2],
      ['PUNCTUATION', 1],
      ['PARAMETER', 2],
      ['PUNCTUATION', 1],
      ['OVERRIDE', 1],
      ['NORMAL', 12],
    ])
  })

  it('未闭合覆盖块按纯文本处理', () => {
    expectStyles('{\\incorrect}{\\incorrect', false, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 9],
      ['OVERRIDE', 1],
      // 源码此处为 WORD 切分后的 NORMAL(2) + SPELLING(9)（无拼写检查器时合并为 NORMAL 11）
      ['NORMAL', 11],
    ])
  })

  it('覆盖块内非标签文本按注释着色', () => {
    expectStyles('abc{def}ghi', false, [
      ['NORMAL', 3],
      ['OVERRIDE', 1],
      ['COMMENT', 3],
      ['OVERRIDE', 1],
      ['NORMAL', 3],
    ])
  })

  it('换行符', () => {
    expectStyles('a\\Nb\\nc\\hd\\N\\N', false, [
      ['NORMAL', 1],
      ['LINE_BREAK', 2],
      ['NORMAL', 1],
      ['LINE_BREAK', 2],
      ['NORMAL', 1],
      ['LINE_BREAK', 2],
      ['NORMAL', 1],
      ['LINE_BREAK', 4],
    ])
  })

  it('\\fn 后的字体名按参数着色（含空格）', () => {
    expectStyles('{\\fnComic Sans MS}', false, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 2],
      ['PARAMETER', 13],
      ['OVERRIDE', 1],
    ])
  })

  it('非模板行不识别 $变量与 !表达式!', () => {
    expectStyles('{\\pos($x, $y)\\fs!10 + 10!}abc', false, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 3],
      ['PUNCTUATION', 1],
      ['PARAMETER', 2],
      ['PUNCTUATION', 1],
      ['NORMAL', 1],
      ['PARAMETER', 2],
      ['PUNCTUATION', 2],
      ['TAG', 2],
      ['PARAMETER', 9],
      ['OVERRIDE', 1],
      ['NORMAL', 3],
    ])
  })

  it('模板行的 $变量', () => {
    expectStyles('$a', true, [['KARAOKE_VARIABLE', 2]])

    expectStyles('{\\pos($x,$y)}a', true, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 3],
      ['PUNCTUATION', 1],
      ['KARAOKE_VARIABLE', 2],
      ['PUNCTUATION', 1],
      ['KARAOKE_VARIABLE', 2],
      ['PUNCTUATION', 1],
      ['OVERRIDE', 1],
      ['NORMAL', 1],
    ])

    expectStyles('{\\fn$fn}a', true, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 2],
      ['KARAOKE_VARIABLE', 3],
      ['OVERRIDE', 1],
      ['NORMAL', 1],
    ])

    expectStyles('{foo$bar}', true, [
      ['OVERRIDE', 1],
      ['COMMENT', 3],
      ['KARAOKE_VARIABLE', 4],
      ['OVERRIDE', 1],
    ])

    expectStyles('{foo$bar', true, [
      ['NORMAL', 4],
      ['KARAOKE_VARIABLE', 4],
    ])
  })

  it('模板行的 !表达式!', () => {
    expectStyles('!5!', true, [['KARAOKE_TEMPLATE', 3]])
    expectStyles('!5', true, [['NORMAL', 2]])
    expectStyles('!x * 10!', true, [['KARAOKE_TEMPLATE', 8]])

    expectStyles('{\\pos(!x + 1!, $y)}a', true, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 3],
      ['PUNCTUATION', 1],
      ['KARAOKE_TEMPLATE', 7],
      ['PUNCTUATION', 1],
      ['NORMAL', 1],
      ['KARAOKE_VARIABLE', 2],
      ['PUNCTUATION', 1],
      ['OVERRIDE', 1],
      ['NORMAL', 1],
    ])

    // `}` 被 !表达式! 吞掉：无 OVR_END → 覆盖块按纯文本处理
    expectStyles("{\\b1!'}'!a", true, [
      ['NORMAL', 4],
      ['KARAOKE_TEMPLATE', 5],
      ['NORMAL', 1],
    ])
  })

  it('多个模板表达式', () => {
    expectStyles('!1!2!3!', true, [
      ['KARAOKE_TEMPLATE', 3],
      ['NORMAL', 1],
      ['KARAOKE_TEMPLATE', 3],
    ])
  })
})
