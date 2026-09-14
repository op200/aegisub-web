import { describe, expect, it } from 'vitest'

import { processTiming, type TimingProcessorOptions } from './timingProcessor'
import type { SubtitleCue } from './types'
import { Framerate } from './vfr'

function cue(
  id: string,
  startMs: number,
  endMs: number,
  style = 'Default',
  overrides: Partial<SubtitleCue> = {},
): SubtitleCue {
  return {
    id,
    layer: 0,
    startMs,
    endMs,
    style,
    actor: '',
    marginL: 0,
    marginR: 0,
    marginV: 0,
    effect: '',
    text: 'line',
    comment: false,
    extra: {},
    ...overrides,
  }
}

function options(overrides: Partial<TimingProcessorOptions> = {}): TimingProcessorOptions {
  return {
    leadIn: 0,
    leadOut: 0,
    beforeStart: 200,
    afterStart: 150,
    beforeEnd: 200,
    afterEnd: 250,
    adjGap: 300,
    adjOverlap: 50,
    adjacentBias: 0.9,
    enableLeadIn: false,
    enableLeadOut: false,
    enableKeyframes: false,
    enableAdjacent: false,
    onlySelection: false,
    ...overrides,
  }
}

describe('timing processor', () => {
  it('adds lead-in clamped by non-colliding previous lines', () => {
    const result = processTiming({
      cues: [cue('a', 500, 1000), cue('b', 1200, 2000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableLeadIn: true, leadIn: 300 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    expect(result.patches).toEqual([
      { id: 'a', startMs: 200, endMs: 1000 },
      // b 与 a 不冲突：起点最多前伸到 a 的结束
      { id: 'b', startMs: 1000, endMs: 2000 },
    ])
  })

  it('adds lead-out clamped by non-colliding following lines', () => {
    const result = processTiming({
      cues: [cue('a', 0, 1000), cue('b', 1300, 2000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableLeadOut: true, leadOut: 350 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    expect(result.patches).toEqual([
      // a 与 b 不冲突：终点最多后延到 b 的开始
      { id: 'a', startMs: 0, endMs: 1300 },
      { id: 'b', startMs: 1300, endMs: 2350 },
    ])
  })

  it('keeps colliding lines when adding lead-in/out', () => {
    const result = processTiming({
      cues: [cue('a', 0, 1000), cue('b', 900, 2000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableLeadIn: true, leadIn: 500, enableLeadOut: true, leadOut: 500 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    // a/b 冲突（CollidesWith），互相不钳制；首行前伸可为负（源码不钳 0）
    expect(result.patches).toEqual([
      { id: 'a', startMs: -500, endMs: 1500 },
      { id: 'b', startMs: 400, endMs: 2500 },
    ])
  })

  it('snaps adjacent lines within gap and overlap thresholds by bias', () => {
    const result = processTiming({
      cues: [
        cue('a', 0, 1000),
        cue('b', 1100, 2000), // dist 100 ≤ gap 300
        cue('c', 2200, 3000), // dist 200 ≤ 300（b 终点已改为 1090 后仍按当前值判定）
        cue('d', 3500, 4000), // dist 500 > 300 不吸附
      ],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableAdjacent: true, adjGap: 300, adjOverlap: 50, adjacentBias: 0.9 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    expect(result.patches).toEqual([
      { id: 'a', startMs: 0, endMs: 1090 }, // setPos = 1000 + int(100·0.9)
      { id: 'b', startMs: 1090, endMs: 2180 }, // setPos = 2000 + int(200·0.9)
      { id: 'c', startMs: 2180, endMs: 3000 },
      // d 未变化，不产生补丁
    ])
  })

  it('snaps overlapping adjacent lines with truncated bias', () => {
    const result = processTiming({
      cues: [cue('a', 0, 1000), cue('b', 970, 2000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableAdjacent: true, adjOverlap: 50, adjacentBias: 0.9 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    // dist = -30；setPos = 1000 + int(-30·0.9) = 973（C++ int 截断朝零）
    expect(result.patches).toEqual([
      { id: 'a', startMs: 0, endMs: 973 },
      { id: 'b', startMs: 973, endMs: 2000 },
    ])
  })

  it('snaps starts and ends to nearest keyframes within thresholds', () => {
    // 25fps CFR：timeAtFrame(f, start) = f·40 − 20，end = f·40 + 20
    const result = processTiming({
      cues: [cue('a', 1500, 3000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options({ enableKeyframes: true, beforeStart: 200, afterStart: 150 }),
      keyframes: [10, 20, 40],
      frameCount: 100,
      hasVideo: true,
      frameRate: Framerate.cfr(25),
    })
    // startF=38 → 最近关键帧 40 → start 时间 1580（差 80 ≤ beforeStart）
    // endF=74 → 最近 99 → closest−1=98 → end 时间 3940（差 940 > beforeEnd）不吸附
    expect(result.patches).toEqual([{ id: 'a', startMs: 1580, endMs: 3000 }])
  })

  it('reports negative duration lines by document row and aborts', () => {
    const result = processTiming({
      cues: [cue('a', 0, 1000), cue('b', 5000, 4000)],
      selectedIds: new Set(),
      checkedStyles: new Set(['Default']),
      options: options(),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    expect(result.invalidRow).toBe(1)
    expect(result.patches).toEqual([])
  })

  it('filters by checked styles, selection and comments', () => {
    const cues = [
      cue('a', 0, 1000),
      cue('b', 2000, 3000, 'ALT'),
      cue('c', 4000, 5000, 'Default', { comment: true }),
      cue('d', 6000, 7000),
    ]
    const result = processTiming({
      cues,
      selectedIds: new Set(['a']),
      checkedStyles: new Set(['Default']),
      options: options({ onlySelection: true, enableLeadIn: true, leadIn: 100 }),
      keyframes: [],
      frameCount: 0,
      hasVideo: false,
      frameRate: Framerate.empty(),
    })
    // 仅选中且样式勾选的非注释行参与：b（样式未勾选）、c（注释）、d（未选中）不变；
    // a 无前序行 → 前伸 100ms 为负（源码不钳 0）
    expect(result.patches).toEqual([{ id: 'a', startMs: -100, endMs: 1000 }])
  })
})
