/**
 * 对白文本块解析与翻译助手导航（ass_dialogue.cpp ParseTags + dialog_translation.cpp）。
 *
 * ParseTags 把一行文本拆成块（花括号丢弃、\p 进入绘图状态）：
 *   "Yes, I "      → plain（纯文本，可翻译）
 *   "{\i1}"        → override（含 \ 的 {...}；GetText 重建为 "{...}"）
 *   "{comment}"    → comment（不含 \ 的 {...}，源码视为注释）
 *   "m 0 0 l 1 1"  → drawing（\p 生效期间的花括号外文本）
 *
 * 翻译助手只处理 plain 块；空白 plain 块在 Tool/Translation Assistant/Skip Whitespace
 * 打开（默认）时同样跳过，其余块恒不可翻译（bad_block）。
 */

export type DialogueBlockType = 'plain' | 'comment' | 'override' | 'drawing'

export interface DialogueBlock {
  type: DialogueBlockType
  /** 块的完整文本（override/comment 含花括号，与源码 GetText 一致；提交时按此拼回） */
  text: string
}

/**
 * 取 override 块内顶层 \p 参数（AssDialogue::ParseTags 只遍历顶层 Tags，
 * \t(...) 内的 \p 属嵌套参数不参与）；块内无 \p 时返回 null（沿用当前绘图级别）。
 */
function drawingLevelOf(work: string): number | null {
  let level: number | null = null
  let depth = 0
  for (let index = 0; index < work.length;) {
    const char = work[index]
    if (char === '(') {
      depth += 1
      index += 1
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
    } else if (char === '\\' && depth === 0) {
      // 顶层标签：名称为连续 ASCII 字母（\p1 名 "p"，\pbo 名 "pbo"）
      let end = index + 1
      while (end < work.length && /[A-Za-z]/.test(work[end])) end += 1
      if (work.slice(index + 1, end) === 'p') {
        let digitsEnd = end
        while (digitsEnd < work.length && /\d/.test(work[digitsEnd])) digitsEnd += 1
        level = digitsEnd > end ? Number.parseInt(work.slice(end, digitsEnd), 10) : 0
      }
      index = end
    } else {
      index += 1
    }
  }
  return level
}

/** ass_dialogue.cpp AssDialogue::ParseTags 的移植 */
export function parseDialogueBlocks(text: string): DialogueBlock[] {
  const blocks: DialogueBlock[] = []
  // 空行：单个空 plain 块（源码特判）
  if (text.length === 0) return [{ type: 'plain', text: '' }]

  let drawingLevel = 0
  for (let cur = 0; cur < text.length;) {
    if (text[cur] === '{') {
      const end = text.indexOf('}', cur)
      // VSFilter 语义：override 块必须闭合，未闭合按纯文本处理（落到 plain 分支）
      if (end !== -1) {
        const work = text.slice(cur + 1, end)
        cur = end + 1
        if (work.length > 0 && !work.includes('\\')) {
          // 无反斜杠的 {...} 视为注释块
          blocks.push({ type: 'comment', text: `{${work}}` })
        } else {
          const level = drawingLevelOf(work)
          if (level !== null) drawingLevel = level
          blocks.push({ type: 'override', text: `{${work}}` })
        }
        continue
      }
    }

    // plain / drawing 块（源码 find('{', cur + 1)：跳过当前字符再找下一个 '{'）
    const end = text.indexOf('{', cur + 1)
    const work = end === -1 ? text.slice(cur) : text.slice(cur, end)
    cur = end === -1 ? text.length : end
    blocks.push({ type: drawingLevel === 0 ? 'plain' : 'drawing', text: work })
  }
  return blocks
}

/** agi::unicode::is_whitespace：全部字符为 Unicode 空白（空串同样为 true） */
export function isUnicodeWhitespace(text: string): boolean {
  return /^\s*$/u.test(text)
}

/** dialog_translation.cpp bad_block */
export function isBadBlock(block: DialogueBlock, skipWhitespace: boolean): boolean {
  return block.type !== 'plain' || (isUnicodeWhitespace(block.text) && skipWhitespace)
}

export interface BlockPosition {
  /** 活动行在 cues 中的下标（源码 AssDialogue::Row，0 基） */
  lineIndex: number
  /** 块下标 */
  blockIndex: number
}

/**
 * dialog_translation.cpp NextBlock/PrevBlock：
 * 在块间移动，跨行时取相邻行的首/末块；跳过全部 bad 块；到文档边界为止。
 * `blocks` 为当前行已解析的块（源码成员 blocks，可能已被提交改写）。
 */
export function stepDialogueBlock(
  cues: readonly { text: string }[],
  lineIndex: number,
  blocks: readonly DialogueBlock[],
  blockIndex: number,
  direction: 1 | -1,
  skipWhitespace: boolean,
): BlockPosition | null {
  let blocksLocal = blocks
  let index = lineIndex
  let position = blockIndex
  for (;;) {
    const atEdge = direction === 1 ? position === blocksLocal.length - 1 : position === 0
    if (atEdge) {
      const nextIndex = index + direction
      // 源码：selectionController->NextLine()/PrevLine() 到边界不移动 → 返回 false
      if (nextIndex < 0 || nextIndex >= cues.length) return null
      index = nextIndex
      blocksLocal = parseDialogueBlocks(cues[index].text)
      position = direction === 1 ? 0 : blocksLocal.length - 1
    } else {
      position += direction
    }
    if (!isBadBlock(blocksLocal[position], skipWhitespace)) break
  }
  return { lineIndex: index, blockIndex: position }
}

/**
 * 提交：源码 `*blocks[cur_block] = AssDialogueBlockPlain(new_value)` + `UpdateText(blocks)`
 * ——当前块替换为纯文本块（用户输入带花括号也不再拆分），再拼回整行文本。
 */
export function commitDialogueBlock(
  blocks: readonly DialogueBlock[],
  replaceIndex: number,
  newText: string,
): { blocks: DialogueBlock[]; text: string } {
  const updated = blocks.map((block, index) =>
    index === replaceIndex ? { type: 'plain' as const, text: newText } : block,
  )
  return { blocks: updated, text: updated.map((block) => block.text).join('') }
}
