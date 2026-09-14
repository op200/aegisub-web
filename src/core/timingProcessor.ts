/**
 * 时间后处理器（dialog_timing_processor.cpp Process()）。
 *
 * 语义严格对齐源码：
 * - SortDialogues：非注释且样式勾选的行；"仅选择"时取选择集子集；任一行 Start > End
 *   则按文档行号报错中止（diag->Row）；按 Start 升序排列后处理。
 * - Lead-in/out：safe_time O(n²)——只与不冲突的行比较（AssDialogue::CollidesWith），
 *   lead-in 取 max(Start-leadIn, 前面各行 End)，lead-out 取 min(End+leadOut, 后面各行 Start)。
 * - Make adjacent：dist = cur.Start − prev.End（C++ int 截断）；dist<0 且 |dist|≤overlap 或
 *   dist>0 且 dist≤gap 时，两侧同设 prev.End + int(dist·bias)（截断）。
 * - Keyframe snapping：FrameAtTime(START/END) 求帧 → get_closest_kf（upper_bound，平局取前）
 *   → TimeAtFrame 转回时间，四阈值判定；末端用 closest−1；有视频时末帧（frameCount−1）
 *   追加为关键帧（provider->GetFrameCount()-1）。
 * - C++ int 毫秒语义：处理前将时间取整到整数毫秒。
 */

import type { SubtitleCue } from './types'
import type { Framerate } from './vfr'

export interface TimingProcessorOptions {
  leadIn: number
  leadOut: number
  beforeStart: number
  afterStart: number
  beforeEnd: number
  afterEnd: number
  adjGap: number
  adjOverlap: number
  /** 0..1（源码 slider 值 / 100） */
  adjacentBias: number
  enableLeadIn: boolean
  enableLeadOut: boolean
  enableKeyframes: boolean
  enableAdjacent: boolean
  onlySelection: boolean
}

export interface TimingProcessorPatch {
  id: string
  startMs: number
  endMs: number
}

export interface TimingProcessorInput {
  cues: SubtitleCue[]
  selectedIds: ReadonlySet<string>
  checkedStyles: ReadonlySet<string>
  options: TimingProcessorOptions
  /** 关键帧帧号（源码 project->Keyframes()） */
  keyframes: number[]
  /** 视频总帧数（追加末帧关键帧；无视频时传 0 与 hasVideo=false） */
  frameCount: number
  hasVideo: boolean
  frameRate: Framerate
}

export interface TimingProcessorResult {
  /** Start > End 的文档行号（0 基）；非 null 时中止且无补丁 */
  invalidRow: number | null
  patches: TimingProcessorPatch[]
}

interface WorkItem {
  cue: SubtitleCue
  start: number
  end: number
}

/** ass_dialogue.cpp AssDialogue::CollidesWith（comp 为当前行） */
function collides(comp: WorkItem, target: WorkItem): boolean {
  return comp.start < target.start ? target.start < comp.end : comp.start < target.end
}

/** dialog_timing_processor.cpp get_closest_kf：upper_bound 定位，平局取前一个 */
function getClosestKf(keyframes: number[], frame: number): number {
  let lo = 0
  let hi = keyframes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] <= frame) lo = mid + 1
    else hi = mid
  }
  // 最后一个关键帧之后 → 返回末尾关键帧
  if (lo === keyframes.length) return keyframes[keyframes.length - 1]
  return lo === 0 || keyframes[lo] - frame < frame - keyframes[lo - 1]
    ? keyframes[lo]
    : keyframes[lo - 1]
}

export function processTiming(input: TimingProcessorInput): TimingProcessorResult {
  const { cues, selectedIds, checkedStyles, options, keyframes, frameCount, hasVideo, frameRate } =
    input

  // SortDialogues：valid_line = !Comment && styles.count(Style)
  const rowOf = new Map(cues.map((cue, index) => [cue.id, index]))
  const pool = cues.filter(
    (cue) =>
      !cue.comment &&
      checkedStyles.has(cue.style) &&
      (!options.onlySelection || selectedIds.has(cue.id)),
  )

  // 负时长检查（diag->Row = 文档行号）
  for (const cue of pool) {
    if (cue.startMs > cue.endMs) {
      return { invalidRow: rowOf.get(cue.id) ?? 0, patches: [] }
    }
  }

  const sorted = [...pool].sort((a, b) => a.startMs - b.startMs)
  const work: WorkItem[] = sorted.map((cue) => ({
    cue,
    start: Math.round(cue.startMs),
    end: Math.round(cue.endMs),
  }))

  // Add lead-in（safe_time：与前面各行比较，非冲突行取 max(End)）
  if (options.enableLeadIn && options.leadIn) {
    for (let i = 0; i < work.length; i++) {
      const cur = work[i]
      let initial = cur.start - options.leadIn
      for (let j = 0; j < i; j++) {
        if (!collides(cur, work[j])) initial = Math.max(initial, work[j].end)
      }
      cur.start = initial
    }
  }

  // Add lead-out（safe_time：与后面各行比较，非冲突行取 min(Start)）
  if (options.enableLeadOut && options.leadOut) {
    for (let i = 0; i < work.length; i++) {
      const cur = work[i]
      let initial = cur.end + options.leadOut
      for (let j = i + 1; j < work.length; j++) {
        if (!collides(cur, work[j])) initial = Math.min(initial, work[j].start)
      }
      cur.end = initial
    }
  }

  // Make adjacent subtitles continuous
  if (options.enableAdjacent) {
    const bias = options.adjacentBias
    for (let i = 1; i < work.length; i++) {
      const prev = work[i - 1]
      const cur = work[i]
      const dist = Math.trunc(cur.start - prev.end)
      if ((dist < 0 && -dist <= options.adjOverlap) || (dist > 0 && dist <= options.adjGap)) {
        const setPos = prev.end + Math.trunc(dist * bias)
        cur.start = setPos
        prev.end = setPos
      }
    }
  }

  // Keyframe snapping（keysAvailable = 关键帧非空且 timecodes 已加载）
  if (options.enableKeyframes && keyframes.length > 0 && frameRate.isLoaded()) {
    const kf = [...keyframes]
    if (hasVideo && frameCount > 0) kf.push(frameCount - 1)

    for (const item of work) {
      // Get closest for start
      const startF = frameRate.frameAtTime(item.start, 'start')
      const closestStart = getClosestKf(kf, startF)
      const startTime = frameRate.timeAtFrame(closestStart, 'start')
      if (
        (closestStart > startF && startTime - item.start <= options.beforeStart) ||
        (closestStart < startF && item.start - startTime <= options.afterStart)
      )
        item.start = startTime

      // Get closest for end（末端用 closest−1 的 END 语义时间）
      const endF = frameRate.frameAtTime(item.end, 'end')
      const closestEnd = getClosestKf(kf, endF) - 1
      const endTime = frameRate.timeAtFrame(closestEnd, 'end')
      if (
        (closestEnd > endF && endTime - item.end <= options.beforeEnd) ||
        (closestEnd < endF && item.end - endTime <= options.afterEnd)
      )
        item.end = endTime
    }
  }

  const patches = work
    .filter(
      (item) =>
        item.start !== Math.round(item.cue.startMs) || item.end !== Math.round(item.cue.endMs),
    )
    .map((item) => ({ id: item.cue.id, startMs: item.start, endMs: item.end }))
  return { invalidRow: null, patches }
}
