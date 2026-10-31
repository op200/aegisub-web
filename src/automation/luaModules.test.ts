import { beforeAll, describe, expect, it, vi } from 'vitest'

// 直接引用仓库内的真实 include 文件（?raw 由 Vite 转成字符串，避免测试依赖 node:fs）
import karaskelAuto4Source from '../../Aegisub/automation/include/karaskel-auto4.lua?raw'
import karaskelSource from '../../Aegisub/automation/include/karaskel.lua?raw'
import reSource from '../../Aegisub/automation/include/re.lua?raw'
import unicodeSource from '../../Aegisub/automation/include/unicode.lua?raw'
import utilsAuto4Source from '../../Aegisub/automation/include/utils-auto4.lua?raw'
import utilsSource from '../../Aegisub/automation/include/utils.lua?raw'
import { closeAutomationState, loadAutomationScript } from './luaEngine'
import { installLuaModuleSearch, installLuaModules } from './luaModules'

/** 假 VFS：refreshIncludeCache 走 dirExists + listTree，条目自带 text 不再读盘 */
const fake = vi.hoisted(() => {
  const files = new Map<string, { text: string; mtime: number }>()
  let clock = 0
  return {
    files,
    add(path: string, text: string): void {
      clock += 1
      files.set(path, { text, mtime: clock })
    },
  }
})

vi.mock('../storage/vfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/vfs')>()
  return {
    ...actual,
    dirExists: async (path: string) => {
      if (path === '/') return true
      const prefix = `${path.replace(/\/+$/, '')}/`
      for (const key of fake.files.keys()) if (key.startsWith(prefix)) return true
      return false
    },
    listTree: async (dir: string) => {
      const prefix = dir === '/' ? '/' : `${dir.replace(/\/+$/, '')}/`
      const entries: Array<{
        path: string
        name: string
        dir: string
        directory: boolean
        size: number
        mtime: number
        text: string
      }> = []
      for (const [path, file] of fake.files) {
        if (!path.startsWith(prefix)) continue
        entries.push({
          path,
          name: path.slice(prefix.length),
          dir,
          directory: false,
          size: file.text.length,
          mtime: file.mtime,
          text: file.text,
        })
      }
      return entries
    },
  }
})

/** Aegisub/automation/include 的真实文件（karaskel 依赖链） */
const INCLUDE_FILES: Record<string, string> = {
  'karaskel.lua': karaskelSource,
  'karaskel-auto4.lua': karaskelAuto4Source,
  'utils.lua': utilsSource,
  'utils-auto4.lua': utilsAuto4Source,
  'unicode.lua': unicodeSource,
  're.lua': reSource,
}

beforeAll(() => {
  for (const [name, text] of Object.entries(INCLUDE_FILES)) {
    fake.add(`/automation/include/${name}`, text)
  }
})

type Fengari = any

interface DirectState {
  fengari: Fengari
  L: any
}

let fengariModule: Fengari | null = null

async function createDirectState(
  files: Record<string, string>,
  dirs: string[],
): Promise<DirectState> {
  fengariModule ??= await import('fengari')
  const fengari = fengariModule as Fengari
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const cache = new Map<string, { mtime: number; code: string }>()
  let clock = 0
  for (const [path, code] of Object.entries(files)) {
    clock += 1
    cache.set(path, { mtime: clock, code })
  }
  installLuaModules(L, { lua, lauxlib, to_luastring, to_jsstring })
  installLuaModuleSearch(L, { lua, lauxlib, to_luastring, to_jsstring }, dirs, cache)
  return { fengari, L }
}

/** 执行一段 Lua 并在失败时返回错误文本 */
function runLua(state: DirectState, code: string): { ok: boolean; error: string } {
  const { lua, lauxlib, to_luastring, to_jsstring } = state.fengari
  const { L } = state
  if (
    lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring('@luaModules.test')) !== 0
  ) {
    const error = to_jsstring(lua.lua_tostring(L, -1))
    lua.lua_pop(L, 1)
    return { ok: false, error }
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== 0) {
    const error = to_jsstring(lua.lua_tostring(L, -1))
    lua.lua_pop(L, 1)
    return { ok: false, error }
  }
  return { ok: true, error: '' }
}

function closeDirectState(state: DirectState): void {
  state.fengari.lua.lua_close(state.L)
}

describe('内置 aegisub.* 模块（Lua 5.3 移植）', () => {
  it('aegisub.util：颜色与字符串工具', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local util = require 'aegisub.util'
      assert(util.ass_color(255, 255, 255) == '&HFFFFFF&')
      local r, g, b, a = util.extract_color('&H00FF00&')
      assert(r == 0 and g == 255 and b == 0 and a == 0)
      local r2, g2, b2, a2 = util.extract_color('&H00FFFFFF')
      assert(r2 == 255 and g2 == 255 and b2 == 255 and a2 == 0)
      assert(util.ass_alpha(128) == '&H80&')
      assert(util.trim('  x  ') == 'x')
      assert(util.headtail('one two') == 'one')
      assert(util.clamp(12, 0, 10) == 10)
      assert(util.interpolate(0.5, 0, 10) == 5)
      local copy = util.deep_copy({a = {b = 1}})
      assert(copy.a.b == 1)
      local r3 = util.HSV_to_RGB(0, 1, 1)
      assert(r3 == 255)
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('aegisub.unicode：字节宽度、字符迭代与大小写', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local unicode = require 'aegisub.unicode'
      assert(unicode.len('aß中') == 3)
      assert(unicode.charwidth('aß中', 1) == 1)
      assert(unicode.charwidth('aß中', 2) == 2)
      assert(unicode.codepoint('中') == 0x4E2D)
      local seen = {}
      for ch, i in unicode.chars('aß中') do seen[#seen + 1] = ch .. ':' .. i end
      assert(table.concat(seen, ' ') == 'a:1 ß:2 中:3')
      assert(unicode.to_upper_case('aß') == 'ASS')
      assert(unicode.to_lower_case('ÄÖÜ') == 'äöü')
      assert(unicode.to_fold_case('Straße') == 'strasse')
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('bit：LuaJIT 32 位语义', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local bit = require 'bit'
      assert(bit.tobit(0xFFFFFFFF) == -1)
      assert(bit.band(0xF0, 0x0F) == 0)
      assert(bit.bor(0xF0, 0x0F) == 255)
      assert(bit.bxor(0xFF, 0xFF) == 0)
      assert(bit.bnot(0) == -1)
      assert(bit.lshift(1, 31) == -2147483648)
      assert(bit.rshift(-1, 31) == 1)
      assert(bit.arshift(-8, 1) == -4)
      assert(bit.rol(1, 4) == 16)
      assert(bit.ror(16, 4) == 1)
      assert(bit.bswap(0x01020304) == 0x04030201)
      assert(bit.tohex(-1) == 'ffffffff')
      assert(bit.tohex(-1, -8) == 'FFFFFFFF')
      assert(bit.tohex(255, 2) == 'ff')
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('ffi：可 require，调用时给出浏览器不支持的错误', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local ffi = require 'ffi'
      assert(type(ffi.new) == 'function')
      local ok, err = pcall(ffi.new, 'int[1]')
      assert(not ok and err:find('not available'), tostring(err))
      local ok2, err2 = pcall(function() return ffi.C.malloc end)
      assert(not ok2 and err2:find('not available'), tostring(err2))
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('aegisub.re：UTF-8 字节偏移、捕获组与替换', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local re = require 'aegisub.re'

      local found = re.find('foo bar', [[\\w+]])
      assert(#found == 2)
      assert(found[1].str == 'foo' and found[1].first == 1 and found[1].last == 3)
      assert(found[2].str == 'bar' and found[2].first == 5 and found[2].last == 7)

      -- 桌面版在 UTF-8 字节串上工作，位置是字节偏移
      local zh = re.find('中a', 'a')
      assert(zh[1].first == 4 and zh[1].last == 4)
      local zz = re.find('中a', '中')
      assert(zz[1].first == 1 and zz[1].last == 3)

      assert(re.sub('foo123bar', [[(\\d+)]], 'N') == 'fooNbar')
      assert(re.sub('a1b2', [[\\d]], function(m) return '<' .. m .. '>' end) == 'a<1>b<2>')

      local parts = re.split('a,b,,c', ',')
      assert(#parts == 4 and parts[3] == '')
      local kept = re.split('a,b,,c', ',', true)
      assert(#kept == 3 and kept[3] == 'c')

      local m = re.match('ABC', 'abc', re.ICASE)
      assert(m ~= nil and m[1].str == 'ABC')
      assert(re.match('ABC', 'abc') == nil)

      -- re.match 返回首次匹配的捕获组列表（整段匹配为第 1 组），不是全部匹配
      local compiled = re.compile([[\\w+]])
      assert(type(compiled) == 'table')
      local groups = compiled:match('one two')
      assert(#groups == 1 and groups[1].str == 'one')
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('aegisub.internal.argcheck：参数校验', async () => {
    const state = await createDirectState({}, [])
    const result = runLua(
      state,
      `
      local check = require 'aegisub.internal.argcheck'
      local fn = check('string ?number')(function(a, b) return a .. tostring(b) end)
      assert(fn('x') == 'xnil')
      local ok, err = pcall(fn, 1)
      assert(not ok and err:find('should be a string'), tostring(err))
      local ok2, err2 = pcall(fn, 'x', 'y')
      assert(not ok2 and err2:find('should be a number'), tostring(err2))
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('模块搜索器：package.path 指向 include 目录并支持 init.lua', async () => {
    const state = await createDirectState(
      {
        '/automation/include/mypkg/mod.lua': 'return { value = 42 }',
        '/automation/include/other/init.lua': 'return { name = "other" }',
      },
      ['/automation/include'],
    )
    const result = runLua(
      state,
      `
      assert(package.path:find('/automation/include/?.lua', 1, true))
      local mod = require 'mypkg.mod'
      assert(mod.value == 42)
      local other = require 'other'
      assert(other.name == 'other')
      -- 重复 require 走 package.loaded 缓存
      assert(require 'mypkg.mod' == mod)
      `,
    )
    expect(result, result.error).toEqual({ ok: true, error: '' })
    closeDirectState(state)
  })

  it('模块搜索器：缺失模块的错误包含搜索过的文件', async () => {
    const state = await createDirectState({}, ['/automation/include'])
    const result = runLua(state, `require 'nope'`)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("module 'nope' not found")
    expect(result.error).toContain("no file '/automation/include/nope.lua'")
    closeDirectState(state)
  })
})

describe('自动化脚本加载（integrated require）', () => {
  it('require karaskel 依赖链 + 标准模块', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "ModuleTest"

      -- karaskel.lua 本身不返回值（桌面版 require 同样返回 true），模块把全局 karaskel 填好
      require 'karaskel'
      assert(type(_G.karaskel) == 'table')
      assert(type(_G.karaskel.collect_head) == 'function')

      local util = require 'aegisub.util'
      assert(util.ass_color(255, 255, 255) == '&HFFFFFF&')

      local unicode = require 'aegisub.unicode'
      assert(unicode.len('aß中') == 3)

      local bit = require 'bit'
      assert(bit.band(0xF0, 0x0F) == 0)

      local re = require 'aegisub.re'
      assert(re.find('foo', 'o')[1].first == 2)

      aegisub.register_macro('noop', 'noop', function() end)
      `,
      '/automation/autoload/module-test.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.name).toBe('ModuleTest')
    expect(loaded.macros).toHaveLength(1)
    closeAutomationState(loaded.stateId)
  })

  it('缺失模块在初始化时给出标准 require 错误', async () => {
    const loaded = await loadAutomationScript(
      `script_name = "Bad"\nrequire 'nope'`,
      '/automation/autoload/bad.lua',
    )
    expect(loaded.loaded).toBe(false)
    expect(loaded.error).toContain("module 'nope' not found")
    expect(loaded.error).toContain("no file '/automation/include/nope.lua'")
  })
})
