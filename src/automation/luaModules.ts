/**
 * Aegisub 内置 Lua 模块（automation/include/aegisub/*.moon 的 Lua 5.3 移植）
 * 与 VFS 版模块搜索器。
 *
 * 桌面版由 script_reader.cpp 的 Install()/module_loader 从真实文件系统加载模块，
 * 并用 MoonScript 运行时编译 aegisub/*.moon。web 无 MoonScript/lpeg（官方编译器
 * 依赖 LPeg），因此：
 * - installLuaModuleSearch 把 include 目录写进 package.path 并替换 searcher #2，
 *   从 include 缓存同步加载 .lua 模块，并清空 cpath/jspath 阻断 fengari 的 XHR 回退；
 * - installLuaModules 把 aegisub.internal.argcheck / aegisub.util / aegisub.unicode /
 *   aegisub.re / bit / ffi 注册到 package.preload（ffi 为可 require 的报错占位）。
 */

import { normalizePath } from '../storage/vfs'

export interface LuaRuntime {
  lua: any
  lauxlib: any
  to_luastring: (value: string) => Uint8Array
  to_jsstring: (value: Uint8Array) => string
}

/** UTF-8 BOM（script_reader.cpp LoadFile 的 `-17 -69 -65`） */
function stripBom(code: string): string {
  return code.charCodeAt(0) === 0xfeff ? code.slice(1) : code
}

function raiseError(L: any, runtime: LuaRuntime, message: string): number {
  runtime.lauxlib.luaL_error(L, runtime.to_luastring('%s'), runtime.to_luastring(message))
  return 0
}

// ---------------------------------------------------------------------------
// 内置模块
// ---------------------------------------------------------------------------

function registerLuaSource(L: any, runtime: LuaRuntime, name: string, source: string): void {
  const { lua, lauxlib, to_luastring, to_jsstring } = runtime
  if (lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring(`@${name}`)) !== 0) {
    const message = to_jsstring(lua.lua_tostring(L, -1))
    lua.lua_pop(L, 1)
    throw new Error(`Failed to compile built-in Lua module "${name}": ${message}`)
  }
  lua.lua_getglobal(L, to_luastring('package'))
  lua.lua_getfield(L, -1, to_luastring('preload'))
  lua.lua_pushvalue(L, -3)
  lua.lua_setfield(L, -2, to_luastring(name))
  lua.lua_pop(L, 3)
}

function registerLuaFunction(
  L: any,
  runtime: LuaRuntime,
  name: string,
  builder: (L: any) => number,
): void {
  const { lua, to_luastring } = runtime
  lua.lua_getglobal(L, to_luastring('package'))
  lua.lua_getfield(L, -1, to_luastring('preload'))
  lua.lua_pushcfunction(L, builder)
  lua.lua_setfield(L, -2, to_luastring(name))
  lua.lua_pop(L, 2)
}

/** 注册 Aegisub 标准模块（桌面版由 MoonScript 编译的那批） */
export function installLuaModules(L: any, runtime: LuaRuntime): void {
  registerLuaSource(L, runtime, 'aegisub.internal.argcheck', ARGCHECK_SOURCE)
  registerLuaSource(L, runtime, 'aegisub.util', UTIL_SOURCE)
  registerLuaSource(L, runtime, 'aegisub.unicode', UNICODE_SOURCE)
  registerLuaSource(L, runtime, 'aegisub.re', RE_SOURCE)
  registerLuaSource(L, runtime, 'bit', BIT_SOURCE)
  registerLuaSource(L, runtime, 'ffi', FFI_SOURCE)
  registerLuaFunction(L, runtime, 'aegisub.__unicode_impl', (L2) => makeUnicodeImpl(L2, runtime))
  registerLuaFunction(L, runtime, 'aegisub.__re_impl', (L2) => makeReImpl(L2, runtime))
}

// ---------------------------------------------------------------------------
// VFS 模块搜索器（script_reader.cpp Install / module_loader）
// ---------------------------------------------------------------------------

export function installLuaModuleSearch(
  L: any,
  runtime: LuaRuntime,
  dirs: string[],
  cache: ReadonlyMap<string, { mtime: number; code: string }>,
): void {
  const { lua, lauxlib, to_luastring, to_jsstring } = runtime

  const moduleLoader = (L2: any): number => {
    const moduleName = to_jsstring(lauxlib.luaL_checkstring(L2, 1))
    const modulePath = moduleName.replace(/\./g, '/')

    // 模块搜索路径可能被脚本改写，每次读取当前 package.path
    lua.lua_getglobal(L2, to_luastring('package'))
    lua.lua_getfield(L2, -1, to_luastring('path'))
    const packagePath = lua.lua_isstring(L2, -1) ? to_jsstring(lua.lua_tostring(L2, -1)) : ''
    lua.lua_pop(L2, 2)

    const missing: string[] = []
    for (const token of packagePath.split(';')) {
      if (!token) continue
      const candidate = normalizePath(token.split('?').join(modulePath))
      const cached = cache.get(candidate)
      if (!cached) {
        missing.push(`\n\tno file '${candidate}'`)
        continue
      }
      if (
        lauxlib.luaL_loadbuffer(
          L2,
          to_luastring(stripBom(cached.code)),
          null,
          to_luastring(candidate),
        ) !== 0
      ) {
        const message = to_jsstring(lua.lua_tostring(L2, -1))
        lua.lua_pop(L2, 1)
        return raiseError(L2, runtime, `Error loading Lua module "${candidate}":\n${message}`)
      }
      return 1
    }

    lua.lua_pushstring(L2, to_luastring(missing.join('')))
    return 1
  }

  lua.lua_getglobal(L, to_luastring('package'))
  // Windows 分支不追加默认路径：package.path 只含 include 目录
  const pathValue = dirs.map((dir) => `${dir}/?.lua;${dir}/?/init.lua;`).join('')
  lua.lua_pushstring(L, to_luastring(pathValue))
  lua.lua_setfield(L, -2, to_luastring('path'))
  for (const field of ['cpath', 'jspath']) {
    lua.lua_pushstring(L, to_luastring(''))
    lua.lua_setfield(L, -2, to_luastring(field))
  }

  lua.lua_getfield(L, -1, to_luastring('searchers'))
  lua.lua_pushcfunction(L, moduleLoader)
  lua.lua_rawseti(L, -2, 2)
  // Lua 5.1 兼容别名：package.loaders 与 package.searchers 同一张表
  lua.lua_pushvalue(L, -1)
  lua.lua_setfield(L, -3, to_luastring('loaders'))
  lua.lua_pop(L, 2)
}

// ---------------------------------------------------------------------------
// aegisub.__unicode_impl
// ---------------------------------------------------------------------------

function makeUnicodeImpl(L: any, runtime: LuaRuntime): number {
  const { lua, lauxlib, to_luastring, to_jsstring } = runtime
  const convert =
    (transform: (value: string) => string) =>
    (L2: any): number => {
      const input = to_jsstring(lauxlib.luaL_checkstring(L2, 1))
      lua.lua_pushstring(L2, to_luastring(transform(input)))
      return 1
    }
  lua.lua_newtable(L)
  const fields: Array<[string, (value: string) => string]> = [
    ['to_upper_case', (value) => value.toUpperCase()],
    ['to_lower_case', (value) => value.toLowerCase()],
    // 桌面版是 ICU u_strFoldCase；JS 无 casefold，用大写再小写近似（ß → ss）
    ['to_fold_case', (value) => value.toUpperCase().toLowerCase()],
  ]
  for (const [name, transform] of fields) {
    lua.lua_pushcfunction(L, convert(transform))
    lua.lua_setfield(L, -2, to_luastring(name))
  }
  return 1
}

// ---------------------------------------------------------------------------
// aegisub.__re_impl（JS RegExp 后端，接口对齐 lua/modules/re.cpp）
// ---------------------------------------------------------------------------

/** 与 re.cpp get_regex_flags 一致的标志位 */
const RE_FLAGS: Array<[string, number]> = [
  ['ICASE', 1],
  ['NOSUB', 2],
  ['COLLATE', 4],
  ['NEWLINE_ALT', 8],
  ['NO_MOD_M', 16],
  ['NO_MOD_S', 32],
  ['MOD_S', 64],
  ['MOD_X', 128],
  ['NO_EMPTY_SUBEXPRESSIONS', 256],
]

const MOD_X = 128
const MOD_S = 64
const ICASE = 1

/** 编译后的正则（handle → RegExp）；Lua 侧不持有对象，句柄随状态长期有效 */
const compiledRegexes = new Map<number, RegExp>()
let nextRegexId = 1

interface ByteMaps {
  /** 码元下标 → 字节偏移 */
  toByte: number[]
  /** 字节偏移 → 码元下标（仅合法边界有值，其余为 -1） */
  toIndex: number[]
  byteLength: number
}

function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function buildByteMaps(text: string): ByteMaps {
  const toByte = new Array<number>(text.length + 1).fill(0)
  const byteLength = utf8ByteLength(text)
  const toIndex = new Array<number>(byteLength + 1).fill(-1)
  let byte = 0
  let index = 0
  while (index < text.length) {
    const code = text.codePointAt(index) as number
    const units = code > 0xffff ? 2 : 1
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    toByte[index] = byte
    toIndex[byte] = index
    for (let offset = 1; offset < units; offset++) toByte[index + offset] = byte
    byte += width
    index += units
  }
  toByte[text.length] = byte
  toIndex[byte] = text.length
  return { toByte, toIndex, byteLength }
}

function indexForByte(maps: ByteMaps, byteOffset: number): number {
  let offset = Math.max(0, Math.min(Math.trunc(byteOffset), maps.byteLength))
  while (offset > 0 && maps.toIndex[offset] < 0) offset--
  return maps.toIndex[offset]
}

type IndexedMatch = RegExpExecArray & {
  indices?: Array<[number, number] | undefined>
}

interface GroupRange {
  start: number
  end: number
}

/**
 * 捕获组在字符串中的码元区间。
 * 优先用 `d` 标志的 match.indices；不支持时整段匹配精确、捕获组用 indexOf 顺序近似。
 */
function groupRanges(subject: string, match: IndexedMatch): Array<GroupRange | null> {
  const ranges: Array<GroupRange | null> = []
  if (match.indices) {
    for (let index = 0; index < match.length; index++) {
      const pair = match.indices[index]
      ranges.push(pair ? { start: pair[0], end: pair[1] } : null)
    }
    return ranges
  }
  let cursor = match.index
  for (let index = 0; index < match.length; index++) {
    const text = match[index]
    if (text === undefined) ranges.push(null)
    else if (index === 0) ranges.push({ start: match.index, end: match.index + text.length })
    else {
      const found = subject.indexOf(text, cursor)
      if (found < 0) ranges.push(null)
      else {
        ranges.push({ start: found, end: found + text.length })
        cursor = found + text.length
      }
    }
  }
  return ranges
}

/** 空匹配时按码点前进（不拆代理对） */
function advanceIndex(text: string, index: number): number {
  if (index + 1 < text.length) {
    const high = text.charCodeAt(index)
    const low = text.charCodeAt(index + 1)
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) return index + 2
  }
  return index + 1
}

function buildRegex(source: string, flags: string): RegExp {
  const attempts = [`${flags}u`, flags]
  if (flags.includes('d')) {
    const withoutIndex = flags.replace('d', '')
    attempts.push(`${withoutIndex}u`, withoutIndex)
  }
  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      return new RegExp(source, attempt)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** boost format_all 的常用替换串展开（$&、$N、${name}、$`、$'、$$） */
function expandReplacement(template: string, subject: string, match: RegExpExecArray): string {
  let result = ''
  for (let index = 0; index < template.length; index++) {
    const char = template[index]
    if (char !== '$') {
      result += char
      continue
    }
    const next = template[index + 1]
    if (!next) {
      result += '$'
      continue
    }
    if (next === '$') {
      result += '$'
      index++
    } else if (next === '&') {
      result += match[0]
      index++
    } else if (next === '`') {
      result += subject.slice(0, match.index)
      index++
    } else if (next === "'") {
      result += subject.slice(match.index + match[0].length)
      index++
    } else if (next === '{') {
      const end = template.indexOf('}', index + 2)
      if (end < 0) {
        result += '$'
        continue
      }
      result += match.groups?.[template.slice(index + 2, end)] ?? ''
      index = end
    } else if (next >= '0' && next <= '9') {
      // 最多两位分组号（boost format 语义）；两位不存在时退化为一位 + 字面数字
      let digits = next
      let cursor = index + 2
      while (
        cursor < template.length &&
        digits.length < 2 &&
        template[cursor] >= '0' &&
        template[cursor] <= '9'
      ) {
        digits += template[cursor]
        cursor++
      }
      const group = Number(digits)
      if (group === 0) result += match[0]
      else if (group < match.length && match[group] !== undefined) result += match[group]
      else if (digits.length === 2) {
        const single = match[Number(digits[0])]
        result += (single ?? '') + digits[1]
      }
      index = cursor - 1
    } else {
      result += '$'
    }
  }
  return result
}

/** 扩展模式：去掉字符类外的空白与 `#` 行注释 */
function stripExtendedMode(pattern: string): string {
  let result = ''
  let inClass = false
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '\\') {
      result += char
      if (index + 1 < pattern.length) result += pattern[index + 1]
      index += 2
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    if (!inClass && char === '#') {
      while (index < pattern.length && pattern[index] !== '\n') index++
      continue
    }
    if (!inClass && /\s/.test(char)) {
      index++
      continue
    }
    result += char
    index++
  }
  return result
}

function makeReImpl(L: any, runtime: LuaRuntime): number {
  const { lua, lauxlib, to_luastring, to_jsstring } = runtime
  const checkString = (L2: any, index: number): string =>
    to_jsstring(lauxlib.luaL_checkstring(L2, index))
  const checkInt = (L2: any, index: number): number =>
    Math.trunc(lauxlib.luaL_checkinteger(L2, index))

  const getCompiled = (L2: any, index: number): RegExp => {
    const handle = checkInt(L2, index)
    const regex = compiledRegexes.get(handle)
    if (!regex) raiseError(L2, runtime, 'Invalid compiled regular expression')
    return regex as RegExp
  }

  const compile = (L2: any): number => {
    const pattern = checkString(L2, 1)
    const flags = checkInt(L2, 2)
    const source = flags & MOD_X ? stripExtendedMode(pattern) : pattern
    let flagString = 'gd'
    if (flags & ICASE) flagString += 'i'
    if (flags & MOD_S) flagString += 's'
    try {
      const regex = buildRegex(source, flagString)
      const handle = nextRegexId++
      compiledRegexes.set(handle, regex)
      lua.lua_pushinteger(L2, handle)
      return 1
    } catch (error) {
      lua.lua_pushnil(L2)
      lua.lua_pushstring(L2, to_luastring(error instanceof Error ? error.message : String(error)))
      return 2
    }
  }

  const search = (L2: any): number => {
    const regex = getCompiled(L2, 1)
    const subject = checkString(L2, 2)
    checkInt(L2, 3)
    const start = checkInt(L2, 4)
    const maps = buildByteMaps(subject)
    regex.lastIndex = indexForByte(maps, start)
    const match = regex.exec(subject) as IndexedMatch | null
    if (!match) {
      lua.lua_pushnil(L2)
      return 1
    }
    const full = groupRanges(subject, match)[0]
    if (!full) {
      lua.lua_pushnil(L2)
      return 1
    }
    lua.lua_pushinteger(L2, maps.toByte[full.start] + 1)
    lua.lua_pushinteger(L2, maps.toByte[full.end])
    return 2
  }

  const matchFn = (L2: any): number => {
    const regex = getCompiled(L2, 1)
    const subject = checkString(L2, 2)
    checkInt(L2, 3)
    const start = checkInt(L2, 4)
    const maps = buildByteMaps(subject)
    const startIndex = indexForByte(maps, start)
    const startByte = maps.toByte[startIndex]
    regex.lastIndex = startIndex
    const match = regex.exec(subject) as IndexedMatch | null
    if (!match) {
      lua.lua_pushnil(L2)
      return 1
    }
    lua.lua_newtable(L2)
    groupRanges(subject, match).forEach((range, groupIndex) => {
      if (!range) {
        lua.lua_pushboolean(L2, 0)
      } else {
        lua.lua_newtable(L2)
        lua.lua_pushinteger(L2, maps.toByte[range.start] - startByte + 1)
        lua.lua_rawseti(L2, -2, 1)
        lua.lua_pushinteger(L2, maps.toByte[range.end] - startByte)
        lua.lua_rawseti(L2, -2, 2)
      }
      lua.lua_rawseti(L2, -2, groupIndex + 1)
    })
    return 1
  }

  const getMatch = (L2: any): number => {
    const index = checkInt(L2, 2)
    lua.lua_rawgeti(L2, 1, index + 1)
    if (!lua.lua_istable(L2, -1)) {
      lua.lua_pop(L2, 1)
      lua.lua_pushnil(L2)
      return 1
    }
    lua.lua_rawgeti(L2, -1, 1)
    lua.lua_rawgeti(L2, -2, 2)
    lua.lua_remove(L2, -3)
    return 2
  }

  const replace = (L2: any): number => {
    const regex = getCompiled(L2, 1)
    const replacement = checkString(L2, 2)
    const subject = checkString(L2, 3)
    checkInt(L2, 4)
    const maxCount = checkInt(L2, 5)

    regex.lastIndex = 0
    let result = ''
    let last = 0
    let count = 0
    while (count < maxCount) {
      const match = regex.exec(subject) as RegExpExecArray | null
      if (!match) break
      result += subject.slice(last, match.index)
      result += expandReplacement(replacement, subject, match)
      last = match.index + match[0].length
      if (match[0].length === 0) regex.lastIndex = advanceIndex(subject, match.index)
      count++
    }
    result += subject.slice(last)
    lua.lua_pushstring(L2, to_luastring(result))
    return 1
  }

  const getFlags = (L2: any): number => {
    lua.lua_newtable(L2)
    RE_FLAGS.forEach(([name, value], index) => {
      lua.lua_newtable(L2)
      lua.lua_pushstring(L2, to_luastring(name))
      lua.lua_setfield(L2, -2, to_luastring('name'))
      lua.lua_pushinteger(L2, value)
      lua.lua_setfield(L2, -2, to_luastring('value'))
      lua.lua_rawseti(L2, -2, index + 1)
    })
    return 1
  }

  lua.lua_newtable(L)
  const fields: Array<[string, (L2: any) => number]> = [
    ['compile', compile],
    ['search', search],
    ['match', matchFn],
    ['get_match', getMatch],
    ['replace', replace],
    ['get_flags', getFlags],
  ]
  for (const [name, fn] of fields) {
    lua.lua_pushcfunction(L, fn)
    lua.lua_setfield(L, -2, to_luastring(name))
  }
  return 1
}

// ---------------------------------------------------------------------------
// Lua 源模块（对照 Aegisub/automation/include/aegisub/*.moon 移植）
// ---------------------------------------------------------------------------

const ARGCHECK_SOURCE = `
local assert = assert
local error = error
local select = select
local type = type

local function is_type(v, ty, expected)
  if ty == expected then return true end
  return ty == 'table' and v ~= nil and v.__class ~= nil and v.__class.__name == expected
end

return function(argfmt)
  assert(type(argfmt) == 'string')
  local min_args, max_args = 0, 0
  local checks = {}
  for arg in argfmt:gmatch('[^ ]+') do
    if arg == '...' then
      max_args = nil
      break
    end
    max_args = max_args + 1
    local optional = arg:sub(1, 1) == '?'
    if optional then
      arg = arg:sub(2)
    else
      min_args = min_args + 1
    end
    local types = nil
    if arg:find('|', 1, true) then
      types = {}
      for ty in arg:gmatch('[^|]+') do
        types[#types + 1] = ty
      end
    end
    checks[max_args] = function(i, v)
      if v == nil then
        if optional then return end
        error('Argument #' .. i .. ' should be a ' .. arg .. ', is nil', 4)
      end
      local ty = type(v)
      if types then
        for _, argtype in ipairs(types) do
          if is_type(v, ty, argtype) then return end
        end
        error('Argument #' .. i .. ' should be a ' .. arg .. ', is ' .. ty .. ' (' .. tostring(v) .. ')', 3)
      end
      if is_type(v, ty, arg) then return end
      error('Argument #' .. i .. ' should be a ' .. arg .. ', is ' .. ty .. ' (' .. tostring(v) .. ')', 3)
    end
  end
  return function(fn)
    return function(...)
      local arg_count = select('#', ...)
      if arg_count < min_args or (max_args and arg_count > max_args) then
        if min_args == max_args then
          error('Expected ' .. min_args .. ' arguments, got ' .. arg_count, 3)
        elseif max_args then
          error('Expected ' .. min_args .. '-' .. max_args .. ' arguments, got ' .. arg_count, 3)
        else
          error('Expected at least ' .. min_args .. ' arguments, got ' .. arg_count, 3)
        end
      end
      for i = 1, arg_count do
        if not checks[i] then break end
        checks[i](i, select(i, ...))
      end
      return fn(...)
    end
  end
end
`

const UTIL_SOURCE = `
local error = error
local pairs = pairs
local select = select
local sformat = string.format
local tonumber = tonumber
local type = type

local check = require 'aegisub.internal.argcheck'

local util = {}

util.copy = check('table')(function(tbl)
  local result = {}
  for k, v in pairs(tbl) do result[k] = v end
  return result
end)

util.deep_copy = check('table')(function(tbl)
  local seen = {}
  local function copy_value(value)
    if type(value) ~= 'table' then return value end
    if seen[value] then return seen[value] end
    local result = {}
    seen[value] = result
    for k, v in pairs(value) do result[k] = copy_value(v) end
    return result
  end
  return copy_value(tbl)
end)

local function ass_color(r, g, b)
  return sformat('&H%02X%02X%02X&', b, g, r)
end

local function ass_alpha(a)
  return sformat('&H%02X&', a)
end

local function ass_style_color(r, g, b, a)
  return sformat('&H%02X%02X%02X%02X', a, b, g, r)
end

local function extract_color(s)
  local a, b, g, r
  a, b, g, r = s:match('&H(%x%x)(%x%x)(%x%x)(%x%x)')
  if a then
    return tonumber(r, 16), tonumber(g, 16), tonumber(b, 16), tonumber(a, 16)
  end
  b, g, r = s:match('&H(%x%x)(%x%x)(%x%x)&')
  if b then
    return tonumber(r, 16), tonumber(g, 16), tonumber(b, 16), 0
  end
  a = s:match('&H(%x%x)&')
  if a then
    return 0, 0, 0, tonumber(a, 16)
  end
  r, g, b, a = s:match('#(%x%x)(%x?%x?)(%x?%x?)(%x?%x?)')
  if r then
    return tonumber(r, 16), tonumber(g, 16) or 0, tonumber(b, 16) or 0, tonumber(a, 16) or 0
  end
  return nil
end

local function clamp(val, min, max)
  if val < min then return min elseif val > max then return max end
  return val
end

local function interpolate(pct, min, max)
  if pct <= 0 then return min elseif pct >= 1 then return max end
  return pct * (max - min) + min
end

local function headtail(s)
  local a, b, head, tail = s:find('(.-)%s+(.*)')
  if a then return head, tail end
  return s, ''
end

local function words(s)
  return function()
    if s == '' then return nil end
    local head, tail = headtail(s)
    s = tail
    return head
  end
end

util.ass_color = ass_color
util.ass_alpha = ass_alpha
util.ass_style_color = ass_style_color
util.extract_color = check('string')(extract_color)
util.alpha_from_style = check('string')(function(scolor)
  return ass_alpha(select(4, extract_color(scolor)))
end)
util.color_from_style = check('string')(function(scolor)
  local r, g, b = extract_color(scolor)
  return ass_color(r or 0, g or 0, b or 0)
end)

util.HSV_to_RGB = function(H, S, V)
  local r, g, b = 0, 0, 0
  if S == 0 then
    r = clamp(V * 255, 0, 255)
    g = r
    b = r
  else
    H = math.abs(H) % 360
    local Hi = math.floor(H / 60)
    local f = H / 60.0 - Hi
    local p = V * (1 - S)
    local q = V * (1 - f * S)
    local t = V * (1 - (1 - f) * S)
    if Hi == 0 then
      r, g, b = V * 255.0, t * 255.0, p * 255.0
    elseif Hi == 1 then
      r, g, b = q * 255.0, V * 255.0, p * 255.0
    elseif Hi == 2 then
      r, g, b = p * 255.0, V * 255.0, t * 255.0
    elseif Hi == 3 then
      r, g, b = p * 255.0, q * 255.0, V * 255.0
    elseif Hi == 4 then
      r, g, b = t * 255.0, p * 255.0, V * 255.0
    elseif Hi == 5 then
      r, g, b = V * 255.0, p * 255.0, q * 255.0
    else
      error('math.floor(H % 360 / 60) should be [0, 6), is ' .. tostring(Hi) .. '?')
    end
  end
  return r, g, b
end

util.HSL_to_RGB = function(H, S, L)
  H = math.abs(H) % 360
  S = clamp(S, 0, 1)
  L = clamp(L, 0, 1)
  local r, g, b
  if S == 0 then
    r, g, b = L, L, L
  else
    local Q
    if L < 0.5 then Q = L * (1.0 + S) else Q = L + S - (L * S) end
    local P = 2.0 * L - Q
    local Hk = H / 360
    local Tr, Tg, Tb
    if Hk < 1 / 3 then
      Tr, Tg, Tb = Hk + 1 / 3, Hk, Hk + 2 / 3
    elseif Hk > 2 / 3 then
      Tr, Tg, Tb = Hk - 2 / 3, Hk, Hk - 1 / 3
    else
      Tr, Tg, Tb = Hk + 1 / 3, Hk, Hk - 1 / 3
    end
    local function get_component(T)
      if T < 1 / 6 then
        return P + ((Q - P) * 6.0 * T)
      elseif T >= 1 / 6 and T < 1 / 2 then
        return Q
      elseif T >= 1 / 2 and T < 2 / 3 then
        return P + ((Q - P) * (2 / 3 - T) * 6.0)
      end
      return P
    end
    r = get_component(Tr)
    g = get_component(Tg)
    b = get_component(Tb)
  end
  return math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5)
end

util.trim = function(s)
  return s:gsub('^%s*(.-)%s*$', '%1')
end
util.headtail = headtail
util.words = words
util.clamp = clamp
util.interpolate = interpolate
util.interpolate_color = function(pct, first, last)
  local r1, g1, b1 = extract_color(first)
  local r2, g2, b2 = extract_color(last)
  return ass_color(
    interpolate(pct, r1, r2),
    interpolate(pct, g1, g2),
    interpolate(pct, b1, b2)
  )
end
util.interpolate_alpha = function(pct, first, last)
  return ass_alpha(interpolate(pct, select(4, extract_color(first)), select(4, extract_color(last))))
end

return util
`

const UNICODE_SOURCE = `
local impl = require 'aegisub.__unicode_impl'
local check = require 'aegisub.internal.argcheck'

local unicode = {}

unicode.charwidth = check('string ?number')(function(s, i)
  local b = s:byte(i)
  if not b then return 1
  elseif b < 128 then return 1
  elseif b < 224 then return 2
  elseif b < 240 then return 3
  else return 4 end
end)

unicode.chars = check('string')(function(s)
  local curchar, i = 0, 1
  return function()
    if i > #s then return nil end
    local j = i
    curchar = curchar + 1
    i = i + unicode.charwidth(s, i)
    return s:sub(j, i - 1), curchar
  end
end)

unicode.len = check('string')(function(s)
  local n = 0
  for _ in unicode.chars(s) do n = n + 1 end
  return n
end)

unicode.codepoint = check('string')(function(s)
  local b = s:byte(1)
  if b < 128 then return b end
  local res, w
  if b < 224 then
    res = b - 192
    w = 2
  elseif b < 240 then
    res = b - 224
    w = 3
  else
    res = b - 240
    w = 4
  end
  for i = 2, w do
    res = res * 64 + s:byte(i) - 128
  end
  return res
end)

local function conv_func(f)
  return check('string')(function(str)
    local result, errmsg = f(str)
    if errmsg then error(errmsg, 2) end
    return result
  end)
end

unicode.to_upper_case = conv_func(impl.to_upper_case)
unicode.to_lower_case = conv_func(impl.to_lower_case)
unicode.to_fold_case = conv_func(impl.to_fold_case)

return unicode
`

const RE_SOURCE = `
local error = error
local next = next
local select = select
local type = type

local bit = require 'bit'
local check = require 'aegisub.internal.argcheck'
local regex = require 'aegisub.__re_impl'

local function is_flag(value)
  return type(value) == 'table' and value._re_flag == true
end

local function search(re, str, start)
  if start > #str then return nil end
  return regex.search(re, str, #str, start)
end

local function replace(re, replacement, str, max_count)
  return regex.replace(re, replacement, str, #str, max_count)
end

local function match(re, str, start)
  assert(start <= #str)
  return regex.match(re, str, #str, start)
end

local function get_match(m, idx)
  return regex.get_match(m, idx)
end

local function compile(pattern, flags)
  local re, err = regex.compile(pattern, flags)
  if re == nil then return err end
  return re
end

local function select_first(n, ...)
  if n == 0 then return end
  local a = ...
  return a, select_first(n - 1, select(2, ...))
end

local function process_flags(...)
  local flags = 0
  for i = 1, select('#', ...) do
    local value = select(i, ...)
    if not is_flag(value) then
      error('Flags must follow all non-flag arguments', 3)
    end
    flags = bit.bor(flags, value.value)
  end
  return flags
end

local function unpack_args(...)
  local flags_start = nil
  for i = 1, select('#', ...) do
    local value = select(i, ...)
    if is_flag(value) then
      flags_start = i
      break
    end
  end
  if not flags_start then return 0, ... end
  return process_flags(select(flags_start, ...)), select_first(flags_start - 1, ...)
end

local function replace_match(match_info, func, str, last, acc)
  if last < match_info.last then
    acc[#acc + 1] = str:sub(last, match_info.first - 1)
  end
  local repl = func(match_info.str, match_info.first, match_info.last)
  if type(repl) == 'string' then
    acc[#acc + 1] = repl
  else
    acc[#acc + 1] = match_info.str
  end
  return match_info.first, match_info.last + 1
end

local function do_single_replace_fun(re, func, str, acc, pos)
  local matches = re:match(str, pos)
  if not matches then return pos end
  local first_index = 1
  if #matches ~= 1 then first_index = 2 end
  local last = pos
  local first
  for i = first_index, #matches do
    first, last = replace_match(matches[i], func, str, last, acc)
  end
  if first == last then
    acc[#acc + 1] = str:sub(last, last)
    last = last + 1
  end
  return last, matches[1].first <= #str
end

local function do_replace_fun(re, func, str, max)
  local acc = {}
  local pos = 1
  for i = 1, max do
    local more
    pos, more = do_single_replace_fun(re, func, str, acc, pos)
    if not more then
      max = i
      break
    end
  end
  return table.concat(acc, '') .. str:sub(pos)
end

local RegEx = {}
RegEx.__index = RegEx
RegEx.__name = 'RegEx'

function RegEx:_check_self()
  if self.__class ~= RegEx then
    error('re method called with invalid self. You probably used . when : is needed.', 3)
  end
end

local function new_regex(id, level)
  return setmetatable({ __class = RegEx, _regex = id, _level = level }, RegEx)
end

RegEx.gsplit = check('RegEx string ?boolean ?number')(function(self, str, skip_empty, max_split)
  if not max_split or max_split <= 0 then max_split = #str end
  local start = 0
  local prev = 1
  local function do_split()
    if not str or #str == 0 then return nil end
    local first, last
    if max_split > 0 then
      first, last = search(self._regex, str, start)
    end
    if not first or first > #str then
      local ret = str:sub(prev, #str)
      str = nil
      if skip_empty and #ret == 0 then return nil end
      return ret
    end
    local ret = str:sub(prev, first - 1)
    prev = last + 1
    if start >= last then start = start + 1 else start = last end
    if skip_empty and #ret == 0 then
      return do_split()
    end
    max_split = max_split - 1
    return ret
  end
  return do_split
end)

RegEx.split = check('RegEx string ?boolean ?number')(function(self, str, skip_empty, max_split)
  local result = {}
  for value in self:gsplit(str, skip_empty, max_split) do
    result[#result + 1] = value
  end
  return result
end)

RegEx.gfind = check('RegEx string')(function(self, str)
  local start = 0
  return function()
    local first, last = search(self._regex, str, start)
    if not first then return nil end
    if last > start then start = last else start = start + 1 end
    return str:sub(first, last), first, last
  end
end)

RegEx.find = check('RegEx string')(function(self, str)
  local result = {}
  for s, first, last in self:gfind(str) do
    result[#result + 1] = { str = s, first = first, last = last }
  end
  if next(result) then return result end
  return nil
end)

RegEx.sub = check('RegEx string string|function ?number')(function(self, str, repl, max_count)
  if not max_count or max_count == 0 then max_count = #str + 1 end
  if type(repl) == 'function' then
    return do_replace_fun(self, repl, str, max_count)
  elseif type(repl) == 'string' then
    return replace(self._regex, repl, str, max_count)
  end
end)

RegEx.gmatch = check('RegEx string ?number')(function(self, str, start)
  if start then start = start - 1 else start = 0 end
  local m = match(self._regex, str, start)
  local i = 0
  return function()
    if not m then return nil end
    local first, last = get_match(m, i)
    if not first then return nil end
    i = i + 1
    return {
      str = str:sub(first + start, last + start),
      first = first + start,
      last = last + start,
    }
  end
end)

RegEx.match = check('RegEx string ?number')(function(self, str, start)
  local result = {}
  for value in self:gmatch(str, start) do
    result[#result + 1] = value
  end
  if next(result) == nil then return nil end
  return result
end)

local function real_compile(pattern, level, flags, stored_level)
  if pattern == '' then
    error('Regular expression must not be empty', level + 1)
  end
  local re = compile(pattern, flags)
  if type(re) == 'string' then
    error(re, level + 1)
  end
  return new_regex(re, stored_level or level + 1)
end

local function invoke(str, pattern, fn, flags, ...)
  local compiled = real_compile(pattern, 3, flags)
  return compiled[fn](compiled, str, ...)
end

local function gen_wrapper(impl_name)
  return check('string string ...')(function(str, pattern, ...)
    return invoke(str, pattern, impl_name, unpack_args(...))
  end)
end

local re = {}
re.compile = check('string ...')(function(pattern, ...)
  return real_compile(pattern, 2, process_flags(...), 2)
end)
re.split = gen_wrapper('split')
re.gsplit = gen_wrapper('gsplit')
re.find = gen_wrapper('find')
re.gfind = gen_wrapper('gfind')
re.match = gen_wrapper('match')
re.gmatch = gen_wrapper('gmatch')
re.sub = gen_wrapper('sub')

local flag_list = regex.get_flags()
for i = 1, #flag_list do
  local flag = flag_list[i]
  re[flag.name] = { _re_flag = true, name = flag.name, value = flag.value }
end

return re
`

const BIT_SOURCE = `
local bit = {}
local floor, ceil = math.floor, math.ceil
local select, tonumber, type = select, tonumber, type
local format = string.format

local function trunc(value)
  if value >= 0 then return floor(value) end
  return ceil(value)
end

-- 对齐 LuaJIT：先归一化为 32 位有符号整数。
-- fengari 的整数上限是 2^31-1，位运算本身即 32 位，故掩码常量不得超过该范围。
local function tobit32(value)
  local number = tonumber(value)
  if not number then error('number expected, got ' .. type(value), 2) end
  number = trunc(number) % 4294967296
  if number >= 2147483648 then number = number - 4294967296 end
  return number
end

local function shift_of(value)
  return trunc(value) % 32
end

function bit.tobit(value)
  return tobit32(value)
end

function bit.band(a, ...)
  local result = tobit32(a)
  for i = 1, select('#', ...) do
    result = result & tobit32((select(i, ...)))
  end
  return result
end

function bit.bor(a, ...)
  local result = tobit32(a)
  for i = 1, select('#', ...) do
    result = result | tobit32((select(i, ...)))
  end
  return result
end

function bit.bxor(a, ...)
  local result = tobit32(a)
  for i = 1, select('#', ...) do
    result = result ~ tobit32((select(i, ...)))
  end
  return result
end

-- fengari 的一元 ~ 不接受浮点操作数（整数子类型才行），改用二元异或实现
function bit.bnot(value)
  return tobit32(value) ~ -1
end

function bit.lshift(value, shift)
  return tobit32(tobit32(value) << shift_of(shift))
end

function bit.rshift(value, shift)
  return tobit32(tobit32(value) >> shift_of(shift))
end

function bit.arshift(value, shift)
  shift = shift_of(shift)
  if shift == 0 then return tobit32(value) end
  return tobit32(floor(tobit32(value) / 2 ^ shift))
end

function bit.rol(value, shift)
  local n = shift_of(shift)
  local v = tobit32(value)
  if n == 0 then return v end
  return tobit32((v << n) | (v >> (32 - n)))
end

function bit.ror(value, shift)
  local n = shift_of(shift)
  local v = tobit32(value)
  if n == 0 then return v end
  return tobit32((v >> n) | (v << (32 - n)))
end

function bit.bswap(value)
  local v = tobit32(value)
  local b1 = v & 255
  local b2 = (v >> 8) & 255
  local b3 = (v >> 16) & 255
  local b4 = (v >> 24) & 255
  return tobit32((b1 << 24) | (b2 << 16) | (b3 << 8) | b4)
end

function bit.tohex(value, digits)
  if digits == nil then digits = 8 end
  digits = trunc(digits)
  local upper = false
  if digits < 0 then
    upper = true
    digits = -digits
  end
  if digits == 0 then return '' end
  if digits > 8 then digits = 8 end
  local v = tobit32(value)
  local text = format('%02x%02x%02x%02x',
    (v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255):sub(9 - digits)
  if upper then text = text:upper() end
  return text
end

return bit
`

const FFI_SOURCE = `
local ffi = {}

local function unavailable(name)
  return function()
    error('LuaJIT FFI is not available in the web build of Aegisub (ffi.' .. name .. ' was called)', 2)
  end
end

local names = {
  'cdef', 'typeof', 'new', 'cast', 'metatype', 'gc', 'istype', 'sizeof',
  'alignof', 'offsetof', 'string', 'copy', 'fill', 'load', 'errno', 'abi',
}
for _, name in ipairs(names) do
  ffi[name] = unavailable(name)
end

ffi.os = 'Other'
ffi.arch = 'wasm'

ffi.C = setmetatable({}, {
  __index = function(_, key)
    error('LuaJIT FFI is not available in the web build of Aegisub (ffi.C.' .. tostring(key) .. ' was called)', 2)
  end,
})

return ffi
`
