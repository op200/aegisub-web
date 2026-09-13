import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { RecentLists } from '../../storage/recentStore'
import { getAegisubMenus, groupMacroMenuItems } from '../aegisubMenus'
import { COMMANDS, primaryShortcut, type MenuItemDefinition } from '../commands'
import { t, tFmt, tPlain, useLocaleVersion } from '../i18n'

interface MenuBarProps {
  projectName: string
  /** 最近文件列表（menu.cpp AddRecent：MRU 子菜单） */
  recentLists: RecentLists
  /** 已加载的 Automation 宏（automation/lua/... 命令） */
  automationMacros: { id: string; name: string }[]
  /** 撤销/重做动态菜单名（edit.cpp COMMAND_DYNAMIC_NAME："Undo <描述>"） */
  undoLabel: string
  redoLabel: string
  onCommand: (id: string) => void
  isCommandEnabled: (id: string) => boolean
  isCommandChecked?: (id: string) => boolean
}

export function MenuBar({
  projectName,
  recentLists,
  automationMacros,
  undoLabel,
  redoLabel,
  onCommand,
  isCommandEnabled,
  isCommandChecked,
}: MenuBarProps) {
  // 语言版本号订阅：切换语言时触发重渲染，render 中 getAegisubMenus() 拿到新结构
  useLocaleVersion()
  const menus = getAegisubMenus()
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null)
        setOpenSubmenu(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null)
        setOpenSubmenu(null)
      }
      if (!event.altKey || event.ctrlKey || event.shiftKey) return
      const menu = getAegisubMenus().find((item) => item.accessKey === event.key.toLowerCase())
      if (menu) {
        event.preventDefault()
        setOpenMenu((current) => (current === menu.id ? null : menu.id))
        setOpenSubmenu(null)
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const closeAll = () => {
    setOpenMenu(null)
    setOpenSubmenu(null)
  }

  const renderItem = (item: MenuItemDefinition, key: string) => {
    if (item.separator) return <div className="menu-separator" role="separator" key={key} />

    // MRU 子菜单（menu.cpp AddRecent：条目 "&{序号} {文件名}"，超过 9 项无加速符；空显示禁用 "Empty"）
    if (item.recent) {
      const list = recentLists[item.recent.toLowerCase() as keyof RecentLists] ?? []
      const submenuId = `recent-${item.recent}`
      const isOpen = openSubmenu === submenuId
      const entries: MenuItemDefinition[] = list.length
        ? list.map((entry, index) => ({
            command: `recent/${item.recent!.toLowerCase()}/${index}`,
            label: `${index < 9 ? '&' : ''}${index + 1} ${entry.name}`,
          }))
        : [{ label: t('Empty'), disabled: true }]
      return (
        <div
          className={`menu-item menu-submenu${isOpen ? ' open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          key={key}
          onPointerEnter={() => setOpenSubmenu(submenuId)}
        >
          <span className="menu-check" />
          <span className="menu-label">{item.label ?? 'Recent'}</span>
          <span />
          <ChevronRight size={13} />
          {isOpen && (
            <div
              className="menu-popup menu-popup-sub"
              role="menu"
              aria-label={item.label ?? 'Recent'}
            >
              {entries.map((entry, index) => renderItem(entry, entry.command ?? `recent-${index}`))}
            </div>
          )}
        </div>
      )
    }

    if (item.submenu) {
      const isOpen = openSubmenu === item.submenu.id
      return (
        <div
          className={`menu-item menu-submenu${isOpen ? ' open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          key={key}
          onPointerEnter={() => setOpenSubmenu(item.submenu!.id)}
        >
          <span className="menu-check" />
          <span className="menu-label">{item.submenu.label}</span>
          <span />
          <ChevronRight size={13} />
          {isOpen && (
            <div className="menu-popup menu-popup-sub" role="menu" aria-label={item.submenu.label}>
              {item.submenu.items.map((sub, index) =>
                renderItem(sub, sub.command ?? sub.submenu?.id ?? `sub-${index}`),
              )}
            </div>
          )}
        </div>
      )
    }

    if (!item.command)
      return (
        <button className="menu-item" role="menuitem" disabled key={key}>
          <span className="menu-check" />
          <span className="menu-label">{item.label}</span>
        </button>
      )

    const enabled = !item.disabled && isCommandEnabled(item.command)
    const checked = isCommandChecked?.(item.command) ?? false
    // app/toggle/toolbar 是 COMMAND_DYNAMIC_NAME：菜单文本随状态变化；
    // edit/undo、edit/redo 同为动态名："Undo <上次操作描述>"（edit.cpp GetUndoDescription）
    const label =
      item.command === 'app/toggle/toolbar'
        ? tPlain(checked ? 'Hide Toolbar' : 'Show Toolbar')
        : item.command === 'edit/undo'
          ? undoLabel
            ? tFmt('Undo %s', undoLabel)
            : (item.label ?? t(COMMANDS[item.command]?.label ?? item.command))
          : item.command === 'edit/redo'
            ? redoLabel
              ? tFmt('Redo %s', redoLabel)
              : (item.label ?? t(COMMANDS[item.command]?.label ?? item.command))
            : (item.label ?? t(COMMANDS[item.command]?.label ?? item.command))
    return (
      <button
        className="menu-item"
        role="menuitem"
        disabled={!enabled}
        key={key}
        onClick={() => {
          closeAll()
          onCommand(item.command!)
        }}
      >
        <span className="menu-check">{checked ? <Check size={13} /> : null}</span>
        <span className="menu-label">{label}</span>
        <span className="menu-shortcut">{primaryShortcut(item.command)}</span>
        <span />
      </button>
    )
  }

  return (
    <nav className="menu-bar" aria-label="Application menu" ref={rootRef}>
      <div className="menu-list" role="menubar">
        {menus.map((menu) => {
          // Automation 菜单动态重建（menu.cpp AutomationMenu::Regenerate）
          const items =
            menu.id === 'automation'
              ? [
                  { command: 'am/meta', label: t(COMMANDS['am/meta'].label) },
                  { separator: true },
                  ...(automationMacros.length
                    ? groupMacroMenuItems(automationMacros)
                    : [{ label: t('No Automation macros loaded'), disabled: true }]),
                ]
              : menu.items
          return (
            <div className="menu-root" key={menu.id}>
              <button
                className={`menu-trigger${openMenu === menu.id ? ' open' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openMenu === menu.id}
                onClick={() => {
                  setOpenMenu((current) => (current === menu.id ? null : menu.id))
                  setOpenSubmenu(null)
                }}
                onPointerEnter={() => {
                  if (openMenu) {
                    setOpenMenu(menu.id)
                    setOpenSubmenu(null)
                  }
                }}
              >
                {menu.label}
              </button>
              {openMenu === menu.id && (
                <div className="menu-popup" role="menu" aria-label={menu.label}>
                  {items.map((item, index) =>
                    renderItem(item, item.command ?? item.submenu?.id ?? `item-${index}`),
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="menu-project" title={projectName}>
        {projectName} - Aegisub Web
      </div>
    </nav>
  )
}
