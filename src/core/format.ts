import { parseBlocks, tagBool } from './assTags'
import { base64ToBytes, bytesToBase64 } from './bytes'
import {
  createCue,
  createDefaultStyle,
  createDocument,
  createProjectProperties,
  makeId,
} from './defaults'
import { formatAssTime, formatSrtTime, parseAssTime, parseEditorTime, parseSrtTime } from './time'
import type {
  ProjectProperties,
  SubtitleAttachment,
  SubtitleAttachmentGroup,
  SubtitleCue,
  SubtitleDocument,
  SubtitleExtradata,
  SubtitleStyle,
} from './types'

const STYLE_COLUMNS = [
  'Name',
  'Fontname',
  'Fontsize',
  'PrimaryColour',
  'SecondaryColour',
  'OutlineColour',
  'BackColour',
  'Bold',
  'Italic',
  'Underline',
  'StrikeOut',
  'ScaleX',
  'ScaleY',
  'Spacing',
  'Angle',
  'BorderStyle',
  'Outline',
  'Shadow',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'Encoding',
]
const SSA_STYLE_COLUMNS = [
  'Name',
  'Fontname',
  'Fontsize',
  'PrimaryColour',
  'SecondaryColour',
  'TertiaryColour',
  'BackColour',
  'Bold',
  'Italic',
  'BorderStyle',
  'Outline',
  'Shadow',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'AlphaLevel',
  'Encoding',
]
const EVENT_COLUMNS = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
]
const SSA_EVENT_COLUMNS = [
  'Marked',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
]
const KNOWN_SECTIONS = new Set([
  'Script Info',
  'V4+ Styles',
  'V4 Styles',
  'Events',
  'Fonts',
  'Graphics',
  'Aegisub Extradata',
  'Aegisub Project Garbage',
])

function splitFields(value: string, count: number): string[] {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < count - 1; index += 1) {
    const comma = value.indexOf(',', start)
    if (comma < 0) break
    fields.push(value.slice(start, comma).trim())
    start = comma + 1
  }
  fields.push(value.slice(start).trim())
  while (fields.length < count) fields.push('')
  return fields
}

function mapFields(columns: string[], values: string[]): Record<string, string> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']))
}

function boolField(value: string): boolean {
  return value === '-1' || value === '1' || value.toLowerCase() === 'true'
}

/** ass_style.cpp AssToSsa：ASS 小键盘对齐 → SSA 旧对齐编号 */
const ASS_TO_SSA_ALIGNMENT: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 9,
  5: 10,
  6: 11,
  7: 5,
  8: 6,
  9: 7,
}
const SSA_TO_ASS_ALIGNMENT: Record<number, number> = Object.fromEntries(
  Object.entries(ASS_TO_SSA_ALIGNMENT).map(([ass, ssa]) => [ssa, Number(ass)]),
)

function styleFromValues(values: Record<string, string>, ssa: boolean): SubtitleStyle {
  const alignment = Number(values.Alignment) || 2
  return {
    id: makeId('style'),
    name: values.Name || 'Default',
    fontName: values.Fontname || 'Arial',
    fontSize: Number(values.Fontsize) || 48,
    primaryColor: values.PrimaryColour || '&H00FFFFFF',
    secondaryColor: values.SecondaryColour || '&H0000FFFF',
    // SSA 的 TertiaryColour 对应 ASS 的 OutlineColour
    outlineColor: values.OutlineColour || values.TertiaryColour || '&H00000000',
    backColor: values.BackColour || '&H80000000',
    bold: boolField(values.Bold ?? ''),
    italic: boolField(values.Italic ?? ''),
    underline: boolField(values.Underline ?? ''),
    strikeout: boolField(values.StrikeOut ?? ''),
    scaleX: Number(values.ScaleX) || 100,
    scaleY: Number(values.ScaleY) || 100,
    spacing: Number(values.Spacing) || 0,
    angle: Number(values.Angle) || 0,
    borderStyle: Number(values.BorderStyle) || 1,
    outline: Number(values.Outline) || 0,
    shadow: Number(values.Shadow) || 0,
    alignment: (ssa ? SSA_TO_ASS_ALIGNMENT[alignment] : undefined) ?? alignment,
    marginL: Number(values.MarginL) || 0,
    marginR: Number(values.MarginR) || 0,
    marginV: Number(values.MarginV) || 0,
    encoding: Number(values.Encoding) || 1,
    values,
  }
}

function cueFromValues(values: Record<string, string>, comment: boolean): SubtitleCue {
  return {
    id: makeId('cue'),
    layer: Number(values.Layer ?? values.Marked) || 0,
    startMs: parseAssTime(values.Start ?? ''),
    endMs: parseAssTime(values.End ?? ''),
    style: values.Style || 'Default',
    actor: values.Name ?? values.Actor ?? '',
    marginL: Number(values.MarginL) || 0,
    marginR: Number(values.MarginR) || 0,
    marginV: Number(values.MarginV) || 0,
    effect: values.Effect ?? '',
    text: values.Text ?? '',
    comment,
    extra: values,
  }
}

// ---------------------------------------------------------------------------
// 附件（ass_attachment.cpp / uuencode.cpp）
// ---------------------------------------------------------------------------

const UU_ALPHABET_OFFSET = 33

export function uuEncode(data: Uint8Array, insertLinebreaks = true): string {
  let output = ''
  let written = 0
  for (let pos = 0; pos < data.length; pos += 3) {
    const src = [data[pos] ?? 0, data[pos + 1] ?? 0, data[pos + 2] ?? 0]
    const dst = [
      src[0] >> 2,
      ((src[0] & 0x03) << 4) | ((src[1] & 0xf0) >> 4),
      ((src[1] & 0x0f) << 2) | ((src[2] & 0xc0) >> 6),
      src[2] & 0x3f,
    ]
    const count = Math.min(data.length - pos + 1, 4)
    for (let index = 0; index < count; index += 1) {
      output += String.fromCharCode(dst[index] + UU_ALPHABET_OFFSET)
      written += 1
      if (insertLinebreaks && written === 80 && pos + 3 < data.length) {
        written = 0
        output += '\r\n'
      }
    }
  }
  return output
}

export function uuDecode(data: string): Uint8Array {
  const output: number[] = []
  let pos = 0
  while (pos + 1 < data.length) {
    const src = [0, 0, 0, 0]
    let bytes = 0
    for (let index = 0; index < 4 && pos < data.length; pos += 1) {
      const char = data.charCodeAt(pos)
      if (char !== 0 && char !== 10 && char !== 13) {
        src[index] = char - UU_ALPHABET_OFFSET
        index += 1
        bytes += 1
      }
    }
    if (bytes > 1) output.push((src[0] << 2) | (src[1] >> 4))
    if (bytes > 2) output.push(((src[1] & 0x0f) << 4) | (src[2] >> 2))
    if (bytes > 3) output.push(((src[2] & 0x03) << 6) | src[3])
  }
  return new Uint8Array(output)
}

/** ass_attachment.cpp：字体名沿用 SSA 约定，在 .ttf 前追加 `_0` */
export function makeAttachment(
  name: string,
  bytes: Uint8Array,
  group?: SubtitleAttachmentGroup,
): SubtitleAttachment {
  const lower = name.toLowerCase()
  const resolved: SubtitleAttachmentGroup =
    group ??
    (lower.endsWith('.ttf') || lower.endsWith('.ttc') || lower.endsWith('.pfb')
      ? 'font'
      : 'graphic')
  const stored =
    resolved === 'font' && lower.endsWith('.ttf') ? `${name.slice(0, -4)}_0${name.slice(-4)}` : name
  return { name: stored, group: resolved, data: bytesToBase64(bytes) }
}

/** AssAttachment::GetFileName(false)：界面/抽取时还原真实文件名 */
export function attachmentFileName(attachment: SubtitleAttachment): string {
  if (attachment.group !== 'font' || !attachment.name.toLowerCase().endsWith('.ttf')) {
    return attachment.name
  }
  const lastUnder = attachment.name.lastIndexOf('_')
  if (lastUnder < 0) return attachment.name
  return `${attachment.name.slice(0, lastUnder)}.ttf`
}

export function attachmentBytes(attachment: SubtitleAttachment): Uint8Array {
  return base64ToBytes(attachment.data)
}

export function findAttachment(
  document: SubtitleDocument,
  name: string,
  group: SubtitleAttachmentGroup,
): SubtitleAttachment | undefined {
  const lower = name.toLowerCase()
  return document.attachments.find(
    (attachment) => attachment.group === group && attachment.name.toLowerCase() === lower,
  )
}

// ---------------------------------------------------------------------------
// Extradata / Project Garbage 编码
// ---------------------------------------------------------------------------

/** libaegisub/ass/string_codec.h inline_string_encode（ASCII 控制字符与 # , : | 转义） */
export function inlineStringEncode(input: string): string {
  let output = ''
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || char === '#' || char === ',' || char === ':' || char === '|') {
      output += `#${code.toString(16).toUpperCase().padStart(2, '0')}`
    } else {
      output += char
    }
  }
  return output
}

export function inlineStringDecode(input: string): string {
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '#' || index + 2 >= input.length) {
      output += input[index]
    } else {
      output += String.fromCharCode(Number.parseInt(input.slice(index + 1, index + 3), 16))
      index += 2
    }
  }
  return output
}

const PROJECT_GARBAGE_KEYS: Record<string, keyof ProjectProperties> = {
  'automation scripts': 'automationScripts',
  'export filters': 'exportFilters',
  'export encoding': 'exportEncoding',
  'last style storage': 'styleStorage',
  'audio file': 'audioFile',
  'audio uri': 'audioFile',
  'video file': 'videoFile',
  'timecodes file': 'timecodesFile',
  'keyframes file': 'keyframesFile',
  'video zoom percent': 'videoZoom',
  'aegisub video zoom percent': 'videoZoom',
  'scroll position': 'scrollPosition',
  'aegisub scroll position': 'scrollPosition',
  'active line': 'activeRow',
  'aegisub active line': 'activeRow',
  'video position': 'videoPosition',
  'aegisub video position': 'videoPosition',
  'video ar mode': 'arMode',
  'video ar value': 'arValue',
}

function parseProjectGarbageLine(properties: ProjectProperties, key: string, value: string): void {
  const lower = key.trim().toLowerCase()
  if (lower.startsWith('automation settings')) {
    // ass_parser.cpp 保留前导空格作为脚本名的一部分
    properties.automationSettings[key.slice('Automation Settings'.length)] = value
    return
  }
  const field = PROJECT_GARBAGE_KEYS[lower]
  if (!field) return
  if (typeof properties[field] === 'number') {
    ;(properties as unknown as Record<string, number>)[field] = Number.parseInt(value, 10) || 0
  } else {
    ;(properties as unknown as Record<string, string>)[field] = value
  }
}

function parseExtradataLine(document: SubtitleDocument, raw: string): void {
  const match = /^Data:[ \t]*(\d+),([^,]+),(.)(.*)$/.exec(raw.trim())
  if (!match) return
  const id = Number.parseInt(match[1], 10)
  const key = inlineStringDecode(match[2])
  const valueType = match[3]
  const rawValue = match[4]
  let value = ''
  if (valueType === 'e') value = inlineStringDecode(rawValue)
  else if (valueType === 'u') value = new TextDecoder('utf-8').decode(uuDecode(rawValue))
  document.extradata.push({ id, key, value })
}

// ---------------------------------------------------------------------------
// ASS / SSA 读取
// ---------------------------------------------------------------------------

export interface AssParseOptions {
  /** 缺省按扩展名判断（与 AssSubtitleFormat::ReadFile 的 version 参数一致） */
  format?: 'ass' | 'ssa'
}

export function parseAss(
  text: string,
  sourceName = 'untitled.ass',
  options: AssParseOptions = {},
): SubtitleDocument {
  const document = createDocument(sourceName)
  document.cues = []
  document.styles = []
  document.scriptInfo = {}
  document.passthroughSections = []
  document.attachments = []
  document.extradata = []
  document.properties = createProjectProperties()

  const format: 'ass' | 'ssa' =
    options.format ?? (sourceName.toLowerCase().endsWith('.ssa') ? 'ssa' : 'ass')
  document.format = format

  let section = ''
  let styleColumns = format === 'ssa' ? SSA_STYLE_COLUMNS : STYLE_COLUMNS
  let eventColumns = format === 'ssa' ? SSA_EVENT_COLUMNS : EVENT_COLUMNS
  let passthrough: { name: string; lines: string[] } | null = null
  // [Fonts]/[Graphics] 当前附件
  let attachment: { name: string; group: SubtitleAttachmentGroup; chunks: string[] } | null = null

  const finishAttachment = () => {
    if (!attachment) return
    const encoded = attachment.chunks.join('')
    if (encoded) {
      document.attachments.push({
        name: attachment.name,
        group: attachment.group,
        data: bytesToBase64(uuDecode(encoded)),
      })
    }
    attachment = null
  }

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)]\s*$/)
    if (sectionMatch) {
      finishAttachment()
      section = sectionMatch[1]
      if (section === 'V4 Styles') {
        styleColumns = SSA_STYLE_COLUMNS
        eventColumns = SSA_EVENT_COLUMNS
      } else if (section === 'V4+ Styles') {
        styleColumns = STYLE_COLUMNS
        eventColumns = EVENT_COLUMNS
      } else if (section === 'Events') {
        eventColumns = format === 'ssa' ? SSA_EVENT_COLUMNS : EVENT_COLUMNS
      }
      passthrough = KNOWN_SECTIONS.has(section) ? null : { name: section, lines: [] }
      if (passthrough) document.passthroughSections.push(passthrough)
      continue
    }
    if (passthrough) {
      passthrough.lines.push(rawLine)
      continue
    }
    if (section === 'Fonts' || section === 'Graphics') {
      const header = section === 'Fonts' ? /^fontname:[ \t]*(.*)$/i : /^filename:[ \t]*(.*)$/i
      const headerMatch = header.exec(rawLine.trim())
      if (headerMatch) {
        finishAttachment()
        attachment = {
          name: headerMatch[1].trim(),
          group: section === 'Fonts' ? 'font' : 'graphic',
          chunks: [],
        }
        continue
      }
      const trimmed = rawLine.trim()
      // 与 ParseAttachmentLine 一致：33..96 的 80 列数据行
      if (attachment && trimmed.length > 0 && trimmed.length <= 80 && /^[!-`]+$/.test(trimmed)) {
        attachment.chunks.push(trimmed)
        continue
      }
      finishAttachment()
      continue
    }
    if (!rawLine.trim() || rawLine.trimStart().startsWith(';')) continue
    const colon = rawLine.indexOf(':')
    if (colon < 0) continue
    const key = rawLine.slice(0, colon).trim()
    const value = rawLine.slice(colon + 1).trim()
    if (section === 'Script Info') {
      document.scriptInfo[key] = value
    } else if (section === 'Aegisub Project Garbage') {
      parseProjectGarbageLine(document.properties, key, value)
    } else if (section === 'Aegisub Extradata') {
      parseExtradataLine(document, rawLine)
    } else if (section === 'V4+ Styles' || section === 'V4 Styles') {
      if (key === 'Format') styleColumns = value.split(',').map((item) => item.trim())
      if (key === 'Style') {
        const values = mapFields(styleColumns, splitFields(value, styleColumns.length))
        const ssa = section === 'V4 Styles' || values.TertiaryColour !== undefined
        document.styles.push(styleFromValues(values, ssa))
      }
    } else if (section === 'Events') {
      if (key === 'Format') eventColumns = value.split(',').map((item) => item.trim())
      if (key === 'Dialogue' || key === 'Comment') {
        document.cues.push(
          cueFromValues(
            mapFields(eventColumns, splitFields(value, eventColumns.length)),
            key === 'Comment',
          ),
        )
      }
    }
  }
  finishAttachment()

  if (!document.styles.length) document.styles.push(createDefaultStyle())
  if (!document.cues.length) document.cues.push(createCue())
  return document
}

// ---------------------------------------------------------------------------
// SRT 读取（subtitle_format_srt.cpp SrtTagParser::ToAss）
// ---------------------------------------------------------------------------

interface FontAttribs {
  face: string
  size: string
  color: string
}

/** agi::Color 的 HTML/ASS 颜色解析（color.cpp + parser.cpp） */
function parseSrtColor(input: string): string {
  const formatAss = (red: number, green: number, blue: number) => {
    const part = (v: number) =>
      Math.max(0, Math.min(255, v)).toString(16).toUpperCase().padStart(2, '0')
    return `&H${part(blue)}${part(green)}${part(red)}&`
  }
  const trimmed = input.trim()
  let match = /^#([0-9a-f]{3})$/i.exec(trimmed)
  if (match) {
    const [r, g, b] = match[1].split('')
    return formatAss(
      Number.parseInt(r + r, 16),
      Number.parseInt(g + g, 16),
      Number.parseInt(b + b, 16),
    )
  }
  match = /^#([0-9a-f]{6})$/i.exec(trimmed)
  if (match) {
    const value = Number.parseInt(match[1], 16)
    return formatAss((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
  }
  match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed)
  if (match) return formatAss(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^&?H([0-9a-f]+)&?$/i.exec(trimmed)
  if (match) {
    let value = Number.parseInt(match[1], 16)
    if (match[1].length <= 6) value &= 0xffffff
    return formatAss(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff)
  }
  if (/^\d+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10)
    return formatAss(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff)
  }
  return ''
}

class ToggleTag {
  private level = 0
  constructor(private readonly tag: string) {}

  open(output: string[]): void {
    if (this.level === 0) output.push(`{\\${this.tag}1}`)
    this.level += 1
  }

  close(output: string[]): void {
    if (this.level === 1) output.push(`{\\${this.tag}}`)
    if (this.level > 0) this.level -= 1
  }
}

const SRT_TAG_RE = /<(\/?b|\/?i|\/?u|\/?s|\/?font)([^>]*)>/gi
const SRT_ATTRIBUTE_RE = /[ \t]+(face|size|color)=('[^']*'|"[^"]*"|[^ \t]+)/gi

/** SrtTagParser::ToAss：<b>/<i>/<u>/<s>/<font face|size|color> → ASS 覆写标签 */
export function srtTagsToAss(srt: string): string {
  const bold = new ToggleTag('b')
  const italic = new ToggleTag('i')
  const underline = new ToggleTag('u')
  const strikeout = new ToggleTag('s')
  const fontStack: FontAttribs[] = []
  const output: string[] = []
  let cursor = 0

  for (const match of srt.matchAll(SRT_TAG_RE)) {
    const index = match.index ?? 0
    output.push(srt.slice(cursor, index))
    cursor = index + match[0].length
    const tagName = match[1].toLowerCase()
    const tagAttrs = match[2]

    switch (tagName) {
      case 'b':
        bold.open(output)
        break
      case '/b':
        bold.close(output)
        break
      case 'i':
        italic.open(output)
        break
      case '/i':
        italic.close(output)
        break
      case 'u':
        underline.open(output)
        break
      case '/u':
        underline.close(output)
        break
      case 's':
        strikeout.open(output)
        break
      case '/s':
        strikeout.close(output)
        break
      case 'font': {
        const oldAttribs: FontAttribs = fontStack.length
          ? fontStack[fontStack.length - 1]
          : { face: '', size: '', color: '' }
        const newAttribs: FontAttribs = { ...oldAttribs }
        // boost::regex_search + match_continuous：属性必须从当前位置连续匹配
        let attrCursor = 0
        const attrSource = tagAttrs
        SRT_ATTRIBUTE_RE.lastIndex = 0
        while (attrCursor <= attrSource.length) {
          SRT_ATTRIBUTE_RE.lastIndex = attrCursor
          const attr = SRT_ATTRIBUTE_RE.exec(attrSource)
          if (!attr || attr.index !== attrCursor) break
          const name = attr[1].toLowerCase()
          let value = attr[2]
          if (
            value.length >= 2 &&
            (value[0] === "'" || value[0] === '"') &&
            value[value.length - 1] === value[0]
          ) {
            value = value.slice(1, -1)
          }
          if (name === 'face') newAttribs.face = `{\\fn${value}}`
          else if (name === 'size') newAttribs.size = `{\\fs${value}}`
          else if (name === 'color') newAttribs.color = `{\\c${parseSrtColor(value)}}`
          attrCursor = attr.index + attr[0].length
        }
        if (newAttribs.face !== oldAttribs.face) output.push(newAttribs.face)
        if (newAttribs.size !== oldAttribs.size) output.push(newAttribs.size)
        if (newAttribs.color !== oldAttribs.color) output.push(newAttribs.color)
        fontStack.push(newAttribs)
        break
      }
      case '/font': {
        if (!fontStack.length) break
        const current = fontStack.pop() as FontAttribs
        const oldAttribs: FontAttribs = fontStack.length
          ? fontStack[fontStack.length - 1]
          : { face: '', size: '', color: '' }
        if (current.face !== oldAttribs.face) output.push(oldAttribs.face || '{\\fn}')
        if (current.size !== oldAttribs.size) output.push(oldAttribs.size || '{\\fs}')
        if (current.color !== oldAttribs.color) output.push(oldAttribs.color || '{\\c}')
        break
      }
      default:
        // 未知标签原样保留（源码把 tag 名转小写后写回）
        output.push(`<${tagName}${tagAttrs}>`)
        break
    }
  }
  output.push(srt.slice(cursor))
  return output.join('').replaceAll('}{', '')
}

const SRT_TIMESTAMP_RE =
  /^([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2},[0-9]+) --> ([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2},[0-9]+)/

export function parseSrt(text: string, sourceName = 'untitled.srt'): SubtitleDocument {
  const document = createDocument(sourceName)
  document.format = 'srt'
  document.cues = []
  document.passthroughSections = []
  document.attachments = []
  document.extradata = []
  document.properties = createProjectProperties()

  // 以空行分隔的块解析（SRT 容错：空行既可分隔字幕，也可出现在字幕内部）
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim())
    const timeIndex = lines.findIndex((line) => SRT_TIMESTAMP_RE.test(line))
    if (timeIndex < 0) continue
    const match = SRT_TIMESTAMP_RE.exec(lines[timeIndex]) as RegExpExecArray
    const cue = createCue(parseSrtTime(match[1]), parseSrtTime(match[2]))
    cue.text = srtTagsToAss(lines.slice(timeIndex + 1).join('\\N'))
    document.cues.push(cue)
  }
  if (!document.cues.length) document.cues.push(createCue())
  return document
}

// ---------------------------------------------------------------------------
// 写出
// ---------------------------------------------------------------------------

function styleValues(style: SubtitleStyle): Record<string, string> {
  // 数字字段兜底 ASS 默认值：上游（如旧版 WASM 核心投影）缺字段时不得产出 "undefined"，
  // 否则 libass 解析为 0（如 ScaleX=0 → 字形不可见）
  const num = (value: number | undefined, fallback: number) => String(value ?? fallback)
  return {
    ...style.values,
    Name: style.name,
    Fontname: style.fontName,
    Fontsize: num(style.fontSize, 48),
    PrimaryColour: style.primaryColor,
    SecondaryColour: style.secondaryColor,
    OutlineColour: style.outlineColor,
    BackColour: style.backColor,
    Bold: style.bold ? '-1' : '0',
    Italic: style.italic ? '-1' : '0',
    Underline: style.underline ? '-1' : '0',
    StrikeOut: style.strikeout ? '-1' : '0',
    ScaleX: num(style.scaleX, 100),
    ScaleY: num(style.scaleY, 100),
    Spacing: num(style.spacing, 0),
    Angle: num(style.angle, 0),
    BorderStyle: num(style.borderStyle, 1),
    Outline: num(style.outline, 2),
    Shadow: num(style.shadow, 0),
    Alignment: num(style.alignment, 2),
    MarginL: num(style.marginL, 10).padStart(4, '0'),
    MarginR: num(style.marginR, 10).padStart(4, '0'),
    MarginV: num(style.marginV, 10).padStart(4, '0'),
    Encoding: num(style.encoding, 1),
  }
}

function ssaStyleValues(style: SubtitleStyle): Record<string, string> {
  const values = styleValues(style)
  return {
    ...values,
    TertiaryColour: style.outlineColor,
    Alignment: String(ASS_TO_SSA_ALIGNMENT[style.alignment] ?? style.alignment),
    AlphaLevel: values.AlphaLevel ?? '0',
  }
}

function cueValues(cue: SubtitleCue, ssa: boolean): Record<string, string> {
  return {
    ...cue.extra,
    [ssa ? 'Marked' : 'Layer']: String(cue.layer),
    Start: formatAssTime(cue.startMs),
    End: formatAssTime(cue.endMs),
    Style: cue.style,
    Name: cue.actor,
    MarginL: String(cue.marginL).padStart(4, '0'),
    MarginR: String(cue.marginR).padStart(4, '0'),
    MarginV: String(cue.marginV).padStart(4, '0'),
    Effect: cue.effect,
    Text: cue.text,
  }
}

/** 逐行 ASS 文本缓存：视觉工具拖动时每帧都要导出整份文档，未变行直接复用。
 *  主线程 cue 对象不可变（变更来自 worker 的结构化克隆或增量合并产生的新对象），
 *  故可按对象身份缓存 */
const cueLineCache = new WeakMap<SubtitleCue, string>()

function assCueLine(cue: SubtitleCue): string {
  const cached = cueLineCache.get(cue)
  if (cached !== undefined) return cached
  const values = cueValues(cue, false)
  const line = `${cue.comment ? 'Comment' : 'Dialogue'}: ${EVENT_COLUMNS.map((column) => values[column] ?? '').join(',')}`
  cueLineCache.set(cue, line)
  return line
}

function projectGarbageLines(properties: ProjectProperties, saveUiState: boolean): string[] {
  const lines: string[] = []
  const add = (key: string, value: string) => {
    if (value) lines.push(`${key}: ${value}`)
  }
  const addNumber = (key: string, value: number) => {
    if (value !== 0) lines.push(`${key}: ${Math.trunc(value)}`)
  }
  add('Automation Scripts', properties.automationScripts)
  add('Export Filters', properties.exportFilters)
  add('Export Encoding', properties.exportEncoding)
  add('Last Style Storage', properties.styleStorage)
  add('Audio File', properties.audioFile)
  add('Video File', properties.videoFile)
  add('Timecodes File', properties.timecodesFile)
  add('Keyframes File', properties.keyframesFile)
  addNumber('Video AR Mode', properties.arMode)
  // std::to_string(double) 固定 6 位小数
  if (properties.arValue !== 0) lines.push(`Video AR Value: ${properties.arValue.toFixed(6)}`)
  if (saveUiState) {
    addNumber('Video Zoom Percent', properties.videoZoom)
    addNumber('Scroll Position', properties.scrollPosition)
    addNumber('Active Line', properties.activeRow)
    addNumber('Video Position', properties.videoPosition)
  }
  return lines
}

function extradataLines(extradata: SubtitleExtradata[]): string[] {
  return extradata.map((entry) => {
    const encodedKey = inlineStringEncode(entry.key)
    const encodedValue = inlineStringEncode(entry.value)
    const prefix = `Data: ${entry.id},${encodedKey},`
    if (4 * entry.value.length < 3 * encodedValue.length) {
      return `${prefix}u${uuEncode(new TextEncoder().encode(entry.value), false)}`
    }
    return `${prefix}e${encodedValue}`
  })
}

export interface AssExportOptions {
  /** 导出（非保存）时与 AssSubtitleFormat::ExportFile 一致：省略 Project Garbage 与 Extradata */
  clean?: boolean
  /** App/Save UI State；缺省 true */
  saveUiState?: boolean
}

function isSsaDocument(document: SubtitleDocument): boolean {
  return document.format === 'ssa'
}

export function exportAss(document: SubtitleDocument, options: AssExportOptions = {}): string {
  const clean = options.clean === true
  const saveUiState = options.saveUiState !== false
  const ssa = isSsaDocument(document)
  const styleColumns = ssa ? SSA_STYLE_COLUMNS : STYLE_COLUMNS
  const eventColumns = ssa ? SSA_EVENT_COLUMNS : EVENT_COLUMNS
  const info = { ScriptType: ssa ? 'v4.00' : 'v4.00+', ...document.scriptInfo }
  if (ssa) info.ScriptType = 'v4.00'

  const lines = [
    '[Script Info]',
    '; Script generated by Aegisub',
    '; https://aegisub.org/',
    ...Object.entries(info).map(([key, value]) => `${key}: ${value}`),
  ]

  if (!clean) {
    lines.push('', '[Aegisub Project Garbage]')
    lines.push(
      ...projectGarbageLines(document.properties ?? createProjectProperties(), saveUiState),
    )
  }

  lines.push('', ssa ? '[V4 Styles]' : '[V4+ Styles]', `Format: ${styleColumns.join(', ')}`)
  for (const style of document.styles) {
    const values = ssa ? ssaStyleValues(style) : styleValues(style)
    lines.push(
      `${ssa ? 'Style' : 'Style'}: ${styleColumns.map((column) => values[column] ?? '').join(',')}`,
    )
  }

  // 附件按 AssFile::Attachments 的连续分组写出（同一 section 头只写一次）
  let attachmentGroup: SubtitleAttachmentGroup | null = null
  for (const attachment of document.attachments ?? []) {
    if (attachment.group !== attachmentGroup) {
      lines.push('', attachment.group === 'font' ? '[Fonts]' : '[Graphics]')
      attachmentGroup = attachment.group
    }
    const header =
      attachment.group === 'font' ? `fontname: ${attachment.name}` : `filename: ${attachment.name}`
    lines.push(header, ...uuEncode(attachmentBytes(attachment), true).split(/\r\n/))
  }

  lines.push('', '[Events]', `Format: ${eventColumns.join(', ')}`)
  for (const cue of document.cues) {
    if (ssa) {
      const values = cueValues(cue, true)
      lines.push(
        `${cue.comment ? 'Comment' : 'Dialogue'}: ${eventColumns.map((column) => values[column] ?? '').join(',')}`,
      )
    } else {
      lines.push(assCueLine(cue))
    }
  }

  if (!clean && (document.extradata?.length ?? 0) > 0) {
    lines.push('', '[Aegisub Extradata]', ...extradataLines(document.extradata))
  }

  for (const section of document.passthroughSections) {
    lines.push('', `[${section.name}]`, ...section.lines)
  }

  return `${lines.join('\r\n')}\r\n`
}

// ---------------------------------------------------------------------------
// SRT 写出（subtitle_format_srt.cpp WriteFile）
// ---------------------------------------------------------------------------

function tagState(text: string): string {
  const state = { b: false, i: false, s: false, u: false }
  const output: string[] = []
  for (const block of parseBlocks(text)) {
    if (block.type === 'override') {
      for (const tag of block.tags) {
        if (tag.name.length !== 2) continue
        const letter = tag.name[1] as 'b' | 'i' | 's' | 'u'
        if (!(letter in state)) continue
        // AssOverrideTag::Params[0].Get(false)
        const value = tagBool(tag.params.split(',')[0] ?? '', false)
        if (value && !state[letter]) output.push(`<${letter}>`)
        if (!value && state[letter]) output.push(`</${letter}>`)
        state[letter] = value
      }
    } else if (block.type === 'plain') {
      output.push(block.text)
    }
  }
  for (const letter of ['b', 'i', 's', 'u'] as const) {
    if (state[letter]) output.push(`</${letter}>`)
  }
  return output.join('')
}

/** SRTSubtitleFormat::ConvertTags：ASS 覆写 → SRT 支持的 b/i/s/u 标签 */
export function convertTagsForSrt(text: string): string {
  return tagState(text)
}

/** AssDialogue::GetStrippedText：只保留 PLAIN 块（含 \N 等文本转义） */
export function strippedText(text: string): string {
  return parseBlocks(text)
    .filter((block) => block.type === 'plain')
    .map((block) => block.text)
    .join('')
}

/** AssFile::Sort(CompStart) */
export function sortCues(cues: SubtitleCue[]): SubtitleCue[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs)
}

export function stripComments(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.filter((cue) => !cue.comment && cue.text !== '')
}

/** SubtitleFormat::RecombineOverlaps（要求 cues 已按 Start 排序） */
export function recombineOverlaps(cues: SubtitleCue[]): SubtitleCue[] {
  const events = [...cues]
  let index = 0
  while (index + 1 < events.length) {
    const prev = events[index]
    const next = events[index + 1]
    if (prev.endMs <= next.startMs) {
      index += 1
      continue
    }
    events.splice(index, 2)
    const insert = (cue: SubtitleCue) => {
      const at = events.findIndex((item) => item.startMs >= cue.startMs)
      events.splice(at < 0 ? events.length : at, 0, cue)
    }
    if (next.startMs > prev.startMs) {
      insert({
        ...prev,
        id: makeId('cue'),
        startMs: prev.startMs,
        endMs: next.startMs,
        text: prev.text,
      })
    }
    insert({
      ...prev,
      id: makeId('cue'),
      startMs: next.startMs,
      endMs: Math.min(prev.endMs, next.endMs),
      text: `${next.text}\\N${prev.text}`,
    })
    if (prev.endMs > next.endMs) {
      insert({
        ...prev,
        id: makeId('cue'),
        startMs: next.endMs,
        endMs: prev.endMs,
        text: prev.text,
      })
    }
    if (next.endMs > prev.endMs) {
      insert({
        ...prev,
        id: makeId('cue'),
        startMs: prev.endMs,
        endMs: next.endMs,
        text: next.text,
      })
    }
    index = 0
  }
  return events
}

/** SubtitleFormat::MergeIdentical */
export function mergeIdentical(cues: SubtitleCue[]): SubtitleCue[] {
  const events: SubtitleCue[] = []
  for (const cue of cues) {
    const previous = events[events.length - 1]
    if (previous && previous.endMs === cue.startMs && previous.text === cue.text) {
      previous.startMs = Math.min(previous.startMs, cue.startMs)
      previous.endMs = Math.max(previous.endMs, cue.endMs)
    } else {
      events.push({ ...cue })
    }
  }
  return events
}

/** SubtitleFormat::ConvertNewlines（mergeLineBreaks=false） */
export function convertNewlines(text: string, newline: string): string {
  return text.replaceAll('\\h', ' ').replace(/\\n/gi, newline)
}

/** 各纯文本/帧基格式共用的导出预处理（Sort/StripComments/Recombine/Merge） */
export function prepareCuesForExport(cues: SubtitleCue[]): SubtitleCue[] {
  let prepared = sortCues(cues)
  prepared = stripComments(prepared)
  prepared = recombineOverlaps(prepared)
  prepared = mergeIdentical(prepared)
  return prepared
}

export function exportSrt(document: SubtitleDocument): string {
  let cues = [...document.cues].sort((a, b) => a.startMs - b.startMs)
  cues = stripComments(cues)
  cues = recombineOverlaps(cues)
  cues = mergeIdentical(cues)
  const chunks: string[] = []
  cues.forEach((cue, index) => {
    chunks.push(
      `${index + 1}\r\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\r\n${convertNewlines(convertTagsForSrt(cue.text), '\r\n')}`,
    )
  })
  return chunks.length ? `${chunks.map((chunk) => `${chunk}\r\n`).join('\r\n')}` : ''
}

// ---------------------------------------------------------------------------
// 行剪贴板（command/edit.cpp copy_lines / paste_lines）
// ---------------------------------------------------------------------------

/**
 * 剪贴板行序列化（AssDialogue::GetEntryData）：与文件写出的区别是 Style/Actor/Effect
 * 的逗号写成 `;`、不用四位数补零的 margin，且文本不含裸换行。
 */
export function formatCueEntryData(cue: SubtitleCue): string {
  const unsafe = (value: string) => value.replaceAll(',', ';')
  return [
    cue.comment ? 'Comment: ' : 'Dialogue: ',
    `${Math.trunc(cue.layer)},`,
    `${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},`,
    `${unsafe(cue.style)},${unsafe(cue.actor)},`,
    `${Math.trunc(cue.marginL)},${Math.trunc(cue.marginR)},${Math.trunc(cue.marginV)},`,
    `${unsafe(cue.effect)},`,
    cue.text.replace(/[\n\r]/g, ''),
  ].join('')
}

function parseIntegerField(value: string): number | null {
  // AssDialogue::Parse 用 lexical_cast<int>，非整数会整行解析失败
  const trimmed = value.trim()
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null
}

/**
 * AssDialogue::Parse 的剪贴板子集：`Dialogue:`/`Comment:` 前缀 + 9 个逗号分隔字段，
 * 失败返回 null（调用方按纯文本行回退，见 paste_lines/get_dialogue）。
 */
export function parseCueEntryData(raw: string): Omit<SubtitleCue, 'id'> | null {
  const line = raw.trim()
  const comment = line.startsWith('Comment:')
  if (!comment && !line.startsWith('Dialogue:')) return null
  const body = line.slice(comment ? 'Comment:'.length : 'Dialogue:'.length)

  const fields: string[] = []
  let start = 0
  for (let index = 0; index < 9; index++) {
    const comma = body.indexOf(',', start)
    if (comma < 0) return null
    fields.push(body.slice(start, comma))
    start = comma + 1
  }
  const text = body.slice(start)

  // SSA 行把 Layer 列写成 Marked=0
  const ssa = /^marked=/i.test(fields[0].trim())
  const layer = ssa ? 0 : parseIntegerField(fields[0])
  const marginL = parseIntegerField(fields[5])
  const marginR = parseIntegerField(fields[6])
  const marginV = parseIntegerField(fields[7])
  if (layer === null || marginL === null || marginR === null || marginV === null) return null
  const clampMargin = (value: number) => Math.max(-9999, Math.min(99999, value))

  return {
    layer,
    startMs: parseEditorTime(fields[1]) ?? 0,
    endMs: parseEditorTime(fields[2]) ?? 0,
    style: fields[3].trim(),
    actor: fields[4].trim(),
    marginL: clampMargin(marginL),
    marginR: clampMargin(marginR),
    marginV: clampMargin(marginV),
    effect: fields[8].trim(),
    text,
    comment,
    extra: {},
  }
}

/**
 * command/edit.cpp try_paste_lines：编辑框内粘贴时，整段必须全部是合法 ASS 行才按行
 * 插入（否则退回文本粘贴）。空行按 boost::char_separator 语义丢弃。
 */
export function parseCueEntryLines(text: string): Omit<SubtitleCue, 'id'>[] | null {
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (!lines.length) return null
  const cues: Omit<SubtitleCue, 'id'>[] = []
  for (const line of lines) {
    const cue = parseCueEntryData(line)
    if (!cue) return null
    cues.push(cue)
  }
  return cues
}
