/**
 * 汉字K值配对的匹配核心（libaegisub/common/karaoke_matcher.cpp 移植）。
 *
 * 源行为 UTF-8 字节索引，这里改用 JS 字符串 + 字形簇数组：
 * 逐字符操作与 ICU character BreakIterator 一致（Intl.Segmenter grapheme）。
 */

import type { KaraokeSyllable } from './karaoke'
import { kanaToRomaji, romajiToKana } from './kanaTable'

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 逐字形簇切分（等价于 ICU character BreakIterator） */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** agi::unicode::is_whitespace：全部字符为 Unicode White_Space（空串同样为 true） */
function isWhitespace(text: string): boolean {
  return /^[\p{White_Space}]*$/u.test(text)
}

/** 单字符且 UTF-8 为 3 字节、首字节 0xE3（源码 is_3byte_e3 判定） */
function isThreeByteE3Cluster(cluster: string): boolean {
  if (cluster.length !== 1) return false
  const code = cluster.charCodeAt(0)
  return code >= 0x3000 && code <= 0x3fff
}

/** agi::BreakIterator 的字符迭代语义 */
class GraphemeIterator {
  private chars: string[] = []
  private begin = 0
  private end = -1

  setText(text: string): void {
    this.chars = graphemes(text)
    this.begin = 0
    this.end = this.chars.length > 0 ? 1 : -1
  }

  done(): boolean {
    return this.begin >= this.chars.length
  }

  isLast(): boolean {
    return this.end === -1 || this.end >= this.chars.length
  }

  next(): void {
    this.begin = this.end
    this.end = this.begin + 1 > this.chars.length ? -1 : this.begin + 1
  }

  current(): string {
    return this.end === -1 ? this.chars.slice(this.begin).join('') : this.chars[this.begin]
  }

  currentToEnd(): string {
    return this.chars.slice(this.begin).join('')
  }

  /** 源码用 `string_view(cur.data(), 6)` 取当前 + 下一字符做双假名查表 */
  nextCurrent(): string {
    return this.chars[this.begin + 1] ?? ''
  }
}

export interface KaraokeMatchResult {
  /** 匹配的源音节数 */
  sourceLength: number
  /** 匹配的目标字符（字形簇）数 */
  destinationLength: number
}

export interface KaraokeMatchGroup {
  src: KaraokeSyllable[]
  dst: string
}

interface InternalMatchGroup extends KaraokeMatchGroup {
  srcStart: number
  srcLen: number
  dstStart: number
  dstLen: number
}

/**
 * agi::AutoMatchKaraoke：尝试把 dst 的开头部分与 src 的第一个音节配对，
 * 返回应当选中的音节数与目标字符数。
 */
export function autoMatchKaraoke(
  sourceStrings: readonly string[],
  destText: string,
): KaraokeMatchResult {
  const result: KaraokeMatchResult = { sourceLength: 0, destinationLength: 0 }
  if (sourceStrings.length === 0) return result
  result.sourceLength = 1

  const dst = new GraphemeIterator()
  const src = new GraphemeIterator()
  dst.setText(destText)
  src.setText(sourceStrings[0].toLowerCase())

  // 吃掉源与目标开头的空白；任一耗尽时返回 true 表示本次匹配结束
  const eatWhitespace = (): boolean => {
    while (!src.done() && isWhitespace(src.current())) src.next()
    while (!dst.done() && isWhitespace(dst.current())) {
      dst.next()
      result.destinationLength += 1
    }

    // 目标先耗尽：剩余源音节全部归入本次匹配
    if (dst.done()) {
      result.sourceLength = sourceStrings.length
      return true
    }

    return src.done()
  }

  if (eatWhitespace()) return result

  // 先按 ICU collator PRIMARY 强度直接比较，再尝试罗马字 → 假名转换
  while (!src.done()) {
    while (!src.done() && !dst.done() && collator.compare(src.current(), dst.current()) === 0) {
      src.next()
      dst.next()
      result.destinationLength += 1
      if (eatWhitespace()) return result
    }

    let matched = false
    for (const [kana, romaji] of romajiToKana(src.currentToEnd())) {
      if (!dst.currentToEnd().startsWith(kana)) continue

      // romaji 均为 ASCII，字符数等于字节数
      for (let i = 0; i < romaji.length; i++) src.next()
      const count = graphemes(kana).length
      result.destinationLength += count
      for (let i = 0; i < count; i++) dst.next()

      if (eatWhitespace()) return result
      matched = true
      break
    }
    if (!matched) break
  }

  // 目标只剩一个字符时，显然要匹配剩余的全部源音节
  if (dst.isLast()) {
    result.sourceLength = sourceStrings.length
    result.destinationLength += 1
    return result
  }

  // 当前字符对不上：向前看最多 3 个目标字符，若其后某处能匹配下一个源音节，
  // 就按距离估算当前音节应选中的源音节与目标字符数。
  const maxCharacterLength = 5
  const dstLookaheadMax = 3

  for (let lookahead = 0; lookahead < dstLookaheadMax; lookahead++) {
    dst.next()
    if (dst.done()) break
    const cur = dst.current()
    if (!isThreeByteE3Cluster(cur)) continue

    // 双假名（如 きゃ）与单假名都尝试转写
    const translit: string[] = []
    const next = dst.nextCurrent()
    if (next && isThreeByteE3Cluster(next)) translit.push(...kanaToRomaji(cur + next))
    translit.push(...kanaToRomaji(cur))

    const srcLookaheadMax = (lookahead + 1) * maxCharacterLength
    let srcLookaheadPos = 0
    for (const syl of sourceStrings) {
      // 空白音节不计入搜索距离
      if (isWhitespace(syl)) continue
      srcLookaheadPos += 1
      if (srcLookaheadPos === 1) continue
      if (srcLookaheadPos > srcLookaheadMax) break

      const lower = syl.toLowerCase()
      if (!(syl.startsWith(cur) || translit.some((romaji) => lower.startsWith(romaji)))) continue

      // 紧邻的下一个音节匹配上：中间内容全部归当前音节
      if (srcLookaheadPos === 2) {
        result.destinationLength += lookahead + 1
        return result
      }

      // 隔了多个音节才匹配：把目标字符均分给这些源音节
      result.destinationLength += 1
      result.sourceLength = Math.floor((srcLookaheadPos - 1) / (lookahead + 1) + 0.5)
      return result
    }
  }

  // 目标非空，至少选中一个字符
  result.destinationLength = Math.max(result.destinationLength, 1)
  return result
}

/** agi::KaraokeMatcher：逐组接受配对并生成带 \k 的目标行文本 */
export class KaraokeMatcher {
  private syllables: KaraokeSyllable[] = []
  private destChars: string[] = []
  private groups: InternalMatchGroup[] = []
  private srcStart = 0
  private srcLen = 0
  private dstStart = 0
  private dstLen = 0

  /** 开始处理一对新行 */
  setInputData(src: KaraokeSyllable[], dst: string): void {
    this.syllables = src
    this.groups = []
    this.srcStart = 0
    this.srcLen = src.length > 0 ? 1 : 0

    this.destChars = graphemes(dst)
    this.dstStart = 0
    this.dstLen = this.destChars.length > 0 ? 1 : 0
  }

  /** 由已接受的配对组生成输出行（时长取整到厘秒，标签恒为 \k） */
  getOutputLine(): string {
    let result = ''
    for (const group of this.groups) {
      let duration = 0
      for (const syllable of group.src) duration += syllable.durationMs
      result += `{\\k${Math.trunc(duration / 10)}}${group.dst}`
    }
    return result
  }

  matchedGroups(): readonly KaraokeMatchGroup[] {
    return this.groups
  }

  currentSourceSelection(): KaraokeSyllable[] {
    return this.syllables.slice(this.srcStart, this.srcStart + this.srcLen)
  }

  unmatchedSource(): KaraokeSyllable[] {
    return this.syllables.slice(this.srcStart + this.srcLen)
  }

  currentDestinationSelection(): string {
    return this.destChars.slice(this.dstStart, this.dstStart + this.dstLen).join('')
  }

  unmatchedDestination(): string {
    return this.destChars.slice(this.dstStart + this.dstLen).join('')
  }

  /** 尚未配对的源音节数（含当前选择） */
  remainingSource(): number {
    return this.unmatchedSource().length + this.srcLen
  }

  /** 尚未配对的目标字符数（含当前选择） */
  remainingDestination(): number {
    return this.destChars.length - this.dstStart
  }

  increaseSourceMatch(): boolean {
    if (this.srcStart + this.srcLen < this.syllables.length) {
      this.srcLen += 1
      return true
    }
    return false
  }

  decreaseSourceMatch(): boolean {
    if (this.srcLen > 0) {
      this.srcLen -= 1
      return true
    }
    return false
  }

  increaseDestinationMatch(): boolean {
    if (this.dstStart + this.dstLen < this.destChars.length) {
      this.dstLen += 1
      return true
    }
    return false
  }

  decreaseDestinationMatch(): boolean {
    if (this.dstLen > 0) {
      this.dstLen -= 1
      return true
    }
    return false
  }

  /** 尝试按日语罗马字自动匹配当前剩余部分 */
  autoMatchJapanese(): void {
    const source = this.syllables.slice(this.srcStart).map((syllable) => syllable.text)
    const dst = this.destChars.slice(this.dstStart).join('')
    const match = autoMatchKaraoke(source, dst)
    this.srcLen = match.sourceLength
    this.dstLen = match.destinationLength
  }

  /** 接受当前选择；完全空的选择返回 false */
  acceptMatch(): boolean {
    if (this.srcLen === 0 && this.dstLen === 0) return false

    this.groups.push({
      src: this.currentSourceSelection(),
      dst: this.currentDestinationSelection(),
      srcStart: this.srcStart,
      srcLen: this.srcLen,
      dstStart: this.dstStart,
      dstLen: this.dstLen,
    })

    this.srcStart += this.srcLen
    this.dstStart += this.dstLen
    this.srcLen = 0
    this.dstLen = 0

    this.increaseSourceMatch()
    this.increaseDestinationMatch()
    return true
  }

  /** 撤销最后一次配对，并把它恢复为当前选择 */
  undoMatch(): boolean {
    const group = this.groups.pop()
    if (!group) return false

    this.srcStart = group.srcStart
    this.srcLen = group.srcLen
    this.dstStart = group.dstStart
    this.dstLen = group.dstLen
    return true
  }
}
