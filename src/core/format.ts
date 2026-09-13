import { createCue, createDefaultStyle, createDocument, makeId } from './defaults'
import { formatAssTime, formatSrtTime, parseAssTime, parseSrtTime } from './time'
import type { SubtitleCue, SubtitleDocument, SubtitleFormat, SubtitleStyle } from './types'

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

function styleFromValues(values: Record<string, string>): SubtitleStyle {
  return {
    id: makeId('style'),
    name: values.Name || 'Default',
    fontName: values.Fontname || 'Arial',
    fontSize: Number(values.Fontsize) || 48,
    primaryColor: values.PrimaryColour || '&H00FFFFFF',
    secondaryColor: values.SecondaryColour || '&H0000FFFF',
    outlineColor: values.OutlineColour || '&H00000000',
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
    alignment: Number(values.Alignment) || 2,
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

export function detectFormat(name: string, text: string): SubtitleFormat {
  if (name.toLowerCase().endsWith('.srt') || /-->/.test(text.slice(0, 500))) return 'srt'
  return 'ass'
}

export function parseSubtitle(text: string, sourceName: string): SubtitleDocument {
  return detectFormat(sourceName, text) === 'srt'
    ? parseSrt(text, sourceName)
    : parseAss(text, sourceName)
}

export function parseAss(text: string, sourceName = 'untitled.ass'): SubtitleDocument {
  const document = createDocument(sourceName)
  document.cues = []
  document.styles = []
  document.scriptInfo = {}
  document.passthroughSections = []

  let section = ''
  let styleColumns = STYLE_COLUMNS
  let eventColumns = EVENT_COLUMNS
  let passthrough: { name: string; lines: string[] } | null = null

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)]\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      passthrough = ['Script Info', 'V4+ Styles', 'V4 Styles', 'Events'].includes(section)
        ? null
        : { name: section, lines: [] }
      if (passthrough) document.passthroughSections.push(passthrough)
      continue
    }
    if (passthrough) {
      passthrough.lines.push(rawLine)
      continue
    }
    if (!rawLine.trim() || rawLine.trimStart().startsWith(';')) continue
    const colon = rawLine.indexOf(':')
    if (colon < 0) continue
    const key = rawLine.slice(0, colon).trim()
    const value = rawLine.slice(colon + 1).trim()
    if (section === 'Script Info') {
      document.scriptInfo[key] = value
    } else if (section === 'V4+ Styles' || section === 'V4 Styles') {
      if (key === 'Format') styleColumns = value.split(',').map((item) => item.trim())
      if (key === 'Style')
        document.styles.push(
          styleFromValues(mapFields(styleColumns, splitFields(value, styleColumns.length))),
        )
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
  if (!document.styles.length) document.styles.push(createDefaultStyle())
  if (!document.cues.length) document.cues.push(createCue())
  document.format = 'ass'
  return document
}

export function parseSrt(text: string, sourceName = 'untitled.srt'): SubtitleDocument {
  const document = createDocument(sourceName)
  document.format = 'srt'
  document.cues = []
  const blocks = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const [start, end] = lines[timeIndex].split('-->').map(parseSrtTime)
    const cue = createCue(start, end)
    cue.text = lines.slice(timeIndex + 1).join('\\N')
    document.cues.push(cue)
  }
  if (!document.cues.length) document.cues.push(createCue())
  return document
}

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

function cueValues(cue: SubtitleCue): Record<string, string> {
  return {
    ...cue.extra,
    Layer: String(cue.layer),
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

export function exportAss(document: SubtitleDocument): string {
  const info = { ScriptType: 'v4.00+', ...document.scriptInfo }
  const lines = [
    '[Script Info]',
    ...Object.entries(info).map(([key, value]) => `${key}: ${value}`),
    '',
    '[V4+ Styles]',
    `Format: ${STYLE_COLUMNS.join(', ')}`,
  ]
  for (const style of document.styles) {
    const values = styleValues(style)
    lines.push(`Style: ${STYLE_COLUMNS.map((column) => values[column] ?? '').join(',')}`)
  }
  lines.push('', '[Events]', `Format: ${EVENT_COLUMNS.join(', ')}`)
  for (const cue of document.cues) {
    const values = cueValues(cue)
    lines.push(
      `${cue.comment ? 'Comment' : 'Dialogue'}: ${EVENT_COLUMNS.map((column) => values[column] ?? '').join(',')}`,
    )
  }
  for (const section of document.passthroughSections)
    lines.push('', `[${section.name}]`, ...section.lines)
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function exportSrt(document: SubtitleDocument): string {
  return document.cues
    .filter((cue) => !cue.comment)
    .map(
      (cue, index) =>
        `${index + 1}\r\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\r\n${cue.text.replaceAll('\\N', '\r\n').replace(/\{[^}]*}/g, '')}`,
    )
    .join('\r\n\r\n')
}

export function exportSubtitle(document: SubtitleDocument, format = document.format): string {
  return format === 'srt' ? exportSrt(document) : exportAss(document)
}
