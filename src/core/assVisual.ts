import { blockText, parseBlocks, type AssBlock, type AssTag } from './assTags'
import { rectangleToDrawing } from './spline'

/**
 * utils.cpp float_to_string：%.Nf 格式化后去尾零（逐行对应源码截断逻辑，
 * 含 "-0." 边界行为——源码对 -0.00x 保留末尾点号）。
 */
export function floatToString(value: number, precision = 2): string {
  const s = value.toFixed(precision)
  let pos = s.length - 1
  while (pos > 0 && s[pos] === '0') pos--
  if (pos !== s.indexOf('.')) pos++
  return s.slice(0, pos)
}

/**
 * printf "%.4g"：4 位有效数字并去尾零（visual_tool_rotate*.cpp 的 \frx/\fry/\frz 输出）。
 * 仅覆盖 UI 领域（角度 0..360）；指数越界时回退科学计数法格式。
 */
export function formatG4(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  const exponent = Math.floor(Math.log10(Math.abs(value)))
  if (exponent < -4 || exponent >= 4) {
    return value.toExponential(3).replace(/\.?0+e/, 'e')
  }
  const decimals = Math.max(0, 3 - exponent)
  const s = value.toFixed(decimals)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export interface AssVisualOverrides {
  pos?: { x: number; y: number }
  /** \move(x1,y1,x2,y2[,t1,t2])（visual_tool_drag.cpp GetLineMove） */
  move?: { x1: number; y1: number; x2: number; y2: number; t1?: number; t2?: number }
  /** \org(x,y) 旋转原点（visual_tool_rotate*.cpp） */
  org?: { x: number; y: number }
  scaleX: number
  scaleY: number
  rotationZ: number
  rotationX: number
  rotationY: number
  /** \fax/\fay 剪切（visual_tool_rotatexy.cpp 变换网格） */
  fax: number
  fay: number
  clip?: { inverse: boolean; x1: number; y1: number; x2: number; y2: number }
}

/** visual_tool.cpp find_tag：按块序扫描覆写块，返回首个同名标签 */
function findTagInBlocks(blocks: AssBlock[], name: string): AssTag | null {
  for (const block of blocks) {
    if (block.type !== 'override') continue
    for (const tag of block.tags) if (tag.name === name) return tag
  }
  return null
}

/** 标签参数 → 数值（Get<float>：解析失败/省略回退） */
function tagNum(tag: AssTag | null, fallback: number): number {
  if (!tag) return fallback
  const value = Number.parseFloat(tag.params)
  return Number.isFinite(value) ? value : fallback
}

/** 标签参数 "(x,y)" → 坐标（vec_or_bad：缺参返回 undefined） */
function tagXY(tag: AssTag | null): { x: number; y: number } | undefined {
  const match = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(tag?.params ?? '')
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined
}

export function readVisualOverrides(
  text: string,
  style?: { scaleX: number; scaleY: number; angle: number },
): AssVisualOverrides {
  const blocks = parseBlocks(text)
  const first = (name: string) => findTagInBlocks(blocks, name)
  const move = first('\\move')
  let moveInfo: AssVisualOverrides['move']
  if (move) {
    const match =
      /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?\d+)\s*,\s*(-?\d+)\s*)?\)/.exec(
        move.params,
      )
    if (match) {
      moveInfo = {
        x1: Number(match[1]),
        y1: Number(match[2]),
        x2: Number(match[3]),
        y2: Number(match[4]),
        ...(match[5] !== undefined && match[6] !== undefined
          ? { t1: Number(match[5]), t2: Number(match[6]) }
          : {}),
      }
    }
  }
  // GetLineRotation：rz 默认取样式 Angle，\frz 优先于 \fr
  const rotationZ = tagNum(first('\\frz'), tagNum(first('\\fr'), style?.angle ?? 0))
  return {
    pos: tagXY(first('\\pos')),
    move: moveInfo,
    org: tagXY(first('\\org')),
    // GetLineScale/GetLineRotation：默认取样式 ScaleX/ScaleY/Angle
    scaleX: tagNum(first('\\fscx'), style?.scaleX ?? 100),
    scaleY: tagNum(first('\\fscy'), style?.scaleY ?? 100),
    rotationZ,
    rotationX: tagNum(first('\\frx'), 0),
    rotationY: tagNum(first('\\fry'), 0),
    fax: tagNum(first('\\fax'), 0),
    fay: tagNum(first('\\fay'), 0),
    clip: (() => {
      // GetLineClip：\iclip 优先于 \clip；仅矩形形式（4 参数），矢量形式由调用方回退全屏矩形
      const tag = findTagInBlocks(blocks, '\\iclip') ?? findTagInBlocks(blocks, '\\clip')
      if (!tag) return undefined
      const match =
        /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(tag.params)
      return match
        ? {
            inverse: tag.name === '\\iclip',
            x1: Number(match[1]),
            y1: Number(match[2]),
            x2: Number(match[3]),
            y2: Number(match[4]),
          }
        : undefined
    })(),
  }
}

/** ass_style.cpp SsaToAss：SSA 旧对齐值 → ASS \an 值 */
function ssaToAss(ssaAlign: number): number {
  switch (ssaAlign) {
    case 1:
    case 2:
    case 3:
      return ssaAlign
    case 5:
      return 7
    case 6:
      return 8
    case 7:
      return 9
    case 9:
      return 4
    case 10:
      return 5
    case 11:
      return 6
    default:
      return 2
  }
}

/**
 * visual_tool.cpp GetLinePosition：无 \pos/\move 时按样式对齐与 Margin 推导默认位置。
 * 对齐优先级：\an 覆写 > \a（SSA 旧值，SsaToAss 转换）> Style.alignment；
 * 行 Margin 为 0 时回退样式 Margin。hor=(align-1)%3、vert=(align-1)/3。
 */
export function defaultLinePosition(
  cue: { marginL: number; marginR: number; marginV: number; text: string },
  style: { alignment: number; marginL: number; marginR: number; marginV: number } | undefined,
  playRes: { x: number; y: number },
): { x: number; y: number } {
  const margins = [cue.marginL, cue.marginR, cue.marginV]
  let align = 2
  if (style) {
    align = style.alignment
    const styleMargins = [style.marginL, style.marginR, style.marginV]
    for (let i = 0; i < 3; i++) if (margins[i] === 0) margins[i] = styleMargins[i]
  }
  let ovrAlign = 0
  const blocks = parseBlocks(cue.text)
  const an = findTagInBlocks(blocks, '\\an')
  if (an) ovrAlign = tagNum(an, 0)
  else {
    const a = findTagInBlocks(blocks, '\\a')
    if (a) ovrAlign = ssaToAss(tagNum(a, 2))
  }
  if (ovrAlign > 0 && ovrAlign <= 9) align = ovrAlign

  const hor = (align - 1) % 3
  const vert = Math.floor((align - 1) / 3)
  const x =
    hor === 0
      ? margins[0]
      : hor === 1
        ? (playRes.x + margins[0] - margins[1]) / 2
        : playRes.x - margins[1]
  const y = vert === 0 ? playRes.y - margins[2] : vert === 1 ? playRes.y / 2 : margins[2]
  return { x, y }
}

/** visual_tool.cpp SetOverride 的同名/互删标签表 */
const REMOVE_TAG: Record<string, string> = {
  '\\1c': '\\c',
  '\\frz': '\\fr',
  '\\pos': '\\move',
  '\\move': '\\pos',
  '\\clip': '\\iclip',
  '\\iclip': '\\clip',
}

/**
 * visual_tool.cpp SetOverride：首个块为覆写块时，删除块内同名/互删标签并把新标签
 * 追加到块尾（AddTag）；首个块为纯文本/注释/绘图块时，整体前插新覆写块。
 */
export function setOverride(text: string, tag: string, value: string): string {
  const name = `\\${tag}`
  const removeTag = REMOVE_TAG[name]
  const blocks = parseBlocks(text)
  const first = blocks[0]
  if (first && first.type === 'override') {
    first.tags = first.tags.filter(
      (existing) => existing.name !== name && existing.name !== removeTag,
    )
    first.tags.push({ name, params: value })
    return blocks.map(blockText).join('')
  }
  return `{${name}${value}}${text}`
}

/** drag 工具写 \pos（visual_tool_drag.cpp UpdateDrag：ToScriptCoords(pos).PStr()，两位小数去尾零） */
export function setPosition(text: string, x: number, y: number): string {
  return setOverride(text, 'pos', `(${floatToString(x)},${floatToString(y)})`)
}

export interface VectorClipInfo {
  inverse: boolean
  scale: number
  drawing: string
}

/**
 * 读取 \clip/\iclip 矢量标签（visual_tool.cpp GetLineVectorClip）：
 * \iclip 优先于 \clip（各取首个命中）；矩形形式转为可编辑折线；矢量形式带可选 scale 参数。
 */
export function readVectorClip(text: string): VectorClipInfo | null {
  const blocks = parseBlocks(text)
  const tag = findTagInBlocks(blocks, '\\iclip') ?? findTagInBlocks(blocks, '\\clip')
  if (!tag) return null
  const inverse = tag.name === '\\iclip'
  const raw = tag.params.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  const rect = raw.match(/^(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)$/)
  if (rect) {
    const [x1, y1, x2, y2] = rect.slice(1).map(Number)
    return { inverse, scale: 1, drawing: rectangleToDrawing(x1, y1, x2, y2) }
  }
  const scaled = raw.match(/^(\d+)\s*,\s*([\s\S]+)$/)
  if (scaled) {
    const scale = Math.max(1, Number(scaled[1]))
    return { inverse, scale, drawing: scaled[2].trim() }
  }
  return { inverse, scale: 1, drawing: raw }
}

/**
 * 写入 \clip/\iclip 并互删反向标签（visual_tool.cpp SetOverride：互删仅作用于首块）。
 */
export function setVectorClip(text: string, inverse: boolean, value: string): string {
  return setOverride(text, inverse ? 'iclip' : 'clip', value)
}
