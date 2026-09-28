// 重设分辨率移植测试：对齐 resolution_resampler.cpp / dialog_resample.cpp 的可见语义
import { describe, expect, it } from 'vitest'

import {
  RESAMPLE_AR_ADD_BORDERS,
  RESAMPLE_AR_MANUAL,
  RESAMPLE_AR_REMOVE_BORDERS,
  RESAMPLE_AR_STRETCH,
  type ResampleSettings,
  createYcbcrConverter,
  floatToString,
  formatAssOverrideColor,
  formatAssStyleColor,
  getScriptInfo,
  getScriptResolution,
  matrixOptionFromHeader,
  parseColor,
  parseYcbcrHeader,
  resampleCommands,
  ycbcrHeaderToBestPracticeString,
  ycbcrHeaderToEffective,
  ycbcrHeaderToExistingString,
} from './resample'
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from './types'

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
    ...over,
  }
}

function makeSettings(over: Partial<ResampleSettings> = {}): ResampleSettings {
  return {
    sourceX: 640,
    sourceY: 480,
    destX: 1280,
    destY: 960,
    margin: [0, 0, 0, 0],
    arMode: RESAMPLE_AR_STRETCH,
    matrixConversion: null,
    ...over,
  }
}

function commandsOf<T extends string>(commands: ReturnType<typeof resampleCommands>, type: T) {
  return commands.filter((c) => c.type === type)
}

describe('floatToString（utils.cpp float_to_string）', () => {
  it('去尾零并保留小数点前内容', () => {
    expect(floatToString(12)).toBe('12')
    expect(floatToString(12.5)).toBe('12.5')
    expect(floatToString(-0)).toBe('-0')
    expect(floatToString(-0.0001)).toBe('-0')
    expect(floatToString(0)).toBe('0')
    expect(floatToString(1 / 3)).toBe('0.333')
    expect(floatToString(2 / 3)).toBe('0.667')
    expect(floatToString(100)).toBe('100')
    expect(floatToString(-2.5)).toBe('-2.5')
    expect(floatToString(106.66666666666667)).toBe('106.667')
  })
})

describe('parseColor（parser.cpp color_grammar）', () => {
  it('ASS 16 进制（&Hbbggrr& / &Haabbggrr）', () => {
    expect(parseColor('&H00FF00&')).toEqual({ r: 0, g: 255, b: 0, a: 0 })
    expect(parseColor('&HFF0000FF')).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(parseColor('&hff&')).toBeNull() // 不足 6 位
  })

  it('SSA 十进制优先于 16 进制（int_ 在前）', () => {
    // 16711680 = 0xFF0000；若按 16 进制解释会得到完全不同的值
    expect(parseColor('16711680')).toEqual({ r: 0, g: 0, b: 255, a: 0 })
    // 8 位十进制数字串同样走 int_（与注释 "decimal numbers ... are also valid hex numbers" 一致）
    expect(parseColor('12345678')).toEqual({
      r: 12345678 & 0xff,
      g: (12345678 >>> 8) & 0xff,
      b: (12345678 >>> 16) & 0xff,
      a: (12345678 >>> 24) & 0xff,
    })
    expect(parseColor('-5')).toEqual({ r: 0xfb, g: 0xff, b: 0xff, a: 0xff })
  })

  it('css 颜色（rgb/rgba/#rrggbb/#rgb）与失败情形', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 0 })
    expect(parseColor('rgba(255,0,0,128)')).toEqual({ r: 255, g: 0, b: 0, a: 128 })
    expect(parseColor('#42a5f5')).toEqual({ r: 0x42, g: 0xa5, b: 0xf5, a: 0 })
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0 })
    expect(parseColor('rgb(300,0,0)')).toBeNull()
    expect(parseColor('rgb(1,2,3) ')).toBeNull() // css 分支不容尾随空白
    expect(parseColor(' 123')).toBeNull() // ass 分支不容前导空白
    expect(parseColor('123 ')).toEqual({
      r: 123 & 0xff,
      g: (123 >>> 8) & 0xff,
      b: 0,
      a: 0,
    }) // ass 分支允许尾随空白
    expect(parseColor('')).toBeNull()
  })

  it('格式化（color.cpp GetAssOverrideFormatted/GetAssStyleFormatted）', () => {
    expect(formatAssOverrideColor({ r: 255, g: 0, b: 0, a: 128 })).toBe('&H0000FF&')
    expect(formatAssStyleColor({ r: 255, g: 0, b: 0, a: 128 })).toBe('&H800000FF')
  })
})

describe('YCbCr header（ycbcr.cpp）', () => {
  it('解析与字符串化', () => {
    expect(parseYcbcrHeader('tv.601')).toEqual({
      kind: 'colorspace',
      colorspace: { matrix: 'SMPTE170M', range: 'MPEG' },
    })
    expect(parseYcbcrHeader(' PC.709 ')).toEqual({
      kind: 'colorspace',
      colorspace: { matrix: 'BT709', range: 'JPEG' },
    })
    expect(parseYcbcrHeader('None')).toEqual({ kind: 'none' })
    expect(parseYcbcrHeader('')).toEqual({ kind: 'missing' })
    expect(parseYcbcrHeader('tv')).toEqual({ kind: 'invalid' })
    expect(parseYcbcrHeader('tv.')).toEqual({ kind: 'invalid' })
    expect(parseYcbcrHeader('tv.601.x')).toEqual({ kind: 'invalid' })

    expect(ycbcrHeaderToExistingString(parseYcbcrHeader('tV.240M'))).toBe('TV.240M')
    expect(ycbcrHeaderToExistingString({ kind: 'missing' })).toBe('')
    expect(ycbcrHeaderToExistingString({ kind: 'none' })).toBe('None')
  })

  it('to_effective / to_best_practice', () => {
    // missing 视作 TV.601
    expect(ycbcrHeaderToEffective({ kind: 'missing' })).toEqual({
      kind: 'colorspace',
      colorspace: { matrix: 'SMPTE170M', range: 'MPEG' },
    })
    // None 是有效 header，保持 None
    expect(ycbcrHeaderToEffective({ kind: 'none' })).toEqual({ kind: 'none' })
    // 仅 601/709 保留；FCC → None；invalid → missing
    expect(ycbcrHeaderToBestPracticeString(parseYcbcrHeader('TV.601'))).toBe('TV.601')
    expect(ycbcrHeaderToBestPracticeString(parseYcbcrHeader('PC.FCC'))).toBe('None')
    expect(ycbcrHeaderToBestPracticeString({ kind: 'none' })).toBe('None')
    expect(ycbcrHeaderToBestPracticeString({ kind: 'invalid' })).toBe('')
  })

  it('MatrixOptionFromHeader 映射到下拉 index', () => {
    expect(matrixOptionFromHeader(parseYcbcrHeader('TV.601'))).toBe(1)
    expect(matrixOptionFromHeader(parseYcbcrHeader('PC.709'))).toBe(4)
    expect(matrixOptionFromHeader(parseYcbcrHeader('None'))).toBe(0)
    expect(matrixOptionFromHeader({ kind: 'missing' })).toBe(0)
  })

  it('rgb_to_rgb：同色彩空间往返近似恒等，601→709 有确定结果', () => {
    const identity = createYcbcrConverter(
      { matrix: 'SMPTE170M', range: 'MPEG' },
      { matrix: 'SMPTE170M', range: 'MPEG' },
    )
    expect(identity.rgbToRgb({ r: 255, g: 0, b: 0, a: 255 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 255,
    })
    expect(identity.rgbToRgb({ r: 255, g: 255, b: 255, a: 0 })).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 0,
    })

    const toRec709 = createYcbcrConverter(
      { matrix: 'SMPTE170M', range: 'MPEG' },
      { matrix: 'BT709', range: 'MPEG' },
    )
    // 白色在两套矩阵下不变（Y=235/Cb=Cr=0）
    expect(toRec709.rgbToRgb({ r: 255, g: 255, b: 255, a: 0 })).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 0,
    })
    // 纯红按 601→709 往返：R 溢出钳到 255、G≈25、B 钳到 0
    expect(toRec709.rgbToRgb({ r: 255, g: 0, b: 0, a: 0 })).toEqual({
      r: 255,
      g: 25,
      b: 0,
      a: 0,
    })
  })
})

describe('分辨率辅助（ass_file.cpp）', () => {
  it('GetResolution 的 Gabest 缺省逻辑', () => {
    expect(getScriptResolution({})).toEqual({ width: 384, height: 288 })
    expect(getScriptResolution({ PlayResY: '1024' })).toEqual({ width: 1280, height: 1024 })
    expect(getScriptResolution({ PlayResY: '480' })).toEqual({ width: 640, height: 480 })
    expect(getScriptResolution({ PlayResX: '1280' })).toEqual({ width: 1280, height: 1024 })
    expect(getScriptResolution({ PlayResX: '853' })).toEqual({ width: 853, height: 639 })
    expect(getScriptResolution({ PlayResX: '640', PlayResY: '480' })).toEqual({
      width: 640,
      height: 480,
    })
  })

  it('GetScriptInfo 键名大小写不敏感', () => {
    expect(getScriptInfo({ playresx: '640' }, 'PlayResX')).toBe('640')
    expect(getScriptInfo({ PlayResX: '640' }, 'PlayResX')).toBe('640')
    expect(getScriptInfo({}, 'PlayResX')).toBe('')
  })
})

describe('resampleCommands（resolution_resampler.cpp）', () => {
  it('等比放大 2 倍：样式数值与 PlayRes 更新，命令首条为 scriptInfo', () => {
    const doc = makeDoc()
    const commands = resampleCommands(doc, makeSettings())

    expect(commands[0]).toEqual({
      type: 'updateScriptInfo',
      patch: { PlayResX: '1280', PlayResY: '960' },
    })
    const styleCmd = commandsOf(commands, 'updateStyle')[0]
    expect(styleCmd).toMatchObject({
      id: 'Default',
      patch: {
        fontSize: 96,
        outline: 4,
        shadow: 4,
        spacing: 0,
        scaleX: 100,
        marginL: 20,
        marginR: 20,
        marginV: 20,
      },
    })
  })

  it('各向异性拉伸（640x480 → 1280x720 Stretch）：scaleX 按 ar、标签按 rx/ry', () => {
    const doc = makeDoc({
      scriptInfo: { LayoutResX: '640', LayoutResY: '360', PlayResX: '640', PlayResY: '480' },
      cues: [
        makeCue({
          text: '{\\b1\\fad(200,300)\\fs 48\\pos(10,20)\\clip(1,2,3,4)\\c&H0000FF&\\p1}m 0 0 l 10 20{\\p0}text',
        }),
      ],
    })
    const commands = resampleCommands(doc, makeSettings({ destY: 720 }))

    const styleCmd = commandsOf(commands, 'updateStyle')[0]
    expect((styleCmd as { patch: { scaleX: number } }).patch.scaleX).toBeCloseTo(
      (100 * (1280 / 720)) / (640 / 480),
      10,
    )
    expect(styleCmd).toMatchObject({
      patch: { fontSize: 72, outline: 3, shadow: 3, marginL: 20, marginR: 20, marginV: 15 },
    })

    const cueCmd = commandsOf(commands, 'updateCue')[0]
    expect(cueCmd).toMatchObject({
      id: '1',
      patch: {
        // \fs 与 \pos 按 ry/rx 缩放；\clip rect 按 (v+shift)*r+0.5 取整；\b/\fad/\c/\p 原样
        // 绘制块按 rx/ar、ry 缩放（ar=1.3333 时 x 系数 1.5）
        text: '{\\b1\\fad(200,300)\\fs72\\pos(20,30)\\clip(2,3,6,6)\\c&H0000FF&\\p1}m 0 0 l 15 30{\\p0}text',
      },
    })

    // LayoutRes：new_lry = 360 + round(360*0/640) = 360；new_lrx = round(640*(360/360)*(1280/720)/(640/480))
    const info = commandsOf(commands, 'updateScriptInfo')[0]
    expect(info).toEqual({
      type: 'updateScriptInfo',
      patch: {
        PlayResX: '1280',
        PlayResY: '720',
        LayoutResX: '853',
        LayoutResY: '360',
      },
    })
  })

  it('Add borders：margin 覆写为左右边带并参与坐标平移', () => {
    // 640x480(4:3) → 1920x1080(16:9)，目标更宽 → 左右加边
    const commands = resampleCommands(
      makeDoc(),
      makeSettings({
        destX: 1920,
        destY: 1080,
        arMode: RESAMPLE_AR_ADD_BORDERS,
        // 对话框在 AddBorder 下禁用 margin，这里给非零值验证源码会被覆写
        margin: [5, 6, 7, 8],
      }),
    )
    const styleCmd = commandsOf(commands, 'updateStyle')[0]
    // margin[LEFT]=margin[RIGHT]=int((480*(16/9)-640)/2)=106；sourceX=852，rx=1920/852，
    // TOP/BOTTOM 保持对话框传入值（AddBorder 只覆写左右），sourceY=480+7+8=495，ry=1080/495
    expect((styleCmd as { patch: { marginL: number } }).patch.marginL).toBe(
      Math.trunc((10 + 106) * (1920 / 852) + 0.5),
    )
    expect((styleCmd as { patch: { marginV: number } }).patch.marginV).toBe(
      Math.trunc((10 + 7) * (1080 / 495) + 0.5),
    )
  })

  it('Remove borders：目标更宽时改为上下加负边距', () => {
    const commands = resampleCommands(
      makeDoc(),
      makeSettings({ destX: 1920, destY: 1080, arMode: RESAMPLE_AR_REMOVE_BORDERS }),
    )
    // border_horizontally 取反 → 走 TOP/BOTTOM：(640/(16/9)-480)/2 = -60
    const styleCmd = commandsOf(commands, 'updateStyle')[0]
    expect((styleCmd as { patch: { marginV: number } }).patch.marginV).toBe(
      Math.trunc((10 - 60) * (1080 / (480 - 120)) + 0.5),
    )
  })

  it('Manual：按 margin 重算 ar，偏差小于 1% 时不拉伸', () => {
    // 640x480 + 左右各 160 → 960x480，ar = 2.0 与 1280/720=1.7778 差异 11% → 拉伸
    const commands = resampleCommands(
      makeDoc(),
      makeSettings({ destY: 720, arMode: RESAMPLE_AR_MANUAL, margin: [160, 160, 0, 0] }),
    )
    const styleCmd = commandsOf(commands, 'updateStyle')[0]
    expect((styleCmd as { patch: { scaleX: number } }).patch.scaleX).toBeCloseTo(
      (100 * (1280 / 720)) / (960 / 480),
      10,
    )
  })

  it('行边距按 (v+margin)*r+0.5 取整，零值保持 0；template/code 注释行跳过', () => {
    const doc = makeDoc({
      cues: [
        makeCue({ id: '1', marginL: 5, marginR: 0, marginV: 7, text: 'a' }),
        makeCue({ id: '2', comment: true, effect: 'template syl', text: '{\\pos(10,20)}x' }),
      ],
    })
    const commands = resampleCommands(doc, makeSettings())
    const cueCmds = commandsOf(commands, 'updateCue')
    expect(cueCmds).toHaveLength(1)
    expect(cueCmds[0]).toEqual({
      type: 'updateCue',
      id: '1',
      patch: { marginL: 10, marginV: 14 },
    })
  })

  it('无变化时不产生行命令（文本与边距相同）', () => {
    const doc = makeDoc({ cues: [makeCue({ text: 'plain text' })] })
    const commands = resampleCommands(doc, makeSettings())
    expect(commandsOf(commands, 'updateCue')).toHaveLength(0)
  })

  it('矩阵转换：写回 YCbCr Matrix 并转换样式与行内颜色', () => {
    const doc = makeDoc({
      styles: [makeStyle({ primaryColor: '&H0000FF&' })],
      cues: [makeCue({ text: '{\\1c&H0000FF&}x' })],
    })
    const commands = resampleCommands(
      doc,
      makeSettings({
        matrixConversion: {
          src: { matrix: 'SMPTE170M', range: 'MPEG' },
          dst: { matrix: 'BT709', range: 'MPEG' },
        },
      }),
    )
    const info = commandsOf(commands, 'updateScriptInfo')[0]
    expect(info).toMatchObject({ patch: { 'YCbCr Matrix': 'TV.709' } })
    // 样式色用 &Haabbggrr 形式（GetAssStyleFormatted）
    expect(
      (commandsOf(commands, 'updateStyle')[0] as { patch: { primaryColor: string } }).patch,
    ).toMatchObject({ primaryColor: '&H000019FF' })
    expect((commandsOf(commands, 'updateCue')[0] as { patch: { text: string } }).patch.text).toBe(
      '{\\1c&H0019FF&}x',
    )
  })

  it('matrixConversion 相同色彩空间时仍写回 BestPractice 但颜色不变', () => {
    const doc = makeDoc({ styles: [makeStyle({ primaryColor: '&H0000FF&' })] })
    const commands = resampleCommands(
      doc,
      makeSettings({
        matrixConversion: {
          src: { matrix: 'SMPTE170M', range: 'MPEG' },
          dst: { matrix: 'SMPTE170M', range: 'MPEG' },
        },
      }),
    )
    expect(commandsOf(commands, 'updateScriptInfo')[0]).toMatchObject({
      patch: { 'YCbCr Matrix': 'TV.601' },
    })
    // src == dst → converter 为空，样式颜色不进 patch（保持原值）
    const stylePatch = (
      commandsOf(commands, 'updateStyle')[0] as { patch: Record<string, unknown> }
    ).patch
    expect(stylePatch.primaryColor).toBeUndefined()
  })
})
