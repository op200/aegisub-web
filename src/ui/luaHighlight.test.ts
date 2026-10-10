/**
 * `!...!` 块内 Lua 词法上色的单元测试（web 版增强，配色/分类见 luaHighlight.ts 文件头）。
 */
import { describe, expect, it } from 'vitest'

import type { AssSyntaxType } from './assHighlight'
import { tokenizeLuaCode } from './luaHighlight'

/** 断言 [类型, 片段] 序列（含相邻同类合并）并校验逐字符覆盖 */
function expectLua(text: string, expected: [AssSyntaxType, string][]) {
  const segments = tokenizeLuaCode(text)
  expect(segments.map((s) => [s.type, s.text])).toEqual(expected)
  expect(segments.map((s) => s.text).join('')).toBe(text)
}

describe('tokenizeLuaCode', () => {
  it('空文本', () => {
    expectLua('', [])
  })

  it('控制流关键字与 local（keyword.control / keyword.local）', () => {
    expectLua('if x then', [
      ['LUA_KEYWORD', 'if'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_KEYWORD', 'then'],
    ])
    expectLua('local y = 1', [
      ['LUA_CONSTANT', 'local'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'y'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '1'],
    ])
  })

  it('被调用的名字（support.function）与库函数整体匹配', () => {
    expectLua('retime("line", 0)', [
      ['LUA_FUNCTION', 'retime'],
      ['LUA_BRACKET1', '('],
      ['LUA_STRING', '"line"'],
      ['LUA_OPERATOR', ','],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '0'],
      ['LUA_BRACKET1', ')'],
    ])
    // 标准库「模块.成员」在 VS Code 语法里整体一个 token（同为函数色）
    expectLua('math.random()', [
      ['LUA_FUNCTION', 'math.random'],
      ['LUA_BRACKET1', '()'],
    ])
    expectLua('tostring(x)', [
      ['LUA_FUNCTION', 'tostring'],
      ['LUA_BRACKET1', '('],
      ['LUA_VARIABLE', 'x'],
      ['LUA_BRACKET1', ')'],
    ])
    // 不在调用位置的名字按普通标识符
    expectLua('x = y', [
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'y'],
    ])
  })

  it('成员访问（`.`/`:` 后的名字 → entity.other.attribute）与库常量', () => {
    expectLua('a.b', [
      ['LUA_VARIABLE', 'a'],
      ['LUA_OPERATOR', '.'],
      ['LUA_PROPERTY', 'b'],
    ])
    // 成员被调用时按函数色（support.function.any-method）
    expectLua('a:b()', [
      ['LUA_VARIABLE', 'a'],
      ['LUA_OPERATOR', ':'],
      ['LUA_FUNCTION', 'b'],
      ['LUA_BRACKET1', '()'],
    ])
    expectLua('math.pi', [['LUA_CONSTANT', 'math.pi']])
    // `..` 连接符后的名字不在成员位
    expectLua('a..b', [
      ['LUA_VARIABLE', 'a'],
      ['LUA_OPERATOR', '..'],
      ['LUA_VARIABLE', 'b'],
    ])
  })

  it('逻辑运算符与 true/false/nil', () => {
    expectLua('a and not b', [
      ['LUA_VARIABLE', 'a'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', 'and'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', 'not'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'b'],
    ])
    expectLua('true, false, nil', [
      ['LUA_CONSTANT', 'true'],
      ['LUA_OPERATOR', ','],
      ['NORMAL', ' '],
      ['LUA_CONSTANT', 'false'],
      ['LUA_OPERATOR', ','],
      ['NORMAL', ' '],
      ['LUA_CONSTANT', 'nil'],
    ])
  })

  it('$变量（`$` 视为 `table.`：$ 用命名空间位色，name 用成员位色）', () => {
    expectLua('$syl.i == $kdur', [
      ['LUA_VARIABLE', '$'],
      ['LUA_PROPERTY', 'syl'],
      ['LUA_OPERATOR', '.'],
      ['LUA_PROPERTY', 'i'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '=='],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', '$'],
      ['LUA_PROPERTY', 'kdur'],
    ])
    expectLua('$var', [
      ['LUA_VARIABLE', '$'],
      ['LUA_PROPERTY', 'var'],
    ])
    // 名字后接调用时按成员函数色（等同于 `obj.f()` 的 f）
    expectLua('$obj.f()', [
      ['LUA_VARIABLE', '$'],
      ['LUA_PROPERTY', 'obj'],
      ['LUA_OPERATOR', '.'],
      ['LUA_FUNCTION', 'f'],
      ['LUA_BRACKET1', '()'],
    ])
    // 名字按 Lua 标识符规则吃后续数字（有意偏离 var_replacer 的 $([%a_]+)，见 未完成计划.md：
    // 引擎正则会把 $a2b 拆成 $a + 2，导致 `2` 被染成数字色）
    expectLua('$a2b', [
      ['LUA_VARIABLE', '$'],
      ['LUA_PROPERTY', 'a2b'],
    ])
    expectLua('$syl2()', [
      ['LUA_VARIABLE', '$'],
      ['LUA_FUNCTION', 'syl2'],
      ['LUA_BRACKET1', '()'],
    ])
    // 单独的 $ 不在替换规则内，按符号处理
    expectLua('$ x', [
      ['LUA_OPERATOR', '$'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'x'],
    ])
  })

  it('数字（十进制/十六进制/浮点/指数 → constant.numeric）', () => {
    expectLua('0x1F 1e3 .5 2. 0xA.8p1', [
      ['LUA_NUMBER', '0x1F'],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '1e3'],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '.5'],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '2.'],
      ['NORMAL', ' '],
      ['LUA_NUMBER', '0xA.8p1'],
    ])
  })

  it('字符串（短字符串转义 / 长括号 → string）', () => {
    expectLua("s = 'a\\'b' .. [[c]]", [
      ['LUA_VARIABLE', 's'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_STRING', "'a\\'b'"],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '..'],
      ['NORMAL', ' '],
      ['LUA_STRING', '[[c]]'],
    ])
    expectLua('x = [==[a]]b]==]', [
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_STRING', '[==[a]]b]==]'],
    ])
  })

  it('注释（-- 行注释 / --[[ ]] 长注释 → comment）', () => {
    expectLua('a -- line', [
      ['LUA_VARIABLE', 'a'],
      ['NORMAL', ' '],
      ['LUA_COMMENT', '-- line'],
    ])
    expectLua('a --[[b]] c', [
      ['LUA_VARIABLE', 'a'],
      ['NORMAL', ' '],
      ['LUA_COMMENT', '--[[b]]'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'c'],
    ])
  })

  it('运算符与标点（→ keyword.operator）', () => {
    expectLua('a..b == c ~= d <= e // f ...', [
      ['LUA_VARIABLE', 'a'],
      ['LUA_OPERATOR', '..'],
      ['LUA_VARIABLE', 'b'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '=='],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'c'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '~='],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'd'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '<='],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'e'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '//'],
      ['NORMAL', ' '],
      ['LUA_VARIABLE', 'f'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '...'],
    ])
  })

  it('括号按嵌套层级上色（VS Code bracket pair colorization：3 色循环 + 未配对红）', () => {
    // 层级 = 所在括号对的深度；开闭同色，第 4 层回到 1 号色（VS Code 未定义 4-6 号前景色）
    expectLua('((((x))))', [
      ['LUA_BRACKET1', '('],
      ['LUA_BRACKET2', '('],
      ['LUA_BRACKET3', '('],
      ['LUA_BRACKET1', '('],
      ['LUA_VARIABLE', 'x'],
      ['LUA_BRACKET1', ')'],
      ['LUA_BRACKET3', ')'],
      ['LUA_BRACKET2', ')'],
      ['LUA_BRACKET1', ')'],
    ])
    // 三种括号共用同一层级计数
    expectLua('{x[y]}', [
      ['LUA_BRACKET1', '{'],
      ['LUA_VARIABLE', 'x'],
      ['LUA_BRACKET2', '['],
      ['LUA_VARIABLE', 'y'],
      ['LUA_BRACKET2', ']'],
      ['LUA_BRACKET1', '}'],
    ])
    // 无开启者 / 类型不匹配的闭合括号 → unexpectedBracket 红
    expectLua('a)', [
      ['LUA_VARIABLE', 'a'],
      ['LUA_BRACKET_UNEXPECTED', ')'],
    ])
    expectLua('(]', [
      ['LUA_BRACKET1', '('],
      ['LUA_BRACKET_UNEXPECTED', ']'],
    ])
    // 未闭合的开启括号保持层级色（打字中途不制造红色噪音）
    expectLua('f(x', [
      ['LUA_FUNCTION', 'f'],
      ['LUA_BRACKET1', '('],
      ['LUA_VARIABLE', 'x'],
    ])
    // 字符串/注释内的括号不参与配对
    expectLua("'(' -- )", [
      ['LUA_STRING', "'('"],
      ['NORMAL', ' '],
      ['LUA_COMMENT', '-- )'],
    ])
  })

  it('不完整输入容错（未闭合字符串/长括号/注释染到块尾）', () => {
    expectLua('x = "abc', [
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_STRING', '"abc'],
    ])
    expectLua('x = [[abc', [
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '='],
      ['NORMAL', ' '],
      ['LUA_STRING', '[[abc'],
    ])
    expectLua('x --abc', [
      ['LUA_VARIABLE', 'x'],
      ['NORMAL', ' '],
      ['LUA_COMMENT', '--abc'],
    ])
    expectLua('f(', [
      ['LUA_FUNCTION', 'f'],
      ['LUA_BRACKET1', '('],
    ])
  })

  it('未知字符按符号处理（保持逐字符覆盖，不制造红色噪音）', () => {
    expectLua('@ #', [
      ['LUA_OPERATOR', '@'],
      ['NORMAL', ' '],
      ['LUA_OPERATOR', '#'],
    ])
  })
})
