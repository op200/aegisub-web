import { exportAss, parseAss, exportSrt, parseSrt } from './format'
import {
  exportEbu,
  exportEncore,
  exportMicrodvd,
  exportTranStation,
  exportTtxt,
  exportTxt,
  parseMicrodvd,
  parseTtxt,
  parseTxt,
  type EbuExportOptions,
  type FrameRateOptions,
  type TextImportOptions,
} from './formatExtra'
/**
 * 字幕格式注册表与读写分发（subtitle_format.cpp LoadFormats）。
 * 与源码一致：EBU/Encore/TranStation 仅写出；MKV 仅读入（内嵌轨道提取）。
 */
import type { ProjectProperties, SubtitleDocument, SubtitleFormat } from './types'

export interface FormatInfo {
  format: SubtitleFormat
  name: string
  /** 读取扩展名（小写，不含点） */
  readExtensions: string[]
  writeExtensions: string[]
}

export const SUBTITLE_FORMATS: FormatInfo[] = [
  {
    format: 'ass',
    name: 'Advanced SubStation Alpha',
    readExtensions: ['ass'],
    writeExtensions: ['ass'],
  },
  { format: 'ssa', name: 'SubStation Alpha', readExtensions: ['ssa'], writeExtensions: ['ssa'] },
  { format: 'srt', name: 'SubRip', readExtensions: ['srt'], writeExtensions: ['srt'] },
  {
    format: 'txt',
    name: 'Plain-Text',
    readExtensions: ['txt'],
    writeExtensions: ['txt'],
  },
  {
    format: 'ttxt',
    name: 'MPEG-4 Streaming Text',
    readExtensions: ['ttxt'],
    writeExtensions: ['ttxt'],
  },
  { format: 'microdvd', name: 'MicroDVD', readExtensions: ['sub'], writeExtensions: ['sub'] },
  { format: 'ebu', name: 'EBU STL', readExtensions: [], writeExtensions: ['stl'] },
  {
    format: 'transtation',
    name: 'TranStation',
    readExtensions: [],
    writeExtensions: ['transtation.txt'],
  },
  { format: 'encore', name: 'Adobe Encore', readExtensions: [], writeExtensions: ['encore.txt'] },
]

export function isAssLike(name: string): boolean {
  return /\.(ass|ssa)$/i.test(name)
}

/** 由文件名判定格式；.txt 需区分 Encore/TranStation 变体 */
export function formatFromFileName(name: string): SubtitleFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.encore.txt')) return 'encore'
  if (lower.endsWith('.transtation.txt')) return 'transtation'
  if (/\.(mkv|mka|mks)$/.test(lower)) return null
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  for (const info of SUBTITLE_FORMATS) {
    if (info.readExtensions.includes(extension)) return info.format
  }
  return null
}

export interface ParseOptions {
  format?: SubtitleFormat
  textImport?: TextImportOptions
  fps?: number
  frameTimes?: number[]
  drop?: boolean
}

/** 判定格式（detectFormat 的扩展版本：SRT/MicroDVD 按内容识别 .txt/.sub 之外的情况） */
export function detectFormat(name: string, text: string): SubtitleFormat {
  const byName = formatFromFileName(name)
  if (byName) return byName
  const head = text.replace(/^\uFEFF/, '').slice(0, 800)
  if (head.includes('-->')) return 'srt'
  if (/^\{[0-9]+}\{[0-9]+}/.test(head)) return 'microdvd'
  if (head.includes('<TextStream')) return 'ttxt'
  return 'ass'
}

export function parseSubtitle(
  text: string,
  sourceName: string,
  options: ParseOptions = {},
): SubtitleDocument {
  const format = options.format ?? detectFormat(sourceName, text)
  switch (format) {
    case 'ass':
    case 'ssa':
      return parseAss(text, sourceName, { format })
    case 'srt':
      return parseSrt(text, sourceName)
    case 'txt':
      return parseTxt(
        text,
        sourceName,
        options.textImport ?? { actorSeparator: ':', commentStarter: '#', includeBlank: false },
      )
    case 'ttxt':
      return parseTtxt(text, sourceName)
    case 'microdvd':
      return parseMicrodvd(text, sourceName, options)
    default:
      throw new Error(`${format} is write-only`)
  }
}

export interface ExportOptions extends FrameRateOptions {
  /** 导出对话框（与保存区分）：ASS 省略 Project Garbage/Extradata */
  clean?: boolean
  saveUiState?: boolean
  /** 保存时用当前 UI/媒体状态覆盖 Project Garbage（避免为此产生撤销记录） */
  properties?: Partial<ProjectProperties>
  ebu?: EbuExportOptions
}

export function exportSubtitle(
  document: SubtitleDocument,
  format: SubtitleFormat = document.format,
  options: ExportOptions = {},
): string | Uint8Array {
  const source: SubtitleDocument = options.properties
    ? { ...document, properties: { ...document.properties, ...options.properties } }
    : document
  switch (format) {
    case 'ssa':
      return exportAss(
        { ...source, format: 'ssa' },
        { clean: options.clean, saveUiState: options.saveUiState },
      )
    case 'ass':
      return exportAss(
        { ...source, format: 'ass' },
        { clean: options.clean, saveUiState: options.saveUiState },
      )
    case 'srt':
      return exportSrt(source)
    case 'txt':
      return exportTxt(source)
    case 'ttxt':
      return exportTtxt(source)
    case 'microdvd':
      return exportMicrodvd(source, options)
    case 'ebu':
      return exportEbu(source, { ...options, ...options.ebu })
    case 'transtation':
      return exportTranStation(source, options)
    case 'encore':
      return exportEncore(source, options)
    default:
      throw new Error(`Unsupported export format: ${format}`)
  }
}

/** 各格式导出扩展名（保存/导出对话框的默认文件名） */
export function exportExtension(format: SubtitleFormat): string {
  return SUBTITLE_FORMATS.find((info) => info.format === format)?.writeExtensions[0] ?? 'ass'
}
