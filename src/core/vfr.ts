/**
 * 帧率/时间码/关键帧核心（对应 libaegisub/common/vfr.cpp、keyframe.cpp）。
 *
 * 语义严格对齐源码：
 * - EXACT：帧的精确开始时间；START：行首帧规则；END：行尾帧规则。
 * - FrameAtTime(ms, START) = FrameAtTime(ms-1, EXACT) + 1；FrameAtTime(ms, END) = FrameAtTime(ms-1, EXACT)。
 * - TimeAtFrame(f, START/END) = 前后帧中点，整除时向上取整（+1 保证 1ms 间隔也向上取整）。
 * - CFR 的 TimeAtFrame(EXACT) 为截断；文件类查表；超出表尾按源码外推公式。
 */

export type TimeKind = 'exact' | 'start' | 'end'

/**
 * 升序数组中第一个 ≥ value 的下标（lower_bound）。空表返回 0。
 * 关键帧 ms → 帧号即此语义：FFMS2 索引按 PTS 升序排帧，帧号 = 帧在排序表中的位置。
 */
export function lowerBoundIndex(sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 浮点秒 → 毫秒，对齐 FFMS2 `(int)((PTS * TimeBase->Num) / TimeBase->Den)` 的
 * int64 截断。web-demuxer/HTMLMediaElement 只给 double 秒，直接 trunc 会在
 * 精确整数毫秒点因浮点下取差 1ms（1/1000 时基 1 小时实测约 0.4% 的帧）。
 * 补偿 1e-6ms：远大于 double 误差（~1e-9ms），远小于最小时基分数间隔
 * （1/1e6 时基为 0.001ms），不会把真实非整数点推进到下一毫秒。
 */
export function ptsToMs(seconds: number): number {
  return Math.trunc(seconds * 1000 + 1e-6)
}

interface V1Range {
  start: number
  end: number
  fps: number
}

export class Framerate {
  /** 每帧的起始毫秒（帧 0 强制为 0）；CFR 构造时为 [0] 哨兵 */
  readonly timecodes: number[]
  /** 每帧时长分子：fps * 1e9（CFR/v1）或平均 fps * 1e9（v2） */
  readonly numerator: number
  /** v1：未舍入累计时长（用于文件末尾外推）；v2/CFR：(n-1)*1e9*1000 / 0 */
  readonly last: number

  private constructor(timecodes: number[], numerator: number, last: number) {
    this.timecodes = timecodes
    this.numerator = numerator
    this.last = last
  }

  /** Framerate{}：未加载（IsLoaded == false） */
  static empty(): Framerate {
    return new Framerate([], 0, 0)
  }

  /** Framerate(double fps)：CFR 构造（numerator(int64_t(fps * denominator)) 截断） */
  static cfr(fps: number): Framerate {
    return new Framerate([0], Math.trunc(fps * 1e9), 0)
  }

  /** 从 v2 timecodes 表构造（已归一化，首帧 0）。
   *  源码 SetFromTimecodes 的 numerator 为 int64 整除（截断非四舍五入） */
  static fromTimecodes(timecodes: number[]): Framerate {
    const normalized = timecodes.map((value) => value - timecodes[0])
    const numerator = Math.trunc(
      ((normalized.length - 1) * 1e9 * 1000) / normalized[normalized.length - 1],
    )
    const last = (normalized.length - 1) * 1e9 * 1000
    return new Framerate(normalized, numerator, last)
  }

  /** 从 v1 展开结果构造（源码 v1 展开走四舍五入，见 parseTimecodes） */
  static fromExpanded(timecodes: number[], assumedFps: number, last: number): Framerate {
    return new Framerate(timecodes, Math.trunc(assumedFps * 1e9), last)
  }

  isLoaded(): boolean {
    return this.numerator > 0
  }

  /** 源码 Framerate::FPS()：numerator / denominator（denominator = 1e9） */
  fps(): number {
    return this.numerator / 1e9
  }

  frameCount(): number {
    return this.timecodes.length
  }

  /** libaegisub vfr.cpp FrameAtTime */
  frameAtTime(ms: number, kind: TimeKind = 'exact'): number {
    if (kind === 'start') return this.frameAtTime(ms - 1, 'exact') + 1
    if (kind === 'end') return this.frameAtTime(ms - 1, 'exact')

    // EXACT
    if (ms < 0) return Math.trunc((ms * this.numerator) / 1e9 / 1000 - 0.999)
    if (this.timecodes.length && ms > this.timecodes[this.timecodes.length - 1]) {
      // 超出表尾：外推（源码 L227-230）
      return (
        Math.trunc(
          ((ms + 1) * this.numerator -
            this.last -
            Math.floor(this.numerator / 2) +
            (1000 * 1e9 - 1)) /
            (1000 * 1e9),
        ) +
        this.timecodes.length -
        2
      )
    }
    // 表内：最大的 timecodes[i] <= ms
    let lo = 0
    let hi = this.timecodes.length - 1
    let result = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.timecodes[mid] <= ms) {
        result = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return result
  }

  /** libaegisub vfr.cpp TimeAtFrame */
  timeAtFrame(frame: number, kind: TimeKind = 'exact'): number {
    if (this.numerator === 0) return 0
    if (kind !== 'exact') {
      const prev = this.timeAtFrame(frame - 1, 'exact')
      const cur = this.timeAtFrame(frame, 'exact')
      const next = this.timeAtFrame(frame + 1, 'exact')
      return kind === 'start'
        ? prev + Math.floor((cur - prev + 1) / 2)
        : cur + Math.floor((next - cur + 1) / 2)
    }
    if (frame < 0) return Math.trunc((frame * 1e9 * 1000) / this.numerator)
    if (frame >= this.timecodes.length) {
      const framesPastEnd = frame - this.timecodes.length + 1
      return Math.trunc(
        (framesPastEnd * 1000 * 1e9 + this.last + Math.floor(this.numerator / 2)) / this.numerator,
      )
    }
    return this.timecodes[frame] ?? 0
  }
}

// ---------------------------------------------------------------------------
// 关键帧（libaegisub/common/keyframe.cpp）
// ---------------------------------------------------------------------------

/**
 * 解析关键帧文件。首行 header 精确匹配源码支持的 6 种格式，否则抛错。
 */
export function parseKeyframes(text: string): number[] {
  const lines = text.split(/\r?\n/)
  const header = (lines.shift() ?? '').trim()
  const keyframes: number[] = []

  if (header === '# keyframe format v1') {
    // 第二行 "fps <数>"：读取但丢弃
    const fpsLine = (lines.shift() ?? '').trim()
    if (!/^fps\s+[\d.]+$/i.test(fpsLine)) throw new Error('Invalid keyframe format')
    for (const line of lines) {
      const value = Number.parseInt(line.trim(), 10)
      if (Number.isFinite(value)) keyframes.push(value)
    }
    return keyframes
  }

  if (
    header === '# XviD 2pass stat file' ||
    header.startsWith('# ffmpeg 2-pass log file') ||
    header.startsWith('# avconv 2-pass log file')
  ) {
    let frame = 0
    for (const line of lines) {
      const c = line[0]?.toLowerCase()
      if (c === 'i') keyframes.push(frame++)
      else if (c === 'p' || c === 'b') frame++
    }
    return keyframes
  }

  if (header === '##map version') {
    let frame = 0
    for (const line of lines) {
      const index = line.search(/[IPB]/)
      if (index < 0) continue
      const c = line[index].toLowerCase()
      if (c === 'i') keyframes.push(frame++)
      else frame++
    }
    return keyframes
  }

  if (header === '#options:') {
    let frame = 0
    for (const line of lines) {
      const pos = line.indexOf('type:')
      if (pos < 0 || pos + 5 >= line.length) continue
      const c = line[pos + 5].toLowerCase()
      if (c === 'i') keyframes.push(frame++)
      else if (c === 'p' || c === 'b') frame++
    }
    return keyframes
  }

  if (header === '# WWXD log file, using qpfile format') {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^(\d+)\s+(\S)$/)
      if (!match) throw new Error('Malformed keyframe line')
      if (match[2].toUpperCase() === 'I') keyframes.push(Number(match[1]))
    }
    return keyframes
  }

  throw new Error('Unknown keyframe format')
}

/** 保存为 Aegisub v1 关键帧格式（keyframe.cpp Save） */
export function serializeKeyframes(keyframes: number[]): string {
  const lines = ['# keyframe format v1', 'fps 0', ...keyframes.map(String)]
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// 时间码文件（libaegisub/common/vfr.cpp）
// ---------------------------------------------------------------------------

/**
 * 解析 timecodes 文件（v1/v2）。返回 Framerate；失败抛错。
 */
export function parseTimecodes(text: string): Framerate {
  const lines = text.split(/\r?\n/)
  let header = (lines.shift() ?? '').trim()
  if (
    header.startsWith('#') &&
    header !== '# timecode format v1' &&
    header !== '# timecode format v2'
  ) {
    // 源码允许 v1 的 header 前有注释行，再读一行作为 header
    header = (lines.shift() ?? '').trim()
  }

  if (header === '# timecode format v2') {
    const timecodes: number[] = []
    for (const line of lines) {
      const value = Number.parseInt(line.trim(), 10)
      if (Number.isFinite(value)) timecodes.push(value)
    }
    if (timecodes.length < 2) throw new Error('Must have at least two timecodes')
    for (let i = 1; i < timecodes.length; i++) {
      if (timecodes[i] < timecodes[i - 1]) throw new Error('Timecodes are out of order')
    }
    if (timecodes[0] === timecodes[timecodes.length - 1])
      throw new Error('Timecodes are all identical')
    return Framerate.fromTimecodes(timecodes)
  }

  if (header === '# timecode format v1' || header.startsWith('Assume ')) {
    const assumeLine = header.startsWith('Assume ') ? header : (lines.shift() ?? '').trim()
    const assumedFps = Number.parseFloat(assumeLine.slice(7))
    if (!Number.isFinite(assumedFps) || assumedFps <= 0 || assumedFps > 1000)
      throw new Error('Invalid assumed fps')

    const ranges: V1Range[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^(\d+),(\d+),([\d.]+)(?:\s|$)/)
      if (!match) throw new Error('Malformed timecodes line')
      const start = Number(match[1])
      const end = Number(match[2])
      const fps = Number(match[3])
      if (start < 0 || end < 0 || end < start || fps <= 0 || fps > 1000)
        throw new Error('Malformed timecodes line')
      ranges.push({ start, end, fps })
    }
    ranges.sort((a, b) => a.start - b.start)
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start <= ranges[i - 1].end) throw new Error('Override ranges must not overlap')
    }

    // 源码展开：帧 0..range.start-1 用 assumed fps，range.start..range.end 用 range fps
    const timecodes: number[] = []
    let time = 0
    let frame = 0
    for (const range of ranges) {
      while (frame < range.start) {
        timecodes.push(Math.round(time))
        time += 1000 / assumedFps
        frame++
      }
      while (frame <= range.end) {
        timecodes.push(Math.round(time))
        time += 1000 / range.fps
        frame++
      }
    }
    timecodes.push(Math.round(time)) // 末尾哨兵
    // last = 未舍入累计时长（v1 外推语义；int64_t 截断）
    const lastUnrounded = time * assumedFps * 1e9
    return Framerate.fromExpanded(timecodes, assumedFps, Math.trunc(lastUnrounded))
  }

  throw new Error('Unknown timecodes format')
}

/** 保存为 v2 格式（Framerate::Save；length > 帧数时外推补齐） */
export function serializeTimecodes(framerate: Framerate, length = -1): string {
  const lines = ['# timecode format v2']
  const total = length > framerate.timecodes.length ? length : framerate.timecodes.length
  for (let frame = 0; frame < total; frame++)
    lines.push(String(framerate.timeAtFrame(frame, 'exact')))
  return lines.join('\n') + '\n'
}

/**
 * 保留首帧偏移的 v2 导出变体（arch1t3cht fork b7d228c0ce "Stop shifting timecodes
 * to start at 0ms" 语义）：表内写原始 PTS 值（帧 0 = 视频首帧偏移，不减 front）。
 * numerator/last 与归一化版本数值相同（back-front 差值不变），fork 的表尾外推公式
 * 同形——外推帧复用归一化 Framerate 的 timeAtFrame 即可。
 */
export function serializeTimecodesKeepOffset(raw: number[], length = -1): string {
  const lines = ['# timecode format v2']
  const rate = Framerate.fromTimecodes(raw) // 仅用于表尾外推
  const total = length > raw.length ? length : raw.length
  for (let frame = 0; frame < total; frame++)
    lines.push(String(frame < raw.length ? raw[frame] : rate.timeAtFrame(frame, 'exact')))
  return lines.join('\n') + '\n'
}

/** 编码文本为 UTF-8 字节数（edit/line/split/estimate 的时长分配权重） */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
