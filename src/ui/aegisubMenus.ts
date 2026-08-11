/**
 * 从 Aegisub 的 `default_menu.json` + `default_menu_platform.json` 构建 React 菜单结构。
 *
 * Aegisub 的菜单数据格式：
 *   { "菜单名": [ 菜单项... ] }
 * 菜单项：
 *   { "command": "cmd/id" }            → 命令（文本取命令注册表）
 *   { "command": "cmd", "text": "..." } → 命令（覆盖显示文本）
 *   { "submenu": "菜单名", "text": "..." } → 子菜单
 *   { "recent": "Type" }               → 最近文件菜单（Web 版暂不支持，禁用显示）
 *   {}                                  → 分隔符
 *   { "special": "..." }               → 特殊项（options/about/exit/automation 等）
 *
 * 平台文件（default_menu_platform.json）覆盖顶层 main/main/file/main/edit。
 */
import { COMMANDS, type MenuDefinition, type MenuItemDefinition } from './commands';
import menuData from './aegisub-data/default_menu.json';
import platformData from './aegisub-data/default_menu_platform.json';

interface RawMenuItem {
  command?: string;
  submenu?: string;
  recent?: string;
  special?: string;
  text?: string;
  tlcontext?: string;
}

type RawMenuMap = Record<string, RawMenuItem[]>;

function stripAccess(label: string): { label: string; accessKey?: string } {
  const match = label.match(/&(.)/);
  if (!match) return { label: label.replace(/&/g, '').trim() };
  return { label: label.replace('&', '').trim(), accessKey: match[1].toLowerCase() };
}

function labelFor(item: RawMenuItem): string {
  if (item.text) return item.text;
  if (item.command) return COMMANDS[item.command]?.label ?? item.command;
  if (item.recent) return `Recent ${item.recent}`;
  return '';
}

function convertItem(item: RawMenuItem, menus: RawMenuMap): MenuItemDefinition {
  if (item.command)
    return {
      command: item.command,
      label: item.text ? stripAccess(item.text).label : (COMMANDS[item.command]?.label ?? item.command),
    };
  if (item.submenu && menus[item.submenu])
    return {
      submenu: {
        id: item.submenu,
        label: stripAccess(labelFor(item)).label,
        items: convertItems(menus[item.submenu], menus),
      },
    };
  if (item.recent) return { label: `Recent ${item.recent}`, disabled: true };
  if (item.special === 'about') return { command: 'app/about', label: 'About Aegisub...' };
  if (item.special === 'options') return { command: 'app/options', label: 'Options...' };
  if (item.special === 'exit') return { command: 'app/exit', label: 'Exit' };
  if (item.special === 'help') return { command: 'help/contents', label: 'Help' };
  return { separator: true };
}

function convertItems(items: RawMenuItem[], menus: RawMenuMap): MenuItemDefinition[] {
  return items.map((item) => convertItem(item, menus));
}

function buildMenus(): MenuDefinition[] {
  const raw = menuData as unknown as RawMenuMap;
  const platform = platformData as unknown as RawMenuMap;

  // 平台文件优先（main / main/file / main/edit 在默认文件里是占位符）
  const merged: RawMenuMap = { ...raw, ...platform };

  const top = merged['main'];
  if (!top) return [];

  const menus: MenuDefinition[] = [];
  for (const item of top) {
    if (item.submenu && merged[item.submenu]) {
      const { label, accessKey } = stripAccess(labelFor(item));
      menus.push({
        id: item.submenu,
        label,
        accessKey: accessKey ?? '',
        items: convertItems(merged[item.submenu], merged),
      });
    } else if (item.special === 'automation') {
      menus.push({
        id: 'automation',
        label: 'Automation',
        accessKey: 'u',
        items: [{ label: 'No Automation scripts loaded', disabled: true }],
      });
    } else if (item.command) {
      const { label, accessKey } = stripAccess(labelFor(item));
      menus.push({ id: item.command, label, accessKey: accessKey ?? '', items: [] });
    }
  }
  return menus;
}

export const AEGISUB_MENUS: MenuDefinition[] = buildMenus();

/** 网格右键菜单（default_menu.json 的 grid_context） */
export const AEGISUB_GRID_CONTEXT: MenuItemDefinition[] = (() => {
  const raw = menuData as unknown as RawMenuMap;
  const list = raw['grid_context'];
  return list ? convertItems(list, raw) : [];
})();
