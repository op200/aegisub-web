import { describe, expect, it } from 'vitest'

import {
  Framerate,
  parseKeyframes,
  parseTimecodes,
  serializeKeyframes,
  utf8ByteLength,
} from './vfr'

describe('Framerate（libaegisub vfr.cpp 语义）', () => {
  it('CFR 25fps：EXACT 截断，START/END 为中点向上取整', () => {
    const fps = Framerate.cfr(25)
    // 帧 10 → EXACT = 10*1000/25 = 400（截断）；START=380；END=420
    expect(fps.timeAtFrame(10)).toBe(400)
    expect(fps.timeAtFrame(10, 'start')).toBe(380)
    expect(fps.timeAtFrame(10, 'end')).toBe(420)
    // FrameAtTime(400, EXACT) = floor((400+0.5)*25/1000) = 10
    expect(fps.frameAtTime(400)).toBe(10)
    expect(fps.frameAtTime(419)).toBe(10)
    // START：FrameAtTime(ms-1)+1；END：FrameAtTime(ms-1)
    // 帧 10 的 START 查询范围 = [380, 419]；END 查询范围 = [401, 440]
    expect(fps.frameAtTime(380, 'start')).toBe(10)
    expect(fps.frameAtTime(400, 'start')).toBe(10)
    expect(fps.frameAtTime(399, 'start')).toBe(10) // START(399) = FrameAtTime(398)+1 = 9+1
    expect(fps.frameAtTime(400, 'end')).toBe(9)
    expect(fps.frameAtTime(401, 'end')).toBe(10)
    expect(fps.frameAtTime(440, 'end')).toBe(10)
  })

  it('恒有 TimeAtFrame(f, END) == TimeAtFrame(f+1, START)', () => {
    const fps = Framerate.cfr(23.976)
    for (let frame = 0; frame < 50; frame++) {
      expect(fps.timeAtFrame(frame, 'end')).toBe(fps.timeAtFrame(frame + 1, 'start'))
    }
  })

  it('v2 timecodes 查表并归一化首帧为 0', () => {
    const fps = Framerate.fromTimecodes([1000, 1500, 1900, 2400])
    expect(fps.timecodes[0]).toBe(0)
    expect(fps.timecodes[2]).toBe(900)
    expect(fps.timeAtFrame(2)).toBe(900)
  })

  it('未加载时 TimeAtFrame 恒为 0', () => {
    const fps = Framerate.empty()
    expect(fps.isLoaded()).toBe(false)
    expect(fps.timeAtFrame(100)).toBe(0)
  })
})

describe('关键帧文件解析（libaegisub keyframe.cpp）', () => {
  it('v1 格式：fps 行被吞掉，逐行整数', () => {
    const text = '# keyframe format v1\nfps 23.976\n0\n100\n250\n'
    expect(parseKeyframes(text)).toEqual([0, 100, 250])
  })

  it('xvid 2pass：i 为关键帧，p/b 递增计数', () => {
    const text = '# XviD 2pass stat file\ni\np\nb\ni\np\n'
    expect(parseKeyframes(text)).toEqual([0, 3])
  })

  it('未知格式抛错', () => {
    expect(() => parseKeyframes('whatever\n1\n2\n')).toThrow('Unknown keyframe format')
  })

  it('保存为 v1 格式', () => {
    expect(serializeKeyframes([0, 100])).toBe('# keyframe format v1\nfps 0\n0\n100\n')
  })
})

describe('timecodes 文件解析（libaegisub vfr.cpp）', () => {
  it('v2 格式逐行毫秒，容忍注释行', () => {
    const text = '# timecode format v2\n0\n1000\n# comment\n2000\n3000\n'
    const fps = parseTimecodes(text)
    expect(fps.timeAtFrame(2)).toBe(2000)
    expect(fps.timeAtFrame(3, 'end')).toBe(3000 + Math.floor((4000 - 3000 + 1) / 2))
  })

  it('v1 格式 assume + 区间展开', () => {
    const text = '# timecode format v1\nAssume 25\n0,49,25\n50,99,50\n'
    const fps = parseTimecodes(text)
    // 帧 0..49 @25fps（40ms），帧 50..99 @50fps（20ms）
    expect(fps.timeAtFrame(1)).toBe(40)
    expect(fps.timeAtFrame(50)).toBe(2000)
    expect(fps.timeAtFrame(51)).toBe(2020)
  })

  it('v1 重叠区间抛错', () => {
    const text = '# timecode format v1\nAssume 25\n0,49,25\n40,99,50\n'
    expect(() => parseTimecodes(text)).toThrow('Override ranges must not overlap')
  })

  it('v2 少于两个 timecodes 抛错', () => {
    expect(() => parseTimecodes('# timecode format v2\n0\n')).toThrow('at least two')
  })
})

describe('utf8ByteLength（edit/line/split/estimate 权重）', () => {
  it('多字节字符按 UTF-8 字节数计', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中文')).toBe(6)
    expect(utf8ByteLength('a文b')).toBe(5)
  })
})
