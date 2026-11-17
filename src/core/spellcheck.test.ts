import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  language: 'en_US',
}))

vi.mock('../storage/vfs', () => ({
  VFS_DIRS: { dictionaries: '/dictionaries' },
  listDir: async (dir: string) =>
    [...state.files.keys()]
      .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map((path) => ({ name: path.slice(dir.length + 1), directory: false })),
  readBytes: async (path: string) => {
    const text = state.files.get(path)
    return text === undefined ? null : new TextEncoder().encode(text)
  },
  readTextFile: async (path: string) => state.files.get(path) ?? null,
  writeTextFile: async (path: string, text: string) => {
    state.files.set(path, text)
  },
}))

vi.mock('../config/options', () => ({
  getOptionString: (name: string) => (name === 'Tool/Spell Checker/Language' ? state.language : ''),
  getOptionBool: () => false,
  setOption: () => {},
}))

import {
  addWordToDictionary,
  canAddWord,
  canRemoveWord,
  ensureSpellCheckerLoaded,
  getSpellCheckerLanguages,
  isSpellCheckerLoaded,
  reloadSpellChecker,
  removeWordFromDictionary,
  spellCheckWord,
  spellSuggestions,
} from './spellcheck'

const AFF = `SET UTF-8
SFX S Y 1
SFX S y ies [^aeiou]y
PFX U Y 1
PFX U 0 un .
`

const DIC = `3
carry/S
happy/U
do/U
`

describe('spellcheck (hunspell 子集)', () => {
  beforeEach(async () => {
    state.files.clear()
    state.language = 'en_US'
    state.files.set('/dictionaries/en_US.aff', AFF)
    state.files.set('/dictionaries/en_US.dic', DIC)
    await reloadSpellChecker()
  })

  it('扫描语言并加载词库', async () => {
    expect(getSpellCheckerLanguages()).toEqual(['en_US'])
    expect(isSpellCheckerLoaded()).toBe(true)
  })

  it('基础词、大小写、词缀与连字符', () => {
    expect(spellCheckWord('carry')).toBe(true)
    expect(spellCheckWord('Carry')).toBe(true)
    expect(spellCheckWord('CARRY')).toBe(true)
    expect(spellCheckWord('carries')).toBe(true)
    expect(spellCheckWord('undo')).toBe(true)
    expect(spellCheckWord('unhappy')).toBe(true)
    expect(spellCheckWord('carry-unhappy')).toBe(true)
    expect(spellCheckWord('carryy')).toBe(false)
    expect(spellCheckWord('12345')).toBe(true)
  })

  it('建议按编辑距离排序', () => {
    const suggestions = spellSuggestions('carryy')
    expect(suggestions[0]).toBe('carry')
  })

  it('添加/移除用户词并写入 user_*.dic', async () => {
    expect(canAddWord('Aegisub')).toBe(true)
    expect(canRemoveWord('Aegisub')).toBe(false)
    await addWordToDictionary('Aegisub')
    expect(spellCheckWord('Aegisub')).toBe(true)
    expect(canRemoveWord('aegisub')).toBe(true)
    expect(state.files.get('/dictionaries/user_en_US.dic')).toContain('aegisub')

    await removeWordFromDictionary('Aegisub')
    expect(spellCheckWord('Aegisub')).toBe(false)
    expect(state.files.get('/dictionaries/user_en_US.dic')).not.toContain('aegisub')
  })

  it('语言禁用后不再检查', async () => {
    state.language = ''
    await ensureSpellCheckerLoaded()
    // 语言为空 → 未加载，spellCheckWord 恒为 true
    expect(isSpellCheckerLoaded()).toBe(false)
    expect(spellCheckWord('definitelymisspelled')).toBe(true)
  })
})
