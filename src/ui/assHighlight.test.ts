/**
 * 移植自源码 tests/tests/dialogue_lexer.cpp 与 tests/tests/syntax_highlight.cpp。
 * 差异：web 侧无拼写检查器（源码 ss::SPELLING 分支），故期望值里 SPELLING 归入 NORMAL。
 */
import { describe, expect, it } from 'vitest'

import { tokenizeAss, tokenizeDialogueBody, type AssSyntaxType } from './assHighlight'
import { LUA_SYNTAX_COLORS } from './luaHighlight'

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
  templateLuaHighlight = true,
) {
  const segments = tokenizeAss(text, karaokeTemplater, templateLuaHighlight)
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
    // 变量名吃后续数字（有意偏离源码 \$[A-Za-z_]+ 正则，见 未完成计划.md：
    // 否则 $syl2 被拆成 $syl + 2，`2` 按普通文本上色）
    expectTokens('$syl2', true, [['KARAOKE_VARIABLE', 5]])
    expectTokens('x$syl2', true, [
      ['TEXT', 1],
      ['KARAOKE_VARIABLE', 5],
    ])
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
    expectStyles('$syl2', true, [['KARAOKE_VARIABLE', 5]])

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

  it('模板行的 !表达式!（web 增强：块内 Lua 上色，! 分界符运算符白）', () => {
    expectStyles('!5!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_NUMBER', 1],
      ['LUA_DELIMITER', 1],
    ])
    expectStyles('!5', true, [['NORMAL', 2]])
    expectStyles('!x * 10!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_VARIABLE', 1],
      ['NORMAL', 1],
      ['LUA_OPERATOR', 1],
      ['NORMAL', 1],
      ['LUA_NUMBER', 2],
      ['LUA_DELIMITER', 1],
    ])

    expectStyles('{\\pos(!x + 1!, $y)}a', true, [
      ['OVERRIDE', 1],
      ['PUNCTUATION', 1],
      ['TAG', 3],
      ['PUNCTUATION', 1],
      ['LUA_DELIMITER', 1],
      ['LUA_VARIABLE', 1],
      ['NORMAL', 1],
      ['LUA_OPERATOR', 1],
      ['NORMAL', 1],
      ['LUA_NUMBER', 1],
      ['LUA_DELIMITER', 1],
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
      ['LUA_DELIMITER', 1],
      ['LUA_STRING', 3],
      ['LUA_DELIMITER', 1],
      ['NORMAL', 1],
    ])
  })

  it('模板表达式内的 Lua 词法（函数名/字符串/关键字）', () => {
    expectStyles('!retime("line",0,0)!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_FUNCTION', 6],
      ['LUA_BRACKET1', 1],
      ['LUA_STRING', 6],
      ['LUA_OPERATOR', 1],
      ['LUA_NUMBER', 1],
      ['LUA_OPERATOR', 1],
      ['LUA_NUMBER', 1],
      ['LUA_BRACKET1', 1],
      ['LUA_DELIMITER', 1],
    ])
    expectStyles('!if x then 1 end!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_KEYWORD', 2],
      ['NORMAL', 1],
      ['LUA_VARIABLE', 1],
      ['NORMAL', 1],
      ['LUA_KEYWORD', 4],
      ['NORMAL', 1],
      ['LUA_NUMBER', 1],
      ['NORMAL', 1],
      ['LUA_KEYWORD', 3],
      ['LUA_DELIMITER', 1],
    ])
  })

  it('多个模板表达式（相邻 !块! 被词法器合并后仍逐块上色）', () => {
    expectStyles('!1!2!3!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_NUMBER', 1],
      ['LUA_DELIMITER', 1],
      ['NORMAL', 1],
      ['LUA_DELIMITER', 1],
      ['LUA_NUMBER', 1],
      ['LUA_DELIMITER', 1],
    ])
    expectStyles('!a!!b!', true, [
      ['LUA_DELIMITER', 1],
      ['LUA_VARIABLE', 1],
      ['LUA_DELIMITER', 2],
      ['LUA_VARIABLE', 1],
      ['LUA_DELIMITER', 1],
    ])
  })

  it('! 分界符与运算符同色（LUA_DELIMITER = VS Code 运算符白 #D4D4D4）', () => {
    expect(LUA_SYNTAX_COLORS.LUA_DELIMITER).toBe(LUA_SYNTAX_COLORS.LUA_OPERATOR)
  })

  it('Subtitle/Highlight/Template Lua 关闭时与源码一致：整块 Karaoke 紫、无底纹', () => {
    expectStyles('!5!', true, [['KARAOKE_TEMPLATE', 3]], false)
    expectStyles(
      'a !x + 1! b',
      true,
      [
        ['NORMAL', 2],
        ['KARAOKE_TEMPLATE', 7],
        ['NORMAL', 2],
      ],
      false,
    )
    expect(tokenizeAss('a !x + 1! b', true, false).every((s) => s.background === undefined)).toBe(
      true,
    )
  })

  it('模板 !代码! 块整体叠加 Dark Modern 编辑区底色（web 增强）', () => {
    // 块内所有段（! 分界符、代码、块内空白）统一带 #1F1F1F 段级底纹，连成整块
    const segments = tokenizeAss('a !x + 1! b', true)
    expect(segments.map((s) => [s.text, s.type, s.background])).toEqual([
      ['a ', 'NORMAL', undefined],
      ['!', 'LUA_DELIMITER', '#1F1F1F'],
      ['x', 'LUA_VARIABLE', '#1F1F1F'],
      [' ', 'NORMAL', '#1F1F1F'],
      ['+', 'LUA_OPERATOR', '#1F1F1F'],
      [' ', 'NORMAL', '#1F1F1F'],
      ['1', 'LUA_NUMBER', '#1F1F1F'],
      ['!', 'LUA_DELIMITER', '#1F1F1F'],
      [' b', 'NORMAL', undefined],
    ])
    // 非模板行（`!` 按普通文本）无段级底纹
    expect(tokenizeAss('!x!', false).every((s) => s.background === undefined)).toBe(true)
  })
})
