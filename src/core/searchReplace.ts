/**
 * 查找/替换引擎（对应 Aegisub src/search_replace_engine.cpp）。
 *
 * web 侧不依赖核心 search/replace 命令，而是在主线程对 `SubtitleCue[]` 求值，
 * 因为源码语义（Skip Override Tags 的区间映射、Limit to Selected、Skip Comments、
 * 正则捕获组替换、文本选区起点）由核心未完整提供。
 * 匹配区间一律为「原文字段索引」，替换/选中直接使用该区间。
 */
import type { SubtitleCue } from './types'

export type SearchField = 'text' | 'style' | 'actor' | 'effect'
export type SearchLimit = 'all' | 'selected'

/** 对齐 SearchReplaceSettings（search_replace_engine.h）；exact_match 源码恒 false，未暴露 */
export interface SearchReplaceSettings {
  find: string
  replaceWith: string
  field: SearchField
  limitTo: SearchLimit
  matchCase: boolean
  useRegex: boolean
  ignoreComments: boolean
  skipTags: boolean
}

export const SEARCH_FIELDS: SearchField[] = ['text', 'style', 'actor', 'effect']

/** 匹配区间（原文字段索引）；regex 用于替换时的捕获组展开 */
export interface FieldMatch {
  start: number
  end: number
  regex: RegExp | null
}

export type Matcher = (value: string, start: number) => FieldMatch | null

export function fieldValue(cue: SubtitleCue, field: SearchField): string {
  switch (field) {
    case 'style':
      return cue.style
    case 'actor':
      return cue.actor
    case 'effect':
      return cue.effect
    default:
      return cue.text
  }
}

/** libaegisub/common/util.cpp parse_blocks：{...} 块区间（未闭合的 { 忽略） */
function parseBlocks(str: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]
    if (ch === '{' && start < 0) start = i
    else if (ch === '}' && start >= 0) {
      blocks.push([start, i + 1])
      start = -1
    }
  }
  return blocks
}

/** 访问器：把字段值转换为「参与匹配的字符串」，并把匹配区间映射回原文 */
interface Accessor {
  get(value: string, start: number): string
  makeMatch(start: number, end: number): { start: number; end: number }
}

/** noop_accessor：直接用字段值（子串起点偏移） */
function makeNoopAccessor(): Accessor {
  let base = 0
  return {
    get(value, start) {
      base = start
      return value.slice(start)
    },
    makeMatch(start, end) {
      return { start: start + base, end: end + base }
    },
  }
}

/** skip_tags_accessor：剥去 {…} 块，并按 tagless_find_helper 语义把区间映射回原文 */
function makeSkipTagsAccessor(): Accessor {
  let base = 0
  let blocks: Array<[number, number]> = []
  return {
    get(value, start) {
      blocks = parseBlocks(value)
      let out = ''
      let last = start
      for (const [first, second] of blocks) {
        if (second <= start) continue
        if (first > last) out += value.slice(last, first)
        last = second
      }
      if (last < value.length) out += value.slice(last)
      base = start
      return out
    },
    makeMatch(start, end) {
      let s = start + base
      let e = end + base
      for (const [first, second] of blocks) {
        if (second <= base) continue
        // 落在匹配起点之前/之内的块：整体跳过（含起点位于块内的情况）
        if (first <= s) {
          const len = second - Math.max(first, base)
          s += len
          e += len
          continue
        }
        if (first >= e) break
        // 匹配内部的块：扩展匹配终点以包含整块
        e += second - first
      }
      return { start: s, end: e }
    },
  }
}

/**
 * 编译匹配器（源码 SearchReplaceEngine::GetMatcher）；正则非法时 throw。
 * 有意偏差：正则用 JS RegExp，与源码 Boost u32regex(perl) 在 \k 等构造上有差异。
 */
export function compileMatcher(settings: SearchReplaceSettings): Matcher {
  const accessor = settings.skipTags ? makeSkipTagsAccessor() : makeNoopAccessor()

  if (settings.useRegex) {
    const regex = new RegExp(settings.find, settings.matchCase ? '' : 'i')
    return (value, start) => {
      const str = accessor.get(value, start)
      const match = regex.exec(str)
      if (!match) return null
      const s = match.index
      const e = s + match[0].length
      const mapped = accessor.makeMatch(s, e)
      return { start: mapped.start, end: mapped.end, regex }
    }
  }

  const lookFor = settings.matchCase ? settings.find : settings.find.toLowerCase()
  return (value, start) => {
    const str = accessor.get(value, start)
    const hay = settings.matchCase ? str : str.toLowerCase()
    const pos = hay.indexOf(lookFor)
    if (pos < 0) return null
    const mapped = accessor.makeMatch(pos, pos + lookFor.length)
    return { start: mapped.start, end: mapped.end, regex: null }
  }
}

export interface FindOptions {
  activeId: string | null
  selectedIds: Set<string>
  /** 文本字段的起始位置（源码 = textSelectionController->GetSelectionEnd()） */
  fieldStart: number
}

export interface FoundMatch {
  cueId: string
  start: number
  end: number
  /** 命中时只改活动行、不改选中集（源码 selection_only 分支） */
  selectionOnly: boolean
}

/**
 * 源码 SearchReplaceEngine::FindReplace(replace=false)：
 * 文本字段从活动行 + 选区终点起环形查找；其余字段从下一行起找匹配行。
 */
export function findNext(
  cues: SubtitleCue[],
  settings: SearchReplaceSettings,
  matcher: Matcher,
  options: FindOptions,
): FoundMatch | null {
  const count = cues.length
  if (!count) return null

  let index = options.activeId ? cues.findIndex((cue) => cue.id === options.activeId) : 0
  if (index < 0) index = 0

  let pos = 0
  let first = index
  if (settings.field === 'text') pos = options.fieldStart
  else first = (index + 1) % count

  const selectionOnly = options.selectedIds.size > 1 && settings.limitTo === 'selected'

  let it = first
  for (;;) {
    const cue = cues[it]
    const skip =
      (selectionOnly && !options.selectedIds.has(cue.id)) ||
      (settings.ignoreComments && cue.comment)
    if (!skip) {
      const match = matcher(fieldValue(cue, settings.field), pos)
      if (match) return { cueId: cue.id, start: match.start, end: match.end, selectionOnly }
    }
    pos = 0
    it = (it + 1) % count
    if (it === first) break
  }
  return null
}

export interface ReplaceResult {
  value: string
  /** 替换后插入文本的终点（源码 ms.end = ms.start + replacement.size） */
  end: number
}

/**
 * 源码 SearchReplaceEngine::Replace：替换单行字段中的一处匹配（正则时展开捕获组）。
 * 有意偏差：$0（Boost 专有）在 web 用 $& 表示整个匹配。
 */
export function replaceInLine(
  value: string,
  match: FieldMatch,
  settings: SearchReplaceSettings,
): ReplaceResult {
  const toReplace = value.slice(match.start, match.end)
  const replacement =
    settings.useRegex && match.regex
      ? toReplace.replace(match.regex, settings.replaceWith)
      : settings.replaceWith
  return {
    value: value.slice(0, match.start) + replacement + value.slice(match.end),
    end: match.start + replacement.length,
  }
}

export interface ReplaceNextOptions extends FindOptions {
  /** 文本字段的选区起点（源码 GetSelectionStart()）；非 text 字段忽略 */
  fieldStart: number
  /** 文本字段的选区终点（源码 GetSelectionEnd()）；非 text 字段忽略 */
  fieldEnd: number
}

export interface ReplaceNextResult {
  /** 执行了替换：返回整行新值（需以 label 'replace' 提交一个撤销点） */
  replacement: { cueId: string; value: string } | null
  /** 命中的行与区间（循环找到的下一处）；整圈无匹配为 null */
  found: FoundMatch | null
  /** found 是否来自循环（需 SetSelectionAndActive/SetActiveLine）；
   *  false = 活动行已匹配但尚未选中，源码仅设置选区后返回 */
  foundViaLoop: boolean
  /** 替换后整圈无匹配：源码把选区设到新插入文本（仅 text 字段） */
  fallbackSelection: { cueId: string; start: number; end: number } | null
}

/**
 * 源码 SearchReplaceEngine::FindReplace(replace=true)（ReplaceNext）：
 * 活动行若在选区起点处命中且已被选中则替换并继续查找下一处；
 * 若非替换语义的命中（未选中）则只设为选区并返回。
 */
export function replaceNext(
  cues: SubtitleCue[],
  settings: SearchReplaceSettings,
  matcher: Matcher,
  options: ReplaceNextOptions,
): ReplaceNextResult {
  const result: ReplaceNextResult = {
    replacement: null,
    found: null,
    foundViaLoop: false,
    fallbackSelection: null,
  }
  const count = cues.length
  if (!count) return result

  let index = options.activeId ? cues.findIndex((cue) => cue.id === options.activeId) : 0
  if (index < 0) index = 0
  const line = cues[index]
  const textField = settings.field === 'text'

  // 活动行的字段值（替换后就地更新，供同一行的后续匹配使用）
  let lineValue = fieldValue(line, settings.field)
  const valueAt = (i: number) => (i === index ? lineValue : fieldValue(cues[i], settings.field))

  let pos = textField ? options.fieldStart : 0
  let replacedMatch: FieldMatch | null = null

  const first = matcher(valueAt(index), pos)
  if (first) {
    const end = textField ? options.fieldEnd : -1
    if (end === -1 || (pos === first.start && end === first.end)) {
      const res = replaceInLine(lineValue, first, settings)
      result.replacement = { cueId: line.id, value: res.value }
      lineValue = res.value
      replacedMatch = { ...first, end: res.end }
      pos = res.end
    } else {
      // 活动行匹配但尚未选中：先显示该匹配，不替换
      result.found = {
        cueId: line.id,
        start: first.start,
        end: first.end,
        selectionOnly: options.selectedIds.size > 1 && settings.limitTo === 'selected',
      }
      return result
    }
  }

  const selectionOnly = options.selectedIds.size > 1 && settings.limitTo === 'selected'
  let it = index
  for (;;) {
    const cue = cues[it]
    const skip =
      (selectionOnly && !options.selectedIds.has(cue.id)) ||
      (settings.ignoreComments && cue.comment)
    if (!skip) {
      const match = matcher(valueAt(it), pos)
      if (match) {
        result.found = { cueId: cue.id, start: match.start, end: match.end, selectionOnly }
        result.foundViaLoop = true
        return result
      }
    }
    pos = 0
    it = (it + 1) % count
    if (it === index) break
  }

  // 替换后整圈无匹配：把选区设到新插入的文本（源码 SetSelection(replace_ms.start, replace_ms.end)）
  if (replacedMatch && textField) {
    result.fallbackSelection = {
      cueId: line.id,
      start: replacedMatch.start,
      end: replacedMatch.end,
    }
  }
  return result
}

export interface ReplacementUpdate {
  cueId: string
  value: string
}

/**
 * 源码 SearchReplaceEngine::ReplaceAll：逐行反复匹配替换，返回每行最终值与出现次数。
 * 非正则路径逐次替换（保留捕获组之外的源码语义）；正则在匹配子串上做首处展开。
 */
export function replaceAllMatches(
  cues: SubtitleCue[],
  settings: SearchReplaceSettings,
  matcher: Matcher,
  selectedIds: Set<string>,
): { updates: ReplacementUpdate[]; count: number } {
  const selectionOnly = settings.limitTo === 'selected'
  const updates: ReplacementUpdate[] = []
  let count = 0

  for (const cue of cues) {
    if (selectionOnly && !selectedIds.has(cue.id)) continue
    if (settings.ignoreComments && cue.comment) continue

    let value = fieldValue(cue, settings.field)
    let pos = 0
    let changed = false
    // 每次替换后 pos 前进到插入文本终点；零长度匹配时终止，避免死循环
    for (;;) {
      const match = matcher(value, pos)
      if (!match) break
      const result = replaceInLine(value, match, settings)
      count += 1
      changed = true
      value = result.value
      if (result.end === match.start) break
      pos = result.end
    }
    if (changed) updates.push({ cueId: cue.id, value })
  }

  return { updates, count }
}
