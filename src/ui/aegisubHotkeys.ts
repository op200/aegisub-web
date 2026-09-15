import { notifyOptionsChanged, getOptionBool } from '../config/options'
import { persistHotkeyJson } from '../storage/configStore'
import hotkeyData from './aegisub-data/default_hotkey.json'
/**
 * Aegisub 默认快捷键数据（default_hotkey.json 原样导入）。
 *
 * 结构：{ "上下文名": { "命令名": [ "按键", ... ] } }
 * 上下文与 src/ui/commands.ts 的 ShortcutContext 完全一致：
 *   Always / Main Frame / Default / Subtitle Grid / Subtitle Edit Box / Video
 *   / Audio / Styling Assistant / Translation Assistant
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
 * 焦点上下文的快捷键查找链（对齐源码 wx 按键事件沿窗口树向上传播）：
 *
 * - base_grid.cpp OnCharHook：先查 "Subtitle Grid"，非方向键再查 "Audio"
 *   （网格聚焦时音频热键可用，方向键留给网格移动）
 * - subs_edit_box.cpp OnKeyDown：查 "Subtitle Edit Box"
 * - audio_display.cpp OnKeyDown：查 "Audio"
 * - video_display.cpp / video_slider.cpp：查 "Video"
 * - frame_main.cpp OnKeyDown：最后查 "Main Frame"
 * - 每级 Scan 内部都做 上下文→Default 回退（libaegisub hotkey.cpp Hotkey::Scan）
 *
 * Always 不在链内：仅在 Audio/Medusa Timing Hotkeys 开启时于所有上下文之前
 * 短路（hotkey.cpp check() 传给 Scan 的 always 标志），见 aegisubCommandForShortcut。
 */
const CONTEXT_CHAIN: Partial<Record<ShortcutContext, readonly ShortcutContext[]>> = {
  'Subtitle Grid': ['Subtitle Grid', 'Default', 'Audio', 'Main Frame'],
  'Subtitle Edit Box': ['Subtitle Edit Box', 'Default', 'Main Frame'],
  Audio: ['Audio', 'Default', 'Main Frame'],
  Video: ['Video', 'Default', 'Main Frame'],
  'Styling Assistant': ['Styling Assistant', 'Default', 'Main Frame'],
  'Translation Assistant': ['Translation Assistant', 'Default', 'Main Frame'],
}

/** 指定焦点上下文的完整查找链（按源码传播顺序，Default 回退已展开） */
export function shortcutContextChain(context: ShortcutContext): readonly ShortcutContext[] {
  return CONTEXT_CHAIN[context] ?? ['Default', 'Main Frame']
}

/** 热键表中按上下文查命令（Hotkey::Scan 的单级语义：局部上下文 → Default 已由链展开） */
function scanContext(context: ShortcutContext, shortcut: string): string | null {
  const map = activeMap[context]
  if (!map) return null
  for (const [id, keys] of Object.entries(map)) {
    if (keys.includes(shortcut)) return id
  }
  return null
}

/** 网格 OnCharHook 视为"导航键"的裸键（base_grid.cpp：这些键跳过 Audio 查询、留给网格移动） */
const GRID_NAV_SHORTCUTS = new Set(['Up', 'Down', 'PageUp', 'PageDown', 'Home', 'End'])

/**
 * 按 libaegisub Hotkey::Scan 与源码按键传播链查找命令：
 * Always（仅 Medusa Timing Hotkeys 开启，最优先短路）→ 焦点上下文链逐级 Scan。
 * 网格聚焦时裸导航键跳过 Audio 上下文（base_grid.cpp OnCharHook：留给网格滚动）。
 */
export function aegisubCommandForShortcut(
  shortcut: string,
  context: ShortcutContext,
  fallback?: (shortcut: string, context: ShortcutContext) => string | null,
): string | null {
  if (getOptionBool('Audio/Medusa Timing Hotkeys')) {
    const always = scanContext('Always', shortcut)
    if (always) return always
  }
  for (const candidateContext of shortcutContextChain(context)) {
    if (
      candidateContext === 'Audio' &&
      context === 'Subtitle Grid' &&
      GRID_NAV_SHORTCUTS.has(shortcut)
    )
      continue
    const command = scanContext(candidateContext, shortcut)
    if (command) return command
  }
  return fallback ? fallback(shortcut, context) : null
}
