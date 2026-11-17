// 字体收集器导出测试：ZIP 结构与字体匹配/去重语义
import { describe, expect, it, vi } from 'vitest'

import { listFontFaces } from '../storage/fontStore'
import type { FontFaceRecord } from '../storage/fontStore'
import { buildZip, collectReferencedFonts } from './fontCollector'

vi.mock('../storage/fontStore', () => ({ listFontFaces: vi.fn() }))

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

/** 按 EOCD 解析中央目录条目（名称 + CRC） */
function readCentralEntries(zip: Uint8Array): Array<{ name: string; crc: number }> {
  const eocd = zip.length - 22
  expect(readU32(zip, eocd)).toBe(0x06054b50)
  const count = readU16(zip, eocd + 10)
  let cursor = readU32(zip, eocd + 16)
  const entries: Array<{ name: string; crc: number }> = []
  for (let index = 0; index < count; index += 1) {
    expect(readU32(zip, cursor)).toBe(0x02014b50)
    const crc = readU32(zip, cursor + 16)
    const nameLength = readU16(zip, cursor + 28)
    const extraLength = readU16(zip, cursor + 30)
    const commentLength = readU16(zip, cursor + 32)
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength))
    entries.push({ name, crc })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function makeRecord(over: Partial<FontFaceRecord> = {}): FontFaceRecord {
  return {
    families: ['Arial'],
    fullNames: ['Arial'],
    postscriptNames: ['ArialMT'],
    style: 'Regular',
    fileName: 'arial.ttf',
    size: 1,
    addedAt: 0,
    data: new Blob(['a']),
    ...over,
  }
}

describe('buildZip', () => {
  it('写入 store 模式条目并带正确 CRC', () => {
    const zip = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }])
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const text = String.fromCharCode(...zip)
    expect(text).toContain('a.txt')
    expect(text).toContain('hello')
    expect([...zip.subarray(zip.length - 22, zip.length - 18)]).toEqual([0x50, 0x4b, 0x05, 0x06])
    const entries = readCentralEntries(zip)
    expect(entries).toHaveLength(1)
    // 标准 CRC32('hello') = 0x3610A686（与 Node zlib.crc32 一致）
    expect(entries[0].crc).toBe(0x3610a686)
  })

  it('重名文件追加 -1 且中央目录条目数正确', () => {
    const zip = buildZip([
      { name: 'a.txt', data: new TextEncoder().encode('x') },
      { name: 'a.txt', data: new TextEncoder().encode('y') },
    ])
    const entries = readCentralEntries(zip)
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'a-1.txt'])
  })
})

describe('collectReferencedFonts', () => {
  it('缓存命中按文件名去重，未命中记入 missing', async () => {
    vi.mocked(listFontFaces).mockResolvedValue([
      makeRecord(),
      makeRecord({
        families: ['Times New Roman'],
        fullNames: ['Times New Roman'],
        postscriptNames: ['TimesNewRomanPSMT'],
        fileName: 'times.ttf',
      }),
    ])
    const result = await collectReferencedFonts(
      ['@Arial', 'arialmt', 'Arial', '@Gone', 'Missing'],
      null,
    )
    expect(result.files.map((file) => file.name)).toEqual(['arial.ttf'])
    // 引用名去重（@Arial/arialmt/Arial 只处理一次）、missing 保留原始引用名
    expect(result.missing).toEqual(['@Gone', 'Missing'])
  })

  it('缓存未命中时回退 Local Font Access，扩展名取自 blob.type', async () => {
    vi.mocked(listFontFaces).mockResolvedValue([])
    const result = await collectReferencedFonts(
      ['@My Font'],
      [
        {
          family: 'My Font',
          postscriptName: 'MyFont-Regular',
          blob: async () => new Blob(['x'], { type: 'font/ttf' }),
        },
      ],
    )
    expect(result.missing).toEqual([])
    expect(result.files).toHaveLength(1)
    expect(result.files[0].name).toBe('MyFont-Regular.ttf')
    expect(await result.files[0].data.text()).toBe('x')
  })
})
