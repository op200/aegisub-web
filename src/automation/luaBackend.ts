/**
 * Lua VM 后端注册表（对应 Web 设置的 Automation/Backend 选项）。
 *
 * 后端必须提供与 fengari 相同形状的 C API 绑定（lua / lauxlib / lualib /
 * to_luastring / to_jsstring），luaEngine / luaModules 的桥接代码因此不感知
 * 具体 VM。新增后端时在文件末尾 registerLuaBackend 注册，load() 内动态 import，
 * 避免首屏加载 VM。
 */

import { getOptionString } from '../config/options'
import { logWarning } from '../ui/log'

export interface LuaVmApi {
  lua: any
  lauxlib: any
  lualib: any
  to_luastring: (value: string) => Uint8Array
  to_jsstring: (value: Uint8Array) => string
  /**
   * 可选：把 VM 内建的 C 模块（lpeg / luabins）注册到 package.preload。
   * 只有能加载 C 模块的后端实现它；返回 false 表示该模块不可用。
   */
  preloadNativeModule?(L: any, name: 'lpeg' | 'luabins'): boolean
}

export interface LuaBackend {
  /** 写入 Automation/Backend 选项的稳定 id */
  id: string
  /** 首选项下拉的显示名 */
  label: string
  /** 懒加载 VM（仅在首次加载 Automation 脚本时调用） */
  load(): Promise<LuaVmApi>
}

const backends = new Map<string, LuaBackend>()
let activeId: string | null = null
let activeApi: LuaVmApi | null = null
/** 进行中的初始化：并发调用共享同一个 Promise（WASM 后端每次 load 都会新建 VM 实例） */
let pending: { id: string; promise: Promise<LuaVmApi> } | null = null

export function registerLuaBackend(backend: LuaBackend): void {
  backends.set(backend.id, backend)
}

/** 首选项 ChoiceControl 选项（value 存 id，label 仅显示） */
export function luaBackendOptions(): Array<{ value: string; label: string }> {
  return [...backends.values()].map(({ id, label }) => ({ value: id, label }))
}

/** 当前选中的后端 id；配置里写了未注册的 id 时回退到第一个后端 */
export function selectedLuaBackendId(): string {
  const id = getOptionString('Automation/Backend')
  if (backends.has(id)) return id
  return backends.values().next().value?.id ?? id
}

/**
 * 加载选中后端；同一 id 只初始化一次（幂等）。
 * 并发调用必须共享同一次加载：WASM 后端每次 load 都会实例化一份新的 VM，
 * 而脚本状态句柄只在所属实例内有效，两个实例并存会让句柄指向另一个实例的同号状态。
 */
export async function ensureLuaBackend(id: string): Promise<LuaVmApi> {
  if (activeApi && activeId === id) return activeApi
  // 同一后端的并发首次调用必须共享同一次加载
  if (pending && pending.id === id) return pending.promise
  const backend = backends.get(id)
  if (!backend) throw new Error(`Unknown Lua backend: ${id}`)
  const promise = backend.load().then(
    (api) => {
      activeApi = api
      activeId = id
      if (pending?.promise === promise) pending = null
      return api
    },
    (error: unknown) => {
      if (pending?.promise === promise) pending = null
      // 默认后端是 WASM：产物 public/wasm/lua55.js 不入库（需 native 构建），
      // 缺失时回退到 fengari，保证 Automation 在未构建的环境里仍可运行。
      if (id !== 'fengari') {
        const reason = error instanceof Error ? error.message : String(error)
        logWarning('automation', `Lua 后端 ${id} 加载失败，已回退到 fengari：${reason}`)
        return ensureLuaBackend('fengari')
      }
      throw error
    },
  )
  pending = { id, promise }
  return promise
}

/** 丢弃已加载的后端（由 luaEngine 关闭全部脚本状态后调用） */
export function resetActiveLuaBackend(): void {
  activeApi = null
  activeId = null
  pending = null
}

// ---------------------------------------------------------------------------
// 已注册后端
// ---------------------------------------------------------------------------

/** fengari：纯 JS 的 Lua 5.3（WASM 后端加载失败时的回退后端） */
registerLuaBackend({
  id: 'fengari',
  label: 'fengari (Lua 5.3)',
  async load() {
    return (await import('fengari')) as unknown as LuaVmApi
  },
})

/** Lua 5.5：官方 Lua 5.5.1 源码经 Emscripten 编译（native/src/lua_web_api.cpp） */
registerLuaBackend({
  id: 'lua55-wasm',
  label: 'Lua 5.5 (WASM)',
  async load() {
    const { createLua55WasmApi } = await import('./backends/lua55Wasm')
    return createLua55WasmApi()
  },
})
