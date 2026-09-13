/**
 * 多语言运行时（对应 Aegisub 的 gettext 本地化：src/locale.cpp + po/*.po）。
 *
 * po 文件不复制，直接引用源码目录 Aegisub/po：
 *   - dev：vite middleware 把 /locales/* 映射到 Aegisub/po/*（见 vite.config.ts）
 *   - build：构建时从 Aegisub/po 原样 emit 到 dist/locales/（仓库内零副本）
 * 运行时按需 fetch 单个 po（约 200KB）解析为内存目录，未命中时回退英文源串。
 *
 * 与源码的对应关系：
 *   - _(msg)            → t(msgid)
 *   - pgettext          → t(msgid, ctx)（pot 中 msgctxt，如 "Menu bar"）
 *   - ngettext          → tPlural(msgid, msgidPlural, n)
 *   - wxString::Format  → tFmt（%s/%d/%i/%u 按序填充，%% 字面 %）
 * 命令 label/help（STR_MENU/STR_HELP）与 default_menu.json 的 text/tlcontext
 * 均为 pot 的 msgid，可直接查表；Aegisub 侧含 & 加速键而 web 侧已剥离，
 * 查询先精确匹配、再按"去 &"回退索引（loose）。
 */
import { useSyncExternalStore } from 'react'

import linguasRaw from '../../Aegisub/po/LINGUAS?raw'
import { getOptionString, setOption } from '../config/options'

// ---------------------------------------------------------------------------
// po 解析
// ---------------------------------------------------------------------------

interface PoEntry {
  msgid: string
  plural?: string
  forms: string[]
}

interface Catalog {
  headers: Map<string, string>
  /** 精确索引：键 = ctx \u0004 msgid（无 ctx 即 msgid） */
  exact: Map<string, PoEntry>
  /** 去加速键回退索引：键 = 去键去 &（用于 COMMANDS label 无 & 而 msgid 含 & 的情况） */
  loose: Map<string, PoEntry>
}

/** po 字符串字面量转义（\n \t \r \" \\） */
function unescapePo(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default:
        return c
    }
  })
}

/** 解析整个 po 文本（标准 GNU gettext 格式；fuzzy 与过时 #~ 条目跳过） */
export function parsePo(text: string): Catalog {
  const catalog: Catalog = { headers: new Map(), exact: new Map(), loose: new Map() }
  let msgctxt = ''
  let msgid = ''
  let msgidPlural: string | null = null
  const msgstr: string[] = []
  let lastForm = -1
  let fuzzy = false
  let inHeader = false

  const flush = () => {
    if (inHeader && msgid === '') {
      // 头部条目：msgid "" + msgstr 多行合并为 header 字段
      const headerText = msgstr.join('\n')
      for (const line of headerText.split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) catalog.headers.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
      }
    } else if (msgid !== '' || msgidPlural !== null) {
      if (!fuzzy && msgstr.some((s) => s !== '')) {
        const entry: PoEntry = {
          msgid,
          plural: msgidPlural ?? undefined,
          // 复制数组：flush 末尾会清空 msgstr，entry 不能持有同一引用
          forms: msgidPlural === null ? [msgstr[0] ?? ''] : [...msgstr],
        }
        const key = msgctxt ? `${msgctxt}\u0004${msgid}` : msgid
        catalog.exact.set(key, entry)
        const stripped = msgid.replace(/&/g, '')
        if (stripped !== msgid) {
          const looseKey = msgctxt ? `${msgctxt}\u0004${stripped}` : stripped
          if (!catalog.loose.has(looseKey)) catalog.loose.set(looseKey, entry)
        }
      }
    }
    msgctxt = ''
    msgid = ''
    msgidPlural = null
    msgstr.length = 0
    lastForm = -1
    fuzzy = false
    inHeader = false
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') {
      // 空行 = 条目结束（仅当已收集内容）
      if (msgid !== '' || msgidPlural !== null || msgstr.length) flush()
      continue
    }
    if (line.startsWith('#~')) continue
    if (line.startsWith('#')) {
      // 条目级 flags：#, fuzzy / #, fuzzy, c-format
      if (/^#[,\s]*fuzzy/.test(line)) fuzzy = true
      continue
    }
    const kv = line.match(/^(msgid_plural|msgid|msgstr\[(\d+)\]|msgstr|msgctxt)\s+"(.*)"\s*$/)
    if (!kv) {
      // 多行续行："..."
      const cont = line.match(/^"(.*)"\s*$/)
      if (!cont) continue
      const chunk = unescapePo(cont[1])
      if (lastForm === -1 && msgid !== '' && msgidPlural === null) {
        // msgid 续行（msgstr 尚未出现）
        msgid += chunk
      } else if (lastForm >= 0) {
        msgstr[lastForm] = (msgstr[lastForm] ?? '') + chunk
      } else if (msgctxt !== '' && msgid === '') {
        msgctxt += chunk
      } else if (msgidPlural !== null) {
        msgidPlural += chunk
      } else if (msgstr.length > 0) {
        msgstr[0] = (msgstr[0] ?? '') + chunk
      }
      continue
    }
    const [, keyword, formIdx, value] = kv
    const chunk = unescapePo(value)
    if (keyword === 'msgctxt') {
      flush()
      msgctxt = chunk
    } else if (keyword === 'msgid') {
      // 新条目开始：仅当旧条目已有内容才 flush（msgctxt 刚设置时不能清掉它）
      if (msgid !== '' || msgidPlural !== null || msgstr.length > 0) flush()
      msgid = chunk
      if (chunk === '') inHeader = true
    } else if (keyword === 'msgid_plural') {
      msgidPlural = chunk
      lastForm = -2
    } else {
      // msgstr 或 msgstr[N]
      const idx = formIdx === undefined ? 0 : Number(formIdx)
      if (formIdx !== undefined) lastForm = idx
      else if (msgidPlural !== null) lastForm = idx
      else lastForm = 0
      msgstr[idx] = (msgstr[idx] ?? '') + chunk
    }
  }
  flush()
  return catalog
}

// ---------------------------------------------------------------------------
// Plural-Forms 求值（header: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : ...);"）
// ---------------------------------------------------------------------------

interface PluralRule {
  nplurals: number
  eval: (n: number) => number
}

const pluralRuleCache = new Map<string, PluralRule>()

/** 递归下降求值 C 风格三元表达式（仅 gettext Plural-Forms 所需子集） */
function compilePluralExpr(src: string): (nValue: number) => number {
  let pos = 0
  let n = 0
  const ws = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos += 1
  }
  const peek = () => {
    ws()
    return src.slice(pos, pos + 2)
  }
  const expect = (token: string): boolean => {
    ws()
    if (src.startsWith(token, pos)) {
      pos += token.length
      return true
    }
    return false
  }

  const ternary = (): number => {
    const cond = or()
    if (expect('?')) {
      const thenVal = ternary()
      expect(':')
      const elseVal = ternary()
      return cond ? thenVal : elseVal
    }
    return cond
  }
  const or = (): number => {
    let v = and()
    for (;;) {
      if (peek() === '||') {
        pos += 2
        const rhs = and()
        v = v || rhs ? 1 : 0
      } else break
    }
    return v
  }
  const and = (): number => {
    let v = equality()
    for (;;) {
      if (peek() === '&&') {
        pos += 2
        const rhs = equality()
        v = v && rhs ? 1 : 0
      } else break
    }
    return v
  }
  const equality = (): number => {
    let v = relational()
    for (;;) {
      if (peek() === '==') {
        pos += 2
        v = v === relational() ? 1 : 0
      } else if (peek() === '!=') {
        pos += 2
        v = v !== relational() ? 1 : 0
      } else break
    }
    return v
  }
  const relational = (): number => {
    let v = additive()
    for (;;) {
      if (peek() === '<=') {
        pos += 2
        v = v <= additive() ? 1 : 0
      } else if (peek() === '>=') {
        pos += 2
        v = v >= additive() ? 1 : 0
      } else if (src[pos] === '<') {
        pos += 1
        v = v < additive() ? 1 : 0
      } else if (src[pos] === '>') {
        pos += 1
        v = v > additive() ? 1 : 0
      } else break
    }
    return v
  }
  const additive = (): number => {
    let v = multiplicative()
    for (;;) {
      if (src[pos] === '+') {
        pos += 1
        v += multiplicative()
      } else if (src[pos] === '-') {
        pos += 1
        v -= multiplicative()
      } else break
    }
    return v
  }
  const multiplicative = (): number => {
    let v = unary()
    for (;;) {
      if (src[pos] === '*') {
        pos += 1
        v *= unary()
      } else if (src[pos] === '%') {
        pos += 1
        v %= unary()
      } else break
    }
    return v
  }
  const unary = (): number => {
    if (expect('!')) return unary() ? 0 : 1
    return primary()
  }
  const primary = (): number => {
    ws()
    if (expect('(')) {
      const v = ternary()
      expect(')')
      return v
    }
    if (src[pos] === 'n') {
      pos += 1
      return n
    }
    const num = src.slice(pos).match(/^\d+/)
    if (num) {
      pos += num[0].length
      return Number(num[0])
    }
    // 无法识别的记号：跳过避免死循环
    pos += 1
    return 0
  }

  return (nValue: number) => {
    n = nValue
    pos = 0
    return ternary()
  }
}

function parsePluralForms(header: string): PluralRule {
  const cached = pluralRuleCache.get(header)
  if (cached) return cached
  let rule: PluralRule = { nplurals: 2, eval: (n) => (n === 1 ? 0 : 1) }
  const match = header.match(/nplurals\s*=\s*(\d+)\s*;\s*plural\s*=\s*(.+?)\s*;?\s*$/)
  if (match) {
    try {
      const evalFn = compilePluralExpr(match[2])
      const nplurals = Math.max(1, Number(match[1]))
      rule = { nplurals, eval: (n) => Math.min(nplurals - 1, Math.max(0, evalFn(n))) }
    } catch {
      // 保持默认规则
    }
  }
  pluralRuleCache.set(header, rule)
  return rule
}

// ---------------------------------------------------------------------------
// 查询与格式化
// ---------------------------------------------------------------------------

function lookup(catalog: Catalog | null, msgid: string, ctx?: string): PoEntry | null {
  if (!catalog) return null
  const key = ctx ? `${ctx}\u0004${msgid}` : msgid
  return catalog.exact.get(key) ?? catalog.loose.get(key) ?? null
}

function stripAccess(label: string): { label: string; accessKey?: string } {
  const match = label.match(/&(.)/)
  if (!match) return { label: label.replace(/&/g, '').trim() }
  return { label: label.replace('&', '').trim(), accessKey: match[1].toLowerCase() }
}

// ---------------------------------------------------------------------------
// 语言状态（模式同 config/options.ts：version + useSyncExternalStore）
// ---------------------------------------------------------------------------

const catalogs = new Map<string, Catalog>()
const pending = new Map<string, Promise<Catalog | null>>()
const translationCache = new Map<string, string>()

let currentLocale = ''
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  translationCache.clear()
  for (const listener of listeners) listener()
}

/** React 订阅：语言切换后版本号 +1，触发依赖组件重渲染 */
export function useLocaleVersion(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => version,
    () => version,
  )
}

/** 当前语言码（如 zh_CN；空 = 尚未初始化，全部回退英文源串） */
export function getLocale(): string {
  return currentLocale
}

/** LINGUAS（源码 po/ 目录原样引用）：语言码列表，保持源文件顺序 */
export const availableLocales: string[] = linguasRaw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

function joinBase(rel: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? `${base}${rel}` : `${base}/${rel}`
}

/** 按需加载一个语言的 po（重复调用复用进行中/已完成的请求） */
export function loadLocale(code: string): Promise<Catalog | null> {
  const loaded = catalogs.get(code)
  if (loaded) return Promise.resolve(loaded)
  const inflight = pending.get(code)
  if (inflight) return inflight
  const task = fetch(joinBase(`locales/${code}.po`))
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((text) => {
      const catalog = parsePo(text)
      catalogs.set(code, catalog)
      return catalog
    })
    .catch(() => null)
  pending.set(code, task)
  return task
}

/** 切换当前语言；po 未就绪时先加载再通知（失败保持原语言） */
export async function setLocale(code: string): Promise<void> {
  if (!code || code === currentLocale) return
  const catalog = await loadLocale(code)
  if (!catalog) return
  currentLocale = code
  notify()
}

/** 语言码 → BCP 47（zh_CN → zh-CN，sr_RS@latin → sr-Latn-RS） */
function codeToBcp47(code: string): string {
  const [base, script] = code.split('@')
  const parts = base.split('_')
  if (parts.length >= 2) parts[1] = parts[1].toUpperCase()
  if (script) {
    const s = script.charAt(0).toUpperCase() + script.slice(1)
    parts.splice(1, 0, s)
  }
  return parts.join('-')
}

/** 语言显示名（按当前 UI 语言渲染，如 zh_CN 下显示 "法语"；失败回退语言码） */
export function localeLabel(code: string): string {
  const bcp = codeToBcp47(code)
  const displayLocales = currentLocale ? [codeToBcp47(currentLocale), 'en'] : undefined
  try {
    const dn = new Intl.DisplayNames(displayLocales, { type: 'language' })
    return dn.of(bcp) ?? code
  } catch {
    return code
  }
}

/**
 * 默认语言探测（对应 wxLocale 初始化语义）：App/Language 未设置时按
 * Accept-Language 优先级匹配 LINGUAS——精确 → 带 Latn 变体 → 语言前缀。
 * acceptLanguages 参数用于测试注入；缺省读 navigator.languages。
 */
export function detectDefaultLocale(codes: string[], acceptLanguages?: readonly string[]): string {
  const candidates: string[] = []
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  if (acceptLanguages?.length) candidates.push(...acceptLanguages)
  else if (nav?.languages?.length) candidates.push(...nav.languages)
  else if (nav?.language) candidates.push(nav.language)
  for (const candidate of candidates) {
    const norm = candidate.replace('-', '_')
    const exact = codes.find((c) => c.toLowerCase() === norm.toLowerCase())
    if (exact) return exact
  }
  for (const candidate of candidates) {
    const norm = candidate.replace('-', '_').toLowerCase()
    const wantsLatin = /latn/i.test(candidate)
    const prefix = norm.split('_')[0]
    const matches = codes.filter((c) => c.toLowerCase().split('_')[0] === prefix)
    if (!matches.length) continue
    if (wantsLatin) {
      const latin = matches.find((c) => c.includes('@latin'))
      if (latin) return latin
    }
    return matches[0]
  }
  return ''
}

/** 启动引导：读取 App/Language（OPT_GET 语义），空则探测浏览器语言，加载 po 后生效 */
export async function initLocale(): Promise<void> {
  if (currentLocale) return
  const configured = getOptionString('App/Language')
  const code = configured || detectDefaultLocale(availableLocales)
  if (!code) return
  const catalog = await loadLocale(code)
  if (!catalog) return
  currentLocale = code
  notify()
}

/** 语言选择提交（对应源码 OPT_SET("App/Language")->SetString） */
export function storeLanguage(code: string): void {
  setOption('App/Language', code)
}

// ---------------------------------------------------------------------------
// 翻译入口
// ---------------------------------------------------------------------------

/** gettext：翻译并保留 & 加速键（菜单路径用，stripAccess 由显示层处理） */
export function t(msgid: string, ctx?: string): string {
  const key = `${ctx ? `${ctx}\u0004` : ''}${msgid}`
  const cached = translationCache.get(key)
  if (cached !== undefined) return cached
  const catalog = currentLocale ? (catalogs.get(currentLocale) ?? null) : null
  const entry = lookup(catalog, msgid, ctx)
  const result = entry?.forms[0] ?? msgid
  translationCache.set(key, result)
  return result
}

/** 翻译并剥离 & 加速键（tooltip/按钮等非菜单场景） */
export function tPlain(msgid: string, ctx?: string): string {
  return stripAccess(t(msgid, ctx)).label
}

/** ngettext：按 Plural-Forms 规则取复数形式 */
export function tPlural(msgid: string, msgidPlural: string, n: number, ctx?: string): string {
  const fallback = n === 1 ? msgid : msgidPlural
  const catalog = currentLocale ? (catalogs.get(currentLocale) ?? null) : null
  const entry = lookup(catalog, msgid, ctx)
  if (!entry || entry.forms.length === 0) return fallback
  const rule = parsePluralForms(catalog?.headers.get('Plural-Forms') ?? '')
  const idx = Math.min(rule.eval(n), entry.forms.length - 1)
  return entry.forms[idx] || fallback
}

/** wxString::Format 语义：%s/%d/%i/%u 按序填充，%% 为字面 % */
export function tFmt(msgid: string, ...args: (string | number)[]): string {
  let text = t(msgid)
  let argIndex = 0
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '%' && i + 1 < text.length) {
      const d = text[i + 1]
      if (d === '%') {
        out += '%'
        i += 1
        continue
      }
      if (d === 's' || d === 'd' || d === 'i' || d === 'u') {
        const arg = args[argIndex]
        if (arg !== undefined) {
          out += String(arg)
          argIndex += 1
          i += 1
          continue
        }
      }
    }
    out += c
  }
  return out
}
