import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  detectDefaultLocale,
  loadLocale,
  parsePo,
  setLocale,
  t,
  tFmt,
  tPlain,
  tPlural,
} from './i18n'

const SAMPLE_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

#: src/command/app.cpp
msgid "&Language..."
msgstr "&语言..."

msgid "New Subtitles"
msgstr "新建字幕"

#, fuzzy
msgid "Fuzzy Entry"
msgstr "应被跳过"

#~ msgid "Obsolete"
#~ msgstr "应被跳过"

msgctxt "Menu bar"
msgid "&File"
msgstr "文件(&F)"

msgid "One item"
msgid_plural "%d items"
msgstr[0] "%d 项"
msgstr[1] "%d 项(复数)"

msgid "multi\\nline \\"quoted\\""
msgstr "多\\n行"

msgid "Menu bar"
msgstr "普通语境的菜单栏"
`

function loadSample(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(SAMPLE_PO, { status: 200 }))),
  )
}

describe('parsePo', () => {
  it('解析精确条目并剥离加速键生成 loose 回退索引', () => {
    const catalog = parsePo(SAMPLE_PO)
    expect(catalog.exact.get('&Language...')?.forms[0]).toBe('&语言...')
    // 去 & 回退索引：msgid 含 & 而调用方传去 & 的形式
    expect(catalog.exact.has('Language...')).toBe(false)
    expect(catalog.loose.has('Language...')).toBe(true)
  })

  it('解析 msgctxt 条目（ctx \\u0004 msgid 键）', () => {
    const catalog = parsePo(SAMPLE_PO)
    expect(catalog.exact.get('Menu bar\u0004&File')?.forms[0]).toBe('文件(&F)')
  })

  it('跳过 fuzzy 与过时 #~ 条目', () => {
    const catalog = parsePo(SAMPLE_PO)
    expect(catalog.exact.has('Fuzzy Entry')).toBe(false)
    expect(catalog.exact.has('Obsolete')).toBe(false)
  })

  it('解析复数形式与多行转义', () => {
    const catalog = parsePo(SAMPLE_PO)
    const plural = catalog.exact.get('One item')
    expect(plural?.plural).toBe('%d items')
    expect(plural?.forms).toEqual(['%d 项', '%d 项(复数)'])
    expect(catalog.exact.get('multi\nline "quoted"')?.forms[0]).toBe('多\n行')
  })

  it('解析 header（Plural-Forms）', () => {
    const catalog = parsePo(SAMPLE_PO)
    expect(catalog.headers.get('Plural-Forms')).toBe('nplurals=2; plural=(n != 1);')
  })
})

describe('查询入口（需已加载语言）', () => {
  beforeEach(() => {
    loadSample()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('t()：精确 → loose 回退 → 原样', async () => {
    await setLocale('test')
    expect(t('New Subtitles')).toBe('新建字幕')
    expect(t('Language...')).toBe('&语言...') // loose：msgid '&Language...'
    expect(t('Not Translated')).toBe('Not Translated') // 未命中回退
    expect(t('&File', 'Menu bar')).toBe('文件(&F)')
    expect(t('Menu bar')).toBe('普通语境的菜单栏') // 无 ctx 不命中 ctx 条目
  })

  it('tPlain() 剥离加速键', async () => {
    await setLocale('test')
    expect(tPlain('Language...')).toBe('语言...')
    expect(tPlain('&File', 'Menu bar')).toBe('文件(F)')
  })

  it('tPlural() 按 Plural-Forms 取形式', async () => {
    await setLocale('test')
    expect(tPlural('One item', '%d items', 1)).toBe('%d 项')
    expect(tPlural('One item', '%d items', 3)).toBe('%d 项(复数)')
  })

  it('tFmt() 按序填充 %s/%d，%% 为字面 %', async () => {
    await setLocale('test')
    // msgid_plural 本身不是可查 msgid：tPlural 取形式后再填充占位符
    expect(tFmt(tPlural('One item', '%d items', 3), 3)).toBe('3 项(复数)')
    expect(tFmt('100%% %s', 'done')).toBe('100% done')
    // 无参数时占位符保留原样
    expect(tFmt(tPlural('One item', '%d items', 1))).toBe('%d 项')
  })
})

describe('detectDefaultLocale', () => {
  it('精确区域匹配优先', () => {
    expect(detectDefaultLocale(['zh_CN', 'zh_TW'], ['zh-TW', 'en'])).toBe('zh_TW')
    expect(detectDefaultLocale(['fr_FR'], ['fr-FR'])).toBe('fr_FR')
  })

  it('语言前缀回退（取列表第一个）', () => {
    expect(detectDefaultLocale(['zh_CN', 'zh_TW'], ['zh'])).toBe('zh_CN')
    expect(detectDefaultLocale(['fr_FR', 'de'], ['fr-CA'])).toBe('fr_FR')
  })

  it('Latn 变体特判（sr_RS@latin）', () => {
    expect(detectDefaultLocale(['sr_RS', 'sr_RS@latin'], ['sr-Latn-RS'])).toBe('sr_RS@latin')
    expect(detectDefaultLocale(['sr_RS', 'sr_RS@latin'], ['sr-RS'])).toBe('sr_RS')
  })

  it('大小写不敏感', () => {
    expect(detectDefaultLocale(['zh_CN'], ['ZH-cn'])).toBe('zh_CN')
  })

  it('无匹配返回空串', () => {
    expect(detectDefaultLocale(['zh_CN'], ['xx-YY', 'yy-ZZ'])).toBe('')
  })
})

describe('loadLocale', () => {
  beforeEach(() => {
    loadSample()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetch 失败返回 null 而不抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))),
    )
    await expect(loadLocale('missing')).resolves.toBeNull()
  })
})

describe('web 补充词典（i18nSupplement，仅 po 未命中时兜底）', () => {
  beforeEach(() => {
    // 空 po：仅头部条目（真实 zh_CN.po 由 dev middleware 从源码目录提供）
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n', {
            status: 200,
          }),
        ),
      ),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('zh_CN：wx stock/web 专属文案经补充词典命中，技术标识回退英文', async () => {
    await setLocale('zh_CN')
    expect(tPlain('OK')).toBe('确定')
    expect(tPlain('Ready')).toBe('就绪')
    expect(tPlain('PlayResX')).toBe('PlayResX')
    expect(tPlain('Not In Supplement')).toBe('Not In Supplement')
  })
})
