/**
 * Lua VM 后端注册表（对应 Web 设置的 Automation/Backend 选项）。
 *
 * 后端必须提供与 fengari 相同形状的 C API 绑定（lua / lauxlib / lualib /
 * to_luastring / to_jsstring），luaEngine / luaModules 的桥接代码因此不感知
 * 具体 VM。新增后端时在文件末尾 registerLuaBackend 注册，load() 内动态 import，
 * 避免首屏加载 VM。
 */

import { getOptionString } from '../config/options'

export interface LuaVmApi {
  lua: any
  lauxlib: any
  lualib: any
  to_luastring: (value: string) => Uint8Array
  to_jsstring: (value: Uint8Array) => string
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

/** 加载选中后端；同一 id 只初始化一次（幂等） */
export async function ensureLuaBackend(id: string): Promise<LuaVmApi> {
  if (activeApi && activeId === id) return activeApi
  const backend = backends.get(id)
  if (!backend) throw new Error(`Unknown Lua backend: ${id}`)
  const api = await backend.load()
  activeApi = api
  activeId = id
  return api
}

/** 丢弃已加载的后端（由 luaEngine 关闭全部脚本状态后调用） */
export function resetActiveLuaBackend(): void {
  activeApi = null
  activeId = null
}

// ---------------------------------------------------------------------------
// 已注册后端
// ---------------------------------------------------------------------------

/** fengari：纯 JS 的 Lua 5.3（默认后端） */
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
