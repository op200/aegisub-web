/**
 * ASS/SRT 之外的 Aegisub 字幕格式（TXT/TTXT/MicroDVD/EBU STL/TranStation/Encore）。
 * 读写语义对齐 subtitle_format_txt/ttxt/microdvd/ebu3264/transtation/encore.cpp。
 */
import { createCue, createDefaultStyle, createDocument, createProjectProperties } from './defaults'
import { convertNewlines, prepareCuesForExport, strippedText } from './format'
import { formatAssTime, parseAssTime } from './time'
import type { SubtitleCue, SubtitleDocument } from './types'
import { Framerate } from './vfr'

export class FpsRequiredError extends Error {
  constructor() {
    super('FPS required')
    this.name = 'FpsRequiredError'
  }
}

export interface FrameRateOptions {
  fps?: number
  /** v2 timecodes 帧起始时间（首帧 0），用于 VFR 导出 */
  frameTimes?: number[]
  drop?: boolean
}

function makeFramerate(options: FrameRateOptions = {}): Framerate | null {
  if (options.frameTimes && options.frameTimes.length >= 2) {
    return Framerate.fromTimecodes(options.frameTimes)
  }
  if (options.fps && Number.isFinite(options.fps) && options.fps > 0) {
    return Framerate.cfr(options.fps)
  }
  return null
}

function requireFramerate(options: FrameRateOptions = {}): Framerate {
  const framerate = makeFramerate(options)
  if (!framerate) throw new FpsRequiredError()
  return framerate
}

function emptyDocument(format: SubtitleDocument['format'], sourceName: string): SubtitleDocument {
  const document = createDocument(sourceName)
  document.format = format
  document.cues = []
  document.passthroughSections = []
  document.attachments = []
  document.extradata = []
  document.properties = createProjectProperties()
  return document
}

// ---------------------------------------------------------------------------
// Plain text（subtitle_format_txt.cpp）
// ---------------------------------------------------------------------------

export interface TextImportOptions {
  actorSeparator: string
  commentStarter: string
  includeBlank: boolean
}

export function parseTxt(
  text: string,
  sourceName = 'untitled.txt',
  options: TextImportOptions = { actorSeparator: ':', commentStarter: '#', includeBlank: false },
): SubtitleDocument {
  const document = emptyDocument('txt', sourceName)
  let actor = ''
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let value = rawLine
    if (value === '' && !options.includeBlank) continue
    if (value.startsWith('# timecode')) {
      throw new Error('File is a timecode file, cannot load as subtitles.')
    }

    let isComment = false
    if (options.commentStarter && value.startsWith(options.commentStarter)) {
      isComment = true
      value = value.slice(options.commentStarter.length)
    }

    if (!isComment && options.actorSeparator && value !== '') {
      if (value[0] !== ' ' && value[0] !== '\t') {
        const pos = value.indexOf(options.actorSeparator)
        if (pos >= 0) {
          actor = value.slice(0, pos).trim()
          value = value.slice(pos + options.actorSeparator.length)
        }
      }
    }

    value = value.replace(/^[ \t]+/, '')
    if (value === '') isComment = true

    const cue = createCue(0, 0)
    cue.actor = isComment ? '' : actor
    cue.comment = isComment
    cue.text = value
    document.cues.push(cue)
  }
  if (!document.cues.length) document.cues.push(createCue(0, 0))
  return document
}

export function exportTxt(document: SubtitleDocument): string {
  let dialogueCount = 0
  let actorCount = 0
  for (const cue of document.cues) {
    if (!cue.comment) {
      dialogueCount += 1
      if (cue.actor !== '') actorCount += 1
    }
  }
  const writeActors = actorCount > Math.trunc(dialogueCount / 2)
  const lines = ['# Exported by Aegisub']
  for (const cue of document.cues) {
    let line = cue.comment ? '# ' : ''
    if (writeActors) line += `${cue.actor}: `
    const text = strippedText(cue.text)
    line += text
    if (text !== '') lines.push(line)
  }
  return `${lines.join('\r\n')}\r\n`
}

// ---------------------------------------------------------------------------
// MPEG-4 Streaming Text（subtitle_format_ttxt.cpp）
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function ttxtSampleTime(ms: number): string {
  return `0${formatAssTime(ms)}`
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, entity) => {
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole
  })
}

function xmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:\\s|^)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  if (!match) return null
  return decodeXmlEntities(match[1] ?? match[2] ?? '')
}

/** 从 '<' 起找标签结束的 '>'（跳过引号内的 >，XML 属性允许裸 >） */
function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

/**
 * TTXT 读取（subtitle_format_ttxt.cpp）。
 * Web Worker 没有 DOMParser，这里用最小 XML 扫描器解析 TextStream/TextSample；
 * 支持 1.0 的 text 属性与 1.1 的节点文本、XML 实体与 CDATA。
 */
export function parseTtxt(text: string, sourceName = 'untitled.ttxt'): SubtitleDocument {
  const document = emptyDocument('ttxt', sourceName)
  const source = text
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content: string) => escapeXml(content))
  const rootMatch = /<TextStream\b/.exec(source)
  if (!rootMatch) throw new Error('Invalid TTXT file.')
  const rootEnd = findTagEnd(source, rootMatch.index)
  if (rootEnd < 0) throw new Error('Invalid TTXT file.')
  const versionText =
    xmlAttribute(source.slice(rootMatch.index + '<TextStream'.length, rootEnd), 'version') ?? ''
  const version = versionText === '1.0' ? 0 : versionText === '1.1' ? 1 : -1
  if (version < 0) throw new Error(`Unknown TTXT version: ${versionText}`)

  let previous: SubtitleCue | null = null
  let lines = 0
  let offset = 0
  for (;;) {
    const open = source.indexOf('<TextSample', offset)
    if (open < 0) break
    const nameEnd = open + '<TextSample'.length
    if (!/[\s/>]/.test(source[nameEnd] ?? '')) {
      offset = nameEnd
      continue
    }
    const tagEnd = findTagEnd(source, open)
    if (tagEnd < 0) break
    const tagBody = source.slice(nameEnd, tagEnd)
    const selfClosing = /\/\s*$/.test(tagBody)
    const attributes = selfClosing ? tagBody.replace(/\/\s*$/, '') : tagBody
    let inner = ''
    offset = tagEnd + 1
    if (!selfClosing) {
      const close = source.indexOf('</TextSample', offset)
      if (close < 0) break
      inner = source.slice(offset, close)
      const closeEnd = findTagEnd(source, close)
      offset = closeEnd < 0 ? close : closeEnd + 1
    }
    const time = parseAssTime(xmlAttribute(attributes, 'sampleTime') ?? '00:00:00.000')
    if (previous) previous.endMs = time
    let sample =
      version === 0
        ? (xmlAttribute(attributes, 'text') ?? '')
        : decodeXmlEntities(inner.replace(/<[^>]+>/g, ''))
    if (sample === '') continue

    const cue = createCue(time, 36000000 - 10)
    if (version === 0) {
      let finalText = ''
      let inside = false
      let first = true
      for (const char of sample) {
        if (char === "'") {
          if (!inside && !first) finalText += '\\N'
          first = false
          inside = !inside
        } else if (inside) {
          finalText += char
        }
      }
      sample = finalText
    } else {
      sample = sample.replaceAll('\r', '').replaceAll('\n', '\\N')
    }
    cue.text = sample
    document.cues.push(cue)
    previous = cue
    lines += 1
  }
  if (lines === 0) document.cues.push(createCue(0, 0))
  return document
}

export function exportTtxt(document: SubtitleDocument): string {
  const cues = prepareCuesForExport(document.cues)
  const children: string[] = []
  const sample = (time: number, content = '') =>
    `  <TextSample sampleTime="${ttxtSampleTime(time)}" xml:space="preserve">${escapeXml(content)}</TextSample>`

  children.push(
    '  <TextStreamHeader width="400" height="60" layer="0" translation_x="0" translation_y="0">',
    '    <TextSampleDescription horizontalJustification="center" verticalJustification="bottom" backColor="0 0 0 0" verticalText="no" fillTextRegion="no" continuousKaraoke="no" scroll="None">',
    '      <FontTable>',
    '        <FontTableEntry fontName="Sans" fontID="1"/>',
    '      </FontTable>',
  )
  // 源码里 TextBox/Style 挂在 TextSampleDescription 上
  children.push(
    '      <TextBox top="0" left="0" bottom="60" right="400"/>',
    '      <Style styles="Normal" fontID="1" fontSize="18" color="ff ff ff ff"/>',
    '    </TextSampleDescription>',
    '  </TextStreamHeader>',
  )

  let previousEnd = 0
  cues.forEach((cue, index) => {
    if (index > 0 && previousEnd !== cue.startMs) children.push(sample(previousEnd))
    children.push(sample(cue.startMs, convertNewlines(strippedText(cue.text), '\r\n')))
    previousEnd = cue.endMs
  })
  children.push(sample(previousEnd))

  return `<?xml version="1.0" encoding="UTF-8"?>\n<TextStream version="1.1">\n${children.join('\n')}\n</TextStream>\n`
}

// ---------------------------------------------------------------------------
// MicroDVD（subtitle_format_microdvd.cpp）
// ---------------------------------------------------------------------------

const MICRODVD_LINE_RE = /^[{[]([0-9]+)[}\]][{[]([0-9]+)[}\]](.*)$/

export function isMicroDvd(text: string): boolean {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? ''
  return MICRODVD_LINE_RE.test(first)
}

export function parseMicrodvd(
  text: string,
  sourceName = 'untitled.sub',
  options: FrameRateOptions = {},
): SubtitleDocument {
  const document = emptyDocument('microdvd', sourceName)
  let framerate: Framerate | null = null
  let first = true
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = MICRODVD_LINE_RE.exec(rawLine)
    if (!match) continue
    let body = match[3]
    if (first) {
      first = false
      const cfr = Number.parseFloat(body.trim())
      if (Number.isFinite(cfr) && body.trim() !== '') {
        framerate = Framerate.cfr(cfr)
        continue
      }
      framerate = makeFramerate(options)
      if (!framerate) throw new FpsRequiredError()
    }
    if (!framerate) throw new FpsRequiredError()
    const start = framerate.timeAtFrame(Number.parseInt(match[1], 10), 'start')
    const end = framerate.timeAtFrame(Number.parseInt(match[2], 10), 'end')
    const cue = createCue(start, end)
    cue.text = body.replaceAll('|', '\\N')
    document.cues.push(cue)
  }
  if (!document.cues.length) document.cues.push(createCue(0, 0))
  return document
}

export function exportMicrodvd(document: SubtitleDocument, options: FrameRateOptions = {}): string {
  const framerate = requireFramerate(options)
  const cues = prepareCuesForExport(document.cues)
  const lines: string[] = []
  if (framerate.timecodes.length <= 1) lines.push(`{1}{1}${framerate.fps().toFixed(6)}`)
  for (const cue of cues) {
    const start = framerate.frameAtTime(cue.startMs, 'start')
    const end = framerate.frameAtTime(cue.endMs, 'end')
    lines.push(`{${start}}{${end}}${convertNewlines(strippedText(cue.text), '|')}`)
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : ''
}

// ---------------------------------------------------------------------------
// SMPTE（TranStation / Encore / EBU 共用）
// ---------------------------------------------------------------------------

function smpteAtFrame(framerate: Framerate, frame: number): [number, number, number, number] {
  const value = Math.max(0, frame)
  const fps = Math.ceil(framerate.fps())
  const totalSeconds = Math.floor(value / fps)
  const f = value % fps
  return [Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60, f]
}

function smpteAtTime(framerate: Framerate, ms: number): [number, number, number, number] {
  return smpteAtFrame(framerate, framerate.frameAtTime(ms, 'exact'))
}

function smpteString(framerate: Framerate, ms: number, separator: string): string {
  const [h, m, s, f] = smpteAtTime(framerate, ms)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${part(h)}${separator}${part(m)}${separator}${part(s)}${separator}${part(f)}`
}

/** TranStation 的 SUB[...] 头（subtitle_format_transtation.cpp ConvertLine） */
function tranStationLine(
  document: SubtitleDocument,
  cue: SubtitleCue,
  framerate: Framerate,
  nextStart: number | null,
): string {
  let valign = 0
  let halign = ' '
  let type = 'N'
  const style = document.styles.find((item) => item.name === cue.style)
  if (style) {
    if (style.alignment >= 4) valign = 4
    if (style.alignment >= 7) valign = 9
    if (style.alignment === 1 || style.alignment === 4 || style.alignment === 7) halign = 'L'
    if (style.alignment === 3 || style.alignment === 6 || style.alignment === 9) halign = 'R'
    if (style.italic) type = 'I'
  }
  if (cue.text.includes('\\i1')) type = 'I'

  let end = cue.endMs
  if (nextStart !== null && nextStart > 0 && end === nextStart) {
    end = framerate.timeAtFrame(framerate.frameAtTime(end, 'end') - 1, 'end')
  }
  return `SUB[${valign}${halign}${type} ${smpteString(framerate, cue.startMs, ':')}>${smpteString(framerate, end, ':')}]\r\n${cue.text}`
}

export function exportTranStation(
  document: SubtitleDocument,
  options: FrameRateOptions = {},
): string {
  const framerate = requireFramerate(options)
  const cues = prepareCuesForExport(document.cues).map((cue) => ({
    ...cue,
    text: convertNewlines(strippedText(cue.text), '\r\n'),
  }))
  const lines: string[] = []
  for (let index = 0; index < cues.length; index += 1) {
    const next = cues[index + 1]
    lines.push(tranStationLine(document, cues[index], framerate, next ? next.startMs : null))
    if (next) lines.push('')
  }
  lines.push('SUB[')
  return `${lines.join('\r\n')}\r\n`
}

export function exportEncore(document: SubtitleDocument, options: FrameRateOptions = {}): string {
  const framerate = requireFramerate(options)
  // Encore 要求 NTSC 用 ';'，其余用 ':'（源码只看 drop 标志）
  const separator = options.drop ? ';' : ':'
  const cues = prepareCuesForExport(document.cues)
  const lines = cues.map(
    (cue, index) =>
      `${index + 1} ${smpteString(framerate, cue.startMs, separator)} ${smpteString(framerate, cue.endMs, separator)} ${convertNewlines(strippedText(cue.text), '\r\n')}`,
  )
  return lines.length ? `${lines.join('\r\n')}\r\n` : ''
}

// ---------------------------------------------------------------------------
// EBU Tech 3264 STL（subtitle_format_ebu3264.cpp，仅支持写出）
// ---------------------------------------------------------------------------

interface EbuSegment {
  text: string
  underline: boolean
  italic: boolean
}

const EBU_MAX_LINE = 40

function ebuTextRows(cue: SubtitleCue, style?: SubtitleDocument['styles'][number]): EbuSegment[][] {
  let italic = style?.italic ?? false
  let underline = style?.underline ?? false
  const rows: EbuSegment[][] = [[]]
  const push = (text: string) => {
    if (!text) return
    const current = rows[rows.length - 1]
    const last = current[current.length - 1]
    if (last && last.italic === italic && last.underline === underline) last.text += text
    else current.push({ text, italic, underline })
  }

  const blocksText = cue.text
  // 逐块处理覆写标签（与 EbuSubtitle::SetTextFromAss 的可见效果一致）
  let cursor = 0
  while (cursor < blocksText.length) {
    if (blocksText[cursor] === '{') {
      const end = blocksText.indexOf('}', cursor)
      if (end < 0) {
        push(blocksText.slice(cursor))
        break
      }
      const work = blocksText.slice(cursor + 1, end)
      for (const match of work.matchAll(/\\(i|u)(-?\d*)/g)) {
        const value = match[2] === '' ? true : Number.parseInt(match[2], 10) !== 0
        if (match[1] === 'i') italic = value
        else underline = value
      }
      cursor = end + 1
      continue
    }
    let next = blocksText.indexOf('{', cursor + 1)
    if (next < 0) next = blocksText.length
    const chunk = blocksText.slice(cursor, next)
    cursor = next
    // 硬换行与硬空格
    const parts = chunk.split(/\\N/i)
    parts.forEach((part, index) => {
      if (index > 0) rows.push([])
      push(part.replaceAll('\\h', ' '))
    })
  }

  // 自动折行（默认 40 列，AutoWrap 语义：按单词边界）
  const wrapped: EbuSegment[][] = []
  for (const row of rows) {
    let current: EbuSegment[] = []
    let length = 0
    for (const segment of row) {
      for (const word of segment.text.split(/(\s+)/)) {
        if (!word) continue
        if (length + word.length > EBU_MAX_LINE && current.length > 0 && word.trim() !== '') {
          wrapped.push(current)
          current = []
          length = 0
        }
        current.push({ ...segment, text: word })
        length += word.length
      }
    }
    if (current.length) wrapped.push(current)
  }
  return wrapped.length ? wrapped : [[{ text: ' ', italic: false, underline: false }]]
}

function writeAsciiField(target: Uint8Array, offset: number, length: number, value: string): void {
  target.fill(0x20, offset, offset + length)
  // GSI 使用 CP850；Web 端无法可靠编码时退化为 ASCII 子集
  for (let index = 0; index < Math.min(length, value.length); index += 1) {
    const code = value.charCodeAt(index)
    target[offset + index] = code >= 0x20 && code < 0x7f ? code : 0x3f
  }
}

export interface EbuExportOptions extends FrameRateOptions {
  maxLineLength?: number
  displayStandard?: 0 | 1 | 2
}

/** EBU STL 写出（默认 25fps / UTF-8 / 开放字幕，GSI+TTI 二进制） */
export function exportEbu(document: SubtitleDocument, options: EbuExportOptions = {}): Uint8Array {
  const framerate = makeFramerate(options) ?? Framerate.cfr(25)
  const maxLine = options.maxLineLength ?? EBU_MAX_LINE
  const display = options.displayStandard ?? 0
  const cues = prepareCuesForExport(document.cues)
  const ttiBlocks: Uint8Array[] = []
  let subtitleNumber = 0
  const subtitleCount = Math.max(1, cues.length)
  const encoder = new TextEncoder()

  const encodeRow = (row: EbuSegment[]): Uint8Array => {
    const bytes: number[] = []
    let underline = false
    let italic = false
    let characters = 0
    for (const segment of row) {
      if (underline !== segment.underline) bytes.push(segment.underline ? 0x83 : 0x82)
      if (italic !== segment.italic) bytes.push(segment.italic ? 0x81 : 0x80)
      underline = segment.underline
      italic = segment.italic
      for (const char of segment.text) {
        if (characters >= maxLine) break
        const encoded = encoder.encode(char)
        if (bytes.length + encoded.length > 112) break
        bytes.push(...encoded)
        characters += 1
      }
    }
    return new Uint8Array(bytes)
  }

  const entries =
    cues.length > 0
      ? cues
      : [
          (() => {
            const cue = createCue(0, 0)
            cue.text = ' '
            return cue
          })(),
        ]
  for (const cue of entries) {
    const style = document.styles.find((item) => item.name === cue.style) ?? createDefaultStyle()
    const alignment = style.alignment >= 1 && style.alignment <= 9 ? style.alignment : 2
    const vertical = Math.trunc(alignment / 3)
    const justification = ((alignment - 1) % 3) + 1
    const rows = ebuTextRows(cue, style)
    // subtitle_format_ebu3264.cpp L460-496：Teletext 1-23 行，开放字幕 0-99 行
    const minRow = display === 0 ? 0 : 1
    const maxRow = display === 0 ? 100 : 24
    const vp =
      vertical === 2
        ? minRow
        : vertical === 1
          ? Math.min(minRow, Math.trunc(maxRow / 2 - (maxRow / 5) * rows.length))
          : maxRow - 1

    const textBytes: number[] = []
    rows.forEach((row, index) => {
      if (index > 0) textBytes.push(0x8a)
      textBytes.push(...encodeRow(row))
    })
    const payload = new Uint8Array(textBytes)

    const frameIn = Math.max(0, framerate.frameAtTime(cue.startMs, 'exact'))
    const frameOut = Math.max(0, framerate.frameAtTime(cue.endMs, 'exact') - 1)
    const [ih, im, is, iff] = smpteAtFrame(framerate, frameIn)
    const [oh, om, os, of] = smpteAtFrame(framerate, frameOut)

    let offset = 0
    let extension = 0
    do {
      const block = new Uint8Array(128)
      block[0] = 0
      block[1] = subtitleNumber & 0xff
      block[2] = (subtitleNumber >> 8) & 0xff
      const remaining = payload.length - offset
      block[3] = remaining >= 112 ? extension++ : 255
      block[4] = 0
      block[5] = ih
      block[6] = im
      block[7] = is
      block[8] = iff
      block[9] = oh
      block[10] = om
      block[11] = os
      block[12] = of
      block[13] = vp
      block[14] = justification
      block[15] = 0
      block.fill(0x8f, 16, 128)
      block.set(payload.subarray(offset, offset + 112), 16)
      ttiBlocks.push(block)
      offset += 112
      // 恰好填满 112 字节时还要补一个终止块
      if (remaining === 112) {
        const terminator = new Uint8Array(128)
        terminator.set(block.subarray(0, 16), 0)
        terminator[3] = 255
        terminator.fill(0x8f, 16, 128)
        ttiBlocks.push(terminator)
        break
      }
      if (remaining < 112) break
    } while (offset < payload.length)
    subtitleNumber += 1
  }

  const gsi = new Uint8Array(1024)
  gsi.fill(0x20)
  writeAsciiField(gsi, 0, 3, '850')
  writeAsciiField(gsi, 3, 8, 'STL25.01')
  gsi[11] = 0x30 + display
  writeAsciiField(gsi, 12, 2, 'U8')
  writeAsciiField(gsi, 14, 2, '00')
  writeAsciiField(gsi, 16, 32, document.scriptInfo.Title ?? '')
  writeAsciiField(gsi, 48, 32, '')
  writeAsciiField(gsi, 80, 32, document.scriptInfo['Original Translation'] ?? '')
  writeAsciiField(gsi, 112, 32, '')
  writeAsciiField(gsi, 144, 32, '')
  writeAsciiField(gsi, 176, 32, '')
  const now = new Date()
  const part = (value: number) => String(value).padStart(2, '0')
  const stamp = `${part(now.getFullYear() % 100)}${part(now.getMonth() + 1)}${part(now.getDate())}`
  const slr = `AGI-${stamp}${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`
  writeAsciiField(gsi, 208, 16, slr)
  writeAsciiField(gsi, 224, 6, stamp)
  writeAsciiField(gsi, 230, 6, stamp)
  writeAsciiField(gsi, 236, 2, '00')
  writeAsciiField(gsi, 238, 5, String(ttiBlocks.length).padStart(5, ' '))
  writeAsciiField(gsi, 243, 5, String(subtitleCount).padStart(5, ' '))
  writeAsciiField(gsi, 248, 3, '001')
  writeAsciiField(gsi, 251, 2, String(maxLine).padStart(2, '0'))
  writeAsciiField(gsi, 253, 2, '99')
  gsi[255] = 0x31 // TCS: time code status
  const first = ttiBlocks[0]
  writeAsciiField(
    gsi,
    256,
    8,
    `${part(first?.[5] ?? 0)}${part(first?.[6] ?? 0)}${part(first?.[7] ?? 0)}${part(first?.[8] ?? 0)}`,
  )
  writeAsciiField(
    gsi,
    264,
    8,
    `${part(first?.[5] ?? 0)}${part(first?.[6] ?? 0)}${part(first?.[7] ?? 0)}${part(first?.[8] ?? 0)}`,
  )
  gsi[272] = 0x31
  gsi[273] = 0x31
  writeAsciiField(gsi, 274, 3, 'XXX')
  writeAsciiField(gsi, 277, 32, '')
  writeAsciiField(gsi, 309, 32, document.scriptInfo['Original Editing'] ?? '')
  writeAsciiField(gsi, 341, 32, '')
  writeAsciiField(
    gsi,
    448,
    576,
    'This file was exported by Aegisub Web using non-standard UTF-8 encoding for the subtitle blocks.',
  )

  const result = new Uint8Array(gsi.length + ttiBlocks.length * 128)
  result.set(gsi, 0)
  ttiBlocks.forEach((block, index) => result.set(block, gsi.length + index * 128))
  return result
}
