/**
 * Aegisub 默认快捷键数据（default_hotkey.json 原样导入）。
 *
 * 结构：{ "上下文名": { "命令名": [ "按键", ... ] } }
 * 上下文与 src/ui/commands.ts 的 ShortcutContext 完全一致：
 *   Always / Default / Subtitle Grid / Subtitle Edit Box / Video / Audio
 *   / Styling Assistant / Translation Assistant
 */
import type { ShortcutContext } from './commands';
import hotkeyData from './aegisub-data/default_hotkey.json';

export type HotkeyMap = Partial<Record<ShortcutContext, Record<string, string[]>>>;

export const AEGISUB_HOTKEYS: HotkeyMap = hotkeyData as unknown as HotkeyMap;

/** 取命令在指定上下文的首个快捷键 */
export function aegisubPrimaryShortcut(commandId: string, context: ShortcutContext = 'Default'): string {
  return AEGISUB_HOTKEYS[context]?.[commandId]?.[0] ?? '';
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
  const contexts: ShortcutContext[] = context === 'Default' ? ['Default'] : [context, 'Default'];
  for (const candidateContext of contexts) {
    const map = AEGISUB_HOTKEYS[candidateContext];
    if (!map) continue;
    for (const [id, keys] of Object.entries(map)) {
      if (keys.includes(shortcut)) return id;
    }
  }
  return fallback ? fallback(shortcut, context) : null;
}
