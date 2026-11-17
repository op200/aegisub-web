/**
 * Hunspell 风格拼写检查（spellchecker_hunspell.cpp 的 web 移植）。
 *
 * 词库来自 VFS 的 `?dictionary`（便携模式下即 /dictionaries）：
 * `<lang>.aff` + `<lang>.dic`，可选 `user_<lang>.dic` 存用户添加的词。
 * 支持常用的 PFX/SFX 词缀规则（strip/add/condition/cross product），
 * 足以读取 en_US、de_DE 等标准 Hunspell 词库。
 */
import { getOptionBool, getOptionString, setOption } from '../config/options'
import { VFS_DIRS, listDir, readBytes, readTextFile, writeTextFile } from '../storage/vfs'

interface AffixRule {
  flag: string
  strip: string
  add: string
  condition: RegExp | null
}

interface AffixGroup {
  crossProduct: boolean
  rules: AffixRule[]
}

interface Dictionary {
  language: string
  /** 小写词干 → 词干标记集合 */
  stems: Map<string, Set<string>>
  /** 带大写字母的原始词（用于大小写敏感匹配） */
  exactCase: Set<string>
  /** 有该标记的词条不可用（FORBIDDENWORD） */
  forbiddenFlag: string | null
  /** 需要词缀才合法（NEEDAFFIX） */
  needAffixFlag: string | null
  prefixes: Map<string, AffixGroup>
  suffixes: Map<string, AffixGroup>
  /** 建议用的词干列表（按词库顺序） */
  wordList: string[]
}

let dictionary: Dictionary | null = null
let languages: string[] = []
let customWords = new Set<string>()
let checkCache = new Map<string, boolean>()
let version = 0
let loadPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

export function getSpellcheckVersion(): number {
  return version
}

export function subscribeSpellcheck(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function bump() {
  version += 1
  checkCache = new Map()
  for (const listener of listeners) listener()
}

export function getSpellCheckerLanguages(): string[] {
  return [...languages]
}

export function getSpellCheckerLanguage(): string {
  return getOptionString('Tool/Spell Checker/Language')
}

export function isSpellCheckerLoaded(): boolean {
  return dictionary !== null && dictionary.language === getSpellCheckerLanguage()
}

// ---------------------------------------------------------------------------
// Hunspell .aff / .dic 解析
// ---------------------------------------------------------------------------

type FlagStyle = 'char' | 'long' | 'num'

function parseFlags(raw: string, style: FlagStyle): string[] {
  if (!raw) return []
  if (style === 'num') return raw.split(',').filter(Boolean)
  if (style === 'long') {
    const flags: string[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) flags.push(raw.slice(i, i + 2))
    return flags
  }
  return Array.from(raw)
}

function unescapeWord(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

/** Hunspell condition → 正则；SFX 锚定词尾，PFX 锚定词首 */
function conditionToRegExp(condition: string, type: 'PFX' | 'SFX'): RegExp | null {
  if (!condition || condition === '.') return null
  let source = ''
  for (let i = 0; i < condition.length; i++) {
    const char = condition[i]
    if (char === '[') {
      const end = condition.indexOf(']', i + 1)
      if (end < 0) break
      source += condition.slice(i, end + 1)
      i = end
      continue
    }
    if (char === '.') source += '.'
    else if ('\\^$*+?(){}|'.includes(char)) source += `\\${char}`
    else source += char
  }
  try {
    return type === 'SFX' ? new RegExp(`${source}$`, 'u') : new RegExp(`^${source}`, 'u')
  } catch {
    return null
  }
}

function stripAdd(value: string): string {
  return value === '0' ? '' : value
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
  }
}

function parseAff(text: string): Omit<Dictionary, 'language' | 'stems' | 'exactCase' | 'wordList'> {
  let flagStyle: FlagStyle = 'char'
  let forbiddenFlag: string | null = null
  let needAffixFlag: string | null = null
  const prefixes = new Map<string, AffixGroup>()
  const suffixes = new Map<string, AffixGroup>()
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    const directive = fields[0].toUpperCase()

    if (directive === 'FLAG' && fields[1]) {
      const style = fields[1].toLowerCase()
      flagStyle = style === 'num' ? 'num' : style === 'long' ? 'long' : 'char'
      continue
    }
    if (directive === 'FORBIDDENWORD' && fields[1]) {
      forbiddenFlag = parseFlags(fields[1], flagStyle)[0] ?? null
      continue
    }
    if (directive === 'NEEDAFFIX' && fields[1]) {
      needAffixFlag = parseFlags(fields[1], flagStyle)[0] ?? null
      continue
    }
    if ((directive === 'PFX' || directive === 'SFX') && fields.length >= 4) {
      const flag = parseFlags(fields[1], flagStyle)[0]
      if (!flag) continue
      const crossProduct = fields[2].toUpperCase() === 'Y'
      const count = Number.parseInt(fields[3], 10)
      const group: AffixGroup = { crossProduct, rules: [] }
      const target = directive === 'PFX' ? prefixes : suffixes
      target.set(flag, group)
      for (let n = 0; n < (Number.isFinite(count) ? count : 0) && i + 1 < lines.length; n++) {
        i += 1
        const ruleLine = lines[i].trim()
        if (!ruleLine || ruleLine.startsWith('#')) continue
        const ruleFields = ruleLine.split(/\s+/)
        if (ruleFields.length < 4) continue
        const addField = stripAdd(ruleFields[3])
        // add 可带 /继续标记，web 版忽略继续标记
        const slash = addField.lastIndexOf('/')
        const add = slash >= 0 ? addField.slice(0, slash) : addField
        group.rules.push({
          flag,
          strip: stripAdd(ruleFields[2]),
          add,
          condition: conditionToRegExp(ruleFields[4], directive),
        })
      }
      continue
    }
  }

  return { prefixes, suffixes, forbiddenFlag, needAffixFlag }
}

function parseDic(
  text: string,
  style: FlagStyle,
): { stems: Map<string, Set<string>>; exactCase: Set<string>; wordList: string[] } {
  const stems = new Map<string, Set<string>>()
  const exactCase = new Set<string>()
  const wordList: string[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  let start = 0
  if (lines.length && /^\s*\d+\s*$/.test(lines[0])) start = 1

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.startsWith('#')) continue
    const first = line.split('\t')[0].trim()
    if (!first) continue
    const slash = first.indexOf('/')
    const rawWord = unescapeWord(slash >= 0 ? first.slice(0, slash) : first)
    const flags = slash >= 0 ? parseFlags(first.slice(slash + 1), style) : []
    if (!rawWord) continue
    const lower = rawWord.toLowerCase()
    let flagsSet = stems.get(lower)
    if (!flagsSet) {
      flagsSet = new Set()
      stems.set(lower, flagsSet)
      if (seen.size < 200000 && !seen.has(lower)) {
        seen.add(lower)
        wordList.push(lower)
      }
    }
    for (const flag of flags) flagsSet.add(flag)
    if (rawWord !== lower) exactCase.add(rawWord)
  }
  return { stems, exactCase, wordList }
}

/** 从 .aff 的 SET 行推断编码，再按该编码解码 */
function decodeAffAndDic(affBytes: Uint8Array, dicBytes: Uint8Array) {
  const probe = decodeWith(affBytes, 'utf-8')
  const setLine = /^\s*SET\s+(\S+)/m.exec(probe)
  const encoding = setLine ? setLine[1] : 'UTF-8'
  return {
    aff: encoding.toUpperCase() === 'UTF-8' ? probe : decodeWith(affBytes, encoding),
    dic:
      encoding.toUpperCase() === 'UTF-8'
        ? decodeWith(dicBytes, 'utf-8')
        : decodeWith(dicBytes, encoding),
  }
}

function flagStyleOf(affText: string): FlagStyle {
  const match = /^\s*FLAG\s+(\S+)/m.exec(affText)
  const style = match?.[1]?.toLowerCase()
  return style === 'num' ? 'num' : style === 'long' ? 'long' : 'char'
}

// ---------------------------------------------------------------------------
// 加载与查询
// ---------------------------------------------------------------------------

async function scanLanguages(): Promise<string[]> {
  const entries = await listDir(VFS_DIRS.dictionaries)
  const names = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name))
  const result: string[] = []
  for (const name of names) {
    if (!name.endsWith('.dic')) continue
    const language = name.slice(0, -4)
    if (language.startsWith('user_')) continue
    if (names.has(`${language}.aff`)) result.push(language)
  }
  return result.sort()
}

async function loadDictionary(language: string): Promise<void> {
  const base = `${VFS_DIRS.dictionaries}/${language}`
  const affBytes = await readBytes(`${base}.aff`)
  const dicBytes = await readBytes(`${base}.dic`)
  if (!affBytes || !dicBytes) {
    dictionary = null
    customWords = new Set()
    bump()
    return
  }
  const decoded = decodeAffAndDic(affBytes, dicBytes)
  const style = flagStyleOf(decoded.aff)
  const aff = parseAff(decoded.aff)
  const dic = parseDic(decoded.dic, style)
  dictionary = { language, ...aff, ...dic }

  customWords = new Set()
  const userText = await readTextFile(`${VFS_DIRS.dictionaries}/user_${language}.dic`)
  if (userText) {
    for (const line of userText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || /^\d+$/.test(trimmed) || trimmed.startsWith('#')) continue
      customWords.add(trimmed.split('/')[0].toLowerCase())
    }
  }
  bump()
}

/** 扫描语言列表并按 Tool/Spell Checker/Language 加载词库（幂等；语言变化时重载） */
export async function ensureSpellCheckerLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  const requested = getSpellCheckerLanguage()
  // 已按当前语言加载则无需重复扫描词库（StrictMode 下 effect 会执行两次）
  if (dictionary && requested && dictionary.language === requested) return
  loadPromise = (async () => {
    languages = await scanLanguages()
    const language = requested
    try {
      if (language) await loadDictionary(language)
      else {
        dictionary = null
        customWords = new Set()
        bump()
      }
    } catch {
      dictionary = null
    } finally {
      bump()
    }
  })()
  await loadPromise
  loadPromise = null
}

/** 选项变化后强制重新加载 */
export async function reloadSpellChecker(): Promise<void> {
  loadPromise = null
  dictionary = null
  await ensureSpellCheckerLoaded()
}

/** 切换语言（写入选项并加载） */
export async function setSpellCheckerLanguage(language: string): Promise<void> {
  setOption('Tool/Spell Checker/Language', language)
  await reloadSpellChecker()
}

function stemFlagsFor(word: string): Set<string> | null {
  if (!dictionary) return null
  return dictionary.stems.get(word.toLowerCase()) ?? null
}

function hasFlag(flags: Set<string> | null, flag: string | null): boolean {
  return !!flags && !!flag && flags.has(flag)
}

function checkWordInternal(input: string): boolean {
  const dict = dictionary
  if (!dict) return true
  const word = input.replace(/^['’-]+|['’-]+$/g, '')
  if (!word) return true
  // 纯数字/符号直接视为正确（Hunspell 同样接受数字）
  if (!/\p{L}/u.test(word)) return true
  if (customWords.has(word.toLowerCase())) return true

  const lower = word.toLowerCase()
  const exactFlags = stemFlagsFor(lower)
  if (exactFlags) {
    if (hasFlag(exactFlags, dict.forbiddenFlag)) return false
    if (!hasFlag(exactFlags, dict.needAffixFlag)) return true
  }

  // 连字符复合词逐段检查
  const hyphenParts = lower.split(/[-‐‑–—]/).filter(Boolean)
  if (
    hyphenParts.length > 1 &&
    hyphenParts.every((part) => checkLowerCaseExact(part) || checkAffixed(part))
  )
    return true

  return checkAffixed(lower)
}

function checkLowerCaseExact(lower: string): boolean {
  const dict = dictionary
  if (!dict) return true
  if (customWords.has(lower)) return true
  const flags = stemFlagsFor(lower)
  if (!flags) return false
  if (hasFlag(flags, dict.forbiddenFlag)) return false
  return !hasFlag(flags, dict.needAffixFlag)
}

/** 反向应用词缀规则：word = add + stem + add 的组合 */
function checkAffixed(word: string): boolean {
  const dict = dictionary
  if (!dict) return true

  const suffixMatches: { rule: AffixRule; group: string; stemWithPrefix: string }[] = []
  for (const [flag, group] of dict.suffixes) {
    for (const rule of group.rules) {
      const add = rule.add.toLowerCase()
      if (!add || !word.endsWith(add)) continue
      suffixMatches.push({
        rule,
        group: flag,
        stemWithPrefix: word.slice(0, word.length - add.length) + rule.strip.toLowerCase(),
      })
    }
  }
  for (const { rule, group, stemWithPrefix } of suffixMatches) {
    const flags = stemFlagsFor(stemWithPrefix)
    if (!hasFlag(flags, group)) continue
    if (rule.condition && !rule.condition.test(stemWithPrefix)) continue
    if (hasFlag(flags, dict.forbiddenFlag)) continue
    return true
  }

  const prefixMatches: { rule: AffixRule; group: string; stemWithSuffix: string }[] = []
  for (const [flag, group] of dict.prefixes) {
    for (const rule of group.rules) {
      const add = rule.add.toLowerCase()
      if (!add || !word.startsWith(add)) continue
      prefixMatches.push({
        rule,
        group: flag,
        stemWithSuffix: rule.strip.toLowerCase() + word.slice(add.length),
      })
    }
  }
  for (const { rule, group, stemWithSuffix } of prefixMatches) {
    const flags = stemFlagsFor(stemWithSuffix)
    if (!hasFlag(flags, group)) continue
    if (rule.condition && !rule.condition.test(stemWithSuffix)) continue
    if (hasFlag(flags, dict.forbiddenFlag)) continue
    return true
  }

  // 交叉组合
  for (const suffix of suffixMatches) {
    for (const prefix of prefixMatches) {
      const suffixGroup = dict.suffixes.get(suffix.group)
      const prefixGroup = dict.prefixes.get(prefix.group)
      if (!suffixGroup?.crossProduct || !prefixGroup?.crossProduct) continue
      const pAdd = prefix.rule.add.toLowerCase()
      const sAdd = suffix.rule.add.toLowerCase()
      if (!word.startsWith(pAdd) || !word.endsWith(sAdd)) continue
      const middle = word.slice(pAdd.length, word.length - sAdd.length)
      const stem = prefix.rule.strip.toLowerCase() + middle + suffix.rule.strip.toLowerCase()
      const flags = stemFlagsFor(stem)
      if (!hasFlag(flags, suffix.group) || !hasFlag(flags, prefix.group)) continue
      if (hasFlag(flags, dict.forbiddenFlag)) continue
      if (suffix.rule.condition && !suffix.rule.condition.test(stem)) continue
      if (prefix.rule.condition && !prefix.rule.condition.test(stem)) continue
      return true
    }
  }
  return false
}

/** Hunspell::spell：词库未加载时返回 true（Aegisub 中即是“没有拼写检查器”） */
export function spellCheckWord(word: string): boolean {
  if (!dictionary) return true
  const cached = checkCache.get(word)
  if (cached !== undefined) return cached
  const result = checkWordInternal(word)
  checkCache.set(word, result)
  return result
}

// ---------------------------------------------------------------------------
// 建议
// ---------------------------------------------------------------------------

function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]
}

/** Hunspell::suggest：按编辑距离从词干表里挑最接近的词 */
export function spellSuggestions(word: string, limit = 5): string[] {
  if (!dictionary) return []
  const lower = word.toLowerCase()
  if (lower.length < 2) return []
  const max = lower.length <= 4 ? 1 : 2
  const matches: { word: string; distance: number }[] = []
  for (const candidate of dictionary.wordList) {
    if (candidate === lower) continue
    if (Math.abs(candidate.length - lower.length) > max) continue
    const distance = boundedDistance(lower, candidate, max)
    if (distance <= max) matches.push({ word: candidate, distance })
  }
  matches.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word))
  const capitalized = /^\p{Lu}/u.test(word)
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of matches) {
    const suggestion = capitalized
      ? match.word.charAt(0).toUpperCase() + match.word.slice(1)
      : match.word
    if (seen.has(suggestion)) continue
    seen.add(suggestion)
    result.push(suggestion)
    if (result.length >= limit) break
  }
  return result
}

export function canAddWord(word: string): boolean {
  return dictionary !== null && /\p{L}/u.test(word)
}

export function canRemoveWord(word: string): boolean {
  return dictionary !== null && customWords.has(word.toLowerCase())
}

async function saveCustomWords(): Promise<void> {
  if (!dictionary) return
  const words = [...customWords].sort()
  await writeTextFile(
    `${VFS_DIRS.dictionaries}/user_${dictionary.language}.dic`,
    `${words.length}\n${words.join('\n')}${words.length ? '\n' : ''}`,
  )
}

export async function addWordToDictionary(word: string): Promise<void> {
  const clean = word.trim()
  if (!clean || !dictionary) return
  customWords.add(clean.toLowerCase())
  checkCache = new Map()
  await saveCustomWords()
  bump()
}

export async function removeWordFromDictionary(word: string): Promise<void> {
  if (!dictionary) return
  customWords.delete(word.trim().toLowerCase())
  checkCache = new Map()
  await saveCustomWords()
  bump()
}

/** Skip Comments / Skip Uppercase 是拼写检查对话框的工具选项 */
export function skipComments(): boolean {
  return getOptionBool('Tool/Spell Checker/Skip Comments')
}

export function skipUppercase(): boolean {
  return getOptionBool('Tool/Spell Checker/Skip Uppercase')
}
