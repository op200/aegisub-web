/**
 * ASS 文本语法高亮（对齐 Aegisub 编辑框 SubsTextEditCtrl::UpdateStyle 的完整语义）。
 *
 * 分词移植自 libaegisub/common/parser.cpp 的 dialogue_tokens 状态机词法器
 * （INITIAL/OVR/TAGSTART/TAGNAME/ARG 五态 + karaoke templater 模式），
 * 绘图标记与样式映射移植自 libaegisub/ass/dialogue_parser.cpp 的
 * MarkDrawings/SplitDrawing/SyntaxHighlighter；
 * 颜色/粗体/下划线/背景取自 default_config.json 的 Colour/Subtitle/Syntax（SetStyles）。
 */
import { getOptionBool, getOptionString } from '../config/options'
import { invertLightness } from './color'

/** 语法高亮样式（agi::ass::SyntaxStyle，dialogue_parser.h） */
export type AssSyntaxType =
  | 'NORMAL'
  | 'COMMENT'
  | 'DRAWING_CMD'
  | 'DRAWING_X'
  | 'DRAWING_Y'
  | 'DRAWING_ENDPOINT_X'
  | 'DRAWING_ENDPOINT_Y'
  | 'OVERRIDE'
  | 'PUNCTUATION'
  | 'TAG'
  | 'ERROR'
  | 'PARAMETER'
  | 'LINE_BREAK'
  | 'KARAOKE_TEMPLATE'
  | 'KARAOKE_VARIABLE'

export interface AssHighlightSegment {
  text: string
  type: AssSyntaxType
}

/** Colour/Subtitle/Syntax 默认配色（default_config.json） */
export const ASS_SYNTAX_COLORS: Record<AssSyntaxType, string> = {
  NORMAL: 'rgb(0,0,0)',
  COMMENT: 'rgb(0,0,0)',
  DRAWING_CMD: 'rgb(0,0,0)',
  DRAWING_X: 'rgb(90,40,40)',
  DRAWING_Y: 'rgb(40,90,40)',
  DRAWING_ENDPOINT_X: 'rgb(90,40,40)',
  DRAWING_ENDPOINT_Y: 'rgb(40,90,40)',
  OVERRIDE: 'rgb(20, 50, 255)',
  PUNCTUATION: 'rgb(255, 0, 200)',
  TAG: 'rgb(90, 90, 90)',
  ERROR: 'rgb(200, 0, 0)',
  PARAMETER: 'rgb(40, 90, 40)',
  LINE_BREAK: 'rgb(160, 160, 160)',
  KARAOKE_TEMPLATE: 'rgb(128, 0, 192)',
  KARAOKE_VARIABLE: 'rgb(128, 0, 192)',
}

/**
 * AssSyntaxType → Colour/Subtitle/Syntax 选项名（subs_edit_ctrl.cpp SetStyles）。
 * 绘图端点坐标与普通坐标共用 Drawing X/Y 的配色，下划线由 Underline/Drawing Endpoint 控制。
 */
const SYNTAX_OPTION: Record<AssSyntaxType, string> = {
  NORMAL: 'Normal',
  COMMENT: 'Comment',
  DRAWING_CMD: 'Drawing Command',
  DRAWING_X: 'Drawing X',
  DRAWING_Y: 'Drawing Y',
  DRAWING_ENDPOINT_X: 'Drawing X',
  DRAWING_ENDPOINT_Y: 'Drawing Y',
  OVERRIDE: 'Brackets',
  PUNCTUATION: 'Slashes',
  TAG: 'Tags',
  ERROR: 'Error',
  PARAMETER: 'Parameters',
  LINE_BREAK: 'Line Break',
  KARAOKE_TEMPLATE: 'Karaoke Template',
  KARAOKE_VARIABLE: 'Karaoke Variable',
}

export interface AssSyntaxStyle {
  color: string
  bold: boolean
  underline: boolean
  /** 空串 = 用编辑框默认背景（源码里 Background/* 为字符串类型时回退默认背景） */
  background: string
}

/** 当前生效的语法高亮配色（dark 主题按亮度反相适配；源码无暗色主题概念） */
export function getSyntaxColors(dark = false): Record<AssSyntaxType, AssSyntaxStyle> {
  const result = {} as Record<AssSyntaxType, AssSyntaxStyle>
  for (const type of Object.keys(ASS_SYNTAX_COLORS) as AssSyntaxType[]) {
    const name = SYNTAX_OPTION[type]
    const color = getOptionString(`Colour/Subtitle/Syntax/${name}`) || ASS_SYNTAX_COLORS[type]
    const background = getOptionString(`Colour/Subtitle/Syntax/Background/${name}`)
    result[type] = {
      color: dark ? invertLightness(color, { max: 0.93 }) : color,
      bold: getOptionBool(`Colour/Subtitle/Syntax/Bold/${name}`),
      underline:
        type === 'DRAWING_ENDPOINT_X' || type === 'DRAWING_ENDPOINT_Y'
          ? getOptionBool('Colour/Subtitle/Syntax/Underline/Drawing Endpoint')
          : false,
      background: background
        ? dark
          ? invertLightness(background, { max: 0.93 })
          : background
        : '',
    }
  }
  return result
}

/** 词法 token 类型（agi::ass::DialogueTokenType） */
type AssTokenType =
  | 'TEXT'
  | 'LINE_BREAK'
  | 'OVR_BEGIN'
  | 'OVR_END'
  | 'TAG_START'
  | 'TAG_NAME'
  | 'OPEN_PAREN'
  | 'CLOSE_PAREN'
  | 'ARG_SEP'
  | 'ARG'
  | 'ERROR'
  | 'COMMENT'
  | 'WHITESPACE'
  | 'DRAWING_FULL'
  | 'DRAWING_CMD'
  | 'DRAWING_X'
  | 'DRAWING_Y'
  | 'DRAWING_ENDPOINT_X'
  | 'DRAWING_ENDPOINT_Y'
  | 'KARAOKE_TEMPLATE'
  | 'KARAOKE_VARIABLE'

export interface AssToken {
  type: AssTokenType
  length: number
}

const WHITESPACE_RE = /\s/
const KARAOKE_VARIABLE_RE = /[A-Za-z_]/
const TAG_NAME_LOWER_RE = /[a-z0-9]/
// 粘滞（y）匹配：必须从 lastIndex 处开始，否则 exec 会向后搜索到无关的匹配
const WHITESPACE_RUN_RE = /\s+/y
const LOWER_RUN_RE = /[a-z]+/y

/** 从 i 开始的最长匹配长度（粘滞匹配，避免每次切片造成 O(n²)） */
function runLength(re: RegExp, text: string, i: number): number {
  re.lastIndex = i
  const match = re.exec(text)
  return match ? match[0].length : 0
}

/** 词法器（parser.cpp TokenizeDialogueBody）：五状态最长匹配 + 相邻同类合并 */
export function tokenizeDialogueBody(text: string, karaokeTemplater = false): AssToken[] {
  const tokens: AssToken[] = []
  let state: 'INITIAL' | 'OVR' | 'TAGSTART' | 'TAGNAME' | 'ARG' = 'INITIAL'
  let parenDepth = 0

  const push = (type: AssTokenType, length: number) => {
    if (length <= 0) return
    const last = tokens[tokens.length - 1]
    if (last && last.type === type) last.length += length
    else tokens.push({ type, length })
  }

  // karaoke templater 模式专属规则（源码里非模板行用永不匹配的 \1 规则替代）
  const karaokeTemplateLength = (i: number): number => {
    if (!karaokeTemplater || text[i] !== '!') return 0
    const end = text.indexOf('!', i + 1)
    return end < 0 ? 0 : end - i + 1
  }
  const karaokeVariableLength = (i: number): number => {
    if (!karaokeTemplater || text[i] !== '$') return 0
    let j = i + 1
    while (j < text.length && KARAOKE_VARIABLE_RE.test(text[j])) j++
    return j > i + 1 ? j - i : 0
  }
  const whitespaceRunLength = (i: number): number =>
    WHITESPACE_RE.test(text[i]) ? runLength(WHITESPACE_RUN_RE, text, i) : 0

  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (state === 'INITIAL') {
      if (c === '\\' && (text[i + 1] === 'n' || text[i + 1] === 'N' || text[i + 1] === 'h')) {
        push('LINE_BREAK', 2)
        i += 2
        continue
      }
      if (c === '{') {
        parenDepth = 0
        state = 'OVR'
        push('OVR_BEGIN', 1)
        i++
        continue
      }
      const kara = c === '!' ? karaokeTemplateLength(i) : c === '$' ? karaokeVariableLength(i) : 0
      if (kara) {
        push(c === '!' ? 'KARAOKE_TEMPLATE' : 'KARAOKE_VARIABLE', kara)
        i += kara
        continue
      }
      push('TEXT', 1)
      i++
      continue
    }

    if (state === 'OVR') {
      if (c === '{') {
        push('ERROR', 1)
        i++
        continue
      }
      if (c === '}') {
        state = 'INITIAL'
        push('OVR_END', 1)
        i++
        continue
      }
      if (c === '\\') {
        state = 'TAGSTART'
        push('TAG_START', 1)
        i++
        continue
      }
      const ws = whitespaceRunLength(i)
      if (ws) {
        push('WHITESPACE', ws)
        i += ws
        continue
      }
      const kara = c === '!' ? karaokeTemplateLength(i) : c === '$' ? karaokeVariableLength(i) : 0
      if (kara) {
        push(c === '!' ? 'KARAOKE_TEMPLATE' : 'KARAOKE_VARIABLE', kara)
        i += kara
        continue
      }
      push('COMMENT', 1)
      i++
      continue
    }

    if (state === 'TAGSTART') {
      const ws = whitespaceRunLength(i)
      if (ws) {
        push('WHITESPACE', ws)
        i += ws
        continue
      }
      // r|fn 先于 [a-z0-9]（等长时先声明者胜）：\r 后直接进入 ARG 态
      if (text.startsWith('fn', i)) {
        push('TAG_NAME', 2)
        state = 'ARG'
        i += 2
        continue
      }
      if (c === 'r') {
        push('TAG_NAME', 1)
        state = 'ARG'
        i++
        continue
      }
      if (c === '\\') {
        push('TAG_START', 1)
        i++
        continue
      }
      if (c === '}') {
        state = 'INITIAL'
        push('OVR_END', 1)
        i++
        continue
      }
      if (TAG_NAME_LOWER_RE.test(c)) {
        push('TAG_NAME', 1)
        state = 'TAGNAME'
        i++
        continue
      }
      push('ARG', 1)
      state = 'ARG'
      i++
      continue
    }

    if (state === 'TAGNAME') {
      const lower = runLength(LOWER_RUN_RE, text, i)
      if (lower) {
        push('TAG_NAME', lower)
        state = 'ARG'
        i += lower
        continue
      }
      if (c === '(') {
        parenDepth++
        push('OPEN_PAREN', 1)
        state = 'ARG'
        i++
        continue
      }
      if (c === ')') {
        parenDepth--
        push('CLOSE_PAREN', 1)
        if (parenDepth === 0) state = 'OVR'
        i++
        continue
      }
      if (c === '}') {
        state = 'INITIAL'
        push('OVR_END', 1)
        i++
        continue
      }
      if (c === '\\') {
        state = 'TAGSTART'
        push('TAG_START', 1)
        i++
        continue
      }
      push('ARG', 1)
      state = 'ARG'
      i++
      continue
    }

    // ARG
    if (c === '{') {
      push('ERROR', 1)
      i++
      continue
    }
    if (c === '}') {
      state = 'INITIAL'
      push('OVR_END', 1)
      i++
      continue
    }
    if (c === '(') {
      parenDepth++
      push('OPEN_PAREN', 1)
      i++
      continue
    }
    if (c === ')') {
      parenDepth--
      push('CLOSE_PAREN', 1)
      if (parenDepth === 0) state = 'OVR'
      i++
      continue
    }
    if (c === '\\') {
      state = 'TAGSTART'
      push('TAG_START', 1)
      i++
      continue
    }
    if (c === ',') {
      push('ARG_SEP', 1)
      i++
      continue
    }
    const ws = whitespaceRunLength(i)
    if (ws) {
      push('WHITESPACE', ws)
      i += ws
      continue
    }
    const kara = c === '!' ? karaokeTemplateLength(i) : c === '$' ? karaokeVariableLength(i) : 0
    if (kara) {
      push(c === '!' ? 'KARAOKE_TEMPLATE' : 'KARAOKE_VARIABLE', kara)
      i += kara
      continue
    }
    push('ARG', 1)
    i++
  }

  return tokens
}

/**
 * 把 \p 之后的文本与向量 clip 参数标记为绘图（dialogue_parser.cpp MarkDrawings），
 * 并把最后一个未闭合覆盖块之后的所有 token 合并为纯文本（VSFilter 语义）。
 */
function markDrawings(str: string, tokens: AssToken[]): void {
  if (!tokens.length) return

  let lastOvrEnd = 0
  for (let i = tokens.length; i > 0; i--) {
    if (tokens[i - 1].type === 'OVR_END') {
      lastOvrEnd = i
      break
    }
  }

  let pos = 0
  let inDrawing = false

  for (let i = 0; i < lastOvrEnd; i++) {
    const len = tokens[i].length

    if (tokens[i].type === 'TEXT') {
      if (inDrawing) tokens[i].type = 'DRAWING_FULL'
    } else if (tokens[i].type === 'TAG_NAME') {
      // 向量 clip（含 iclip）：把括号内的整段参数并成一个绘图 token
      if (
        i + 3 < tokens.length &&
        (len === 4 || len === 5) &&
        str.slice(pos, pos + len).endsWith('clip') &&
        tokens[i + 1].type === 'OPEN_PAREN'
      ) {
        let drawingStart = 0
        let drawingEnd = 0
        for (let j = i + 2; j < tokens.length; j++) {
          if (tokens[j].type === 'ARG_SEP') {
            if (drawingStart) break // 两个以上参数 = 矩形 clip，不是绘图
            drawingStart = j + 1
          } else if (tokens[j].type === 'CLOSE_PAREN') {
            drawingEnd = j
            break
          } else if (tokens[j].type !== 'WHITESPACE' && tokens[j].type !== 'ARG') {
            break
          }
        }
        if (drawingEnd) {
          if (!drawingStart) drawingStart = i + 2
          if (drawingEnd !== drawingStart) {
            let tokenlen = 0
            for (let j = drawingStart; j < drawingEnd; j++) tokenlen += tokens[j].length
            tokens[drawingStart].length = tokenlen
            tokens[drawingStart].type = 'DRAWING_FULL'
            tokens.splice(drawingStart + 1, drawingEnd - drawingStart - 1)
            lastOvrEnd -= drawingEnd - drawingStart - 1
          }
        }
      }

      // \p<比例>：比例含 1-9 则后续文本按绘图着色（前导 0 视为 0）
      if (len === 1 && i + 1 < tokens.length && str[pos] === 'p') {
        inDrawing = false
        if (i + 1 !== lastOvrEnd && tokens[i + 1].type === 'ARG') {
          for (let j = pos + len; j < pos + len + tokens[i + 1].length; j++) {
            const c = str[j]
            if (c >= '1' && c <= '9') inDrawing = true
            else if (c !== '0') break
          }
        }
      }
    }

    pos += len
  }

  for (let i = lastOvrEnd; i < tokens.length;) {
    const token = tokens[i]
    if (
      token.type === 'KARAOKE_TEMPLATE' ||
      token.type === 'KARAOKE_VARIABLE' ||
      token.type === 'LINE_BREAK'
    ) {
      i++
      continue
    }
    token.type = inDrawing ? 'DRAWING_FULL' : 'TEXT'
    if (i > 0 && tokens[i - 1].type === token.type) {
      tokens[i - 1].length += token.length
      tokens.splice(i, 1)
      continue
    }
    i++
  }
}

/**
 * 把绘图 token 切成命令/坐标/空白并标注类型（WordSplitter::SplitDrawing）。
 * 返回拆分后最后一个 token 的下标（源码里 SwitchTo 的 ++i 等价物）。
 */
function splitDrawing(text: string, start: number, tokens: AssToken[], index: number): number {
  const total = tokens[index].length
  const runs: AssToken[] = []
  let p = 0
  while (p < total) {
    const isWs = text[start + p] === ' ' || text[start + p] === '\t'
    let q = p + 1
    while (q < total && (text[start + q] === ' ' || text[start + q] === '\t') === isWs) q++
    runs.push({ type: isWs ? 'WHITESPACE' : 'DRAWING_FULL', length: q - p })
    p = q
  }
  tokens.splice(index, 1, ...runs)

  let dpos = start
  let numCoord = 0
  let lastCmd = ' '
  for (let j = index; j < index + runs.length; j++) {
    const token = tokens[j]
    const c = text[dpos]
    if (token.type === 'WHITESPACE') {
      // 空白不参与命令/坐标判定
    } else if (lastCmd === ' ' && c !== 'm') {
      token.type = 'ERROR' // 绘图必须以 m 开头
    } else if (
      c === 'm' ||
      c === 'n' ||
      c === 'l' ||
      c === 's' ||
      c === 'b' ||
      c === 'p' ||
      c === 'c'
    ) {
      token.type = 'DRAWING_CMD'
      if (token.length !== 1) token.type = 'ERROR'
      if (numCoord % 2 !== 0) token.type = 'ERROR'
      lastCmd = c
      numCoord = 0
    } else {
      let valid = true
      for (let k = 0; k < token.length; k++) {
        const ch = text[dpos + k]
        if (
          !(
            (ch >= '0' && ch <= '9') ||
            ch === '.' ||
            ch === '+' ||
            ch === '-' ||
            ch === 'e' ||
            ch === 'E'
          )
        )
          valid = false
      }
      if (!valid) token.type = 'ERROR'
      else if (lastCmd === 'b' && numCoord % 6 >= 4)
        token.type = numCoord % 2 === 0 ? 'DRAWING_ENDPOINT_X' : 'DRAWING_ENDPOINT_Y'
      else token.type = numCoord % 2 === 0 ? 'DRAWING_X' : 'DRAWING_Y'
      numCoord++
    }
    dpos += token.length
  }

  return index + runs.length - 1
}

/** 拆分绘图 token（SplitWords；web 侧无拼写检查，故不做单词切分） */
function splitDrawings(text: string, tokens: AssToken[]): void {
  let pos = 0
  for (let i = 0; i < tokens.length; i++) {
    const len = tokens[i].length
    if (tokens[i].type === 'DRAWING_FULL') i = splitDrawing(text, pos, tokens, i)
    pos += len
  }
}

/** token → 语法样式的映射（SyntaxHighlighter::Highlight，相邻同类合并） */
function syntaxHighlight(text: string, tokens: AssToken[]): AssHighlightSegment[] {
  const styled: { type: AssSyntaxType; length: number }[] = []
  const setStyling = (length: number, type: AssSyntaxType) => {
    if (length <= 0) return
    const last = styled[styled.length - 1]
    if (last && last.type === type) last.length += length
    else styled.push({ type, length })
  }

  for (const token of tokens) {
    const len = token.length
    switch (token.type) {
      case 'KARAOKE_TEMPLATE':
        setStyling(len, 'KARAOKE_TEMPLATE')
        break
      case 'KARAOKE_VARIABLE':
        setStyling(len, 'KARAOKE_VARIABLE')
        break
      case 'LINE_BREAK':
        setStyling(len, 'LINE_BREAK')
        break
      case 'ERROR':
        setStyling(len, 'ERROR')
        break
      case 'ARG':
        setStyling(len, 'PARAMETER')
        break
      case 'COMMENT':
        setStyling(len, 'COMMENT')
        break
      case 'DRAWING_CMD':
        setStyling(len, 'DRAWING_CMD')
        break
      case 'DRAWING_X':
        setStyling(len, 'DRAWING_X')
        break
      case 'DRAWING_Y':
        setStyling(len, 'DRAWING_Y')
        break
      case 'DRAWING_ENDPOINT_X':
        setStyling(len, 'DRAWING_ENDPOINT_X')
        break
      case 'DRAWING_ENDPOINT_Y':
        setStyling(len, 'DRAWING_ENDPOINT_Y')
        break
      case 'TEXT':
        setStyling(len, 'NORMAL')
        break
      case 'TAG_NAME':
        setStyling(len, 'TAG')
        break
      case 'OPEN_PAREN':
      case 'CLOSE_PAREN':
      case 'ARG_SEP':
      case 'TAG_START':
        setStyling(len, 'PUNCTUATION')
        break
      case 'OVR_BEGIN':
      case 'OVR_END':
        setStyling(len, 'OVERRIDE')
        break
      case 'WHITESPACE': {
        const last = styled[styled.length - 1]
        if (last && last.type === 'PARAMETER') setStyling(len, 'PARAMETER')
        // 端点坐标之间的空白继承 X 的样式，使下划线连成一段
        else if (last && last.type === 'DRAWING_ENDPOINT_X') setStyling(len, 'DRAWING_ENDPOINT_X')
        else setStyling(len, 'NORMAL')
        break
      }
      default:
        // DRAWING_FULL 已在 SplitWords 中拆开；兜底按普通文本以免丢失字符
        setStyling(len, 'NORMAL')
    }
  }

  const segments: AssHighlightSegment[] = []
  let pos = 0
  for (const style of styled) {
    segments.push({ text: text.slice(pos, pos + style.length), type: style.type })
    pos += style.length
  }
  return segments
}

/**
 * 把 ASS 文本分成带样式类型的片段。
 * karaokeTemplater = 源码 SubsTextEditCtrl::UpdateStyle 的 template_line：
 * 活动行是 Comment 且 Effect 以 "template" 开头（不区分大小写）。
 */
export function tokenizeAss(text: string, karaokeTemplater = false): AssHighlightSegment[] {
  const tokens = tokenizeDialogueBody(text, karaokeTemplater)
  markDrawings(text, tokens)
  splitDrawings(text, tokens)
  return syntaxHighlight(text, tokens)
}
