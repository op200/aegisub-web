/**
 * 卡拉OK数据模型（对应 libaegisub/ass/karaoke.cpp 与 src/ass_karaoke.cpp）。
 *
 * - 音节 start_time 为绝对毫秒；\k 参数为厘秒，解析 ×10、序列化 (d+5)/10。
 * - \K 归一化为 \kf；其它 override 标签按文本偏移保留并在序列化时插回。
 * - split 的时长分配按 UTF-8 字节数比例，取整到 10ms（厘秒）。
 */

export type KaraokeTagType = '\\k' | '\\kf' | '\\ko'

export interface KaraokeSyllable {
  tagType: KaraokeTagType
  /** 绝对毫秒（行 Start 为基准链） */
  startMs: number
  durationMs: number
  text: string
  /** 文本字节偏移 → 覆盖标签文本（如 "{\\i1}"），序列化时插回 */
  ovrTags: Map<number, string>
}

/** round_cs：(t + 5) / 10 * 10，取整到厘秒 */
export function roundCs(t: number): number {
  return Math.floor((t + 5) / 10) * 10
}

function byteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * ass_karaoke.cpp ParseKaraokeSyllables：解析行为音节序列。
 * 零 \k 行 → 单个 duration=0 的音节（start = 行 Start）。
 */
export function parseKaraokeSyllables(text: string, lineStartMs: number): KaraokeSyllable[] {
  const syllables: KaraokeSyllable[] = []
  let current: KaraokeSyllable = {
    tagType: '\\k',
    startMs: lineStartMs,
    durationMs: 0,
    text: '',
    ovrTags: new Map(),
  }

  const push = () => {
    if (current.durationMs > 0 || current.text) syllables.push(current)
  }

  let position = 0
  const blocks = [...text.matchAll(/\{([^}]*)\}|([^{]+)/g)]
  for (const block of blocks) {
    if (block[2] !== undefined) {
      current.text += block[2]
      position += block[2].length
      continue
    }
    const content = block[1]
    const tags = [...content.matchAll(/\\([^\\]+)/g)]
    let nonKaraTags: string[] = []
    const flushPlainTags = () => {
      if (nonKaraTags.length) {
        current.ovrTags.set(current.text.length, `{${nonKaraTags.join('')}}`)
        nonKaraTags = []
      }
    }
    for (const tag of tags) {
      const body = tag[1]
      // 仅拆 \k / \kf / \ko / \K（\K 归一化为 \kf）；其它标签按偏移记入 ovrTags
      const karaMatch = body.match(/^([kK])([fo]?)(\d+(?:\.\d+)?)/)
      if (karaMatch) {
        flushPlainTags()
        if (current.durationMs > 0 || current.text) {
          push()
          current = {
            tagType: '\\k',
            startMs: current.startMs + current.durationMs,
            durationMs: 0,
            text: '',
            ovrTags: new Map(),
          }
        }
        const letter = karaMatch[1]
        const modifier = karaMatch[2] ?? ''
        current.tagType = letter === 'K' ? '\\kf' : (`\\k${modifier}` as KaraokeTagType)
        current.durationMs = Number(karaMatch[3]) * 10
      } else {
        nonKaraTags.push(`\\${body}`)
      }
    }
    flushPlainTags()
  }
  push()
  void position
  return syllables.length
    ? syllables
    : [{ tagType: '\\k', startMs: lineStartMs, durationMs: 0, text: '', ovrTags: new Map() }]
}

/** libaegisub Karaoke::SetLine 的 Normalize：音节总长对齐行时长 */
function normalize(syllables: KaraokeSyllable[], lineStartMs: number, lineEndMs: number): void {
  const total = syllables.reduce((sum, syl) => sum + syl.durationMs, 0)
  const duration = Math.max(0, lineEndMs - lineStartMs)
  if (total < duration) {
    syllables[syllables.length - 1].durationMs += duration - total
  } else if (total > duration) {
    let excess = total - duration
    for (let i = syllables.length - 1; i >= 0 && excess > 0; i--) {
      const syl = syllables[i]
      const cut = Math.min(syl.durationMs, excess)
      syl.durationMs -= cut
      if (syl.startMs > lineEndMs) {
        syl.startMs = lineEndMs
        syl.durationMs = 0
      }
      excess -= cut
    }
  }
}

export class Karaoke {
  syllables: KaraokeSyllable[] = []

  /** SetKaraokeLine(auto_split=true, normalize=true)：解析 + 归一化 + 空格预切分 */
  static fromLine(text: string, lineStartMs: number, lineEndMs: number): Karaoke {
    const karaoke = new Karaoke()
    karaoke.syllables = parseKaraokeSyllables(text, lineStartMs)
    normalize(karaoke.syllables, lineStartMs, lineEndMs)
    if (karaoke.syllables.length === 1) karaoke.autoSplit()
    return karaoke
  }

  /** AutoSplit：在最后一个音节的每个空格后切分 */
  autoSplit(): void {
    const last = this.syllables[this.syllables.length - 1]
    if (!last) return
    const parts = last.text.split(/(\s+)/).filter((part) => part.length)
    // 合并：空格附在前段之后（ass_karaoke auto_split 语义：空格后切分）
    const pieces: string[] = []
    for (const part of parts) {
      if (/\s+/.test(part) && pieces.length) pieces[pieces.length - 1] += part
      else pieces.push(part)
    }
    if (pieces.length < 2) return
    let rest = pieces.slice(1).join('')
    const firstText = pieces[0]
    const original = this.syllables.pop()!
    this.syllables.push({ ...original, text: firstText })
    // 其余片段依次追加，时长按字节数比例分配
    const bytes = pieces.map((piece) => byteLength(piece))
    const totalBytes = bytes.reduce((sum, value) => sum + value, 0)
    if (!totalBytes) return
    let allocated = 0
    const anchor = this.syllables[this.syllables.length - 1]
    anchor.durationMs = roundCs((original.durationMs * bytes[0]) / totalBytes)
    allocated = anchor.durationMs
    let cursor = anchor.startMs + anchor.durationMs
    for (let i = 1; i < pieces.length; i++) {
      const isLast = i === pieces.length - 1
      const duration = isLast
        ? Math.max(0, original.durationMs - allocated)
        : roundCs((original.durationMs * bytes[i]) / totalBytes)
      this.syllables.push({
        tagType: original.tagType,
        startMs: cursor,
        durationMs: duration,
        text: pieces[i],
        ovrTags: new Map(),
      })
      allocated += duration
      cursor += duration
    }
    void rest
  }

  /** DoAddSplit：在 sylIdx 音节的字节位置 pos 后切分 */
  addSplit(sylIdx: number, pos: number): void {
    const syl = this.syllables[sylIdx]
    if (!syl) return
    const clamped = Math.max(0, Math.min(syl.text.length, pos))
    const left = syl.text.slice(0, clamped)
    const right = syl.text.slice(clamped)
    syl.text = left
    const next: KaraokeSyllable = {
      tagType: syl.tagType,
      startMs: syl.startMs,
      durationMs: 0,
      text: right,
      ovrTags: new Map(),
    }
    // 时长分配（按 UTF-8 字节比例，round_cs）
    if (!right) next.durationMs = 0
    else if (!left) {
      next.durationMs = syl.durationMs
      syl.durationMs = 0
    } else {
      const leftBytes = byteLength(left)
      const rightBytes = byteLength(right)
      next.durationMs = roundCs((syl.durationMs * rightBytes) / (leftBytes + rightBytes))
      syl.durationMs -= next.durationMs
    }
    next.startMs = syl.startMs + syl.durationMs
    // 位置 ≥ 原文本长度的 ovrTags 迁移到新音节
    for (const [offset, tag] of [...syl.ovrTags]) {
      if (offset >= clamped) {
        syl.ovrTags.delete(offset)
        next.ovrTags.set(offset - clamped, tag)
      }
    }
    this.syllables.splice(sylIdx + 1, 0, next)
  }

  /** RemoveSplit：sylIdx 音节并回前一个（0 不可删） */
  removeSplit(sylIdx: number): void {
    if (sylIdx <= 0 || sylIdx >= this.syllables.length) return
    const previous = this.syllables[sylIdx - 1]
    const syl = this.syllables[sylIdx]
    previous.durationMs += syl.durationMs
    for (const [offset, tag] of syl.ovrTags) {
      previous.ovrTags.set(offset + previous.text.length, tag)
    }
    previous.text += syl.text
    this.syllables.splice(sylIdx, 1)
  }

  /** SetTagType：全部音节统一 tag 类型 */
  setTagType(tag: KaraokeTagType): void {
    for (const syl of this.syllables) syl.tagType = tag
  }

  /** SetStartTime：拖动音节 sylIdx 的开始时间（前音节补/减同量；0 拒绝） */
  setStartTime(sylIdx: number, timeMs: number): void {
    if (sylIdx <= 0 || sylIdx >= this.syllables.length) return
    const syl = this.syllables[sylIdx]
    const delta = timeMs - syl.startMs
    syl.startMs = timeMs
    syl.durationMs = Math.max(0, syl.durationMs - delta)
    this.syllables[sylIdx - 1].durationMs = Math.max(
      0,
      this.syllables[sylIdx - 1].durationMs + delta,
    )
  }

  /** GetText：序列化（(d+5)/10 整除回厘秒；ovrTags 按偏移插回） */
  getText(): string {
    let result = ''
    for (const syl of this.syllables) {
      result += `{${syl.tagType}${Math.floor((syl.durationMs + 5) / 10)}}`
      let text = syl.text
      const entries = [...syl.ovrTags.entries()].sort((a, b) => a[0] - b[0])
      let rebuilt = ''
      let cursor = 0
      for (const [offset, tag] of entries) {
        const index = Math.min(offset, text.length)
        rebuilt += text.slice(cursor, index) + tag
        cursor = index
      }
      rebuilt += text.slice(cursor)
      text = rebuilt
      result += text
    }
    return result
  }
}
