/**
 * 配置持久化（对应源码 ?user/config.json、?user/hotkey.json 与 ?user/shift_history.json）。
 *
 * 桌面版三者在便携模式下都写 ?user（= 便携包根，main.cpp L167-181）；web 便携根
 * 即 VFS 根，故对应 /config.json、/hotkey.json、/shift_history.json。
 * - config.json：agi::Options 退出时 Flush 全量选项树；web 每次 OPT_SET 后写穿
 *   VFS（250ms 去抖），options.ts 的 localStorage 同步镜像保留为回退。
 * - hotkey.json：hotkey.cpp Flush 的整表 { "上下文": { "命令": ["按键"] } }。
 * - shift_history.json：平移时轴对话框历史（dialog_shift_times.cpp）。
 *
 * 旧数据（v4 config store 三键、v3 仅 localStorage 的 aegisub-web:config /
 * aegisub-web:hotkeys）为只读回退：VFS 缺失时读旧位置并回写 VFS（惰性迁移）。
 */
import { openMainDatabase } from './db'
import { deletePath, readTextFile, writeTextFile } from './vfs'

/** VFS 根下的对应文件（?user/*.json） */
const CONFIG_FILE = '/config.json'
const HOTKEY_FILE = '/hotkey.json'
const SHIFT_HISTORY_FILE = '/shift_history.json'

/** 旧版存储位置（v4 config store 键名与源码文件名一致） */
const LEGACY_STORE = 'config'
const LEGACY_CONFIG_KEY = 'config.json'
const LEGACY_HOTKEY_KEY = 'hotkey.json'
const LEGACY_SHIFT_HISTORY_KEY = 'shift_history.json'
/** 旧版（localStorage-only）键，保留用于一次性迁移 */
const LEGACY_LOCAL_CONFIG_KEY = 'aegisub-web:config'
const LEGACY_LOCAL_HOTKEY_KEY = 'aegisub-web:hotkeys'

function readLocalStorage<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function readLegacyStore<T>(key: string): Promise<T | null> {
  try {
    if (typeof indexedDB === 'undefined') return null
    const database = await openMainDatabase()
    try {
      const value = await new Promise<T | undefined>((resolve, reject) => {
        const request = database.transaction(LEGACY_STORE).objectStore(LEGACY_STORE).get(key)
        request.onsuccess = () => resolve(request.result as T | undefined)
        request.onerror = () => reject(request.error)
      })
      return value ?? null
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

/** 读取 VFS 中的 JSON 文件；不存在或解析失败返回 null */
async function readJsonFile(path: string): Promise<unknown> {
  const text = await readTextFile(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 写入 VFS 中的 JSON 文件（2 空格缩进，便于在文件管理器中阅读） */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, JSON.stringify(value, null, 2))
}

// --- /shift_history.json（dialog_shift_times.cpp SaveHistory/LoadHistory/OnClear） ---

/** 读取平移时轴历史；无文件时回退旧存储，仍无则 null */
export async function loadShiftHistoryFile(): Promise<unknown> {
  try {
    const value = await readJsonFile(SHIFT_HISTORY_FILE)
    if (value !== null) return value
    return await readLegacyStore<unknown>(LEGACY_SHIFT_HISTORY_KEY)
  } catch {
    return null
  }
}

/** 写入平移时轴历史（内存态由调用方保留；持久化失败不阻断操作） */
export async function saveShiftHistoryFile(history: unknown): Promise<void> {
  try {
    await writeJsonFile(SHIFT_HISTORY_FILE, history)
  } catch {
    // 私密模式下 IndexedDB 可能不可用，仅内存保留
  }
}

/** 删除平移时轴历史（Clear 按钮：agi::fs::Remove(history_filename)） */
export async function clearShiftHistoryFile(): Promise<void> {
  try {
    await deletePath(SHIFT_HISTORY_FILE)
  } catch {
    // 与源码一致：删除失败静默（Remove 仅记日志）
  }
}

export interface PersistedConfig {
  configTree: Record<string, unknown> | null
  hotkeys: unknown | null
}

/**
 * 启动引导：读 VFS，缺失时依次回退旧 config store 与 localStorage，
 * 并把回退命中的值回写 VFS（惰性迁移）。
 */
export async function loadPersistedConfig(): Promise<PersistedConfig> {
  let configTree: Record<string, unknown> | null = null
  let hotkeys: unknown | null = null
  try {
    configTree = (await readJsonFile(CONFIG_FILE)) as Record<string, unknown> | null
    hotkeys = await readJsonFile(HOTKEY_FILE)
    if (configTree === null) {
      const legacy =
        (await readLegacyStore<Record<string, unknown>>(LEGACY_CONFIG_KEY)) ??
        readLocalStorage<Record<string, unknown>>(LEGACY_LOCAL_CONFIG_KEY)
      if (legacy) {
        configTree = legacy
        await writeJsonFile(CONFIG_FILE, legacy)
      }
    }
    if (hotkeys === null) {
      const legacy =
        (await readLegacyStore<unknown>(LEGACY_HOTKEY_KEY)) ??
        readLocalStorage<unknown>(LEGACY_LOCAL_HOTKEY_KEY)
      if (legacy) {
        hotkeys = legacy
        await writeJsonFile(HOTKEY_FILE, legacy)
      }
    }
    return { configTree, hotkeys }
  } catch {
    // 私密模式下 IndexedDB 可能不可用：继续用 localStorage 回退
    if (configTree === null) configTree = readLocalStorage(LEGACY_LOCAL_CONFIG_KEY)
    if (hotkeys === null) hotkeys = readLocalStorage(LEGACY_LOCAL_HOTKEY_KEY)
    return { configTree, hotkeys }
  }
}

// --- 写穿持久化：高频 OPT_SET 合并为一次 VFS 写（250ms 去抖） --------------
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
        if (configTree !== null) await writeJsonFile(CONFIG_FILE, configTree)
        if (hotkeys !== null) await writeJsonFile(HOTKEY_FILE, hotkeys)
      } catch {
        // VFS 不可用时 localStorage 回退已在 persist() / setActiveHotkeys 同步完成
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
