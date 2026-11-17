// 内置导出过滤器移植测试：对齐 export_fixstyle.cpp / export_framerate.cpp 的可见语义
import { describe, expect, it } from 'vitest'

import { createProjectProperties } from './defaults'
import { fixStyles, transformFramerateCue, transformFramerateDocument } from './exportFilters'
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from './types'
import { Framerate } from './vfr'

function makeStyle(over: Partial<SubtitleStyle> = {}): SubtitleStyle {
  return {
    id: 'Default',
    name: 'Default',
    fontName: 'Arial',
    fontSize: 48,
    primaryColor: '&H00FFFFFF',
    secondaryColor: '&H0000FFFF',
    outlineColor: '&H00000000',
    backColor: '&H80000000',
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    outline: 2,
    shadow: 2,
    alignment: 2,
    marginL: 10,
    marginR: 10,
    marginV: 10,
    encoding: 1,
    values: {},
    ...over,
  }
}

function makeCue(over: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    id: '1',
    layer: 0,
    startMs: 0,
    endMs: 1000,
    style: 'Default',
    actor: '',
    marginL: 0,
    marginR: 0,
    marginV: 0,
    effect: '',
    text: '',
    comment: false,
    extra: {},
    ...over,
  }
}

function makeDoc(over: Partial<SubtitleDocument> = {}): SubtitleDocument {
  return {
    format: 'ass',
    sourceName: 'test.ass',
    revision: 0,
    scriptInfo: { PlayResX: '640', PlayResY: '480' },
    styles: [makeStyle()],
    cues: [],
    passthroughSections: [],
    attachments: [],
    extradata: [],
    properties: createProjectProperties(),
    ...over,
  }
}

describe('fixStyles（export_fixstyle.cpp）', () => {
  it('样式名忽略大小写匹配，未匹配的回退 Default', () => {
    const doc = makeDoc({
      styles: [makeStyle({ name: 'Default' }), makeStyle({ id: 'alt', name: 'Alt Style' })],
      cues: [
        makeCue({ id: '1', style: 'default' }),
        makeCue({ id: '2', style: 'ALT STYLE' }),
        makeCue({ id: '3', style: 'Missing' }),
      ],
    })

    const fixed = fixStyles(doc)

    expect(fixed.cues.map((cue) => cue.style)).toEqual(['default', 'ALT STYLE', 'Default'])
    // 原文档不被修改；匹配行保持原对象，回退行是新对象
    expect(doc.cues[2].style).toBe('Missing')
    expect(fixed.cues[0]).toBe(doc.cues[0])
    expect(fixed.cues[2]).not.toBe(doc.cues[2])
  })
})

describe('transformFramerate（export_framerate.cpp）', () => {
  it('CFR 24 → 25：换算行时间并重写 override 时间参数', () => {
    const cue = makeCue({
      startMs: 1000,
      endMs: 2000,
      text: '{\\fad(500,500)\\move(10,10,20,20,0,500)\\k20\\k30\\t(0,500,\\fad(100,200))}Hello',
    })

    // 24fps 帧 25 起点 = 1042（截断）→ newStart = 1040；帧 50 起点 = 2083 → newEnd = 2090
    // \fad 的 500ms 在输出 25fps 下为帧 37.5 → 输入 24fps 插值 1562
    const result = transformFramerateCue(cue, Framerate.cfr(24), Framerate.cfr(25))

    expect(result).toEqual({
      startMs: 1040,
      endMs: 2090,
      text: '{\\fad(522,528)\\move(10,10,20,20,2,522)\\k21\\k31\\t(2,522,\\fad(106,215))}Hello',
    })
  })

  it('24 → VFR timecodes：按输出帧表定位、按输入帧率插值', () => {
    // 帧起始：0/20/40/60/80/100，帧 6 跳变到 300
    const output = Framerate.fromTimecodes([0, 20, 40, 60, 80, 100, 300, 340, 380, 420, 460, 500])
    const cue = makeCue({
      startMs: 80,
      endMs: 120,
      text: '{\\fad(20,40)\\move(1,2,3,4,0,20)\\k10\\k10}VFR',
    })

    // 80ms → 输出帧 4 起点 → 输入 25fps 帧 4 = 160；120ms → 帧 5 内 10% → 204 → +9 截断 = 210
    const result = transformFramerateCue(cue, Framerate.cfr(25), output)

    expect(result).toEqual({
      startMs: 160,
      endMs: 210,
      text: '{\\fad(40,50)\\move(1,2,3,4,0,40)\\k5\\k2}VFR',
    })
  })

  it('无 override 标签的行只改起止时间', () => {
    const cue = makeCue({ startMs: 1000, endMs: 2000, text: 'Plain text' })
    const result = transformFramerateCue(cue, Framerate.cfr(24), Framerate.cfr(25))
    expect(result).toEqual({ startMs: 1040, endMs: 2090, text: 'Plain text' })
  })

  it('transformFramerateDocument 逐行换算且不改原文档', () => {
    const doc = makeDoc({
      cues: [
        makeCue({ id: '1', startMs: 1000, endMs: 2000, text: 'A' }),
        makeCue({ id: '2', startMs: 0, endMs: 1000, text: 'B' }),
      ],
    })

    const result = transformFramerateDocument(doc, Framerate.cfr(24), Framerate.cfr(25))

    expect(result).not.toBe(doc)
    expect(doc.cues[0].startMs).toBe(1000)
    expect(result.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([
      [1040, 2090],
      [0, 1050],
    ])
  })
})
