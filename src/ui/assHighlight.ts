/**
 * ASS 文本语法高亮分词（对齐 Aegisub SyntaxHighlighter 的样式语义）。
 * 颜色取自 Aegisub default_config.json 的 Colour/Subtitle/Syntax。
 */
import { getOptionBool, getOptionString } from '../config/options'
import { invertLightness } from './color'

export type AssSyntaxType =
  | 'NORMAL'
  | 'OVERRIDE'
  | 'TAG'
  | 'PARAMETER'
  | 'LINE_BREAK'
  | 'PUNCTUATION'
  | 'ERROR'
  | 'KARAOKE'

export interface AssHighlightSegment {
  text: string
  type: AssSyntaxType
}

/**
 * Aegisub Colour/Subtitle/Syntax 配色（default_config.json 默认值，
 * 运行时实际颜色经 getSyntaxColors 从 Preferences 读取）。
 */
export const ASS_SYNTAX_COLORS: Record<AssSyntaxType, { color: string; bold?: boolean }> = {
  NORMAL: { color: '#000000' },
  OVERRIDE: { color: '#1432ff' },
  TAG: { color: '#5a5a5a', bold: true },
  PARAMETER: { color: '#285a28' },
  LINE_BREAK: { color: '#a0a0a0', bold: true },
  PUNCTUATION: { color: '#1432ff' },
  ERROR: { color: '#c80000' },
  KARAOKE: { color: '#8000c0', bold: true },
}

/** AssSyntaxType → Colour/Subtitle/Syntax 选项名（preferences.cpp Interface_Colours） */
const SYNTAX_OPTION: Record<AssSyntaxType, { color: string; bold: string }> = {
  NORMAL: { color: 'Colour/Subtitle/Syntax/Normal', bold: 'Colour/Subtitle/Syntax/Bold/Normal' },
  OVERRIDE: {
    color: 'Colour/Subtitle/Syntax/Brackets',
    bold: 'Colour/Subtitle/Syntax/Bold/Brackets',
  },
  TAG: { color: 'Colour/Subtitle/Syntax/Tags', bold: 'Colour/Subtitle/Syntax/Bold/Tags' },
  PARAMETER: {
    color: 'Colour/Subtitle/Syntax/Parameters',
    bold: 'Colour/Subtitle/Syntax/Bold/Parameters',
  },
  LINE_BREAK: {
    color: 'Colour/Subtitle/Syntax/Line Break',
    bold: 'Colour/Subtitle/Syntax/Bold/Line Break',
  },
  PUNCTUATION: {
    color: 'Colour/Subtitle/Syntax/Slashes',
    bold: 'Colour/Subtitle/Syntax/Bold/Slashes',
  },
  ERROR: { color: 'Colour/Subtitle/Syntax/Error', bold: 'Colour/Subtitle/Syntax/Bold/Error' },
  KARAOKE: {
    color: 'Colour/Subtitle/Syntax/Karaoke Template',
    bold: 'Colour/Subtitle/Syntax/Bold/Karaoke Template',
  },
}

/** 当前生效的语法高亮配色（空字符串选项值 = 未自定义，回退默认；dark 主题按亮度反相适配） */
export function getSyntaxColors(
  dark = false,
): Record<AssSyntaxType, { color: string; bold?: boolean }> {
  const result = {} as Record<AssSyntaxType, { color: string; bold?: boolean }>
  for (const [type, defaults] of Object.entries(ASS_SYNTAX_COLORS) as [
    AssSyntaxType,
    { color: string; bold?: boolean },
  ][]) {
    const spec = SYNTAX_OPTION[type]
    const color = getOptionString(spec.color) || defaults.color
    result[type] = {
      color: dark ? invertLightness(color, { max: 0.93 }) : color,
      bold: getOptionBool(spec.bold),
    }
  }
  return result
}

const KARAOKE_TEMPLATE = /^\[(?:k|K)(?:f|F|o|O)?\d*(?:\s*\d+)?\s*\]/

/** 把 ASS 文本分成带样式类型的片段 */
export function tokenizeAss(text: string): AssHighlightSegment[] {
  const segments: AssHighlightSegment[] = []
  const push = (value: string, type: AssSyntaxType) => {
    if (value) segments.push({ text: value, type })
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]

    // 反斜杠：标签或换行符
    if (c === '\\') {
      const next = text[i + 1]
      if (next === 'N' || next === 'n' || next === 'h') {
        push(text.slice(i, i + 2), 'LINE_BREAK')
        i += 2
        continue
      }
      // 标签名（可能含 _ 与数字后缀，如 \1c 中的 1）
      let j = i + 1
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j]) && j - i < 6) j++
      const name = text.slice(i, j)
      // 卡拉 OK 模板 $k 等
      if (/^\$[a-zA-Z]/.test(text.slice(i))) {
        let k = i
        while (k < text.length && /[\w\d]/.test(text[k])) k++
        push(text.slice(i, k), 'KARAOKE')
        i = k
        continue
      }
      push(name, 'TAG')
      i = j

      // 参数：=值 或 (括号参数)
      if (text[i] === '=') {
        let k = i + 1
        while (
          k < text.length &&
          text[k] !== ',' &&
          text[k] !== ')' &&
          text[k] !== '{' &&
          text[k] !== '\\'
        )
          k++
        push(text.slice(i, k), 'PARAMETER')
        i = k
      } else if (text[i] === '(') {
        let depth = 0
        let k = i
        while (k < text.length) {
          if (text[k] === '(') depth++
          else if (text[k] === ')') {
            depth--
            if (depth === 0) {
              k++
              break
            }
          }
          k++
        }
        push(text.slice(i, k), 'PARAMETER')
        i = k
      }
      continue
    }

    if (c === '{') {
      push('{', 'OVERRIDE')
      i++
      continue
    }
    if (c === '}') {
      push('}', 'OVERRIDE')
      i++
      continue
    }
    if (c === ',' || c === '(' || c === ')') {
      push(c, 'PUNCTUATION')
      i++
      continue
    }

    // 普通文本段（含卡拉 OK 模板标记如 {\k20} 已由上面处理；这里是块外文本）
    let j = i
    while (
      j < text.length &&
      text[j] !== '\\' &&
      text[j] !== '{' &&
      text[j] !== '}' &&
      text[j] !== ','
    )
      j++
    const run = text.slice(i, j)
    // 块外以 [k...] 开头的卡拉 OK 模板
    if (KARAOKE_TEMPLATE.test(run)) push(run, 'KARAOKE')
    else push(run, 'NORMAL')
    i = j
  }
  return segments
}
