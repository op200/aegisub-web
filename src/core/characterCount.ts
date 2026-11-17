// agi::CharacterCount / MaxLineLength 的 web 版（libaegisub/common/character_count.cpp）。
// ICU BreakIterator 的字符边界对应 Intl.Segmenter 的 grapheme 边界。

export const IGNORE_WHITESPACE = 1
export const IGNORE_PUNCTUATION = 2
export const IGNORE_BLOCKS = 4

const PUNCTUATION_RE = /^\p{P}/u
const WHITESPACE_RE = /^\p{Z}/u
const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** 按 grapheme cluster 切分（BMP/代理对/组合序列/ZWJ emoji 均算一个字符） */
export function graphemes(text: string): string[] {
  if (!text) return []
  if (!SEGMENTER) return Array.from(text)
  const out: string[] = []
  for (const part of SEGMENTER.segment(text)) out.push(part.segment)
  return out
}

function firstCodePoint(text: string): number {
  return text.codePointAt(0) ?? 0
}

/** count_in_range()：统计 range 内未被忽略的字符数 */
function countInRange(text: string, mask: number): number {
  if (!text) return 0
  if (!mask) return graphemes(text).length

  let count = 0
  let prev = 0
  for (const grapheme of graphemes(text)) {
    const cp = firstCodePoint(grapheme)
    const char = String.fromCodePoint(cp)
    const p = prev
    prev = cp

    if (
      ((mask & IGNORE_PUNCTUATION) !== 0 && PUNCTUATION_RE.test(char)) ||
      ((mask & IGNORE_WHITESPACE) !== 0 && WHITESPACE_RE.test(char))
    )
      continue

    // 前一个字符是反斜杠且当前在忽略空白时，检查 \n \N \h
    if (mask & IGNORE_WHITESPACE && p === 0x5c && 'nNh'.includes(char)) {
      // 忽略标点时反斜杠本身没被计数；否则需要把已经计上的反斜杠减掉
      if (!(mask & IGNORE_PUNCTUATION)) --count
      continue
    }

    ++count
  }
  return count
}

function ignoreMask(ignore: number): number {
  let mask = 0
  if (ignore & IGNORE_PUNCTUATION) mask |= IGNORE_PUNCTUATION
  if (ignore & IGNORE_WHITESPACE) mask |= IGNORE_WHITESPACE
  return mask
}

/** agi::CharacterCount：可跳过 {...} 块、空白与标点 */
export function characterCount(text: string, ignore = 0): number {
  const mask = ignoreMask(ignore)
  if ((ignore & IGNORE_BLOCKS) === 0) return countInRange(text, mask)

  let characters = 0
  let rest = text
  while (rest) {
    const pos = rest.indexOf('{')
    if (pos < 0) break
    const end = rest.indexOf('}')
    if (end < 0) break // 没有闭合 }，剩余部分（含 {）按字符计数
    if (pos > 0) characters += countInRange(rest.slice(0, pos), mask)
    rest = rest.slice(end + 1)
  }
  if (rest) characters += countInRange(rest, mask)
  return characters
}

/**
 * agi::MaxLineLength：只统计 TEXT，跳过 override 块与绘图，\N 分行、\h 为硬空格。
 * 未闭合的 override 块不产生 TEXT token，因此其后内容不计入。
 */
export function maxLineLength(text: string, ignore = 0): number {
  const mask = ignoreMask(ignore)
  let maxLine = 0
  let currentLine = 0
  let textStart = 0
  let i = 0
  // \p 绘图状态：Override 块中的 \pN 决定后续 TEXT 是否按绘图忽略
  let drawing = false

  const flushText = (end: number) => {
    if (drawing || end <= textStart) return
    currentLine += countInRange(text.slice(textStart, end), mask)
  }

  const updateDrawing = (block: string) => {
    const tagRe = /\\p([^\\}]*)/g
    let match: RegExpExecArray | null
    while ((match = tagRe.exec(block))) {
      const value = match[1]
      let next = false
      for (const char of value) {
        if (char >= '1' && char <= '9') {
          next = true
          continue
        }
        if (char !== '0') break
      }
      drawing = next
    }
  }

  while (i < text.length) {
    if (text[i] === '\\') {
      const next = text[i + 1]
      if (next === 'N' || next === 'n') {
        flushText(i)
        maxLine = Math.max(maxLine, currentLine)
        currentLine = 0
        i += 2
        textStart = i
        continue
      }
      if (next === 'h') {
        flushText(i)
        if (!(mask & IGNORE_WHITESPACE)) currentLine += 1
        i += 2
        textStart = i
        continue
      }
      i += 1
      continue
    }
    if (text[i] === '{') {
      flushText(i)
      const end = text.indexOf('}', i + 1)
      // 未闭合的 Override 块：MarkDrawings 不会把其后的 token 合并成 TEXT，整段忽略
      if (end < 0) {
        textStart = text.length
        break
      }
      updateDrawing(text.slice(i + 1, end))
      i = end + 1
      textStart = i
      continue
    }
    // 由一个 code point 起步；迭代到下一个特殊字符，组合序列不会被拆开
    i += text.codePointAt(i)! > 0xffff ? 2 : 1
  }
  flushText(text.length)
  return Math.max(maxLine, currentLine)
}

/** agi::IndexOfCharacter：第 n 个字符的 UTF-16 偏移 */
export function indexOfCharacter(text: string, n: number): number {
  if (!text || n === 0) return 0
  if (!SEGMENTER) {
    const list = Array.from(text)
    if (n >= list.length) return text.length
    return list.slice(0, n).join('').length
  }
  let index = 0
  for (const part of SEGMENTER.segment(text)) {
    if (n <= 0) return part.index
    n -= 1
    index = part.index + part.segment.length
  }
  return n > 0 ? text.length : index
}
