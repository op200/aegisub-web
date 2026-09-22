/**
 * ASS 覆写标签块编辑（ass_dialogue.cpp ParseTags + command/edit.cpp parsed_line）。
 *
 * 供 EditPanel 的 B/I/U/S 切换（edit/style/*）、颜色（edit/color/*）与字体
 * （edit/font）标签写入使用，语义严格对齐源码：
 * - 块类型：PLAIN / OVERRIDE / COMMENT（无反斜杠的 {}）/ DRAWING（\p 期间）。
 * - set_tag：命中 OVERRIDE 块则替换块内同名（含 alt 名）标签参数并删除重复项，
 *   未命中则追加；PLAIN 文本则在光标处插入 {tag value}；COMMENT/DRAWING 块
 *   向前回退到上一块，orig_pos 回退到最近的 '{'。
 * - get_value：从 blockn 块向前查找同名标签（块内后者覆盖前者）。
 */

export type AssBlock =
  | { type: 'plain'; text: string }
  | { type: 'drawing'; text: string }
  | { type: 'comment'; text: string }
  | { type: 'override'; text: string; tags: AssTag[] }

export interface AssTag {
  /** 重生成文本（源码 operator std::string：Name + 参数） */
  name: string
  /** 名字后的参数（去前导空白） */
  params: string
}

/**
 * ass_override.cpp load_protos 的标签原型表（须保持源码顺序：长名在前，
 * 首个 starts_with 命中即为止，例如 \bord/\be/\blur 先于 \b、\fscx 先于 \fs）。
 */
const TAG_PROTOS = [
  '\\alpha',
  '\\bord',
  '\\xbord',
  '\\ybord',
  '\\shad',
  '\\xshad',
  '\\yshad',
  '\\fade',
  '\\move',
  '\\clip',
  '\\iclip',
  '\\fscx',
  '\\fscy',
  '\\pos',
  '\\org',
  '\\pbo',
  '\\fad',
  '\\fsp',
  '\\frx',
  '\\fry',
  '\\frz',
  '\\fr',
  '\\fax',
  '\\fay',
  '\\1c',
  '\\2c',
  '\\3c',
  '\\4c',
  '\\1a',
  '\\2a',
  '\\3a',
  '\\4a',
  '\\fe',
  '\\ko',
  '\\kf',
  '\\be',
  '\\blur',
  '\\fn',
  '\\fs+',
  '\\fs-',
  '\\fs',
  '\\an',
  '\\c',
  '\\b',
  '\\i',
  '\\u',
  '\\s',
  '\\a',
  '\\k',
  '\\K',
  '\\q',
  '\\p',
  '\\r',
  '\\t',
]

/** 解析标签名/参数（AssOverrideTag::SetText：原型表前缀命中；未命中为 junk 标签） */
function parseTag(raw: string): AssTag {
  for (const name of TAG_PROTOS) {
    if (raw.startsWith(name)) {
      return { name, params: raw.slice(name.length).replace(/^\s+/, '') }
    }
  }
  return { name: raw, params: '' }
}

/** ass_dialogue.cpp AssDialogue::ParseTags */
export function parseBlocks(text: string): AssBlock[] {
  if (text === '') return [{ type: 'plain', text: '' }]

  const blocks: AssBlock[] = []
  let drawingLevel = 0
  let cur = 0
  while (cur < text.length) {
    if (text[cur] === '{') {
      const end = text.indexOf('}', cur)
      // VSFilter 要求覆写块闭合，未闭合按普通文本
      if (end < 0) {
        blocks.push(
          drawingLevel > 0
            ? { type: 'drawing', text: text.slice(cur) }
            : { type: 'plain', text: text.slice(cur) },
        )
        break
      }
      const work = text.slice(cur + 1, end)
      cur = end + 1
      if (work.length > 0 && !work.includes('\\')) {
        // 无反斜杠的 {} 按注释块
        blocks.push({ type: 'comment', text: `{${work}}` })
      } else {
        const tags = parseOverrideTags(work)
        for (const tag of tags) if (tag.name === '\\p') drawingLevel = tagInt(tag.params, 0)
        blocks.push({ type: 'override', text: `{${work}}`, tags })
      }
      continue
    }
    const next = text.indexOf('{', cur + 1)
    const work = next < 0 ? text.slice(cur) : text.slice(cur, next)
    cur = next < 0 ? text.length : next
    blocks.push(drawingLevel > 0 ? { type: 'drawing', text: work } : { type: 'plain', text: work })
  }
  return blocks
}

/** ass_override.cpp AssDialogueBlockOverride::ParseTags（括号深度内不切分） */
function parseOverrideTags(work: string): AssTag[] {
  const tags: AssTag[] = []
  let depth = 0
  let start = 0
  for (let i = 1; i < work.length; i++) {
    if (depth > 0) {
      if (work[i] === ')') depth--
    } else if (work[i] === '\\') {
      tags.push(parseTag(work.slice(start, i)))
      start = i
    } else if (work[i] === '(') {
      depth++
    }
  }
  if (work.length > 0) tags.push(parseTag(work.slice(start)))
  return tags
}

/**
 * dialog_style_editor.cpp StyleRenamer::ProcessTag 的存在性检查：
 * 覆写块内 \r 标签的参数文本（源码 AssOverrideParameter 已去空白）等于样式名。
 */
export function hasStyleOverride(text: string, name: string): boolean {
  if (!text.includes('\\r')) return false
  for (const block of parseBlocks(text)) {
    if (block.type !== 'override') continue
    for (const tag of block.tags) {
      if (tag.name === '\\r' && tag.params.trim() === name) return true
    }
  }
  return false
}

/** 块序列化（AssDialogueBlockOverride::GetText：{Name+Params...}；其余原样） */
export function blockText(block: AssBlock): string {
  if (block.type === 'override') return `{${block.tags.map((t) => t.name + t.params).join('')}}`
  return block.text
}

/** command/edit.cpp block_at_pos：按普通字符位置定位块号 */
export function blockAtPos(text: string, pos: number): number {
  let n = 0
  const max = text.length - 1
  let inBlock = false
  let plain = pos
  for (let i = 0; i <= max; i++) {
    if (text[i] === '{') {
      if (!inBlock && i > 0 && plain >= 0) n++
      inBlock = true
    } else if (text[i] === '}' && inBlock) {
      inBlock = false
      if (plain > 0 && (i + 1 === max || text[i + 1] !== '{')) n++
    } else if (!inBlock) {
      if (--plain === 0) return n + (i < max && text[i + 1] === '{' ? 1 : 0)
    }
  }
  return n - (inBlock ? 1 : 0)
}

/** command/edit.cpp normalize_pos：原始位置 → 块外普通字符位置 */
export function normalizePos(text: string, pos: number): number {
  let plainLen = 0
  let inBlock = false
  const max = text.length - 1
  for (let i = 0; i < pos && i <= max; i++) {
    if (text[i] === '{') inBlock = true
    if (!inBlock) plainLen++
    if (text[i] === '}' && inBlock) inBlock = false
  }
  return plainLen
}

/** command/edit.cpp find_tag：从 blockn 块向前找同名（含 alt）标签，块内后者覆盖前者 */
export function findTag(blocks: AssBlock[], blockn: number, tag: string, alt = ''): AssTag | null {
  for (let b = Math.min(blockn, blocks.length - 1); b >= 0; b--) {
    const block = blocks[b]
    if (block.type !== 'override') continue
    for (let i = block.tags.length - 1; i >= 0; i--) {
      if (block.tags[i].name === tag || block.tags[i].name === alt) return block.tags[i]
    }
  }
  return null
}

function tagInt(params: string, fallback: number): number {
  const value = Number.parseInt(params, 10)
  return Number.isFinite(value) ? value : fallback
}

/** 参数按布尔读取（Get<bool>：非零为真，缺省回退） */
export function tagBool(params: string, fallback: boolean): boolean {
  const value = tagInt(params, Number.NaN)
  return Number.isFinite(value) ? value !== 0 : fallback
}

/** 参数按 &HBBGGRR(&) / 十进制颜色读取 → #RRGGBB（agi::Color 解析） */
export function tagColorHex(params: string): string | null {
  const hex = /&H([0-9a-f]{1,8})&?/i.exec(params)
  if (hex) {
    let value = Number.parseInt(hex[1], 16)
    if (!Number.isFinite(value)) return null
    // 不足 6 位视为 &HBBGGRR 的省略形式
    value &= 0xffffff
    const blue = (value >> 16) & 0xff
    const green = (value >> 8) & 0xff
    const red = value & 0xff
    const part = (v: number) => v.toString(16).padStart(2, '0')
    return `#${part(red)}${part(green)}${part(blue)}`
  }
  const decimal = /^\d+$/.exec(params.trim())
  if (decimal) {
    const value = Number.parseInt(decimal[0], 10) & 0xffffff
    const part = (v: number) => v.toString(16).padStart(2, '0')
    return `#${part(value & 0xff)}${part((value >> 8) & 0xff)}${part((value >> 16) & 0xff)}`
  }
  return null
}

/** #RRGGBB → &HBBGGRR&（agi::Color::GetAssOverrideFormatted） */
export function assOverrideColor(hex: string): string {
  const rgb = hex.replace('#', '').padStart(6, '0')
  const red = rgb.slice(0, 2)
  const green = rgb.slice(2, 4)
  const blue = rgb.slice(4, 6)
  return `&H${blue}${green}${red}&`.toUpperCase()
}

export interface SetTagResult {
  text: string
  /** 插入点之后文本的长度增量（源码 set_tag 返回的 shift） */
  shift: number
}

/**
 * command/edit.cpp parsed_line::set_tag：在指定位置写入 tag=value。
 * normPos 为普通字符位置（定位块），origPos 为原始文本位置（插入点）。
 */
export function setTag(
  text: string,
  tag: string,
  value: string,
  normPos: number,
  origPos: number,
): SetTagResult {
  const blocks = parseBlocks(text)
  let blockn = blockAtPos(text, normPos)
  let insertAt = origPos
  let target: AssBlock | null = null

  while (blockn >= 0 && !target) {
    const block = blocks[blockn]
    if (!block) break
    if (block.type === 'plain') target = block
    else if (block.type === 'drawing') blockn--
    else if (block.type === 'comment') {
      blockn--
      insertAt = text.lastIndexOf('{', insertAt)
    } else target = block
  }
  if (blockn < 0) insertAt = 0

  const insert = tag + value
  let shift = insert.length

  if ((target && target.type === 'plain') || blockn < 0 || !target) {
    const next = text.slice(0, insertAt) + '{' + insert + '}' + text.slice(insertAt)
    return { text: next, shift: shift + 2 }
  }

  if (target && target.type === 'override') {
    const alt = tag === '\\c' ? '\\1c' : ''
    let found = false
    const tags: AssTag[] = []
    for (const existing of target.tags) {
      if (existing.name === tag || (alt !== '' && existing.name === alt)) {
        shift -= existing.name.length + existing.params.length
        if (found) continue // 重复同名标签删除
        found = true
        tags.push({ name: existing.name, params: value })
      } else tags.push(existing)
    }
    if (!found) tags.push({ name: tag, params: value })
    target.tags = tags
  }

  return { text: blocks.map(blockText).join(''), shift }
}
