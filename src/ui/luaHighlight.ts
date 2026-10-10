/**
 * 卡拉OK模板 `!代码!` 块内 Lua 代码的语法上色（web 版增强；源码 subs_edit_ctrl.cpp
 * 仅把整块 !...! 染成 Karaoke Template 紫，块内不做细分）。
 *
 * 手写容错词法器：不做法文法校验，打字过程中的不完整输入（未闭合字符串/长括号、
 * 孤立符号等）不抛错，未闭合片段染到块尾，保证高亮层与文本逐字符对齐。
 *
 * 词法类对齐 VS Code 内置 Lua 语法（extensions/lua/syntaxes/lua.tmLanguage.json），
 * 配色取自 VS Code「现代深色 / Dark Modern」主题（LUA_SYNTAX_COLORS）：
 *   控制流关键字 if/then/end/…  keyword.control          → LUA_KEYWORD   #C586C0
 *   true/false/nil、local、_G   constant.language 等     → LUA_CONSTANT  #569CD6
 *   and/or/not                  keyword.operator         → LUA_OPERATOR  #D4D4D4
 *   库函数/全局函数/被调用的名字  support.function         → LUA_FUNCTION  #DCDCAA
 *   `.`/`:` 后的成员名           entity.other.attribute   → LUA_PROPERTY  #4EC9B0
 *   其他标识符                   variable.other           → LUA_VARIABLE  #9CDCFE
 *   字符串（含长括号）string、数字 constant.numeric、注释 comment、运算符/标点 → 同名 LUA_* 类
 *
 * 括号 ( ) [ ] { } 按嵌套层级上色（对齐 VS Code bracket pair colorization）：
 *   色板取 editorBracketHighlight.foreground1/2/3 = #FFD700 / #DA70D6 / #179FFF，
 *   层级 4 起循环（Dark Modern 未定义 4-6 号色，VS Code 语义即 rollover）；
 *   无开启者或类型不匹配的闭合括号用 unexpectedBracket 红 rgba(255,18,18,0.8)，
 *   字符串/长括号/注释内的括号不参与配对（词法器先整段消费）。
 *
 * `!` 分界符（LUA_DELIMITER，按运算符白显示）与块外 `$变量`（Karaoke 紫）由调用方
 * （assHighlight.ts）处理；块内 `$var` 按
 * 「`$` 视为 `table.`」上色（kara-templater.lua 的 var_replacer 以 $([%a_]+) 替换变量）：
 * `$` → LUA_VARIABLE（表/命名空间位），name → LUA_PROPERTY（被访问的成员位，
 * 后接调用则 LUA_FUNCTION）——即 `$var` 与 `var.var` 同款上色逻辑。
 * 块整体（含 `!` 分界符与块内空白）的底纹 LUA_BLOCK_BACKGROUND（#1F1F1F，Dark Modern
 * 编辑区底色）由调用方叠加为段级 background，本词法器只负责词法分类。
 */
import type { AssHighlightSegment, AssSyntaxType, LuaSyntaxType } from './assHighlight'

/**
 * VS Code「现代深色 / Dark Modern」主题的 Lua 配色（用户选择：不做亮色适配，恒用原色）。
 * 逐项取自 VS Code 主题链：dark_modern.json → dark_plus.json → dark_vs.json。
 */
export const LUA_SYNTAX_COLORS: Record<LuaSyntaxType, string> = {
  LUA_DELIMITER: '#D4D4D4', // `!` 分界符（web 增强：与运算符同色）
  LUA_COMMENT: '#6A9955', // comment
  LUA_STRING: '#CE9178', // string
  LUA_NUMBER: '#B5CEA8', // constant.numeric
  LUA_KEYWORD: '#C586C0', // keyword.control（dark_plus 覆盖 dark_vs 的 #569CD6）
  LUA_CONSTANT: '#569CD6', // constant.language / keyword.local
  LUA_FUNCTION: '#DCDCAA', // entity.name.function / support.function
  LUA_VARIABLE: '#9CDCFE', // variable.other
  LUA_PROPERTY: '#4EC9B0', // entity.other.attribute（`.`/`:` 后的成员名）
  LUA_OPERATOR: '#D4D4D4', // keyword.operator
  LUA_BRACKET1: '#FFD700', // editorBracketHighlight.foreground1
  LUA_BRACKET2: '#DA70D6', // editorBracketHighlight.foreground2
  LUA_BRACKET3: '#179FFF', // editorBracketHighlight.foreground3
  // editorBracketHighlight.unexpectedBracket.foreground（未配对/类型不匹配的闭合括号）
  LUA_BRACKET_UNEXPECTED: 'rgba(255, 18, 18, 0.8)',
}

/** `!代码!` 块的段级底纹：Dark Modern 编辑区底色 editor.background（31,31,31） */
export const LUA_BLOCK_BACKGROUND = '#1F1F1F'

/** 底纹内的光标色：VS Code editorCursor.foreground 深色默认 #AEAFAD（浅色主题下
 *  编辑框 caret 为 --text 深色，落在 #1F1F1F 上不可见，块内恒用深色主题光标色） */
export const LUA_BLOCK_CARET = '#AEAFAD'

/** 控制流与结构关键字（keyword.control.lua → LUA_KEYWORD） */
const LUA_CONTROL_KEYWORDS = new Set([
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'repeat',
  'return',
  'then',
  'until',
  'while',
])

/** 字面量与声明关键字（constant.language.lua / keyword.local.lua → 同为 LUA_CONSTANT） */
const LUA_CONSTANTS = new Set(['true', 'false', 'nil', 'local', '_ENV', '_G', '_VERSION'])

/** 逻辑运算符（keyword.operator.logical.lua → 与运算符同色） */
const LUA_LOGICAL_OPERATORS = new Set(['and', 'or', 'not'])

/** 标准库全局函数（support.function.lua） */
const LUA_GLOBAL_FUNCTIONS = new Set([
  'assert',
  'collectgarbage',
  'dofile',
  'error',
  'getfenv',
  'getmetatable',
  'ipairs',
  'load',
  'loadfile',
  'loadstring',
  'module',
  'next',
  'pairs',
  'pcall',
  'print',
  'rawequal',
  'rawget',
  'rawlen',
  'rawset',
  'require',
  'select',
  'setfenv',
  'setmetatable',
  'tonumber',
  'tostring',
  'type',
  'unpack',
  'xpcall',
])

/** 标准库「模块.成员」函数（support.function.library.lua，语法里整体一个 token） */
const LUA_LIBRARY_MODULES: Record<string, string[]> = {
  coroutine: ['create', 'isyieldable', 'close', 'resume', 'running', 'status', 'wrap', 'yield'],
  string: [
    'byte',
    'char',
    'dump',
    'find',
    'format',
    'gmatch',
    'gsub',
    'len',
    'lower',
    'match',
    'pack',
    'packsize',
    'rep',
    'reverse',
    'sub',
    'unpack',
    'upper',
  ],
  table: ['concat', 'create', 'insert', 'maxn', 'move', 'pack', 'remove', 'sort', 'unpack'],
  math: [
    'abs',
    'acos',
    'asin',
    'atan',
    'atan2',
    'ceil',
    'cos',
    'cosh',
    'deg',
    'exp',
    'floor',
    'fmod',
    'frexp',
    'ldexp',
    'log',
    'log10',
    'max',
    'min',
    'modf',
    'pow',
    'rad',
    'random',
    'randomseed',
    'sin',
    'sinh',
    'sqrt',
    'tan',
    'tanh',
    'tointeger',
    'type',
  ],
  io: [
    'close',
    'flush',
    'input',
    'lines',
    'open',
    'output',
    'popen',
    'read',
    'tmpfile',
    'type',
    'write',
  ],
  os: [
    'clock',
    'date',
    'difftime',
    'execute',
    'exit',
    'getenv',
    'remove',
    'rename',
    'setlocale',
    'time',
    'tmpname',
  ],
  package: ['loadlib', 'seeall', 'searchpath'],
  debug: [
    'debug',
    'getfenv',
    'setfenv',
    'gethook',
    'sethook',
    'getinfo',
    'getlocal',
    'setlocal',
    'getmetatable',
    'setmetatable',
    'getregistry',
    'getupvalue',
    'setupvalue',
    'getuservalue',
    'setuservalue',
    'setcstacklimit',
    'traceback',
    'upvalueid',
    'upvaluejoin',
  ],
  bit32: [
    'arshift',
    'band',
    'bnot',
    'bor',
    'btest',
    'bxor',
    'extract',
    'replace',
    'lrotate',
    'lshift',
    'rrotate',
    'rshift',
  ],
  utf8: ['char', 'codes', 'codepoint', 'len', 'offset'],
}

const LUA_LIBRARY_FUNCTIONS = new Set(
  Object.entries(LUA_LIBRARY_MODULES).flatMap(([module, members]) =>
    members.map((member) => `${module}.${member}`),
  ),
)

/** 标准库「模块.成员」常量（constant.language.lua，整体一色） */
const LUA_LIBRARY_CONSTANTS = new Set([
  'math.pi',
  'math.huge',
  'math.maxinteger',
  'math.mininteger',
  'utf8.charpattern',
  'io.stdin',
  'io.stdout',
  'io.stderr',
  'package.config',
  'package.cpath',
  'package.loaded',
  'package.loaders',
  'package.path',
  'package.preload',
  'package.searchers',
])

/** Lua 词法类 → 高亮样式（配色见 LUA_SYNTAX_COLORS） */
const STYLE_KEYWORD: AssSyntaxType = 'LUA_KEYWORD'
const STYLE_CONSTANT: AssSyntaxType = 'LUA_CONSTANT'
const STYLE_STRING: AssSyntaxType = 'LUA_STRING'
const STYLE_NUMBER: AssSyntaxType = 'LUA_NUMBER'
const STYLE_COMMENT: AssSyntaxType = 'LUA_COMMENT'
const STYLE_FUNCTION: AssSyntaxType = 'LUA_FUNCTION'
const STYLE_VARIABLE: AssSyntaxType = 'LUA_VARIABLE'
const STYLE_PROPERTY: AssSyntaxType = 'LUA_PROPERTY'
const STYLE_OPERATOR: AssSyntaxType = 'LUA_OPERATOR'
const STYLE_BRACKET_UNEXPECTED: AssSyntaxType = 'LUA_BRACKET_UNEXPECTED'

/** 括号配对表与层级色板（VS Code 仅定义 foreground1-3，层级 4 起循环） */
const BRACKET_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const BRACKET_LEVEL_STYLES: AssSyntaxType[] = ['LUA_BRACKET1', 'LUA_BRACKET2', 'LUA_BRACKET3']

/** 层级（1 起）→ 括号配色类型 */
function bracketLevelStyle(depth: number): AssSyntaxType {
  return BRACKET_LEVEL_STYLES[(depth - 1) % BRACKET_LEVEL_STYLES.length]
}

const NAME_START_RE = /[A-Za-z_]/
const NAME_CHAR_RE = /[A-Za-z0-9_]/
const HEX_DIGIT_RE = /[0-9a-fA-F]/

/** 双字符运算符（Lua 5.1 全集 + 5.3 的地板除/位运算） */
const TWO_CHAR_OPS = new Set(['..', '==', '~=', '<=', '>=', '::', '//', '<<', '>>'])

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

/** 若 text[i] 开始是长括号 `[`=*`[`，返回等号数；否则 -1 */
function longBracketLevel(text: string, i: number): number {
  if (text[i] !== '[') return -1
  let j = i + 1
  while (text[j] === '=') j++
  return text[j] === '[' ? j - i - 1 : -1
}

/** 长括号闭合串（`]`=*`]`） */
function longBracketClose(level: number): string {
  return `]${'='.repeat(level)}]`
}

/** 名字后是否紧跟调用（support.function.any-method：`(`/`{`/字符串字面量，允许中间空白） */
function isCalledName(text: string, end: number): boolean {
  let j = end
  while (j < text.length && /\s/.test(text[j])) j++
  const c = text[j]
  return c === '(' || c === '{' || c === '"' || c === "'" || text.startsWith('[[', j)
}

/** 名字是否处于成员位（TextMate 的 (?<=[^.]\.|:) 语义：`a..b` 的连接符不算） */
function isMemberPosition(text: string, start: number): boolean {
  const prev = text[start - 1]
  return prev === ':' || (prev === '.' && text[start - 2] !== '.')
}

/** 「模块.成员」整体匹配（库函数/库常量；TextMate 里同样整体一个 token） */
function libraryPairAt(
  text: string,
  start: number,
  nameEnd: number,
): { end: number; type: AssSyntaxType } | null {
  if (text[nameEnd] !== '.' || !NAME_START_RE.test(text[nameEnd + 1] ?? '')) return null
  let memberEnd = nameEnd + 1
  while (memberEnd < text.length && NAME_CHAR_RE.test(text[memberEnd])) memberEnd++
  const key = text.slice(start, memberEnd)
  if (LUA_LIBRARY_FUNCTIONS.has(key)) return { end: memberEnd, type: STYLE_FUNCTION }
  if (LUA_LIBRARY_CONSTANTS.has(key)) return { end: memberEnd, type: STYLE_CONSTANT }
  return null
}

/** 单个名字的词法类（不含「模块.成员」整体匹配；判定顺序对齐 lua.tmLanguage.json） */
function nameStyle(text: string, start: number, end: number): AssSyntaxType {
  const name = text.slice(start, end)
  if (LUA_CONSTANTS.has(name)) return STYLE_CONSTANT
  if (LUA_CONTROL_KEYWORDS.has(name)) return STYLE_KEYWORD
  if (LUA_LOGICAL_OPERATORS.has(name)) return STYLE_OPERATOR
  if (LUA_GLOBAL_FUNCTIONS.has(name) || isCalledName(text, end)) return STYLE_FUNCTION
  return isMemberPosition(text, start) ? STYLE_PROPERTY : STYLE_VARIABLE
}

/**
 * 把 `!...!` 块内文本切成带样式类型的片段（严格逐字符覆盖输入）。
 * 空文本返回空数组；相邻同类片段已合并。
 */
export function tokenizeLuaCode(text: string): AssHighlightSegment[] {
  const segments: AssHighlightSegment[] = []
  const n = text.length

  const push = (start: number, end: number, type: AssSyntaxType) => {
    if (end <= start) return
    const last = segments[segments.length - 1]
    if (last && last.type === type) last.text += text.slice(start, end)
    else segments.push({ text: text.slice(start, end), type })
  }

  let i = 0
  const bracketStack: string[] = []
  while (i < n) {
    const c = text[i]

    // 空白（并入 Normal）
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r'))
        j++
      push(i, j, 'NORMAL')
      i = j
      continue
    }

    // $变量：kara-templater 的 var_replacer 规则为 $([%a_]+)（先于表达式求值）。
    // `$` 视为 `table.`：`$` 用表/命名空间位颜色，name 用成员位颜色（后接调用则函数色）。
    // 名字按 Lua 标识符规则吃后续数字（`$a2b` 整体成段）：引擎正则不含数字，
    // 但那会把 `$syl2` 拆成 `$syl`+`2`（数字色）——有意偏离，见 未完成计划.md
    if (c === '$' && NAME_START_RE.test(text[i + 1] ?? '')) {
      let j = i + 2
      while (j < n && NAME_CHAR_RE.test(text[j])) j++
      push(i, i + 1, STYLE_VARIABLE)
      push(i + 1, j, isCalledName(text, j) ? STYLE_FUNCTION : STYLE_PROPERTY)
      i = j
      continue
    }

    // 注释：-- 行注释 或 --[=*[ 长注释
    if (c === '-' && text[i + 1] === '-') {
      const level = longBracketLevel(text, i + 2)
      if (level >= 0) {
        const close = longBracketClose(level)
        const end = text.indexOf(close, i + 4 + level)
        const stop = end < 0 ? n : end + close.length
        push(i, stop, STYLE_COMMENT)
        i = stop
      } else {
        const end = text.indexOf('\n', i)
        const stop = end < 0 ? n : end
        push(i, stop, STYLE_COMMENT)
        i = stop
      }
      continue
    }

    // 长字符串 [[...]] / [=[...]=]（未闭合则染到块尾）
    const lbLevel = c === '[' ? longBracketLevel(text, i) : -1
    if (lbLevel >= 0) {
      const close = longBracketClose(lbLevel)
      const end = text.indexOf(close, i + 2 + lbLevel)
      const stop = end < 0 ? n : end + close.length
      push(i, stop, STYLE_STRING)
      i = stop
      continue
    }

    // 短字符串 '...' / "..."（\ 转义跳过一个字符；未闭合则染到块尾）
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        j++
        if (text[j - 1] === c) break
      }
      const stop = Math.min(j, n)
      push(i, stop, STYLE_STRING)
      i = stop
      continue
    }

    // 数字：十进制/十六进制整数与浮点（含 e/E、p/P 指数）
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      let j = i
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        j = i + 2
        while (j < n && HEX_DIGIT_RE.test(text[j])) j++
        if (text[j] === '.') {
          j++
          while (j < n && HEX_DIGIT_RE.test(text[j])) j++
        }
        if (text[j] === 'p' || text[j] === 'P') {
          let k = j + 1
          if (text[k] === '+' || text[k] === '-') k++
          if (isDigit(text[k])) {
            k++
            while (k < n && isDigit(text[k])) k++
            j = k
          }
        }
      } else {
        while (j < n && isDigit(text[j])) j++
        if (text[j] === '.') {
          j++
          while (j < n && isDigit(text[j])) j++
        }
        if (text[j] === 'e' || text[j] === 'E') {
          let k = j + 1
          if (text[k] === '+' || text[k] === '-') k++
          if (isDigit(text[k])) {
            k++
            while (k < n && isDigit(text[k])) k++
            j = k
          }
        }
      }
      push(i, j, STYLE_NUMBER)
      i = j
      continue
    }

    // 名字：库函数/库常量（模块.成员 整体）→ 关键字 → 调用名 → 成员名 → 普通标识符
    if (NAME_START_RE.test(c)) {
      let j = i + 1
      while (j < n && NAME_CHAR_RE.test(text[j])) j++
      const pair = libraryPairAt(text, i, j)
      if (pair) {
        push(i, pair.end, pair.type)
        i = pair.end
        continue
      }
      push(i, j, nameStyle(text, i, j))
      i = j
      continue
    }

    // 括号按嵌套层级上色（层级=所在括号对的深度；单 `[` 索引/取长不算长括号）
    if (c === '(' || c === '[' || c === '{') {
      bracketStack.push(c)
      push(i, i + 1, bracketLevelStyle(bracketStack.length))
      i += 1
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = bracketStack[bracketStack.length - 1]
      if (top !== undefined && BRACKET_PAIRS[top] === c) {
        push(i, i + 1, bracketLevelStyle(bracketStack.length))
        bracketStack.pop()
      } else {
        // 无开启者/类型不匹配 → VS Code unexpectedBracket 红；未闭合的开启括号
        // 保持层级色（打字中途不制造红色噪音）
        push(i, i + 1, STYLE_BRACKET_UNEXPECTED)
      }
      i += 1
      continue
    }

    // 运算符/标点（最长匹配）；未知字符同样按符号上色，保持逐字符覆盖且不制造红色噪音
    if (text.slice(i, i + 3) === '...') {
      push(i, i + 3, STYLE_OPERATOR)
      i += 3
      continue
    }
    if (TWO_CHAR_OPS.has(text.slice(i, i + 2))) {
      push(i, i + 2, STYLE_OPERATOR)
      i += 2
      continue
    }
    push(i, i + 1, STYLE_OPERATOR)
    i += 1
  }

  return segments
}
