/**
 * Lua Automation 行模型（对应 Aegisub auto4_lua_assfile.cpp 的 LuaAssFile）。
 *
 * 纯 JS 层，不依赖 fengari：
 * - 行空间 = Info + Styles + Events（1-based），字段逐字对齐 AssEntryToLua / LuaToAssEntry；
 * - raw 采用 GetEntryData / UpdateData 的规范序列化（Aegisub 载入即规范化，语义等价）；
 * - 提交（ProcessingComplete）以 replaceDocument 整表重放，info 段仅在脚本触碰过时携带。
 *
 * 颜色文法见 libaegisub/common/parser.cpp 的 color_grammar，序列化见 color.cpp。
 */

import { createCue, createDefaultStyle, makeId } from '../core/defaults'
import { formatAssTime } from '../core/time'
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from '../core/types'

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

export interface AssColor {
  r: number
  g: number
  b: number
  a: number
}

/** abgr 解包（parser.cpp unpack_colors：r 低字节，a 高字节） */
function abgrColor(value: number): AssColor {
  const abgr = value >>> 0
  return {
    r: abgr & 0xff,
    g: (abgr >>> 8) & 0xff,
    b: (abgr >>> 16) & 0xff,
    a: (abgr >>> 24) & 0xff,
  }
}

function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * parser.cpp: color = css_color | ass_color，整串消耗（ass 形允许尾随空白，css 形不允许）。
 * 失败或空串 → Color 默认值全 0（color.h 各分量默认 0）。
 */
export function parseAssColor(input: string): AssColor {
  const zero: AssColor = { r: 0, g: 0, b: 0, a: 0 }
  if (!input) return zero

  // css：rgb()/rgba()（十进制分量 1..3 位，>255 失败）与 #RRGGBB / #RGB（单字符双写）
  if (input.startsWith('#')) {
    const hex = input.slice(1)
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const nibble = (ch: string) => parseInt(ch, 16) * 17
      return { r: nibble(hex[0]), g: nibble(hex[1]), b: nibble(hex[2]), a: 0 }
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 0,
      }
    }
    return zero
  }
  const rgb = input.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/)
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    return r <= 255 && g <= 255 && b <= 255 ? { r, g, b, a: 0 } : zero
  }
  const rgba = input.match(
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
  )
  if (rgba) {
    const [r, g, b, a] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
    return r <= 255 && g <= 255 && b <= 255 && a <= 255 ? { r, g, b, a } : zero
  }

  // ass：int_（十进制 SSA）优先，其后 &H(8|6)hex&（& 与 H 各自可选），允许尾随空白
  const decimal = input.match(/^([+-]?\d+)[ \t]*$/)
  if (decimal) {
    const value = Number(decimal[1])
    if (Number.isSafeInteger(value) && Math.abs(value) <= 0xffffffff) return abgrColor(value)
    return zero
  }
  const hex = input.match(/^&?[Hh]?([0-9a-fA-F]{8}|[0-9a-fA-F]{6})&?[ \t]*$/)
  if (hex) return abgrColor(parseInt(hex[1], 16))
  return zero
}

/** Color::GetAssStyleFormatted：&HAABBGGRR（大写，无尾部 &） */
export function formatCoreColor(color: AssColor): string {
  return `&H${hexByte(color.a)}${hexByte(color.b)}${hexByte(color.g)}${hexByte(color.r)}`
}

/** AssEntryToLua 的 color1..4：GetAssStyleFormatted + "&" */
export function formatLuaStyleColor(color: AssColor): string {
  return `${formatCoreColor(color)}&`
}

/** Color::GetHexFormatted（true = #RRGGBBAA，false = #RRGGBB） */
export function formatHexColor(color: AssColor, alpha: boolean): string {
  const base = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`
  return alpha ? `${base}${hexByte(color.a)}` : base
}

// ---------------------------------------------------------------------------
// 行类型（AssEntryToLua / LuaToAssEntry 字段表）
// ---------------------------------------------------------------------------

export const INFO_SECTION = '[Script Info]'
export const STYLE_SECTION = '[V4+ Styles]'
export const EVENT_SECTION = '[Events]'

export interface LuaInfoRow {
  class: 'info'
  section: string
  raw: string
  key: string
  value: string
}

export interface LuaStyleRow {
  class: 'style'
  section: string
  raw: string
  name: string
  fontname: string
  fontsize: number
  color1: string
  color2: string
  color3: string
  color4: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  scale_x: number
  scale_y: number
  spacing: number
  angle: number
  borderstyle: number
  outline: number
  shadow: number
  align: number
  margin_l: number
  margin_r: number
  margin_t: number
  margin_b: number
  encoding: number
  relative_to: number
  /** 核心样式表的 values（Lua 不可见），仅原样文档行保留；脚本写入的行为空 */
  values?: Record<string, string>
}

export interface LuaDialogueRow {
  class: 'dialogue'
  section: string
  raw: string
  comment: boolean
  layer: number
  start_time: number
  end_time: number
  style: string
  actor: string
  effect: string
  margin_l: number
  margin_r: number
  margin_t: number
  margin_b: number
  text: string
  extra: Record<string, string>
}

export type LuaRow = LuaInfoRow | LuaStyleRow | LuaDialogueRow

export interface StyleRowFields {
  name: string
  fontname: string
  fontsize: number
  color1: string
  color2: string
  color3: string
  color4: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  scale_x: number
  scale_y: number
  spacing: number
  angle: number
  borderstyle: number
  outline: number
  shadow: number
  align: number
  margin_l: number
  margin_r: number
  margin_t: number
  encoding: number
}

export interface DialogueRowFields {
  comment: boolean
  layer: number
  start_time: number
  end_time: number
  style: string
  actor: string
  effect: string
  margin_l: number
  margin_r: number
  margin_t: number
  text: string
  extra: Record<string, string>
}

/** C printf %g（6 位有效数字、去尾零；UpdateData 的样式数值列） */
function formatG(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  let text = value.toPrecision(6)
  if (text.includes('e')) {
    text = text.replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e')
    return text.replace(/e([+-])(\d)$/, 'e$10$2')
  }
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** AssStyle::UpdateData 的规范序列化（name/font 逗号→分号，%g/%d，UpdateData 语法颜色） */
export function styleRawFor(fields: StyleRowFields): string {
  const name = fields.name.replaceAll(',', ';')
  const font = fields.fontname.replaceAll(',', ';')
  const bool = (value: boolean) => (value ? -1 : 0)
  return [
    'Style: ',
    `${name},${font},${formatG(fields.fontsize)},`,
    `${formatCoreColor(parseAssColor(fields.color1))},`,
    `${formatCoreColor(parseAssColor(fields.color2))},`,
    `${formatCoreColor(parseAssColor(fields.color3))},`,
    `${formatCoreColor(parseAssColor(fields.color4))},`,
    `${bool(fields.bold)},${bool(fields.italic)},${bool(fields.underline)},${bool(fields.strikeout)},`,
    `${formatG(fields.scale_x)},${formatG(fields.scale_y)},${formatG(fields.spacing)},${formatG(fields.angle)},`,
    `${Math.trunc(fields.borderstyle)},${formatG(fields.outline)},${formatG(fields.shadow)},${Math.trunc(fields.align)},`,
    `${Math.trunc(fields.margin_l)},${Math.trunc(fields.margin_r)},${Math.trunc(fields.margin_t)},`,
    `${Math.trunc(fields.encoding)}`,
  ].join('')
}

/** AssDialogue::GetEntryData 的规范序列化（style/actor/effect 逗号→分号，文本去 \n\r） */
export function dialogueRawFor(fields: DialogueRowFields): string {
  const unsafe = (value: string) => value.replaceAll(',', ';')
  const safe = (value: number) => `${Math.trunc(value)}`
  const text = fields.text.replace(/[\n\r]/g, '')
  return [
    fields.comment ? 'Comment: ' : 'Dialogue: ',
    `${safe(fields.layer)},`,
    `${formatAssTime(fields.start_time)},${formatAssTime(fields.end_time)},`,
    `${unsafe(fields.style)},${unsafe(fields.actor)},`,
    `${safe(fields.margin_l)},${safe(fields.margin_r)},${safe(fields.margin_t)},`,
    `${unsafe(fields.effect)},${text}`,
  ].join('')
}

export function makeInfoRow(key: string, value: string): LuaInfoRow {
  return { class: 'info', section: INFO_SECTION, raw: `${key}: ${value}`, key, value }
}

export function makeStyleRow(fields: StyleRowFields, values?: Record<string, string>): LuaStyleRow {
  return {
    class: 'style',
    section: STYLE_SECTION,
    raw: styleRawFor(fields),
    // UpdateData 会就地替换 name/font 的逗号，读取侧看到的是替换后的值
    name: fields.name.replaceAll(',', ';'),
    fontname: fields.fontname.replaceAll(',', ';'),
    fontsize: fields.fontsize,
    color1: fields.color1,
    color2: fields.color2,
    color3: fields.color3,
    color4: fields.color4,
    bold: fields.bold,
    italic: fields.italic,
    underline: fields.underline,
    strikeout: fields.strikeout,
    scale_x: fields.scale_x,
    scale_y: fields.scale_y,
    spacing: fields.spacing,
    angle: fields.angle,
    borderstyle: fields.borderstyle,
    outline: fields.outline,
    shadow: fields.shadow,
    align: fields.align,
    margin_l: fields.margin_l,
    margin_r: fields.margin_r,
    margin_t: fields.margin_t,
    margin_b: fields.margin_t,
    encoding: fields.encoding,
    relative_to: 2,
    values,
  }
}

export function makeDialogueRow(fields: DialogueRowFields): LuaDialogueRow {
  return {
    class: 'dialogue',
    section: EVENT_SECTION,
    raw: dialogueRawFor(fields),
    comment: fields.comment,
    layer: fields.layer,
    start_time: fields.start_time,
    end_time: fields.end_time,
    style: fields.style,
    actor: fields.actor,
    effect: fields.effect,
    margin_l: fields.margin_l,
    margin_r: fields.margin_r,
    margin_t: fields.margin_t,
    margin_b: fields.margin_t,
    text: fields.text,
    extra: { ...fields.extra },
  }
}

/** [Events] 标准列（Extradata 之外的列；web 把全部列放在 cue.extra，读取时剔除） */
const STANDARD_EVENT_COLUMNS = new Set([
  'Marked',
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'Actor',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
  'Comment',
])

function extraColumns(extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (!STANDARD_EVENT_COLUMNS.has(key)) result[key] = value
  }
  return result
}

/** 文档 → Lua 全空间行（Info + Styles + Events） */
export function documentToLuaRows(document: SubtitleDocument): LuaRow[] {
  const rows: LuaRow[] = []
  for (const [key, value] of Object.entries(document.scriptInfo)) rows.push(makeInfoRow(key, value))
  for (const style of document.styles) {
    rows.push(
      makeStyleRow(
        {
          name: style.name,
          fontname: style.fontName,
          fontsize: style.fontSize,
          color1: formatLuaStyleColor(parseAssColor(style.primaryColor)),
          color2: formatLuaStyleColor(parseAssColor(style.secondaryColor)),
          color3: formatLuaStyleColor(parseAssColor(style.outlineColor)),
          color4: formatLuaStyleColor(parseAssColor(style.backColor)),
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
          strikeout: style.strikeout,
          scale_x: style.scaleX,
          scale_y: style.scaleY,
          spacing: style.spacing,
          angle: style.angle,
          borderstyle: style.borderStyle,
          outline: style.outline,
          shadow: style.shadow,
          align: style.alignment,
          margin_l: style.marginL,
          margin_r: style.marginR,
          margin_t: style.marginV,
          encoding: style.encoding,
        },
        style.values,
      ),
    )
  }
  for (const cue of document.cues) {
    rows.push(
      makeDialogueRow({
        comment: cue.comment,
        layer: cue.layer,
        start_time: cue.startMs,
        end_time: cue.endMs,
        style: cue.style,
        actor: cue.actor,
        effect: cue.effect,
        margin_l: cue.marginL,
        margin_r: cue.marginR,
        margin_t: cue.marginV,
        text: cue.text,
        extra: extraColumns(cue.extra),
      }),
    )
  }
  return rows
}

/** AssFile::GetResolution（含 Gabest 缺省逻辑：0x0 → 384x288） */
export function resolutionFromRows(rows: LuaRow[]): { width: number; height: number } {
  const info: Record<string, string> = {}
  for (const row of rows) if (row.class === 'info') info[row.key] = row.value
  const asInt = (value: string | undefined) => Number.parseInt(value ?? '', 10) || 0
  let sw = asInt(info.PlayResX)
  let sh = asInt(info.PlayResY)
  if (sw === 0 && sh === 0) {
    sw = 384
    sh = 288
  } else if (sw === 0) sw = sh === 1024 ? 1280 : Math.trunc((sh * 4) / 3)
  else if (sh === 0) sh = sw === 1280 ? 1024 : Math.trunc((sw * 3) / 4)
  return { width: sw, height: sh }
}

// ---------------------------------------------------------------------------
// 提交负载（ProcessingComplete 的 apply_lines + AssFile::Commit）
// ---------------------------------------------------------------------------

export interface LuaCommitPayload {
  info?: Record<string, string>
  styles?: Array<Partial<Omit<SubtitleStyle, 'id'>>>
  cues: Array<Partial<Omit<SubtitleCue, 'id'>>>
}

export interface LuaCommit {
  payload: LuaCommitPayload
  /** 撤销点描述；空串表示源码侧也不产生 Commit（web apply 空 label 不入撤销栈） */
  label: string
}

function styleRowPatch(row: LuaStyleRow): Partial<Omit<SubtitleStyle, 'id'>> {
  return {
    name: row.name,
    fontName: row.fontname,
    fontSize: row.fontsize,
    primaryColor: formatCoreColor(parseAssColor(row.color1)),
    secondaryColor: formatCoreColor(parseAssColor(row.color2)),
    outlineColor: formatCoreColor(parseAssColor(row.color3)),
    backColor: formatCoreColor(parseAssColor(row.color4)),
    bold: row.bold,
    italic: row.italic,
    underline: row.underline,
    strikeout: row.strikeout,
    scaleX: row.scale_x,
    scaleY: row.scale_y,
    spacing: row.spacing,
    angle: row.angle,
    borderStyle: row.borderstyle,
    outline: row.outline,
    shadow: row.shadow,
    alignment: row.align,
    marginL: row.margin_l,
    marginR: row.margin_r,
    marginV: row.margin_t,
    encoding: row.encoding,
    values: row.values ?? {},
  }
}

function cueRowPatch(row: LuaDialogueRow): Partial<Omit<SubtitleCue, 'id'>> {
  return {
    layer: row.layer,
    startMs: row.start_time,
    endMs: row.end_time,
    style: row.style,
    actor: row.actor,
    marginL: row.margin_l,
    marginR: row.margin_r,
    marginV: row.margin_t,
    effect: row.effect,
    text: row.text,
    comment: row.comment,
    extra: { ...row.extra },
  }
}

/**
 * 行快照 → replaceDocument 负载（apply_lines）：
 * info 段仅在 script_info_copied（web = infoTouched）时整替；styles 空表保留原样式（web 偏差）。
 */
export function buildReplaceDocumentPayload(
  rows: LuaRow[],
  infoTouched: boolean,
): LuaCommitPayload {
  const payload: LuaCommitPayload = { cues: [] }
  if (infoTouched) {
    const info: Record<string, string> = {}
    for (const row of rows) if (row.class === 'info') info[row.key] = row.value
    payload.info = info
  }
  const styles = rows.filter((row): row is LuaStyleRow => row.class === 'style').map(styleRowPatch)
  if (styles.length) payload.styles = styles
  payload.cues = rows
    .filter((row): row is LuaDialogueRow => row.class === 'dialogue')
    .map(cueRowPatch)
  return payload
}

/**
 * 负载 → 文档（纯函数版 replaceDocument，供导出过滤器链在文档副本上运行）：
 * 语义与 core/runtime.ts 的 replaceDocument 一致（info 有则整替、styles 非空则重建、cues 整表重建）。
 */
export function applyLuaPayload(
  document: SubtitleDocument,
  payload: LuaCommitPayload,
): SubtitleDocument {
  const next: SubtitleDocument = { ...document }
  if (payload.info !== undefined) next.scriptInfo = { ...payload.info }
  if (payload.styles && payload.styles.length) {
    next.styles = payload.styles.map((style) => ({
      ...createDefaultStyle(),
      ...style,
      id: makeId('style'),
    }))
  }
  const rebuilt = payload.cues.map((cue) => ({ ...createCue(0, 5000), ...cue, id: makeId('cue') }))
  next.cues = rebuilt.length ? rebuilt : [createCue()]
  return next
}

// ---------------------------------------------------------------------------
// [Aegisub Project Garbage] 的 Export Filters（ass_parser.cpp:49 / subtitle_format_ass.cpp:95）
// ---------------------------------------------------------------------------

const PROJECT_GARBAGE_SECTION = 'Aegisub Project Garbage'
const EXPORT_FILTERS_PREFIX = 'Export Filters:'

/** 读取 Properties.export_filters（'|' 连接；行不存在为空表） */
export function documentExportFilters(document: SubtitleDocument): string[] {
  const section = document.passthroughSections.find((item) => item.name === PROJECT_GARBAGE_SECTION)
  const line = section?.lines.find((item) => item.startsWith(EXPORT_FILTERS_PREFIX))
  if (!line) return []
  return line
    .slice(EXPORT_FILTERS_PREFIX.length)
    .trim()
    .split('|')
    .filter((name) => name !== '')
}

/**
 * 写入 Properties.export_filters 的文档副本（WriteIfNotEmpty 语义：
 * 空表不写行；段内无其它行时整段移除）。
 */
export function withExportFilters(document: SubtitleDocument, names: string[]): SubtitleDocument {
  const next: SubtitleDocument = { ...document }
  const sections = next.passthroughSections.map((item) => ({ ...item, lines: [...item.lines] }))
  const index = sections.findIndex((item) => item.name === PROJECT_GARBAGE_SECTION)
  const value = names.join('|')

  if (index < 0) {
    if (!value) return document
    sections.push({ name: PROJECT_GARBAGE_SECTION, lines: [`${EXPORT_FILTERS_PREFIX} ${value}`] })
    next.passthroughSections = sections
    return next
  }

  const section = sections[index]
  const lineIndex = section.lines.findIndex((item) => item.startsWith(EXPORT_FILTERS_PREFIX))
  if (value) {
    const line = `${EXPORT_FILTERS_PREFIX} ${value}`
    // 桌面版按 Write 的固定字段序落盘；web 保留原行位置，无行时插到段首
    if (lineIndex >= 0) section.lines[lineIndex] = line
    else section.lines.unshift(line)
  } else if (lineIndex >= 0) {
    section.lines.splice(lineIndex, 1)
  }
  if (!section.lines.length) sections.splice(index, 1)
  next.passthroughSections = sections
  return next
}

// ---------------------------------------------------------------------------
// 行模型（LuaAssFile）
// ---------------------------------------------------------------------------

/** AssFile::CommitType */
const COMMIT_SCRIPTINFO = 0x2
const COMMIT_STYLES = 0x4
const COMMIT_DIAG_ADDREM = 0x10

interface PendingCommit {
  rows: LuaRow[]
  message: string
  modificationType: number
}

/**
 * Lua subtitles 对象的 JS 侧模型。参数校验（check_uint/check_int/argcheck）由引擎的
 * C 函数层在调用前完成；本类只做源码语义中的结构性操作与错误（allow-modify / bounds）。
 */
export class LuaFileModel {
  rows: LuaRow[]
  /** script_info_copied：任何 info 行被删/写/插后置位，提交时整替 info 段 */
  infoTouched = false
  /** 自上次撤销点以来的修改位（modification_mask 累积） */
  modificationType = 0
  canModify: boolean
  canSetUndo: boolean
  /**
   * LuaAssFile::references < 2：ProcessingComplete / Cancel 之后对象即失效，
   * 后续任何访问（GetObjPointer allow_expired=false）都报 "no longer valid"。
   */
  valid = true

  private pending: PendingCommit[] = []

  constructor(rows: LuaRow[], options: { canModify: boolean; canSetUndo: boolean }) {
    this.rows = rows
    this.canModify = options.canModify
    this.canSetUndo = options.canSetUndo
  }

  private checkAllowModify(): void {
    if (!this.canModify)
      throw new Error('Attempt to modify subtitles in read-only feature context.')
  }

  private checkBounds(index: number): void {
    if (!Number.isInteger(index) || index <= 0 || index > this.rows.length)
      throw new Error(`Requested out-of-range line from subtitle file: ${index}`)
  }

  /** modification_mask + QueueLineForDeletion 的 info 触达判定 */
  private markTouched(row: LuaRow): void {
    this.modificationType |=
      row.class === 'dialogue'
        ? COMMIT_DIAG_ADDREM
        : row.class === 'style'
          ? COMMIT_STYLES
          : COMMIT_SCRIPTINFO
    if (row.class === 'info') this.infoTouched = true
  }

  /** ObjectIndexWrite：n<0 插入、n==0 追加、n>0 替换；row 为 null 表示删除该行 */
  indexWrite(index: number, row: LuaRow | null): void {
    this.checkAllowModify()
    if (index < 0) {
      if (!row) throw new Error("Can't convert a non-table value to AssEntry")
      this.insertRows(-index, [row])
    } else if (index === 0) {
      if (!row) throw new Error("Can't convert a non-table value to AssEntry")
      this.appendRows([row])
    } else if (row) {
      this.checkBounds(index)
      this.markTouched(row)
      this.removeAt([index])
      this.rows.splice(index - 1, 0, row)
    } else {
      this.removeAt([index])
    }
  }

  /** ObjectDelete：索引已由引擎校验（1-based，允许重复，升序单遍删除） */
  removeAt(indexes: number[]): void {
    this.checkAllowModify()
    const sorted = [...indexes].sort((a, b) => a - b)
    let idIndex = 0
    const kept: LuaRow[] = []
    for (let i = 0; i < this.rows.length; i++) {
      if (idIndex < sorted.length && sorted[idIndex] === i + 1) {
        this.markTouched(this.rows[i])
        idIndex++
      } else kept.push(this.rows[i])
    }
    this.rows = kept
  }

  /** ObjectDeleteRange：钳制到 [1, size]，a >= b 直接返回 */
  deleteRange(first: number, last: number): void {
    this.checkAllowModify()
    const a = Math.max(first, 1) - 1
    const b = Math.min(last, this.rows.length)
    if (a >= b) return
    for (let i = a; i < b; i++) this.markTouched(this.rows[i])
    this.rows.splice(a, b - a)
  }

  /** ObjectAppend：空表插到 0；否则从尾部找同组行后插入，找不到则末尾 */
  appendRows(newRows: LuaRow[]): void {
    this.checkAllowModify()
    for (const row of newRows) {
      this.markTouched(row)
      if (!this.rows.length) {
        this.rows.push(row)
        continue
      }
      let inserted = false
      for (let i = this.rows.length; i > 0; i--) {
        if (this.rows[i - 1].class === row.class) {
          this.rows.splice(i, 0, row)
          inserted = true
          break
        }
      }
      if (!inserted) this.rows.push(row)
    }
  }

  /** ObjectInsert：before 已由引擎校验 1..size+1；= size+1 转 append */
  insertRows(before: number, newRows: LuaRow[]): void {
    this.checkAllowModify()
    if (before === this.rows.length + 1) {
      this.appendRows(newRows)
      return
    }
    for (const row of newRows) this.markTouched(row)
    this.rows.splice(before - 1, 0, ...newRows)
  }

  /** LuaSetUndoPoint：仅 can_set_undo 且自上次撤销点以来有修改时记录快照 */
  setUndoPoint(message: string): void {
    if (!this.canSetUndo)
      throw new Error('Attempt to set an undo point in a context where it makes no sense to do so.')
    if (!this.modificationType) return
    this.pending.push({
      rows: this.rows.slice(),
      message,
      modificationType: this.modificationType,
    })
    this.modificationType = 0
  }

  /** LuaGetScriptResolution（读取当前行中的 PlayResX/PlayResY） */
  resolution(): { width: number; height: number } {
    return resolutionFromRows(this.rows)
  }

  /** ProcessingComplete：pending 依次重放，尾部修改在可设置撤销点时以描述为 label 提交 */
  processingComplete(undoDescription: string): { commits: LuaCommit[]; rows: LuaRow[] } {
    const commits: LuaCommit[] = this.pending.map((commit) => ({
      payload: buildReplaceDocumentPayload(commit.rows, this.infoTouched),
      label: commit.message,
    }))
    if (this.modificationType) {
      commits.push({
        payload: buildReplaceDocumentPayload(this.rows, this.infoTouched),
        label: this.canSetUndo ? undoDescription : '',
      })
    }
    this.pending = []
    this.valid = false
    return { commits, rows: this.rows }
  }

  /** Cancel：丢弃全部修改（等待 GC 释放） */
  cancel(): void {
    this.pending = []
    this.rows = []
    this.valid = false
  }
}
