// 重设分辨率（分辨率重采样）——Aegisub Resolution Resampler 的 TS 移植
//
// 对齐源码：
//   - Aegisub/src/resolution_resampler.cpp（ResampleResolution 几何与标签重采样）
//   - Aegisub/src/dialog_resample.cpp（DialogResample 的初值/建议逻辑，UI 在 dialogs.tsx）
//   - Aegisub/src/ass_override.cpp（标签原型表、参数分类、tokenize/parse_parameters、序列化）
//   - Aegisub/src/ass_dialogue.cpp（ParseTags/UpdateText 的块切分与重写）
//   - Aegisub/libaegisub/{common/color,common/parser,common/ycbcr,common/ycbcr_conv,include/...}
//
// 与源码一致的关键语义（勿"顺手优化"）：
//   - 参数一律经 float_to_string（%.3f 去尾零）；INT 变换 trunc((v+shift)*resizer+0.5)
//   - 重写后 override 块按原型规范化序列化（\fad → \fad()、\b 1 → \b1、多余参数丢弃）
//   - 仅 Manual 以外模式禁用 margin；AddBorder/RemoveBorder 会覆写 margin[LEFT/RIGHT] 或 [TOP/BOTTOM]
//   - 整份文档一次 apply（单步撤销），label 与源码 Commit 描述一致："resolution resampling"

import type { CoreCommand, SubtitleCue, SubtitleDocument, SubtitleStyle } from './types'

// ---------------------------------------------------------------------------
// 基础工具（对齐 C 运行时与 agi/utils）
// ---------------------------------------------------------------------------

/** float_to_string（utils.h）：%.{precision}f 后去掉尾零（保留 '.' 前内容） */
export function floatToString(val: number, precision = 3): string {
  if (!Number.isFinite(val)) return val > 0 ? 'inf' : val < 0 ? '-inf' : 'nan'
  let s = val.toFixed(precision)
  // printf 对负值保留符号（含 -0 与入舍到 0 的负值：-0.0001 → "-0.000"）
  if (!s.startsWith('-') && (val < 0 || Object.is(val, -0))) s = `-${s}`
  let pos = -1
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] !== '0') {
      pos = i
      break
    }
  }
  if (pos !== s.indexOf('.')) pos += 1
  return s.slice(0, pos)
}

/** atoi：跳过前导空白与符号后取连续数字，无数字为 0 */
function atoi(text: string): number {
  const match = /^\s*([+-]?\d+)/.exec(text)
  return match ? Number(match[1]) : 0
}

/** atof：strtod 的前缀解析（不要求整串消费） */
function atof(text: string): number {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text)
  return match ? Number(match[1]) : 0
}

/** std::isspace（C locale）语义的 Trim */
function trim(text: string): string {
  return text.replace(/^[\t\n\v\f\r ]+/, '').replace(/[\t\n\v\f\r ]+$/, '')
}

// ---------------------------------------------------------------------------
// 颜色（libaegisub/color.h + common/parser.cpp color_grammar）
// ---------------------------------------------------------------------------

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const ZERO_COLOR: Rgba = { r: 0, g: 0, b: 0, a: 0 }

function unpackAbgr(value: number): Rgba {
  const v = value >>> 0
  return { r: v & 0xff, g: (v >>> 8) & 0xff, b: (v >>> 16) & 0xff, a: (v >>> 24) & 0xff }
}

function parseCssColor(s: string): Rgba | null {
  // rgb( / rgba(：分量 1-3 位十进制（uint_parser<unsigned char>：>255 解析失败）；
  // blank = *qi::blank（仅空格/制表符），且整串必须完全消费
  const rgba =
    /^rgba\([ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*\)(?![\s\S])/.exec(
      s,
    )
  if (rgba) {
    const [r, g, b, a] = rgba.slice(1).map(Number)
    return r <= 255 && g <= 255 && b <= 255 && a <= 255 ? { r, g, b, a } : null
  }
  const rgb =
    /^rgb\([ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*\)(?![\s\S])/.exec(s)
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number)
    return r <= 255 && g <= 255 && b <= 255 ? { r, g, b, a: 0 } : null
  }
  // #rrggbb 优先于 #rgb（与语法中的 hex_byte 先于 hex_char 一致）
  const byte = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})(?![\s\S])/.exec(s)
  if (byte)
    return { r: parseInt(byte[1], 16), g: parseInt(byte[2], 16), b: parseInt(byte[3], 16), a: 0 }
  const nibble = /^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])(?![\s\S])/.exec(s)
  if (nibble) {
    const [r, g, b] = nibble.slice(1).map((d) => parseInt(d, 16))
    return { r: r * 16 + r, g: g * 16 + g, b: b * 16 + b, a: 0 }
  }
  return null
}

function trailingBlanksOnly(s: string, from: number): boolean {
  return /^[ \t]*(?![\s\S])/.test(s.slice(from))
}

/** agi::Color(std::string_view)：解析失败返回 null（对应 C++ 默认 0,0,0,0） */
export function parseColor(text: string): Rgba | null {
  // parser::parse(Color&) 对空串直接失败；css_color 在前、ass_color 在后，无 skipper
  if (!text) return null
  const css = parseCssColor(text)
  if (css) return css
  // ass_color：int_（SSA 十进制，32 位内）优先——成功即不再尝试 16 进制（PEG 语义）
  const intMatch = /^[+-]?\d+/.exec(text)
  if (intMatch) {
    const value = Number(intMatch[0])
    if (value >= -2147483648 && value <= 2147483647) {
      return trailingBlanksOnly(text, intMatch[0].length) ? unpackAbgr(value) : null
    }
  }
  // 16 进制：可选 &、可选 H/h、8 位或 6 位、可选 &（8 位先于 6 位）
  const hexMatch = /^&?[Hh]?([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})&?/.exec(text)
  if (!hexMatch) return null
  if (!trailingBlanksOnly(text, hexMatch[0].length)) return null
  return unpackAbgr(parseInt(hexMatch[1], 16))
}

/** GetAssOverrideFormatted：&Hbbggrr&（无 alpha） */
export function formatAssOverrideColor(c: Rgba): string {
  return `&H${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}&`
}

/** GetAssStyleFormatted：&Haabbggrr */
export function formatAssStyleColor(c: Rgba): string {
  return `&H${hex2(c.a)}${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}`
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0')
}

// ---------------------------------------------------------------------------
// YCbCr（libaegisub/ycbcr.h + ycbcr_conv.h）
// ---------------------------------------------------------------------------

export type YcbcrMatrix = 'Unspecified' | 'BT709' | 'FCC' | 'BT470BG' | 'SMPTE170M' | 'SMPTE240M'
export type YcbcrRange = 'Unspecified' | 'MPEG' | 'JPEG'

export interface YcbcrColorspace {
  matrix: YcbcrMatrix
  range: YcbcrRange
}

export type YcbcrHeader =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'none' }
  | { kind: 'colorspace'; colorspace: YcbcrColorspace }

/** dialog_resample.cpp MatrixOptions（与 agi::ycbcr::valid_header_strings 刻意分开） */
export const MATRIX_OPTIONS = [
  '',
  'TV.601',
  'PC.601',
  'TV.709',
  'PC.709',
  'TV.FCC',
  'PC.FCC',
  'TV.240M',
  'PC.240M',
]

/** Header::Header(std::string)（ycbcr.cpp parse_ycbcr_header） */
export function parseYcbcrHeader(matrix: string): YcbcrHeader {
  // boost::to_lower_copy：按字节 ASCII 小写（勿用 JS toLowerCase 的 Unicode 语义）
  const lower = trim(matrix.replace(/[A-Z]/g, (c) => c.toLowerCase()))
  if (!lower) return { kind: 'missing' }
  if (lower === 'none') return { kind: 'none' }
  const parts = lower.split('.')
  let range: YcbcrRange = 'Unspecified'
  let mat: YcbcrMatrix = 'Unspecified'
  if (parts.length === 2) {
    if (parts[0] === 'tv') range = 'MPEG'
    else if (parts[0] === 'pc') range = 'JPEG'
    if (parts[1] === '709') mat = 'BT709'
    else if (parts[1] === '601') mat = 'SMPTE170M'
    else if (parts[1] === 'fcc') mat = 'FCC'
    else if (parts[1] === '240m') mat = 'SMPTE240M'
  }
  if (mat === 'Unspecified' || range === 'Unspecified') return { kind: 'invalid' }
  return { kind: 'colorspace', colorspace: { matrix: mat, range } }
}

/** Header::to_string：不可编码为 header 串时返回 null */
export function ycbcrHeaderToString(header: YcbcrHeader): string | null {
  if (header.kind === 'colorspace') {
    const prefix =
      header.colorspace.range === 'MPEG' ? 'TV' : header.colorspace.range === 'JPEG' ? 'PC' : null
    if (!prefix) return null
    switch (header.colorspace.matrix) {
      case 'BT709':
        return `${prefix}.709`
      case 'FCC':
        return `${prefix}.FCC`
      case 'BT470BG':
      case 'SMPTE170M':
        return `${prefix}.601`
      case 'SMPTE240M':
        return `${prefix}.240M`
      default:
        return null
    }
  }
  if (header.kind === 'none') return 'None'
  if (header.kind === 'missing') return ''
  return null
}

export function ycbcrHeaderValid(header: YcbcrHeader): boolean {
  return ycbcrHeaderToString(header) !== null
}

/** Header::to_effective：missing/invalid 按渲染器语义视作 TV.601 */
export function ycbcrHeaderToEffective(header: YcbcrHeader): YcbcrHeader {
  return ycbcrHeaderValid(header) && header.kind !== 'missing'
    ? header
    : { kind: 'colorspace', colorspace: { matrix: 'SMPTE170M', range: 'MPEG' } }
}

/** Header::to_existing：有效原样返回；无效 colorspace → None；否则 missing */
export function ycbcrHeaderToExisting(header: YcbcrHeader): YcbcrHeader {
  if (ycbcrHeaderValid(header)) return header
  if (header.kind === 'colorspace') return { kind: 'none' }
  return { kind: 'missing' }
}

/** Header::to_best_practice：仅 601/709 保留，其余 → None；missing/invalid → missing */
export function ycbcrHeaderToBestPractice(header: YcbcrHeader): YcbcrHeader {
  if (header.kind === 'colorspace') {
    const m = header.colorspace.matrix
    if (
      (m === 'BT709' || m === 'SMPTE170M' || m === 'BT470BG') &&
      header.colorspace.range !== 'Unspecified'
    ) {
      return header
    }
  } else if (header.kind === 'missing' || header.kind === 'invalid') {
    return { kind: 'missing' }
  }
  return { kind: 'none' }
}

export function ycbcrHeaderToExistingString(header: YcbcrHeader): string {
  return ycbcrHeaderToString(ycbcrHeaderToExisting(header)) ?? ''
}

export function ycbcrHeaderToBestPracticeString(header: YcbcrHeader): string {
  return ycbcrHeaderToString(ycbcrHeaderToBestPractice(header)) ?? ''
}

/** MatrixOptionFromHeader：查表得 MatrixOptions 下标，未命中为 0 */
export function matrixOptionFromHeader(header: YcbcrHeader): number {
  const index = MATRIX_OPTIONS.indexOf(ycbcrHeaderToExistingString(header))
  return index < 0 ? 0 : index
}

export interface YcbcrConverter {
  rgbToRgb(color: Rgba): Rgba
}

const MATRIX_COEFFICIENTS: Partial<Record<YcbcrMatrix, [number, number, number]>> = {
  BT709: [0.2126, 0.7152, 0.0722],
  FCC: [0.3, 0.59, 0.11],
  BT470BG: [0.299, 0.587, 0.114],
  SMPTE170M: [0.299, 0.587, 0.114],
  SMPTE240M: [0.212, 0.701, 0.087],
}

type Matrix3x3 = [number, number, number, number, number, number, number, number, number]

function prod(m: Matrix3x3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function rowMult(m: Matrix3x3, values: [number, number, number]): Matrix3x3 {
  // 每行乘一个系数（init_src：range 缩放）
  return [
    m[0] * values[0],
    m[1] * values[0],
    m[2] * values[0],
    m[3] * values[1],
    m[4] * values[1],
    m[5] * values[1],
    m[6] * values[2],
    m[7] * values[2],
    m[8] * values[2],
  ]
}

function colMult(m: Matrix3x3, values: [number, number, number]): Matrix3x3 {
  // 每列乘一个系数（init_dst：range 缩放）
  return [
    m[0] * values[0],
    m[1] * values[1],
    m[2] * values[2],
    m[3] * values[0],
    m[4] * values[1],
    m[5] * values[2],
    m[6] * values[0],
    m[7] * values[1],
    m[8] * values[2],
  ]
}

function clampByte(v: number): number {
  const i = Math.trunc(v)
  return i > 255 ? 255 : i < 0 ? 0 : i
}

/** ycbcr_converter(src, dst)：rgb → src YCbCr → dst YCbCr → rgb（rgb_to_rgb） */
export function createYcbcrConverter(src: YcbcrColorspace, dst: YcbcrColorspace): YcbcrConverter {
  const coeffSrc = MATRIX_COEFFICIENTS[src.matrix]
  const coeffDst = MATRIX_COEFFICIENTS[dst.matrix]
  if (!coeffSrc || !coeffDst) throw new Error('Unsupported colorspace conversion')

  const [Kr, Kg, Kb] = coeffSrc
  let toYcbcr: Matrix3x3 = [
    Kr,
    Kg,
    Kb,
    -Kr / (1 - Kb),
    -Kg / (1 - Kb),
    1,
    1,
    -Kg / (1 - Kr),
    -Kb / (1 - Kr),
  ]
  let shiftTo: [number, number, number]
  if (src.range === 'JPEG') {
    toYcbcr = rowMult(toYcbcr, [1, 0.5, 0.5])
    shiftTo = [0, 128, 128]
  } else {
    toYcbcr = rowMult(toYcbcr, [219 / 255, 112 / 255, 112 / 255])
    shiftTo = [16, 128, 128]
  }

  const [KrD, KgD, KbD] = coeffDst
  let fromYcbcr: Matrix3x3 = [
    1,
    0,
    1 - KrD,
    1,
    (-(1 - KbD) * KbD) / KgD,
    (-(1 - KrD) * KrD) / KgD,
    1,
    1 - KbD,
    0,
  ]
  let shiftFrom: [number, number, number]
  if (dst.range === 'JPEG') {
    fromYcbcr = colMult(fromYcbcr, [1, 2, 2])
    shiftFrom = [0, -128, -128]
  } else {
    fromYcbcr = colMult(fromYcbcr, [255 / 219, 255 / 112, 255 / 112])
    shiftFrom = [-16, -128, -128]
  }

  return {
    rgbToRgb(color) {
      const ycc = prod(toYcbcr, [color.r, color.g, color.b])
      const rgb = prod(fromYcbcr, [
        ycc[0] + shiftTo[0] + shiftFrom[0],
        ycc[1] + shiftTo[1] + shiftFrom[1],
        ycc[2] + shiftTo[2] + shiftFrom[2],
      ])
      return {
        r: clampByte(rgb[0] + 0.5),
        g: clampByte(rgb[1] + 0.5),
        b: clampByte(rgb[2] + 0.5),
        a: color.a,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// ass_override.cpp：标签原型表与参数解析
// ---------------------------------------------------------------------------

type VariableDataType = 'INT' | 'FLOAT' | 'TEXT' | 'BOOL' | 'BLOCK'

type ParameterClass =
  | 'NORMAL'
  | 'ABSOLUTE_SIZE_X'
  | 'ABSOLUTE_SIZE_Y'
  | 'ABSOLUTE_SIZE_XY'
  | 'ABSOLUTE_POS_X'
  | 'ABSOLUTE_POS_Y'
  | 'RELATIVE_SIZE_X'
  | 'RELATIVE_SIZE_Y'
  | 'RELATIVE_TIME_START'
  | 'RELATIVE_TIME_END'
  | 'KARAOKE'
  | 'DRAWING'
  | 'ALPHA'
  | 'COLOR'

/** AssParameterOptional：参数仅在"参数总数为指定位数"时存在 */
const NOT_OPTIONAL = 0xff
const OPTIONAL_2 = 0x02
const OPTIONAL_3 = 0x04
const OPTIONAL_4 = 0x08

interface ParamProto {
  optional: number
  type: VariableDataType
  cls: ParameterClass
}

interface TagProto {
  name: string
  params: ParamProto[]
}

function param(
  type: VariableDataType,
  cls: ParameterClass = 'NORMAL',
  optional = NOT_OPTIONAL,
): ParamProto {
  return { optional, type, cls }
}

function proto(name: string, ...params: ParamProto[]): TagProto {
  return { name, params }
}

/** 标签原型表（load_protos）：长名必须排在短名前，顺序与源码逐一对应 */
const TAG_PROTOS: TagProto[] = [
  proto('\\alpha', param('TEXT', 'ALPHA')),
  proto('\\bord', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto('\\xbord', param('FLOAT', 'ABSOLUTE_SIZE_X')),
  proto('\\ybord', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto('\\shad', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto('\\xshad', param('FLOAT', 'ABSOLUTE_SIZE_X')),
  proto('\\yshad', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto(
    '\\fade',
    param('INT'),
    param('INT'),
    param('INT'),
    param('INT', 'RELATIVE_TIME_START'),
    param('INT', 'RELATIVE_TIME_START'),
    param('INT', 'RELATIVE_TIME_START'),
    param('INT', 'RELATIVE_TIME_START'),
  ),
  proto(
    '\\move',
    param('FLOAT', 'ABSOLUTE_POS_X'),
    param('FLOAT', 'ABSOLUTE_POS_Y'),
    param('FLOAT', 'ABSOLUTE_POS_X'),
    param('FLOAT', 'ABSOLUTE_POS_Y'),
    param('INT', 'RELATIVE_TIME_START'),
    param('INT', 'RELATIVE_TIME_START'),
  ),
  // rect 与 vector 版 (i)clip 必须相邻（parse_parameters 的 ++proto_it 依赖此顺序）
  proto(
    '\\clip',
    param('INT', 'ABSOLUTE_POS_X'),
    param('INT', 'ABSOLUTE_POS_Y'),
    param('INT', 'ABSOLUTE_POS_X'),
    param('INT', 'ABSOLUTE_POS_Y'),
  ),
  proto('\\clip', param('INT', 'NORMAL', OPTIONAL_2), param('TEXT', 'DRAWING')),
  proto(
    '\\iclip',
    param('INT', 'ABSOLUTE_POS_X'),
    param('INT', 'ABSOLUTE_POS_Y'),
    param('INT', 'ABSOLUTE_POS_X'),
    param('INT', 'ABSOLUTE_POS_Y'),
  ),
  proto('\\iclip', param('INT', 'NORMAL', OPTIONAL_2), param('TEXT', 'DRAWING')),
  proto('\\fscx', param('FLOAT', 'RELATIVE_SIZE_X')),
  proto('\\fscy', param('FLOAT', 'RELATIVE_SIZE_Y')),
  proto('\\pos', param('FLOAT', 'ABSOLUTE_POS_X'), param('FLOAT', 'ABSOLUTE_POS_Y')),
  proto('\\org', param('FLOAT', 'ABSOLUTE_POS_X'), param('FLOAT', 'ABSOLUTE_POS_Y')),
  proto('\\pbo', param('INT', 'ABSOLUTE_SIZE_Y')),
  proto('\\fad', param('INT', 'RELATIVE_TIME_START'), param('INT', 'RELATIVE_TIME_END')),
  proto('\\fsp', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto('\\frx', param('FLOAT')),
  proto('\\fry', param('FLOAT')),
  proto('\\frz', param('FLOAT')),
  proto('\\fr', param('FLOAT')),
  proto('\\fax', param('FLOAT')),
  proto('\\fay', param('FLOAT')),
  proto('\\1c', param('TEXT', 'COLOR')),
  proto('\\2c', param('TEXT', 'COLOR')),
  proto('\\3c', param('TEXT', 'COLOR')),
  proto('\\4c', param('TEXT', 'COLOR')),
  proto('\\1a', param('TEXT', 'ALPHA')),
  proto('\\2a', param('TEXT', 'ALPHA')),
  proto('\\3a', param('TEXT', 'ALPHA')),
  proto('\\4a', param('TEXT', 'ALPHA')),
  proto('\\fe', param('TEXT')),
  proto('\\ko', param('INT', 'KARAOKE')),
  proto('\\kf', param('INT', 'KARAOKE')),
  proto('\\be', param('INT')),
  proto('\\blur', param('FLOAT')),
  proto('\\fn', param('TEXT')),
  proto('\\fs+', param('FLOAT')),
  proto('\\fs-', param('FLOAT')),
  proto('\\fs', param('FLOAT', 'ABSOLUTE_SIZE_Y')),
  proto('\\an', param('INT')),
  proto('\\c', param('TEXT', 'COLOR')),
  proto('\\b', param('INT')),
  proto('\\i', param('BOOL')),
  proto('\\u', param('BOOL')),
  proto('\\s', param('BOOL')),
  proto('\\a', param('INT')),
  proto('\\k', param('INT', 'KARAOKE')),
  proto('\\K', param('INT', 'KARAOKE')),
  proto('\\q', param('INT')),
  proto('\\p', param('INT')),
  proto('\\r', param('TEXT')),
  proto(
    '\\t',
    param('INT', 'RELATIVE_TIME_START', OPTIONAL_3 | OPTIONAL_4),
    param('INT', 'RELATIVE_TIME_START', OPTIONAL_3 | OPTIONAL_4),
    param('FLOAT', 'NORMAL', OPTIONAL_2 | OPTIONAL_4),
    param('BLOCK'),
  ),
]

/** 单个标签参数（AssOverrideParameter） */
class OverrideParam {
  omitted = true
  value = ''
  readonly type: VariableDataType
  readonly cls: ParameterClass
  /** BLOCK 参数的惰性内联块（Get<AssDialogueBlockOverride*> 仅在递归时构造） */
  blockTags: OverrideTag[] | null = null

  constructor(type: VariableDataType, cls: ParameterClass) {
    this.type = type
    this.cls = cls
  }

  set(value: string): void {
    this.omitted = false
    this.value = value
    this.blockTags = null
  }

  /** Get<std::string>：块已构造时用块文本（去首尾大括号） */
  getString(): string {
    if (this.blockTags) {
      let s = blockText(this.blockTags)
      if (s.startsWith('{')) s = s.slice(1)
      if (s.endsWith('}')) s = s.slice(0, -1)
      return s
    }
    return this.value
  }

  getInt(): number {
    return atoi(this.getString())
  }

  getIntDefault(def: number): number {
    return this.omitted ? def : this.getInt()
  }

  getDouble(): number {
    return atof(this.getString())
  }

  /** Set<int>：std::to_string(new_value) */
  setInt(value: number): void {
    this.set(String(Math.trunc(value)))
  }

  /** Set<double>：float_to_string */
  setDouble(value: number): void {
    this.set(floatToString(value))
  }
}

interface OverrideTag {
  name: string
  params: OverrideParam[]
  valid: boolean
}

/** tokenize（ass_override.cpp）：无括号整体为单参数，有括号按顶层逗号切分 */
function tokenize(text: string): string[] {
  const list: string[] = []
  if (!text) return list
  if (text[0] !== '(') {
    list.push(trim(text))
    return list
  }
  const len = text.length
  let i = 0
  let depth = 1
  while (i < len && depth > 0) {
    i += 1
    const start = i
    while (i < len && depth > 0) {
      const c = text[i]
      if (c === ',' && depth === 1) break
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        if (depth === 0) break
      }
      i += 1
    }
    list.push(trim(text.slice(start, i)))
  }
  if (i + 1 < len) list.push(text.slice(i + 1))
  return list
}

/** parse_parameters：按 parFlag 判断可选参数是否出现 */
function parseParameters(text: string, protoIndex: number): OverrideParam[] {
  const list = tokenize(text)
  const total = list.length
  // 1 << (total - 1)；total=0 时 JS 与 x86 C++ 同为 0x80000000（有符号位移出 31 位）
  const parsFlag = 1 << (total - 1)
  let protoParams = TAG_PROTOS[protoIndex].params
  const name = TAG_PROTOS[protoIndex].name
  if ((name === '\\clip' || name === '\\iclip') && total !== 4) {
    protoParams = TAG_PROTOS[protoIndex + 1].params
  }
  const params: OverrideParam[] = []
  let cur = 0
  for (const pp of protoParams) {
    const p = new OverrideParam(pp.type, pp.cls)
    params.push(p)
    if (!(pp.optional & parsFlag) || cur >= total) continue
    p.set(list[cur])
    cur += 1
  }
  return params
}

/** AssOverrideTag::SetText：按原型表前缀匹配，未命中为 junk 标签（原名保留） */
function parseOverrideTag(text: string): OverrideTag {
  const index = TAG_PROTOS.findIndex((p) => text.startsWith(p.name))
  if (index < 0) return { name: text, params: [], valid: false }
  return {
    name: TAG_PROTOS[index].name,
    params: parseParameters(text.slice(TAG_PROTOS[index].name.length), index),
    valid: true,
  }
}

/** AssDialogueBlockOverride::ParseTags：depth>0 时不切分（括号内的 \ 不算标签起点） */
function parseOverrideTags(text: string): OverrideTag[] {
  const tags: OverrideTag[] = []
  let depth = 0
  let start = 0
  for (let i = 1; i < text.length; i += 1) {
    if (depth > 0) {
      if (text[i] === ')') depth -= 1
    } else if (text[i] === '\\') {
      tags.push(parseOverrideTag(text.slice(start, i)))
      start = i
    } else if (text[i] === '(') {
      depth += 1
    }
  }
  if (text.length) tags.push(parseOverrideTag(text.slice(start)))
  return tags
}

/** operator std::string：Params.size()>1 加括号；仅序列化非 omitted 参数 */
function serializeTag(tag: OverrideTag): string {
  let result = tag.name
  const parentheses = tag.params.length > 1
  if (parentheses) result += '('
  result += tag.params
    .filter((p) => !p.omitted)
    .map((p) => p.getString())
    .join(',')
  if (parentheses) result += ')'
  return result
}

function blockText(tags: OverrideTag[]): string {
  return `{${tags.map(serializeTag).join('')}}`
}

// ---------------------------------------------------------------------------
// ass_dialogue.cpp：块切分与重写
// ---------------------------------------------------------------------------

type DialogueBlock =
  | { kind: 'plain'; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'drawing'; text: string; scale: number }
  | { kind: 'override'; tags: OverrideTag[] }

/** AssDialogue::ParseTags：{} 无 \ 视为注释块；未闭合 { 按纯文本处理；\p 控制绘制块 */
function parseDialogueBlocks(text: string): DialogueBlock[] {
  const blocks: DialogueBlock[] = []
  if (!text) return [{ kind: 'plain', text: '' }]

  let drawingLevel = 0
  const len = text.length
  let cur = 0
  while (cur < len) {
    if (text[cur] === '{') {
      const end = text.indexOf('}', cur)
      // VSFilter 语义：未闭合的 { 当作普通文本（源码 goto plain）
      if (end !== -1) {
        cur += 1
        const work = text.slice(cur, end)
        cur = end + 1
        if (work.length && !work.includes('\\')) {
          blocks.push({ kind: 'comment', text: `{${work}}` })
        } else {
          const tags = parseOverrideTags(work)
          for (const tag of tags) {
            if (tag.name === '\\p') drawingLevel = tag.params[0].getIntDefault(0)
          }
          blocks.push({ kind: 'override', tags })
        }
        continue
      }
    }

    // 纯文本 / 绘制块
    const next = text.indexOf('{', cur + 1)
    const work = next === -1 ? text.slice(cur) : text.slice(cur, next)
    cur = next === -1 ? len : next
    blocks.push(
      drawingLevel === 0
        ? { kind: 'plain', text: work }
        : { kind: 'drawing', text: work, scale: drawingLevel },
    )
  }
  return blocks
}

/** AssDialogueBlockOverride GetText / Plain / Comment / Drawing 的拼接（UpdateText） */
function blocksToText(blocks: DialogueBlock[]): string {
  return blocks
    .map((block) => (block.kind === 'override' ? blockText(block.tags) : block.text))
    .join('')
}

// ---------------------------------------------------------------------------
// resolution_resampler.cpp
// ---------------------------------------------------------------------------

/** transform_drawing：按空格分词；数值沿 x/y 交替缩放；命令字符重置轴；未识别 token 丢弃 */
function transformDrawing(
  drawing: string,
  shiftX: number,
  shiftY: number,
  scaleX: number,
  scaleY: number,
): string {
  let isX = true
  let out = ''
  for (const cur of drawing.split(' ')) {
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cur)) {
      const val = Number(cur)
      out += `${floatToString(isX ? (val + shiftX) * scaleX : (val + shiftY) * scaleY)} `
      isX = !isX
    } else if (cur.length === 1) {
      const c = cur.toLowerCase()
      if ('mnlbspc'.includes(c)) {
        isX = true
        out += `${c} `
      }
    }
  }
  return out.length ? out.slice(0, -1) : out
}

interface ResampleState {
  /** [LEFT, RIGHT, TOP, BOTTOM] */
  margin: [number, number, number, number]
  rx: number
  ry: number
  rm: number
  ar: number
  conv: YcbcrConverter | null
}

/** resample_tags 回调 */
function resampleParameter(par: OverrideParam, state: ResampleState): void {
  let resizer = 1
  let shift = 0
  switch (par.cls) {
    case 'ABSOLUTE_SIZE_X':
      resizer = state.rx
      break
    case 'ABSOLUTE_SIZE_Y':
      resizer = state.ry
      break
    case 'ABSOLUTE_SIZE_XY':
      resizer = state.rm
      break
    case 'ABSOLUTE_POS_X':
      resizer = state.rx
      shift = state.margin[0]
      break
    case 'ABSOLUTE_POS_Y':
      resizer = state.ry
      shift = state.margin[2]
      break
    case 'RELATIVE_SIZE_X':
      resizer = state.ar
      break
    case 'RELATIVE_SIZE_Y':
      break
    case 'DRAWING':
      par.set(
        transformDrawing(par.getString(), state.margin[0], state.margin[2], state.rx, state.ry),
      )
      return
    case 'COLOR':
      if (state.conv) {
        const color = parseColor(par.getString()) ?? ZERO_COLOR
        par.set(formatAssOverrideColor(state.conv.rgbToRgb(color)))
      }
      return
    default:
      return
  }
  if (par.type === 'FLOAT') par.setDouble((par.getDouble() + shift) * resizer)
  else if (par.type === 'INT') par.setInt(Math.trunc((par.getInt() + shift) * resizer + 0.5))
}

/** AssDialogueBlockOverride::ProcessParameters：先回调，再对 BLOCK 参数递归 */
function processParameters(tags: OverrideTag[], state: ResampleState): void {
  for (const tag of tags) {
    for (const par of tag.params) {
      if (par.omitted) continue
      resampleParameter(par, state)
      if (par.type === 'BLOCK') {
        // Get<AssDialogueBlockOverride*>：块仅在此惰性构造，构造源为当前 value
        if (!par.blockTags) par.blockTags = parseOverrideTags(par.value)
        processParameters(par.blockTags, state)
      }
    }
  }
}

/** resample_line：返回需要更新的字段（无变化返回 null，等价于提交后无差异） */
function resampleCue(
  cue: SubtitleCue,
  state: ResampleState,
): Partial<Omit<SubtitleCue, 'id'>> | null {
  // template/code 注释行不参与（kara-templater 输出）
  if (cue.comment && (cue.effect.startsWith('template') || cue.effect.startsWith('code')))
    return null

  const blocks = parseDialogueBlocks(cue.text)
  for (const block of blocks) {
    if (block.kind === 'override') processParameters(block.tags, state)
  }
  for (const block of blocks) {
    if (block.kind === 'drawing') {
      // 绘制块按 rx/ar、ry 变换（字体拉伸补偿；与 override 内 \p 参数不同）
      block.text = transformDrawing(block.text, 0, 0, state.rx / state.ar, state.ry)
    }
  }

  // Margin[0]=L, [1]=R, [2]=V；V 用 margin[TOP] 与 ry（源码如此）
  const margins: [number, number, number] = [cue.marginL, cue.marginR, cue.marginV]
  for (let i = 0; i < 3; i += 1) {
    if (margins[i]) {
      margins[i] = Math.trunc((margins[i] + state.margin[i]) * (i < 2 ? state.rx : state.ry) + 0.5)
    }
  }

  const text = blocksToText(blocks)
  const patch: Partial<Omit<SubtitleCue, 'id'>> = {}
  if (text !== cue.text) patch.text = text
  if (margins[0] !== cue.marginL) patch.marginL = margins[0]
  if (margins[1] !== cue.marginR) patch.marginR = margins[1]
  if (margins[2] !== cue.marginV) patch.marginV = margins[2]
  return Object.keys(patch).length ? patch : null
}

/** resample_style：字号/边框/阴影/间距/水平缩放/边距与颜色矩阵 */
function resampleStyle(
  style: SubtitleStyle,
  state: ResampleState,
): Partial<Omit<SubtitleStyle, 'id'>> {
  const patch: Partial<Omit<SubtitleStyle, 'id'>> = {
    fontSize: Math.trunc(style.fontSize * state.ry + 0.5),
    outline: style.outline * state.ry,
    shadow: style.shadow * state.ry,
    spacing: style.spacing * state.ry, // 渲染时还会乘 scalex（含 ar）
    scaleX: style.scaleX * state.ar,
    marginL: Math.trunc((style.marginL + state.margin[0]) * state.rx + 0.5),
    marginR: Math.trunc((style.marginR + state.margin[1]) * state.rx + 0.5),
    marginV: Math.trunc((style.marginV + state.margin[2]) * state.ry + 0.5),
  }
  if (state.conv) {
    patch.primaryColor = formatAssStyleColor(
      state.conv.rgbToRgb(parseColor(style.primaryColor) ?? ZERO_COLOR),
    )
    patch.secondaryColor = formatAssStyleColor(
      state.conv.rgbToRgb(parseColor(style.secondaryColor) ?? ZERO_COLOR),
    )
    patch.outlineColor = formatAssStyleColor(
      state.conv.rgbToRgb(parseColor(style.outlineColor) ?? ZERO_COLOR),
    )
    patch.backColor = formatAssStyleColor(
      state.conv.rgbToRgb(parseColor(style.backColor) ?? ZERO_COLOR),
    )
  }
  return patch
}

/** ResampleARMode（dialog_resample.cpp 的 ar_modes 顺序） */
export const RESAMPLE_AR_STRETCH = 0
export const RESAMPLE_AR_ADD_BORDERS = 1
export const RESAMPLE_AR_REMOVE_BORDERS = 2
export const RESAMPLE_AR_MANUAL = 3

export interface ResampleSettings {
  sourceX: number
  sourceY: number
  destX: number
  destY: number
  /** [LEFT, RIGHT, TOP, BOTTOM]（resolution_resampler.cpp margin[4]） */
  margin: [number, number, number, number]
  arMode: number
  /** 仅在两端都选了有效矩阵时非空（DialogResample::OnMatrixChange） */
  matrixConversion: { src: YcbcrColorspace; dst: YcbcrColorspace } | null
}

/** AssFile::GetResolution：PlayResX/Y + Gabest 缺省逻辑 */
export function getScriptResolution(scriptInfo: Record<string, string>): {
  width: number
  height: number
} {
  let width = atoi(getScriptInfo(scriptInfo, 'PlayResX'))
  let height = atoi(getScriptInfo(scriptInfo, 'PlayResY'))
  if (width === 0 && height === 0) {
    width = 384
    height = 288
  } else if (width === 0) {
    width = height === 1024 ? 1280 : Math.trunc((height * 4) / 3)
  } else if (height === 0) {
    height = width === 1280 ? 1024 : Math.trunc((width * 3) / 4)
  }
  return { width, height }
}

/** GetScriptInfo：键名大小写不敏感（boost::iequals） */
export function getScriptInfo(scriptInfo: Record<string, string>, key: string): string {
  if (key in scriptInfo) return scriptInfo[key]
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(scriptInfo)) {
    if (k.toLowerCase() === lower) return v
  }
  return ''
}

function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * ResampleResolution：一次生成整份文档的重采样命令（单步撤销）。
 * 返回空数组表示无任何变化（不应建立撤销点）。
 */
export function resampleCommands(
  document: SubtitleDocument,
  settings: ResampleSettings,
): CoreCommand[] {
  const margin: [number, number, number, number] = [...settings.margin]
  let horizontalStretch = 1
  let oldAr = settings.sourceX / settings.sourceY
  const newAr = settings.destX / settings.destY
  let borderHorizontally = newAr > oldAr
  // 宽高比非常接近时不处理（848x480 <-> 1280x720 为 .006）
  if (Math.abs(oldAr - newAr) / newAr > 0.01) {
    switch (settings.arMode) {
      case RESAMPLE_AR_REMOVE_BORDERS:
        borderHorizontally = !borderHorizontally
      // falls through（RemoveBorder 复用 AddBorder 的边界计算）
      case RESAMPLE_AR_ADD_BORDERS:
        if (borderHorizontally) {
          margin[0] = margin[1] = Math.trunc((settings.sourceY * newAr - settings.sourceX) / 2)
        } else {
          margin[2] = margin[3] = Math.trunc((settings.sourceX / newAr - settings.sourceY) / 2)
        }
        break
      case RESAMPLE_AR_STRETCH:
        horizontalStretch = newAr / oldAr
        break
      case RESAMPLE_AR_MANUAL:
        oldAr =
          (settings.sourceX + margin[0] + margin[1]) / (settings.sourceY + margin[2] + margin[3])
        if (Math.abs(oldAr - newAr) / newAr > 0.01) horizontalStretch = newAr / oldAr
        break
      default:
        break
    }
  }

  // LayoutRes 同步裁剪/拉伸（源码注释的约束 1/2；new_lry 用 source_x 除，勿改）
  const lrx = atoi(getScriptInfo(document.scriptInfo, 'LayoutResX'))
  const lry = atoi(getScriptInfo(document.scriptInfo, 'LayoutResY'))
  let newLrx = 0
  let newLry = 0
  if (lrx !== 0 && lry !== 0) {
    newLry = lry + roundHalfAwayFromZero((lry * (margin[2] + margin[3])) / settings.sourceX)
    newLrx = roundHalfAwayFromZero(
      (lrx * (newLry / lry) * (settings.destX / settings.destY)) /
        (settings.sourceX / settings.sourceY),
    )
  }

  const sourceX = settings.sourceX + margin[0] + margin[1]
  const sourceY = settings.sourceY + margin[2] + margin[3]
  const rx = settings.destX / sourceX
  const ry = settings.destY / sourceY
  const conversion = settings.matrixConversion
  const state: ResampleState = {
    margin,
    rx,
    ry,
    rm: rx === ry ? rx : Math.sqrt(rx * ry),
    ar: horizontalStretch,
    conv:
      conversion &&
      (conversion.src.matrix !== conversion.dst.matrix ||
        conversion.src.range !== conversion.dst.range)
        ? createYcbcrConverter(conversion.src, conversion.dst)
        : null,
  }

  const commands: CoreCommand[] = []

  const infoPatch: Record<string, string> = {
    PlayResX: String(settings.destX),
    PlayResY: String(settings.destY),
  }
  if (conversion) {
    // 源码：Header(settings.matrix_conversion->second).to_best_practice_string()
    infoPatch['YCbCr Matrix'] = ycbcrHeaderToBestPracticeString({
      kind: 'colorspace',
      colorspace: conversion.dst,
    })
  }
  if (lrx !== 0 && lry !== 0) {
    infoPatch.LayoutResX = String(newLrx)
    infoPatch.LayoutResY = String(newLry)
  }

  for (const style of document.styles) {
    commands.push({ type: 'updateStyle', id: style.id, patch: resampleStyle(style, state) })
  }
  for (const cue of document.cues) {
    const patch = resampleCue(cue, state)
    if (patch) commands.push({ type: 'updateCue', id: cue.id, patch })
  }

  const scriptInfoChanged = Object.entries(infoPatch).some(
    ([key, value]) => getScriptInfo(document.scriptInfo, key) !== value,
  )
  if (scriptInfoChanged) commands.unshift({ type: 'updateScriptInfo', patch: infoPatch })

  return commands
}
