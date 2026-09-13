import toolbarData from './aegisub-data/default_toolbar.json'
/**
 * 从 Aegisub 的 `default_toolbar.json` 构建工具栏。
 *
 * 数据格式：{ "工具栏名": [ "cmd/id", "", "cmd/id", ... ] }，空字符串为分组分隔符。
 * 图标：见 aegisubIcons.ts 的 COMMAND_ICONS 映射。
 * 尺寸：默认 16px（Aegisub `App/Toolbar Icon Size = 16`）。
 */
import { commandIcon } from './aegisubIcons'

export interface ToolbarButton {
  command: string
  icon?: string
}

export interface ToolbarGroup {
  buttons: ToolbarButton[]
}

const ICON_SIZE = 16

function buildToolbars(): Record<string, ToolbarGroup[]> {
  const raw = toolbarData as unknown as Record<string, string[]>
  const result: Record<string, ToolbarGroup[]> = {}
  for (const [name, list] of Object.entries(raw)) {
    const groups: ToolbarGroup[] = []
    let current: ToolbarButton[] = []
    for (const entry of list) {
      if (entry === '') {
        if (current.length) {
          groups.push({ buttons: current })
          current = []
        }
      } else {
        current.push({ command: entry, icon: commandIcon(entry, ICON_SIZE) })
      }
    }
    if (current.length) groups.push({ buttons: current })
    result[name] = groups
  }
  return result
}

export const AEGISUB_TOOLBARS: Record<string, ToolbarGroup[]> = buildToolbars()

/** 主工具栏按钮组（Aegisub 主窗口工具栏） */
export const MAIN_TOOLBAR = AEGISUB_TOOLBARS['main'] ?? []
