import { notifyOptionsChanged } from '../config/options'
import { persistHotkeyJson } from '../storage/configStore'
import hotkeyData from './aegisub-data/default_hotkey.json'
/**
 * Aegisub 默认快捷键数据（default_hotkey.json 原样导入）。
 *
 * 结构：{ "上下文名": { "命令名": [ "按键", ... ] } }
 * 上下文与 src/ui/commands.ts 的 ShortcutContext 完全一致：
 *   Always / Default / Subtitle Grid / Subtitle Edit Box / Video / Audio
 *   / Styling Assistant / Translation Assistant
 *
 * 用户自定义（Preferences → Interface → Hotkeys，对应 hotkey_data_view_model +
 * hotkey.json）整体替换默认表并持久化到 IndexedDB（localStorage 为同步回退）。
 * 注意源码语义：?user/hotkey.json 存在时整表替换默认表（json_util::file 不合并）。
 */
import type { ShortcutContext } from './commands'

export type HotkeyMap = Partial<Record<ShortcutContext, Record<string, string[]>>>

export const AEGISUB_HOTKEYS: HotkeyMap = hotkeyData as unknown as HotkeyMap

const STORAGE_KEY = 'aegisub-web:hotkeys'

let activeMap: HotkeyMap = AEGISUB_HOTKEYS

function loadStored(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) activeMap = JSON.parse(raw) as HotkeyMap
  } catch {
    // 损坏的自定义表直接回退默认
  }
}
loadStored()

/** 当前生效的热键表（默认表或用户自定义） */
export function getActiveHotkeys(): HotkeyMap {
  return activeMap
}

/** 整表替换（Preferences::OnApply → hotkey::inst->SetHotkeyMap → Flush） */
export function setActiveHotkeys(map: HotkeyMap): void {
  activeMap = map
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage 不可用时仅内存生效
  }
  // IndexedDB 持久化（hotkey.json 对应物），失败静默降级
  persistHotkeyJson(map)
  notifyOptionsChanged()
}

/** 恢复默认热键（Preferences::OnResetDefault） */
export function resetHotkeys(): void {
  setActiveHotkeys(AEGISUB_HOTKEYS)
}

// ---------------------------------------------------------------------------
// hotkey.json 导入导出（与 Aegisub 桌面版 ?user/hotkey.json 互相兼容）
// ---------------------------------------------------------------------------

/** 旧版热键条目（hotkey.cpp hotkey_visitor：{ "modifiers": [...], "key": "..." }） */
interface LegacyHotkeyEntry {
  modifiers?: string[]
  key?: string
}

function normalizeHotkeyEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const legacy = entry as LegacyHotkeyEntry
    // 源码：缺 modifiers 或缺 key 的条目均 LOG_E 跳过
    if (typeof legacy.key === 'string' && Array.isArray(legacy.modifiers)) {
      const modifiers = legacy.modifiers
      return `${modifiers.join('-')}${modifiers.length > 0 ? '-' : ''}${legacy.key}`
    }
  }
  return null
}

/** 导出为源码 hotkey.json 格式（Hotkey::Flush：{"上下文": {"命令": ["按键"]}}） */
export function serializeHotkeyJson(): string {
  return `${JSON.stringify(activeMap, null, 2)}\n`
}

/**
 * 导入 hotkey.json（源码新版字符串数组或旧版 {modifiers,key} 结构均可），
 * 整表替换当前热键（json_util::file 的替换语义）。返回导入的组合键数量。
 */
export function importHotkeyJson(text: string): number {
  const parsed = JSON.parse(text) as Record<string, Record<string, unknown[]>>
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid hotkey file')
  let combos = 0
  const map: HotkeyMap = {}
  for (const [context, commands] of Object.entries(parsed)) {
    if (commands === null || typeof commands !== 'object' || Array.isArray(commands)) continue
    const contextMap: Record<string, string[]> = {}
    for (const [command, entries] of Object.entries(commands)) {
      if (!Array.isArray(entries)) continue
      const keys = entries.map(normalizeHotkeyEntry).filter((key): key is string => key !== null)
      if (keys.length > 0) {
        contextMap[command] = keys
        combos += keys.length
      }
    }
    if (Object.keys(contextMap).length > 0) map[context as ShortcutContext] = contextMap
  }
  setActiveHotkeys(map)
  return combos
}

/** 取命令在指定上下文的首个快捷键 */
export function aegisubPrimaryShortcut(
  commandId: string,
  context: ShortcutContext = 'Default',
): string {
  return activeMap[context]?.[commandId]?.[0] ?? ''
}

/**
 * 按 libaegisub Hotkey::Scan 的默认优先级查找命令：
 * 指定上下文 → Default。Always 仅在 Medusa Timing Hotkeys 开启时参与，默认关闭。
 */
export function aegisubCommandForShortcut(
  shortcut: string,
  context: ShortcutContext,
  fallback?: (shortcut: string, context: ShortcutContext) => string | null,
): string | null {
  const contexts: ShortcutContext[] = context === 'Default' ? ['Default'] : [context, 'Default']
  for (const candidateContext of contexts) {
    const map = activeMap[candidateContext]
    if (!map) continue
    for (const [id, keys] of Object.entries(map)) {
      if (keys.includes(shortcut)) return id
    }
  }
  return fallback ? fallback(shortcut, context) : null
}
