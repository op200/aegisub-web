/**
 * 配置持久化（对应源码 ?user/config.json 与 ?user/hotkey.json）。
 *
 * config.json：agi::Options 在退出时 Flush 全量选项树；web 版每次 OPT_SET
 * 后写穿到 IndexedDB 'config' store（localStorage 保留为同步回退）。
 * hotkey.json：hotkey.cpp Flush 的整表 { "上下文": { "命令": ["按键"] } }。
 *
 * 启动时由 main.tsx 引导加载：IndexedDB 优先，旧版仅 localStorage 的数据
 * 自动迁移写入 IndexedDB。
 */
import { openMainDatabase } from './db'

const STORE = 'config'
const CONFIG_KEY = 'config.json'
const HOTKEY_KEY = 'hotkey.json'

/** 旧版（localStorage-only）存储键，保留用于一次性迁移 */
const LEGACY_CONFIG_KEY = 'aegisub-web:config'
const LEGACY_HOTKEY_KEY = 'aegisub-web:hotkeys'

function readLegacy<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function idbGet<T>(database: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

function idbPut(database: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export interface PersistedConfig {
  configTree: Record<string, unknown> | null
  hotkeys: unknown | null
}

/** 启动引导：读 IndexedDB，缺失项回退旧版 localStorage 并迁移入库 */
export async function loadPersistedConfig(): Promise<PersistedConfig> {
  try {
    if (typeof indexedDB === 'undefined') return { configTree: null, hotkeys: null }
    const database = await openMainDatabase()
    try {
      let configTree = (await idbGet<Record<string, unknown>>(database, CONFIG_KEY)) ?? null
      let hotkeys = (await idbGet<unknown>(database, HOTKEY_KEY)) ?? null
      if (!configTree) {
        const legacy = readLegacy<Record<string, unknown>>(LEGACY_CONFIG_KEY)
        if (legacy) {
          await idbPut(database, CONFIG_KEY, legacy)
          configTree = legacy
        }
      }
      if (!hotkeys) {
        const legacy = readLegacy<unknown>(LEGACY_HOTKEY_KEY)
        if (legacy) {
          await idbPut(database, HOTKEY_KEY, legacy)
          hotkeys = legacy
        }
      }
      return { configTree, hotkeys }
    } finally {
      database.close()
    }
  } catch {
    // 私密模式下 IndexedDB 可能不可用：继续用 localStorage 回退
    return {
      configTree: readLegacy<Record<string, unknown>>(LEGACY_CONFIG_KEY),
      hotkeys: readLegacy<unknown>(LEGACY_HOTKEY_KEY),
    }
  }
}

// --- 写穿持久化：高频 OPT_SET 合并为一次 IDB 写（250ms 去抖） --------------
let pendingConfig: Record<string, unknown> | null = null
let pendingHotkeys: unknown = null
let pendingHotkeysDirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const configTree = pendingConfig
    const hotkeys = pendingHotkeysDirty ? pendingHotkeys : null
    pendingConfig = null
    pendingHotkeys = null
    pendingHotkeysDirty = false
    if (configTree === null && hotkeys === null) return
    void (async () => {
      try {
        if (typeof indexedDB === 'undefined') return
        const database = await openMainDatabase()
        try {
          if (configTree !== null) await idbPut(database, CONFIG_KEY, configTree)
          if (hotkeys !== null) await idbPut(database, HOTKEY_KEY, hotkeys)
        } finally {
          database.close()
        }
      } catch {
        // IndexedDB 不可用时 localStorage 回退已在 persist() 同步完成
      }
    })()
  }, 250)
}

/** config.json 写穿（options.ts persist 调用） */
export function persistConfigJson(tree: Record<string, unknown>): void {
  pendingConfig = tree
  scheduleFlush()
}

/** hotkey.json 写穿（aegisubHotkeys.setActiveHotkeys 调用） */
export function persistHotkeyJson(map: unknown): void {
  pendingHotkeys = map
  pendingHotkeysDirty = true
  scheduleFlush()
}
