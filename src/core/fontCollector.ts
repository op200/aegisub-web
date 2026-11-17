/**
 * 字体收集器导出核心（dialog_fonts_collector.cpp 的「复制到文件夹 / 打包成 zip」）。
 *
 * 浏览器里字体来源有两条：IndexedDB 字体缓存（record.data 本身是 Blob，可直接
 * 复制）与 Local Font Access 枚举到的系统字体（需再调 blob() 取字节）。两条来源
 * 都按 family/fullName/postscriptName 三个名字集匹配，与字体供给器一致。
 *
 * 桌面 dialog_fonts_collector.cpp 还有「复制到字幕所在目录」与「在字幕目录建
 * 软链接」两种模式；浏览器没有字幕文件的真实路径，也没有文件系统软链接，
 * 这两种模式无法对应，故只保留「复制到文件夹」与「打包成 zip」。
 */
import { listFontFaces } from '../storage/fontStore'
import type { FontFaceRecord } from '../storage/fontStore'

export interface FontFileData {
  name: string
  data: Blob
}

export interface LocalFontLike {
  family: string
  fullName?: string
  postscriptName?: string
  style?: string
  blob(): Promise<Blob>
}

/** 引用名归一化：前缀 @ 是 ASS 竖排标记，空白不参与匹配 */
function normalizeName(name: string): string {
  return name.replace(/^@/, '').trim().toLowerCase()
}

/** 任一名字命中即可（与可用性检查的集合语义一致） */
function matchesName(record: FontFaceRecord, key: string): boolean {
  return [...record.families, ...record.fullNames, ...record.postscriptNames].some(
    (name) => normalizeName(name) === key,
  )
}

/** Local Font Access 的 blob() 类型 → 文件扩展名 */
function extensionFor(type: string): string {
  switch (type.split(';')[0].trim().toLowerCase()) {
    case 'font/ttf':
      return '.ttf'
    case 'font/otf':
      return '.otf'
    case 'font/woff':
      return '.woff'
    case 'font/woff2':
      return '.woff2'
    case 'font/collection':
      return '.ttc'
    default:
      return '.bin'
  }
}

/**
 * 按字幕引用的字体名收集字体文件字节。
 * 缓存优先；未命中时查 Local Font Access 列表；都不中记入 missing（保留原始名）。
 */
export async function collectReferencedFonts(
  names: string[],
  localFonts: LocalFontLike[] | null,
): Promise<{ files: FontFileData[]; missing: string[] }> {
  let records: FontFaceRecord[] = []
  try {
    records = await listFontFaces()
  } catch {
    // 缓存不可读时按空列表处理，仍可继续走 Local Font Access
    records = []
  }
  const files: FontFileData[] = []
  const missing: string[] = []
  const seenNames = new Set<string>()
  const seenFiles = new Set<string>()
  for (const raw of names) {
    const key = normalizeName(raw)
    if (!key || seenNames.has(key)) continue
    seenNames.add(key)
    const record = records.find((item) => matchesName(item, key))
    if (record) {
      // 同一文件可能被多个名字引用，只输出一次
      const fileKey = record.fileName.toLowerCase()
      if (!seenFiles.has(fileKey)) {
        seenFiles.add(fileKey)
        files.push({ name: record.fileName, data: record.data })
      }
      continue
    }
    const local = localFonts?.find((font) =>
      [font.family, font.fullName, font.postscriptName].some(
        (value) => value !== undefined && normalizeName(value) === key,
      ),
    )
    if (!local) {
      missing.push(raw)
      continue
    }
    const data = await local.blob() // oxlint-disable-line eslint/no-await-in-loop
    const baseName = local.postscriptName ?? local.fullName ?? local.family
    const name = `${baseName}${extensionFor(data.type)}`
    const fileKey = name.toLowerCase()
    if (seenFiles.has(fileKey)) continue
    seenFiles.add(fileKey)
    files.push({ name, data })
  }
  return { files, missing }
}

// ---------------------------------------------------------------------------
// 最小 ZIP writer（store 模式，不压缩）
// ---------------------------------------------------------------------------

/** 固定的 DOS 时间戳（1980-01-01 00:00:00），保证产物可复现 */
const DOS_TIME = 0
const DOS_DATE = 0x21
const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** general purpose flag bit 11：文件名为 UTF-8 */
const FLAG_UTF8 = 0x0800

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 标准 CRC-32（IEEE 802.3，多项式 0xEDB88320） */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function putU16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true)
  return offset + 2
}

function putU32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true)
  return offset + 4
}

function putBytes(bytes: Uint8Array, offset: number, data: Uint8Array): number {
  bytes.set(data, offset)
  return offset + data.length
}

/** 重名追加 -1、-2（保留扩展名） */
function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** 生成 store 模式 ZIP（local header + central directory + EOCD） */
export function buildZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder()
  const used = new Set<string>()
  const entries = files.map((file) => {
    const name = uniqueFileName(file.name, used)
    used.add(name.toLowerCase())
    return { nameBytes: encoder.encode(name), data: file.data, crc: crc32(file.data) }
  })

  let size = 22 + entries.reduce((sum, entry) => sum + 30 + 46 + entry.nameBytes.length * 2, 0)
  size += entries.reduce((sum, entry) => sum + entry.data.length, 0)
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  const offsets: number[] = []
  let cursor = 0

  for (const entry of entries) {
    offsets.push(cursor)
    cursor = putU32(view, cursor, LOCAL_SIG)
    cursor = putU16(view, cursor, 20) // version needed
    cursor = putU16(view, cursor, FLAG_UTF8)
    cursor = putU16(view, cursor, 0) // method: store
    cursor = putU16(view, cursor, DOS_TIME)
    cursor = putU16(view, cursor, DOS_DATE)
    cursor = putU32(view, cursor, entry.crc)
    cursor = putU32(view, cursor, entry.data.length) // compressed size
    cursor = putU32(view, cursor, entry.data.length) // uncompressed size
    cursor = putU16(view, cursor, entry.nameBytes.length)
    cursor = putU16(view, cursor, 0) // extra length
    cursor = putBytes(bytes, cursor, entry.nameBytes)
    cursor = putBytes(bytes, cursor, entry.data)
  }

  const centralOffset = cursor
  entries.forEach((entry, index) => {
    cursor = putU32(view, cursor, CENTRAL_SIG)
    cursor = putU16(view, cursor, 20) // version made by
    cursor = putU16(view, cursor, 20) // version needed
    cursor = putU16(view, cursor, FLAG_UTF8)
    cursor = putU16(view, cursor, 0)
    cursor = putU16(view, cursor, DOS_TIME)
    cursor = putU16(view, cursor, DOS_DATE)
    cursor = putU32(view, cursor, entry.crc)
    cursor = putU32(view, cursor, entry.data.length)
    cursor = putU32(view, cursor, entry.data.length)
    cursor = putU16(view, cursor, entry.nameBytes.length)
    cursor = putU16(view, cursor, 0) // extra length
    cursor = putU16(view, cursor, 0) // comment length
    cursor = putU16(view, cursor, 0) // disk number
    cursor = putU16(view, cursor, 0) // internal attributes
    cursor = putU32(view, cursor, 0) // external attributes
    cursor = putU32(view, cursor, offsets[index])
    cursor = putBytes(bytes, cursor, entry.nameBytes)
  })
  const centralSize = cursor - centralOffset

  cursor = putU32(view, cursor, EOCD_SIG)
  cursor = putU16(view, cursor, 0) // this disk
  cursor = putU16(view, cursor, 0) // central directory disk
  cursor = putU16(view, cursor, entries.length)
  cursor = putU16(view, cursor, entries.length)
  cursor = putU32(view, cursor, centralSize)
  cursor = putU32(view, cursor, centralOffset)
  cursor = putU16(view, cursor, 0) // comment length
  return bytes.subarray(0, cursor)
}

/** 逐个写入目录（File System Access API；调用方负责先拿到有效 handle） */
export async function writeFontsToDirectory(
  files: FontFileData[],
  directory: FileSystemDirectoryHandle,
): Promise<void> {
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- 逐个写入，避免同时占用过多文件句柄
    const handle = await directory.getFileHandle(file.name, { create: true })
    // oxlint-disable-next-line no-await-in-loop -- 同上
    const writable = await handle.createWritable()
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writable.write(await file.data.arrayBuffer())
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writable.close()
  }
}
