/**
 * 配置存储测试（libaegisub/option.cpp 语义：默认值、类型化读写、持久化合并、恢复默认）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CONFIG,
  getOption,
  getOptionBool,
  getOptionInt,
  getOptionString,
  getOptionType,
  importConfigJson,
  isOptionDefault,
  optionNames,
  resetOption,
  resetOptions,
  serializeConfigJson,
  setOption,
} from './options'

type Store = Record<string, string>

function installLocalStorage(): Store {
  const store: Store = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
  })
  return store
}

let store: Store

beforeEach(() => {
  store = installLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('options', () => {
  it('默认值来自 default_config.json', () => {
    expect(getOptionInt('Limits/Undo Levels')).toBe(50)
    expect(getOptionInt('Audio/Lead/IN')).toBe(100)
    expect(getOptionString('Subtitle/Grid/Hide Overrides Char')).toBe('☀')
    expect(getOption<boolean>('Video/Subtitle Sync')).toBe(true)
    expect(getOptionString('Colour/Subtitle Grid/Background/Selection')).toBe('rgb(206, 255, 231)')
    expect(DEFAULT_CONFIG.Video['Default Zoom']).toBe(7)
  })

  it('类型检测与 agi::OptionType 一致', () => {
    expect(getOptionType('App/Auto/Save')).toBe('bool')
    expect(getOptionType('App/Auto/Save Every Seconds')).toBe('int')
    expect(getOptionType('Colour/Visual Tools/Shaded Area Alpha')).toBe('double')
    expect(getOptionType('Path/Screenshot')).toBe('string')
    expect(getOptionType('Colour/Audio Display/Play Cursor')).toBe('color')
    expect(getOptionType('Audio/Colour Schemes')).toBe('list-string')
  })

  it('未知选项抛错（OPT_GET 的 InternalError 语义）', () => {
    expect(() => getOption('No/Such/Option')).toThrow(/Unknown option/)
    expect(() => setOption('No/Such/Option', 1)).toThrow(/Unknown option/)
  })

  it('类型不匹配抛错', () => {
    expect(() => setOption('App/Auto/Save', 'yes')).toThrow(/Type mismatch/)
    expect(() => setOption('App/Toolbar Icon Size', 1.5)).toThrow(/Type mismatch/)
  })

  it('setOption 写值 + 持久化 + isDefault/reset 语义', () => {
    expect(isOptionDefault('Limits/MRU')).toBe(true)
    setOption('Limits/MRU', 8)
    expect(getOptionInt('Limits/MRU')).toBe(8)
    expect(isOptionDefault('Limits/MRU')).toBe(false)
    expect(JSON.parse(store['aegisub-web:config']).Limits['MRU']).toBe(8)
    resetOption('Limits/MRU')
    expect(getOptionInt('Limits/MRU')).toBe(16)
    expect(isOptionDefault('Limits/MRU')).toBe(true)
  })

  it('重复设置相同值不触发持久化', () => {
    setOption('Limits/MRU', 8)
    const raw = store['aegisub-web:config']
    setOption('Limits/MRU', 8)
    expect(store['aegisub-web:config']).toBe(raw)
  })

  it('启动时从 localStorage 合并（仅接受已知路径与类型）', async () => {
    setOption('Limits/MRU', 5)
    setOption('App/Auto/Save', false)
    // 模拟重新加载模块
    vi.resetModules()
    await import('./options')
    const { getOptionInt: nextGetInt, getOptionBool: nextGetBool } = await import('./options')
    expect(nextGetInt('Limits/MRU')).toBe(5)
    expect(nextGetBool('App/Auto/Save')).toBe(false)
  })

  it('resetOptions 批量恢复默认（Preferences::OnResetDefault）', () => {
    setOption('Limits/MRU', 4)
    setOption('Limits/Undo Levels', 10)
    setOption('Limits/Find Replace', 2)
    resetOptions(['Limits/MRU', 'Limits/Undo Levels'])
    expect(getOptionInt('Limits/MRU')).toBe(16)
    expect(getOptionInt('Limits/Undo Levels')).toBe(50)
    expect(getOptionInt('Limits/Find Replace')).toBe(2)
  })

  it('optionNames 覆盖 PreferenceDialog 引用的全部选项域', () => {
    const names = optionNames()
    for (const prefix of [
      'App/',
      'Audio/',
      'Video/',
      'Subtitle/',
      'Colour/',
      'Limits/',
      'Timing/',
      'Tool/Preferences',
    ]) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(true)
    }
  })

  it('importConfigJson 应用源码格式树（类型化数组还原为 list-string，未知项跳过）', () => {
    const applied = importConfigJson(
      JSON.stringify({
        App: { Auto: { Save: false, 'Save Every Seconds': 30 } },
        Limits: { MRU: 5 },
        Audio: { 'Colour Schemes': [{ string: 'Green' }, { string: 'Icy Blue' }] },
        Not: { In: { Defaults: 1 } },
      }),
    )
    expect(getOptionBool('App/Auto/Save')).toBe(false)
    expect(getOptionInt('App/Auto/Save Every Seconds')).toBe(30)
    expect(getOptionInt('Limits/MRU')).toBe(5)
    expect(getOption('Audio/Colour Schemes')).toEqual(['Green', 'Icy Blue'])
    expect(applied).toBe(4) // 未知项 Not/In/Defaults 不计入
  })

  it('serializeConfigJson 导出源码格式（含默认值，list-string 为 [{"string": ...}]）', () => {
    setOption('Limits/MRU', 5)
    const tree = JSON.parse(serializeConfigJson()) as Record<string, Record<string, unknown>>
    expect(tree.Limits.MRU).toBe(5)
    expect(tree.Video['Default Zoom']).toBe(7)
    expect(tree.Audio['Colour Schemes']).toEqual([{ string: 'Green' }, { string: 'Icy Blue' }])
  })

  it('importConfigJson 非法 JSON 抛错', () => {
    expect(() => importConfigJson('not json')).toThrow()
  })
})
