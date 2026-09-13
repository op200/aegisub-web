/**
 * 热键导入导出测试（la/common/hotkey.cpp 语义：整表替换、旧版 {modifiers,key} 迁移）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getActiveHotkeys,
  importHotkeyJson,
  resetHotkeys,
  serializeHotkeyJson,
} from './aegisubHotkeys'

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  resetHotkeys()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hotkey.json 导入导出', () => {
  it('新版格式整表替换（json_util::file 的替换语义，不与默认表合并）', () => {
    const combos = importHotkeyJson(
      JSON.stringify({
        Default: { 'subtitle/save': ['Ctrl-S', 'Ctrl-Shift-S'] },
        Video: { 'video/frame/next': ['Right'] },
      }),
    )
    expect(combos).toBe(3)
    expect(getActiveHotkeys().Default?.['subtitle/save']).toEqual(['Ctrl-S', 'Ctrl-Shift-S'])
    expect(getActiveHotkeys().Video?.['video/frame/next']).toEqual(['Right'])
    // 整表替换后默认表其余条目不再存在
    expect(getActiveHotkeys().Default?.['subtitle/undo']).toBeUndefined()
  })

  it('旧版 {modifiers, key} 结构转换为 Mod-Key 字符串（hotkey.cpp hotkey_visitor）', () => {
    importHotkeyJson(
      JSON.stringify({
        Default: { 'subtitle/save': [{ modifiers: ['Ctrl'], key: 'x' }, 'Ctrl-Shift-S'] },
      }),
    )
    expect(getActiveHotkeys().Default?.['subtitle/save']).toEqual(['Ctrl-x', 'Ctrl-Shift-S'])
  })

  it('缺 modifiers/key 的旧版条目跳过（源码 LOG_E 语义）', () => {
    importHotkeyJson(JSON.stringify({ Default: { 'subtitle/save': [{ key: 'x' }, 'Ctrl-S'] } }))
    expect(getActiveHotkeys().Default?.['subtitle/save']).toEqual(['Ctrl-S'])
  })

  it('serializeHotkeyJson 导出与导入往返一致', () => {
    importHotkeyJson(JSON.stringify({ Default: { 'subtitle/save': ['Ctrl-S'] } }))
    const exported = JSON.parse(serializeHotkeyJson()) as Record<string, Record<string, string[]>>
    expect(exported.Default['subtitle/save']).toEqual(['Ctrl-S'])
    expect(Object.keys(exported)).toEqual(['Default'])
  })

  it('非对象根抛错', () => {
    expect(() => importHotkeyJson('[1,2]')).toThrow(/Invalid hotkey file/)
    expect(() => importHotkeyJson('not json')).toThrow()
  })
})
