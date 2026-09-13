import menuData from './aegisub-data/default_menu.json'
import platformData from './aegisub-data/default_menu_platform.json'
/**
 * 从 Aegisub 的 `default_menu.json` + `default_menu_platform.json` 构建 React 菜单结构。
 *
 * Aegisub 的菜单数据格式：
 *   { "菜单名": [ 菜单项... ] }
 * 菜单项：
 *   { "command": "cmd/id" }            → 命令（文本取命令注册表）
 *   { "command": "cmd", "text": "..." } → 命令（覆盖显示文本）
 *   { "submenu": "菜单名", "text": "..." } → 子菜单
 *   { "recent": "Type" }               → 最近文件菜单（MRU 子菜单，标题 "&Recent"）
 *   {}                                  → 分隔符
 *   { "special": "..." }               → 特殊项（options/about/exit/automation 等）
 *
 * 平台文件（default_menu_platform.json）覆盖顶层 main/main/file/main/edit。
 *
 * 本地化：json 的 text 与命令 label/help 均为 po msgid（tlcontext 对应 msgctxt），
 * 经 src/ui/i18n.ts 查表翻译；结构按当前语言缓存，语言切换后自动重建。
 */
import { COMMANDS, type MenuDefinition, type MenuItemDefinition } from './commands'
import { getLocale, t } from './i18n'

interface RawMenuItem {
  command?: string
  submenu?: string
  recent?: string
  special?: string
  text?: string
  tlcontext?: string
}

type RawMenuMap = Record<string, RawMenuItem[]>

function stripAccess(label: string): { label: string; accessKey?: string } {
  const match = label.match(/&(.)/)
  if (!match) return { label: label.replace(/&/g, '').trim() }
  return { label: label.replace('&', '').trim(), accessKey: match[1].toLowerCase() }
}

function labelFor(item: RawMenuItem): string {
  if (item.text) return t(item.text, item.tlcontext)
  // COMMANDS label 是源码 STR_MENU 去 & 后的形式，i18n loose 索引负责回退命中
  if (item.command) return t(COMMANDS[item.command]?.label ?? item.command)
  // menu.cpp AddRecent：MRU 子菜单标题固定为 "&Recent"（JSON 里的 text 不生效）
  if (item.recent) return t('&Recent')
  return ''
}

function convertItem(item: RawMenuItem, menus: RawMenuMap): MenuItemDefinition {
  if (item.command)
    return {
      command: item.command,
      label: item.text
        ? stripAccess(t(item.text, item.tlcontext)).label
        : t(COMMANDS[item.command]?.label ?? item.command),
    }
  if (item.submenu && menus[item.submenu])
    return {
      submenu: {
        id: item.submenu,
        label: stripAccess(labelFor(item)).label,
        items: convertItems(menus[item.submenu], menus),
      },
    }
  // menu.cpp AddRecent：MRU 子菜单标题固定为 "&Recent"；内容由 MenuBar 按最近文件动态渲染
  if (item.recent) return { recent: item.recent, label: t('&Recent') }
  if (item.special === 'about')
    return { command: 'app/about', label: t(COMMANDS['app/about'].label) }
  if (item.special === 'options')
    return { command: 'app/options', label: t(COMMANDS['app/options'].label) }
  if (item.special === 'exit') return { command: 'app/exit', label: t(COMMANDS['app/exit'].label) }
  if (item.special === 'help')
    return { command: 'help/contents', label: t(COMMANDS['help/contents'].label) }
  return { separator: true }
}

function convertItems(items: RawMenuItem[], menus: RawMenuMap): MenuItemDefinition[] {
  return items.map((item) => convertItem(item, menus))
}

function buildMenus(): MenuDefinition[] {
  const raw = menuData as unknown as RawMenuMap
  const platform = platformData as unknown as RawMenuMap

  // 平台文件优先（main / main/file / main/edit 在默认文件里是占位符）
  const merged: RawMenuMap = { ...raw, ...platform }

  const top = merged['main']
  if (!top) return []

  const menus: MenuDefinition[] = []
  for (const item of top) {
    if (item.submenu && merged[item.submenu]) {
      // 顶层菜单名：json 带 tlcontext "Menu bar"，对应 pot 的 msgctxt（"&File" 等）
      const { label, accessKey } = stripAccess(
        item.text ? t(item.text, item.tlcontext) : labelFor(item),
      )
      menus.push({
        id: item.submenu,
        label,
        accessKey: accessKey ?? '',
        items: convertItems(merged[item.submenu], merged),
      })
    } else if (item.special === 'automation') {
      // menu.cpp AutomationMenu：am/meta + 分隔符 + 宏列表（无宏时显示禁用提示）
      menus.push({
        id: 'automation',
        label: stripAccess(t('Automation', item.tlcontext)).label,
        accessKey: 'u',
        items: [
          { command: 'am/meta', label: t(COMMANDS['am/meta'].label) },
          { separator: true },
          { label: t('No Automation macros loaded'), disabled: true },
        ],
      })
    } else if (item.command) {
      const { label, accessKey } = stripAccess(labelFor(item))
      menus.push({ id: item.command, label, accessKey: accessKey ?? '', items: [] })
    }
  }
  return menus
}

// 按当前语言缓存（语言切换后首次访问自动重建）
let cacheLocale: string | null = null
let menusCache: MenuDefinition[] | null = null
let gridContextCache: MenuItemDefinition[] | null = null
let videoContextCache: MenuItemDefinition[] | null = null

function ensureCache(): void {
  const locale = getLocale()
  if (menusCache && cacheLocale === locale) return
  const raw = menuData as unknown as RawMenuMap
  menusCache = buildMenus()
  const grid = raw['grid_context']
  const video = raw['video_context']
  gridContextCache = grid ? convertItems(grid, raw) : []
  videoContextCache = video ? convertItems(video, raw) : []
  cacheLocale = locale
}

/** 主菜单（当前语言） */
export function getAegisubMenus(): MenuDefinition[] {
  ensureCache()
  return menusCache!
}

/** 网格右键菜单（default_menu.json 的 grid_context，当前语言） */
export function getGridContext(): MenuItemDefinition[] {
  ensureCache()
  return gridContextCache!
}

/** 视频显示区右键菜单（default_menu.json 的 video_context，当前语言） */
export function getVideoContext(): MenuItemDefinition[] {
  ensureCache()
  return videoContextCache!
}

/**
 * menu.cpp AutomationMenu::Regenerate：宏名按 "/" 分段生成嵌套子菜单并排序。
 * 宏名是用户内容，不参与翻译。
 */
export function groupMacroMenuItems(macros: { id: string; name: string }[]): MenuItemDefinition[] {
  interface Node {
    children: Map<string, Node>
    macro?: { id: string; name: string }
  }
  const root: Node = { children: new Map() }
  for (const macro of macros) {
    const segments = macro.name.split('/')
    let node = root
    segments.forEach((segment, index) => {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map() })
      node = node.children.get(segment)!
      if (index === segments.length - 1) node.macro = macro
    })
  }
  const build = (node: Node): MenuItemDefinition[] => {
    const items: MenuItemDefinition[] = []
    const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))
    for (const [segment, child] of sortedChildren) {
      if (child.children.size > 0) {
        items.push({
          submenu: {
            id: `automation-sub:${segment}:${child.macro?.id ?? ''}`,
            label: segment,
            items: build(child),
          },
        })
      } else if (child.macro) {
        items.push({ command: child.macro.id, label: segment })
      }
    }
    return items
  }
  return build(root)
}
