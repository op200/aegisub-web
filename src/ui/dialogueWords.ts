// dialogue_parser.cpp SplitWords / subs_edit_ctrl.cpp GetBoundsOfWordAtPosition 的 web 版。
// WORD 只从 TEXT token 切出（绘图、override、注释不参与拼写检查）。

import { tokenizeDialogueBody } from './assHighlight'

export interface DialogueWord {
  word: string
  /** UTF-16 偏移 */
  start: number
  end: number
}

const WORD_SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null

/** 把一段 TEXT 切成 WORD（Intl.Segmenter 的 isWordLike 对应 ICU UBRK_WORD_NONE 之外的类型） */
export function splitWords(text: string, offset = 0): DialogueWord[] {
  if (!text) return []
  if (!WORD_SEGMENTER) {
    const result: DialogueWord[] = []
    for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_'’-]+/gu)) {
      result.push({
        word: match[0],
        start: offset + (match.index ?? 0),
        end: offset + (match.index ?? 0) + match[0].length,
      })
    }
    return result
  }
  const result: DialogueWord[] = []
  for (const part of WORD_SEGMENTER.segment(text)) {
    if (!part.isWordLike) continue
    result.push({
      word: part.segment,
      start: offset + part.index,
      end: offset + part.index + part.segment.length,
    })
  }
  return result
}

/** 一行台词里所有可拼写检查的词（按出现顺序） */
export function dialogueWords(text: string): DialogueWord[] {
  const tokens = tokenizeDialogueBody(text)
  if (tokens.length === 0) return splitWords(text)
  const words: DialogueWord[] = []
  let offset = 0
  for (const token of tokens) {
    if (token.type === 'TEXT')
      words.push(...splitWords(text.slice(offset, offset + token.length), offset))
    offset += token.length
  }
  return words
}

/** GetBoundsOfWordAtPosition：右键位置落在 WORD 内才返回该词 */
export function wordAtPosition(text: string, position: number): DialogueWord | null {
  if (!text || position < 0 || position >= text.length) return null
  const tokens = tokenizeDialogueBody(text)
  let offset = 0
  for (const token of tokens) {
    if (offset + token.length <= position) {
      offset += token.length
      continue
    }
    if (token.type !== 'TEXT') return null
    const segment = text.slice(offset, offset + token.length)
    for (const word of splitWords(segment, offset)) {
      if (position >= word.start && position < word.end) return word
    }
    return null
  }
  return null
}
