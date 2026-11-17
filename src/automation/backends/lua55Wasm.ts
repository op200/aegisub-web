/**
 * Lua 5.5（WASM）后端。
 *
 * Lua 本体是官方 lua/lua v5.5.1 源码经 Emscripten 编译的产物
 * （native/src/lua_web_api.cpp 提供桥接，public/wasm/lua55.js 为构建结果）。
 * 这里把桥接层包装成与 fengari 相同形状的 LuaVmApi，使 luaEngine / luaModules
 * 不感知具体 VM。
 *
 * 与 C 桥接的约定见 native/src/lua_web_api.cpp 文件头：
 *   - lua_State* / userdata 均以整数 handle 表示
 *   - 所有 JS 函数编译成同一个 C 调度器，通过异常传递 yield / raise / 文本错误
 *   - JS 初始化后把自身挂到 Module.luaWeb，供 EM_JS 回调
 */
import type { LuaVmApi } from '../luaBackend'

const LUA_OK = 0
const LUA_YIELD = 1
const LUA_ERRRUN = 2
const LUA_MULTRET = -1

const LUA_TNONE = -1
const LUA_TNIL = 0
const LUA_TBOOLEAN = 1
const LUA_TLIGHTUSERDATA = 2
const LUA_TNUMBER = 3
const LUA_TSTRING = 4
const LUA_TTABLE = 5
const LUA_TFUNCTION = 6
const LUA_TUSERDATA = 7
const LUA_TTHREAD = 8

interface Lua55Module {
  _lua_web_registry_index(): number
  _lua_web_newstate(): number
  _lua_web_close(handle: number): void
  _lua_web_newthread(handle: number): number
  _lua_web_main_handle(handle: number): number
  _lua_web_openlibs(handle: number): void
  _lua_web_gettop(handle: number): number
  _lua_web_settop(handle: number, idx: number): void
  _lua_web_pushvalue(handle: number, idx: number): void
  _lua_web_pop(handle: number, n: number): void
  _lua_web_insert(handle: number, idx: number): void
  _lua_web_remove(handle: number, idx: number): void
  _lua_web_replace(handle: number, idx: number): void
  _lua_web_absindex(handle: number, idx: number): number
  _lua_web_xmove(from: number, to: number, n: number): void
  _lua_web_type(handle: number, idx: number): number
  _lua_web_typename(handle: number, tp: number): number
  _lua_web_isnil(handle: number, idx: number): number
  _lua_web_isnumber(handle: number, idx: number): number
  _lua_web_isstring(handle: number, idx: number): number
  _lua_web_istable(handle: number, idx: number): number
  _lua_web_isboolean(handle: number, idx: number): number
  _lua_web_isfunction(handle: number, idx: number): number
  _lua_web_isuserdata(handle: number, idx: number): number
  _lua_web_isyieldable(handle: number): number
  _lua_web_toboolean(handle: number, idx: number): number
  _lua_web_tonumber(handle: number, idx: number): number
  _lua_web_tointeger(handle: number, idx: number): number
  _lua_web_tolstring(handle: number, idx: number): number
  _lua_web_touserdata(handle: number, idx: number): number
  _lua_web_pushnil(handle: number): void
  _lua_web_pushboolean(handle: number, value: number): void
  _lua_web_pushnumber(handle: number, value: number): void
  _lua_web_pushinteger(handle: number, value: number): void
  _lua_web_pushstring(handle: number, ptr: number, len: number): void
  _lua_web_pushlightuserdata(handle: number, id: number): void
  _lua_web_newuserdata(handle: number, id: number): number
  _lua_web_newtable(handle: number): void
  _lua_web_getfield(handle: number, idx: number, name: number): void
  _lua_web_setfield(handle: number, idx: number, name: number): void
  _lua_web_getglobal(handle: number, name: number): void
  _lua_web_setglobal(handle: number, name: number): void
  _lua_web_rawget(handle: number, idx: number): void
  _lua_web_rawset(handle: number, idx: number): void
  _lua_web_rawgeti(handle: number, idx: number, n: number): void
  _lua_web_rawseti(handle: number, idx: number, n: number): void
  _lua_web_rawlen(handle: number, idx: number): number
  _lua_web_setmetatable(handle: number, idx: number): number
  _lua_web_next(handle: number, idx: number): number
  _lua_web_pushclosure(handle: number, id: number, nup: number): void
  _lua_web_pcall(handle: number, nargs: number, nresults: number, errfunc: number): number
  _lua_web_call(handle: number, nargs: number, nresults: number): number
  _lua_web_resume(co: number, from: number, nargs: number): number
  _lua_web_ref(handle: number, t: number): number
  _lua_web_loadbuffer(handle: number, src: number, len: number, name: number): number
  _lua_web_dostring(handle: number, src: number, len: number, name: number): number
  _lua_web_set_error(ptr: number, len: number): void
  _lua_web_buffer(size: number): number
  _lua_web_buffer2(size: number): number
  _lua_web_strlen_addr(): number
  _lua_web_next_ref(): number
  _lua_web_getstack(handle: number, level: number): number
  _lua_web_getinfo(handle: number, level: number): number
  _lua_web_dbg_str(which: number): number
  _lua_web_dbg_int(which: number): number
  _lua_web_preload_lpeg(handle: number): number
  _lua_web_preload_luabins(handle: number): number
  HEAPU8: Uint8Array
  HEAP32: Int32Array
  luaWeb?: LuaWebBridge
}

/** EM_JS 回调入口（C 调度器调用） */
interface LuaWebBridge {
  invoke(id: number, handle: number): number
  release(id: number): void
  setTextError(text: string): void
  pushError(handle: number, error: unknown): void
}

interface RefRecord {
  value: unknown
  main: number
}

interface Invoker {
  fn: (L: number) => number
  main: number
}

class YieldSignal {
  readonly luaYield: number
  constructor(n: number) {
    this.luaYield = n
  }
}

class RaiseSignal {
  readonly luaRaise = true
}

class LuaTextError extends Error {
  readonly luaText: string
  constructor(text: string) {
    super(text)
    this.name = 'LuaTextError'
    this.luaText = text
  }
}

export class LuaDebug {
  event = 0
  name: Uint8Array | null = null
  namewhat: Uint8Array | null = null
  what: Uint8Array | null = null
  source: Uint8Array | null = null
  short_src: Uint8Array | null = null
  currentline = -1
  linedefined = -1
  lastlinedefined = -1
  nups = 0
  nparams = 0
  isvararg = false
  istailcall = false
  /** 当前 getstack 命中的层级，供同一次 getinfo 使用 */
  _level = 0
}

function isSignal(error: unknown): boolean {
  return (
    error instanceof YieldSignal || error instanceof RaiseSignal || error instanceof LuaTextError
  )
}

export class Lua55Api implements LuaVmApi {
  readonly lua: Record<string, unknown>
  readonly lauxlib: Record<string, unknown>
  readonly lualib: Record<string, unknown>
  readonly to_luastring: (value: string) => Uint8Array
  readonly to_jsstring: (value: Uint8Array) => string

  private readonly mod: Lua55Module
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private readonly registryIndex: number
  private readonly strlenAddr: number
  private readonly refs = new Map<number, RefRecord>()
  private readonly invokers = new Map<number, Invoker>()
  private nextInvoker = 1

  constructor(mod: Lua55Module) {
    this.mod = mod
    this.registryIndex = mod._lua_web_registry_index()
    this.strlenAddr = mod._lua_web_strlen_addr()
    mod.luaWeb = this as unknown as LuaWebBridge

    this.to_luastring = (value: string) => this.encoder.encode(value)
    this.to_jsstring = (value: Uint8Array) => this.decoder.decode(value)
    this.lua = this.makeLua()
    this.lauxlib = this.makeLauxlib()
    this.lualib = { luaL_openlibs: (L: number) => mod._lua_web_openlibs(L) }
  }

  // -- EM_JS 回调 -----------------------------------------------------------

  invoke(id: number, handle: number): number {
    const invoker = this.invokers.get(id)
    if (!invoker) return 0
    try {
      const results = invoker.fn(handle)
      return typeof results === 'number' ? results : 0
    } catch (error) {
      if (isSignal(error)) throw error
      // 普通 JS 异常按 fengari 的做法包成 lightuserdata 错误对象
      this.pushError(handle, error)
      throw new RaiseSignal()
    }
  }

  release(id: number): void {
    this.refs.delete(id)
  }

  /**
   * 把编译进 wasm 的 lpeg / luabins 注册到 package.preload。
   * luabins 注册在 aegisub.__luabins_impl 下，由 luaModules 的 Lua 包装层发废弃警告。
   */
  preloadNativeModule(L: number, name: 'lpeg' | 'luabins'): boolean {
    if (name === 'lpeg') return this.mod._lua_web_preload_lpeg(L) !== 0
    if (name === 'luabins') return this.mod._lua_web_preload_luabins(L) !== 0
    return false
  }

  setTextError(text: string): void {
    const bytes = this.encoder.encode(text)
    const ptr = this.writeBuffer(2, bytes)
    this.mod._lua_web_set_error(ptr, bytes.length)
  }

  pushError(handle: number, error: unknown): void {
    const id = this.mod._lua_web_next_ref()
    this.refs.set(id, { value: error, main: this.mainOf(handle) })
    this.mod._lua_web_pushlightuserdata(handle, id)
  }

  // -- 二进制 / 字符串辅助 --------------------------------------------------

  private writeBuffer(slot: 1 | 2, bytes: Uint8Array): number {
    const ptr =
      slot === 1 ? this.mod._lua_web_buffer(bytes.length) : this.mod._lua_web_buffer2(bytes.length)
    this.mod.HEAPU8.set(bytes, ptr)
    return ptr
  }

  private stringAt(ptr: number): Uint8Array | null {
    if (!ptr) return null
    const length = this.mod.HEAP32[this.strlenAddr >> 2]
    return this.mod.HEAPU8.slice(ptr, ptr + Math.max(0, length))
  }

  private decode(value: Uint8Array | string): string {
    return typeof value === 'string' ? value : this.decoder.decode(value)
  }

  private bytesOf(value: Uint8Array | string): Uint8Array {
    return typeof value === 'string' ? this.encoder.encode(value) : value
  }

  private mainOf(handle: number): number {
    return this.mod._lua_web_main_handle(handle)
  }

  private typenameOf(handle: number, idx: number): string {
    const typename = this.stringAt(
      this.mod._lua_web_typename(handle, this.mod._lua_web_type(handle, idx)),
    )
    return typename ? this.decoder.decode(typename) : ''
  }

  // -- lua -----------------------------------------------------------------

  private makeLua(): Record<string, unknown> {
    const mod = this.mod
    const lua: Record<string, unknown> = {
      LUA_OK,
      LUA_YIELD,
      LUA_ERRRUN,
      LUA_MULTRET,
      LUA_REGISTRYINDEX: this.registryIndex,
      LUA_TNONE,
      LUA_TNIL,
      LUA_TBOOLEAN,
      LUA_TLIGHTUSERDATA,
      LUA_TNUMBER,
      LUA_TSTRING,
      LUA_TTABLE,
      LUA_TFUNCTION,
      LUA_TUSERDATA,
      LUA_TTHREAD,
      lua_Debug: LuaDebug,

      lua_upvalueindex: (i: number) => this.registryIndex - (i + 1),
      lua_gettop: (L: number) => mod._lua_web_gettop(L),
      lua_settop: (L: number, idx: number) => mod._lua_web_settop(L, idx),
      lua_pop: (L: number, n: number) => mod._lua_web_settop(L, -n - 1),
      lua_pushvalue: (L: number, idx: number) => mod._lua_web_pushvalue(L, idx),
      lua_insert: (L: number, idx: number) => mod._lua_web_insert(L, idx),
      lua_remove: (L: number, idx: number) => mod._lua_web_remove(L, idx),
      lua_replace: (L: number, idx: number) => mod._lua_web_replace(L, idx),
      lua_absindex: (L: number, idx: number) => mod._lua_web_absindex(L, idx),
      lua_xmove: (from: number, to: number, n: number) => mod._lua_web_xmove(from, to, n),

      lua_type: (L: number, idx: number) => mod._lua_web_type(L, idx),
      lua_typename: (L: number, tp: number) =>
        this.stringAt(mod._lua_web_typename(L, tp)) ?? new Uint8Array(0),
      lua_isnil: (L: number, idx: number) => mod._lua_web_isnil(L, idx) !== 0,
      lua_isnumber: (L: number, idx: number) => mod._lua_web_isnumber(L, idx) !== 0,
      lua_isstring: (L: number, idx: number) => mod._lua_web_isstring(L, idx) !== 0,
      lua_istable: (L: number, idx: number) => mod._lua_web_istable(L, idx) !== 0,
      lua_isboolean: (L: number, idx: number) => mod._lua_web_isboolean(L, idx) !== 0,
      lua_isfunction: (L: number, idx: number) => mod._lua_web_isfunction(L, idx) !== 0,
      lua_isuserdata: (L: number, idx: number) => mod._lua_web_isuserdata(L, idx) !== 0,
      lua_isyieldable: (L: number) => mod._lua_web_isyieldable(L) !== 0,
      lua_toboolean: (L: number, idx: number) => mod._lua_web_toboolean(L, idx) !== 0,
      lua_tonumber: (L: number, idx: number) => mod._lua_web_tonumber(L, idx),
      lua_tointeger: (L: number, idx: number) => Math.trunc(mod._lua_web_tointeger(L, idx)),
      lua_tolstring: (L: number, idx: number) => this.stringAt(mod._lua_web_tolstring(L, idx)),
      lua_tostring: (L: number, idx: number) => this.stringAt(mod._lua_web_tolstring(L, idx)),
      lua_touserdata: (L: number, idx: number) => {
        const id = mod._lua_web_touserdata(L, idx)
        return id ? (this.refs.get(id)?.value ?? null) : null
      },

      lua_pushnil: (L: number) => mod._lua_web_pushnil(L),
      lua_pushboolean: (L: number, value: unknown) => mod._lua_web_pushboolean(L, value ? 1 : 0),
      lua_pushnumber: (L: number, value: number) => mod._lua_web_pushnumber(L, value),
      lua_pushinteger: (L: number, value: number) => mod._lua_web_pushinteger(L, Math.trunc(value)),
      lua_pushstring: (L: number, value: Uint8Array | string) => {
        const bytes = this.bytesOf(value)
        if (bytes.length === 0) {
          mod._lua_web_pushstring(L, 0, 0)
          return
        }
        mod._lua_web_pushstring(L, this.writeBuffer(1, bytes), bytes.length)
      },
      lua_pushlightuserdata: (L: number, value: unknown) => {
        const id = mod._lua_web_next_ref()
        this.refs.set(id, { value, main: this.mainOf(L) })
        mod._lua_web_pushlightuserdata(L, id)
      },
      lua_newuserdata: (L: number, _size: number) => {
        const id = mod._lua_web_next_ref()
        mod._lua_web_newuserdata(L, id)
        const object: Record<string, unknown> = {}
        this.refs.set(id, { value: object, main: this.mainOf(L) })
        return object
      },
      lua_newtable: (L: number) => mod._lua_web_newtable(L),

      lua_getfield: (L: number, idx: number, name: Uint8Array) =>
        mod._lua_web_getfield(L, idx, this.writeBuffer(1, name)),
      lua_setfield: (L: number, idx: number, name: Uint8Array) =>
        mod._lua_web_setfield(L, idx, this.writeBuffer(1, name)),
      lua_getglobal: (L: number, name: Uint8Array) =>
        mod._lua_web_getglobal(L, this.writeBuffer(1, name)),
      lua_setglobal: (L: number, name: Uint8Array) =>
        mod._lua_web_setglobal(L, this.writeBuffer(1, name)),
      lua_rawget: (L: number, idx: number) => mod._lua_web_rawget(L, idx),
      lua_rawset: (L: number, idx: number) => mod._lua_web_rawset(L, idx),
      lua_rawgeti: (L: number, idx: number, n: number) => mod._lua_web_rawgeti(L, idx, n),
      lua_rawseti: (L: number, idx: number, n: number) => mod._lua_web_rawseti(L, idx, n),
      lua_rawlen: (L: number, idx: number) => mod._lua_web_rawlen(L, idx),
      lua_setmetatable: (L: number, idx: number) => mod._lua_web_setmetatable(L, idx),
      lua_next: (L: number, idx: number) => mod._lua_web_next(L, idx),

      lua_pushcclosure: (L: number, fn: (L2: number) => number, nup: number) => {
        const id = this.nextInvoker++
        this.invokers.set(id, { fn, main: this.mainOf(L) })
        mod._lua_web_pushclosure(L, id, nup)
      },
      lua_pushcfunction: (L: number, fn: (L2: number) => number) => {
        const id = this.nextInvoker++
        this.invokers.set(id, { fn, main: this.mainOf(L) })
        mod._lua_web_pushclosure(L, id, 0)
      },

      lua_call: (L: number, nargs: number, nresults: number) => {
        if (mod._lua_web_call(L, nargs, nresults) !== LUA_OK) throw new RaiseSignal()
      },
      lua_pcall: (L: number, nargs: number, nresults: number, errfunc: number) =>
        mod._lua_web_pcall(L, nargs, nresults, errfunc),
      lua_error: () => {
        throw new RaiseSignal()
      },
      lua_yield: (_L: number, n: number): never => {
        throw new YieldSignal(n)
      },
      lua_resume: (co: number, from: number, nargs: number) => mod._lua_web_resume(co, from, nargs),
      lua_newthread: (L: number) => mod._lua_web_newthread(L),
      lua_close: (L: number) => this.closeState(L),

      lua_getstack: (L: number, level: number, ar: LuaDebug) => {
        const ok = mod._lua_web_getstack(L, level)
        if (ok) ar._level = level
        return ok !== 0
      },
      lua_getinfo: (L: number, _what: string, ar: LuaDebug) => {
        if (!mod._lua_web_getinfo(L, ar._level)) return 0
        const what = this.stringAt(mod._lua_web_dbg_str(2))
        ar.name = this.stringAt(mod._lua_web_dbg_str(0))
        ar.namewhat = this.stringAt(mod._lua_web_dbg_str(1))
        ar.source = this.stringAt(mod._lua_web_dbg_str(3))
        ar.short_src = this.stringAt(mod._lua_web_dbg_str(4))
        ar.currentline = mod._lua_web_dbg_int(0)
        ar.linedefined = mod._lua_web_dbg_int(1)
        ar.lastlinedefined = mod._lua_web_dbg_int(2)
        ar.what = what
        if (what && this.decoder.decode(what) === 'C') {
          // C 桥接帧对脚本等价于 fengari 的 JS 帧：what='J'、source='=[JS]'
          ar.what = this.encoder.encode('J')
          ar.source = this.encoder.encode('=[JS]')
          ar.short_src = ar.source
        }
        return 1
      },
    }
    return lua
  }

  // -- lauxlib -------------------------------------------------------------

  private makeLauxlib(): Record<string, unknown> {
    const mod = this.mod
    return {
      luaL_newstate: () => mod._lua_web_newstate(),
      luaL_openlibs: (L: number) => mod._lua_web_openlibs(L),
      luaL_ref: (L: number, t: number) => mod._lua_web_ref(L, t),
      luaL_loadbuffer: (
        L: number,
        buffer: Uint8Array,
        size: number | null | undefined,
        name: Uint8Array,
      ) => {
        const bytes = buffer
        const srcPtr = this.writeBuffer(1, bytes)
        const namePtr = this.writeBuffer(2, name)
        return mod._lua_web_loadbuffer(
          L,
          srcPtr,
          size === null || size === undefined ? bytes.length : size,
          namePtr,
        )
      },
      luaL_dostring: (L: number, text: Uint8Array) => {
        const bytes = this.bytesOf(text)
        const ptr = this.writeBuffer(1, bytes)
        return mod._lua_web_dostring(L, ptr, bytes.length, ptr)
      },
      luaL_checkstring: (L: number, n: number) => {
        if (!this.isString(L, n)) {
          throw new LuaTextError(
            `bad argument #${n} to '?' (string expected, got ${this.typenameOf(L, n)})`,
          )
        }
        const value = this.stringAt(mod._lua_web_tolstring(L, n))
        if (!value)
          throw new LuaTextError(`bad argument #${n} to '?' (string expected, got no value)`)
        return value
      },
      luaL_checkinteger: (L: number, n: number) => {
        if (this.isNumber(L, n)) return Math.trunc(mod._lua_web_tointeger(L, n))
        throw new LuaTextError(
          `bad argument #${n} to '?' (number expected, got ${this.typenameOf(L, n)})`,
        )
      },
      luaL_argerror: (_L: number, n: number, message: Uint8Array) => {
        throw new LuaTextError(`bad argument #${n} to '?' (${this.decoder.decode(message)})`)
      },
      luaL_error: (_L: number, fmt: Uint8Array | string, ...args: unknown[]) => {
        throw new LuaTextError(this.formatMessage(fmt, args))
      },
    }
  }

  private isString(L: number, idx: number): boolean {
    return this.mod._lua_web_isstring(L, idx) !== 0
  }

  private isNumber(L: number, idx: number): boolean {
    return this.mod._lua_web_isnumber(L, idx) !== 0
  }

  private formatMessage(fmt: Uint8Array | string, args: unknown[]): string {
    let index = 0
    return this.decode(fmt).replace(/%([%sdqi])/g, (_match, spec: string) => {
      if (spec === '%') return '%'
      const value = index < args.length ? args[index++] : ''
      if (spec === 'd' || spec === 'i') return String(Math.trunc(Number(value)))
      return this.decode(value as Uint8Array | string)
    })
  }

  // -- 生命周期 -------------------------------------------------------------

  private closeState(L: number): void {
    const main = this.mainOf(L)
    this.mod._lua_web_close(L)
    for (const [id, record] of this.refs) {
      if (record.main === main) this.refs.delete(id)
    }
    for (const [id, invoker] of this.invokers) {
      if (invoker.main === main) this.invokers.delete(id)
    }
  }
}

/** 加载 public/wasm/lua55.js 并建立 bridge */
export async function createLua55WasmApi(): Promise<LuaVmApi> {
  const module = await loadLuaModule()
  return new Lua55Api(module)
}

async function loadLuaModule(): Promise<Lua55Module> {
  const inBrowser = typeof document !== 'undefined'
  const url = inBrowser
    ? new URL('wasm/lua55.js', document.baseURI).href
    : new URL('../../../public/wasm/lua55.js', import.meta.url).href

  let factory: ((options?: object) => Promise<Lua55Module>) | undefined
  if (inBrowser) {
    // 与 WASM 核心相同：fetch + Blob 绕过 Vite 对 public 资源的 import 转换
    const source = await (await fetch(url, { cache: 'no-cache' })).text()
    const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      const imported = (await import(/* @vite-ignore */ objectUrl)) as {
        default?: (options?: object) => Promise<Lua55Module>
        createLua55?: (options?: object) => Promise<Lua55Module>
      }
      factory = imported.default ?? imported.createLua55
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } else {
    const imported = (await import(/* @vite-ignore */ url)) as {
      default?: (options?: object) => Promise<Lua55Module>
      createLua55?: (options?: object) => Promise<Lua55Module>
    }
    factory = imported.default ?? imported.createLua55
  }
  if (!factory) throw new Error('lua55.js does not export a module factory')
  return factory()
}
