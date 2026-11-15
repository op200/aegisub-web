import { srtTagsToAss } from './format'
/**
 * Matroska 内嵌字幕提取（mkv_wrap.cpp MatroskaWrapper::GetSubtitles 的 Web 版）。
 * 只识别 S_TEXT/ASS、S_TEXT/SSA、S_TEXT/UTF8，输出可被 parseAss 解析的 ASS 文本。
 */
import { formatAssTime } from './time'

export interface MkvSubtitleTrack {
  /** Matroska TrackNumber */
  number: number
  codecId: string
  name: string
  language: string
  /** 统一输出为 ASS 文本（SRT 已转换） */
  assText: string
  ssa: boolean
}

interface ElementHeader {
  id: number
  size: number
  dataStart: number
  end: number
  unknownSize: boolean
}

interface TrackInfo {
  number: number
  codecId: string
  name: string
  language: string
  codecPrivate: Uint8Array
  timestampScale: number
}

interface BlockFrame {
  track: number
  startMs: number
  durationMs: number | null
  data: Uint8Array
}

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_TIMESTAMP_SCALE = 0x2ad7b1
const ID_TRACKS = 0x1654ae6b
const ID_TRACK_ENTRY = 0xae
const ID_TRACK_NUMBER = 0xd7
const ID_TRACK_TYPE = 0x83
const ID_CODEC_ID = 0x86
const ID_CODEC_PRIVATE = 0x63a2
const ID_TRACK_NAME = 0x536e
const ID_LANGUAGE = 0x22b59c
const ID_TRACK_TIMESTAMP_SCALE = 0x23314f
const ID_CLUSTER = 0x1f43b675
const ID_CLUSTER_TIMESTAMP = 0xe7
const ID_SIMPLE_BLOCK = 0xa3
const ID_BLOCK_GROUP = 0xa0
const ID_BLOCK = 0xa1
const ID_BLOCK_DURATION = 0x9b

const SEGMENT_LEVEL_IDS = new Set([
  ID_SEGMENT,
  ID_INFO,
  ID_TRACKS,
  ID_CLUSTER,
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x114d9b74, // SeekHead
  0x1941a469, // Attachments
])

function readVint(
  data: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number; length: number } | null {
  if (offset >= data.length) return null
  const first = data[offset]
  if (first === 0) return null
  let length = 1
  let mask = 0x80
  while ((first & mask) === 0) {
    length += 1
    mask >>= 1
    if (length > 8) return null
  }
  if (offset + length > data.length) return null
  let value = keepMarker ? first : first & (mask - 1)
  for (let index = 1; index < length; index += 1) value = value * 256 + data[offset + index]
  const allOnes = keepMarker ? false : value === 2 ** (7 * length) - 1
  return { value: allOnes ? -1 : value, length }
}

function readElement(data: Uint8Array, offset: number, limit: number): ElementHeader | null {
  if (offset >= limit) return null
  const id = readVint(data, offset, true)
  if (!id) return null
  const size = readVint(data, offset + id.length, false)
  if (!size) return null
  const dataStart = offset + id.length + size.length
  const unknownSize = size.value < 0
  const end = unknownSize ? limit : Math.min(limit, dataStart + size.value)
  return { id: id.value, size: size.value, dataStart, end, unknownSize }
}

function readUint(data: Uint8Array, start: number, end: number): number {
  let value = 0
  for (let index = start; index < end; index += 1) value = value * 256 + data[index]
  return value
}

function readFloat(data: Uint8Array, start: number, end: number): number {
  const length = end - start
  const view = new DataView(data.buffer, data.byteOffset + start, length)
  if (length === 4) return view.getFloat32(0)
  if (length === 8) return view.getFloat64(0)
  return 1
}

function readUtf8(data: Uint8Array, start: number, end: number): string {
  let text = new TextDecoder('utf-8').decode(data.subarray(start, end))
  while (text.endsWith('\u0000')) text = text.slice(0, -1)
  return text
}

function parseTracks(data: Uint8Array, start: number, end: number): TrackInfo[] {
  const tracks: TrackInfo[] = []
  let offset = start
  while (offset < end) {
    const element = readElement(data, offset, end)
    if (!element) break
    if (element.id === ID_TRACK_ENTRY) {
      const track: TrackInfo = {
        number: 0,
        codecId: '',
        name: '',
        language: '',
        codecPrivate: new Uint8Array(),
        timestampScale: 1,
      }
      let isSubtitle = false
      let cursor = element.dataStart
      while (cursor < element.end) {
        const child = readElement(data, cursor, element.end)
        if (!child) break
        switch (child.id) {
          case ID_TRACK_NUMBER:
            track.number = readUint(data, child.dataStart, child.end)
            break
          case ID_TRACK_TYPE:
            isSubtitle = readUint(data, child.dataStart, child.end) === 0x11
            break
          case ID_CODEC_ID:
            track.codecId = readUtf8(data, child.dataStart, child.end)
            break
          case ID_CODEC_PRIVATE:
            track.codecPrivate = data.slice(child.dataStart, child.end)
            break
          case ID_TRACK_NAME:
            track.name = readUtf8(data, child.dataStart, child.end)
            break
          case ID_LANGUAGE:
            track.language = readUtf8(data, child.dataStart, child.end)
            break
          case ID_TRACK_TIMESTAMP_SCALE:
            track.timestampScale = readFloat(data, child.dataStart, child.end)
            break
          default:
            break
        }
        cursor = child.end
      }
      if (isSubtitle && track.number > 0 && /^S_TEXT\/(ASS|SSA|UTF8)$/i.test(track.codecId)) {
        tracks.push(track)
      }
    }
    offset = element.end
    if (element.unknownSize) break
  }
  return tracks
}

function parseLacedFrames(payload: Uint8Array, count: number, type: number): Uint8Array[] {
  const frames: Uint8Array[] = []
  let cursor = 0
  const sizes: number[] = []
  if (type === 0x02) {
    // Xiph lacing
    for (let index = 0; index < count - 1; index += 1) {
      let size = 0
      while (cursor < payload.length && payload[cursor] === 255) {
        size += 255
        cursor += 1
      }
      if (cursor >= payload.length) return []
      size += payload[cursor]
      cursor += 1
      sizes.push(size)
    }
  } else if (type === 0x06) {
    // EBML lacing
    const first = readVint(payload, cursor, false)
    if (!first) return []
    cursor += first.length
    sizes.push(first.value)
    for (let index = 1; index < count - 1; index += 1) {
      const signed = readVint(payload, cursor, false)
      if (!signed) return []
      cursor += signed.length
      const bias = 2 ** (7 * signed.length - 1) - 1
      sizes.push(sizes[sizes.length - 1] + signed.value - bias)
    }
  }
  if (type === 0x04) {
    const size = Math.floor((payload.length - cursor) / count)
    for (let index = 0; index < count; index += 1) sizes.push(size)
  }
  for (let index = 0; index < count; index += 1) {
    const size =
      index < count - 1 ? sizes[index] : payload.length - cursor - sizes.reduce((a, b) => a + b, 0)
    if (size < 0) return []
    frames.push(payload.subarray(cursor, cursor + size))
    cursor += size
  }
  return frames
}

function parseBlock(
  data: Uint8Array,
  clusterMs: number,
  timestampScale: number,
  trackScales: Map<number, number>,
): BlockFrame | null {
  const trackVint = readVint(data, 0, false)
  if (!trackVint) return null
  const offset = trackVint.length
  if (offset + 3 > data.length) return null
  const relative = (data[offset] << 8) | data[offset + 1]
  const signedRelative = relative & 0x8000 ? relative - 0x10000 : relative
  const flags = data[offset + 2]
  const lacing = flags & 0x06
  const trackScale = trackScales.get(trackVint.value) ?? 1
  const startMs = ((clusterMs + signedRelative) * timestampScale * trackScale) / 1e6
  let payload = data.subarray(offset + 3)
  if (lacing) {
    if (!payload.length) return null
    const count = payload[0] + 1
    const frames = parseLacedFrames(payload.subarray(1), count, lacing)
    if (!frames.length) return null
    payload = frames[0]
  }
  return { track: trackVint.value, startMs, durationMs: null, data: payload }
}

function collectCluster(
  data: Uint8Array,
  start: number,
  limit: number,
  timestampScale: number,
  trackScales: Map<number, number>,
  blocks: BlockFrame[],
): number {
  let offset = start
  let clusterMs = 0
  while (offset < limit) {
    const element = readElement(data, offset, limit)
    if (!element) break
    if (SEGMENT_LEVEL_IDS.has(element.id)) return offset
    if (element.id === ID_CLUSTER_TIMESTAMP) {
      clusterMs = readUint(data, element.dataStart, element.end)
    } else if (element.id === ID_SIMPLE_BLOCK) {
      const block = parseBlock(
        data.subarray(element.dataStart, element.end),
        clusterMs,
        timestampScale,
        trackScales,
      )
      if (block) blocks.push(block)
    } else if (element.id === ID_BLOCK_GROUP) {
      let cursor = element.dataStart
      let block: BlockFrame | null = null
      let duration: number | null = null
      while (cursor < element.end) {
        const child = readElement(data, cursor, element.end)
        if (!child) break
        if (child.id === ID_BLOCK) {
          const parsed = parseBlock(
            data.subarray(child.dataStart, child.end),
            clusterMs,
            timestampScale,
            trackScales,
          )
          if (parsed) block = parsed
        } else if (child.id === ID_BLOCK_DURATION) {
          duration = Math.round((readUint(data, child.dataStart, child.end) * timestampScale) / 1e6)
        }
        cursor = child.end
      }
      if (block) {
        block.durationMs = duration
        blocks.push(block)
      }
    }
    offset = element.end
    if (element.unknownSize) break
  }
  return offset
}

/** 从 Matroska 文件提取可读字幕轨（返回完整 ASS 文档文本） */
export function extractMkvSubtitles(bytes: Uint8Array): MkvSubtitleTrack[] {
  // 找到 Segment
  let offset = 0
  let segmentStart = -1
  let segmentEnd = bytes.length
  while (offset < bytes.length) {
    const element = readElement(bytes, offset, bytes.length)
    if (!element) break
    if (element.id === ID_SEGMENT) {
      segmentStart = element.dataStart
      segmentEnd = element.end
      break
    }
    if (element.id === ID_EBML) {
      offset = element.end
      continue
    }
    offset = element.end
  }
  if (segmentStart < 0) throw new Error('Invalid Matroska file: Segment not found')

  let timestampScale = 1_000_000
  const tracks: TrackInfo[] = []

  // 第一遍：Info/Tracks
  offset = segmentStart
  while (offset < segmentEnd) {
    const element = readElement(bytes, offset, segmentEnd)
    if (!element) break
    if (element.id === ID_INFO) {
      let cursor = element.dataStart
      while (cursor < element.end) {
        const child = readElement(bytes, cursor, element.end)
        if (!child) break
        if (child.id === ID_TIMESTAMP_SCALE) {
          timestampScale = readUint(bytes, child.dataStart, child.end)
        }
        cursor = child.end
      }
    } else if (element.id === ID_TRACKS) {
      tracks.push(...parseTracks(bytes, element.dataStart, element.end))
    }
    if (element.id === ID_CLUSTER) break
    offset = element.end
  }
  if (!tracks.length) throw new Error('File has no recognised subtitle tracks.')

  const trackScales = new Map<number, number>()
  for (const track of tracks) trackScales.set(track.number, track.timestampScale)

  // 第二遍：Cluster
  const blocks: BlockFrame[] = []
  offset = segmentStart
  while (offset < segmentEnd) {
    const element = readElement(bytes, offset, segmentEnd)
    if (!element) break
    if (element.id === ID_CLUSTER) {
      const next = collectCluster(
        bytes,
        element.dataStart,
        segmentEnd,
        timestampScale,
        trackScales,
        blocks,
      )
      offset = Math.max(next, element.dataStart + 1)
    } else {
      offset = element.end
    }
    if (offset <= segmentStart) break
  }

  // 时间轴补齐：同轨按开始时间排序，缺失的结束时间取下一块开始
  blocks.sort((a, b) => a.startMs - b.startMs)
  for (const track of tracks) {
    const own = blocks.filter((block) => block.track === track.number)
    for (let index = 0; index < own.length; index += 1) {
      if (own[index].durationMs === null) {
        own[index].durationMs =
          index + 1 < own.length ? own[index + 1].startMs - own[index].startMs : 5000
      }
    }
  }

  const result: MkvSubtitleTrack[] = []
  for (const track of tracks) {
    const own = blocks.filter((block) => block.track === track.number)
    if (!own.length) continue
    const ssa = /S_TEXT\/SSA/i.test(track.codecId)
    const srt = /S_TEXT\/UTF8/i.test(track.codecId)
    const lines: string[] = []
    for (const block of own) {
      const text = new TextDecoder('utf-8').decode(block.data)
      const start = formatAssTime(Math.max(0, block.startMs))
      const end = formatAssTime(Math.max(0, block.startMs + (block.durationMs ?? 0)))
      if (srt) {
        const converted = srtTagsToAss(text).replace(/\r\n|\r|\n/g, '\\N')
        lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${converted}`)
      } else {
        const first = text.indexOf(',')
        const second = first < 0 ? -1 : text.indexOf(',', first + 1)
        if (second < 0) continue
        lines.push(
          `Dialogue: ${text.slice(first + 1, second)},${start},${end},${text.slice(second + 1)}`,
        )
      }
    }
    const privateText = new TextDecoder('utf-8').decode(track.codecPrivate)
    const header = privateText
      .replace(/^\uFEFF/, '')
      .replace(/\[Events\][\s\S]*$/i, '')
      .trimEnd()
    const body = [
      header || '[Script Info]\nScriptType: v4.00+',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...lines,
      '',
    ].join('\r\n')
    result.push({
      number: track.number,
      codecId: track.codecId,
      name: track.name,
      language: track.language,
      assText: body,
      ssa,
    })
  }
  return result
}
