import { Video } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

import {
  getOption,
  getOptionBool,
  getOptionInt,
  getOptionString,
  useOptionsVersion,
} from '../../config/options'
import {
  readVisualOverrides,
  setOverride,
  setPosition,
  readVectorClip,
  setVectorClip,
} from '../../core/assVisual'
import { exportAss } from '../../core/format'
import { Spline, scaleSpline, vec, type SplineCurve, type Vec2 } from '../../core/spline'
import { formatVideoTime } from '../../core/time'
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from '../../core/types'
import type { Framerate } from '../../core/vfr'
import { WebCodecsVideoSource } from '../../media/webcodecsVideo'
import type { MediaSource } from '../../platform/types'
import { aegisubIconUrl, commandIcon } from '../aegisubIcons'
import { getVideoContext } from '../aegisubMenus'
import { createAssRenderer, type AssRenderer } from '../assRenderer'
import { assColorToCss, cssColorToHex } from '../color'
import { COMMANDS, commandTooltip } from '../commands'
import { tPlain } from '../i18n'
import { logError, logInfo, logWarning } from '../log'
import { SLIDER_PALETTES, useSystemTheme } from '../theme'
import { probeLocalFonts } from './dialogs'
import { MenuPopup } from './MenuPopup'

interface PreviewPaneProps {
  document: SubtitleDocument
  media: MediaSource | null
  currentTimeMs: number
  activeCue: SubtitleCue | null
  onTimeChange: (timeMs: number) => void
  onDurationChange: (durationMs: number) => void
  onOpenMedia: () => void
  mediaAction: { sequence: number; type: string }
  onCommand: (id: string) => void
  onPatchCue: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void
  onPatchStyle: (id: string, patch: Partial<Omit<SubtitleStyle, 'id'>>, label: string) => void
  isCommandEnabled: (id: string) => boolean
  isCommandChecked: (id: string) => boolean
  windowZoom: number
  onWindowZoomChange: (zoom: number) => void
  onIntrinsicSizeChange: (width: number, height: number) => void
  intrinsicWidth: number
  intrinsicHeight: number
  /** 本地字体授权递增计数：变化时重建 jassub 实例，让 libass 用新权限重新匹配字体 */
  localFontsEpoch: number
  /** 用户在预览区完成系统字体授权后回调（同 Fonts Collector，epoch++ 触发重建） */
  onLocalFontsAuthorize?: () => void
  /** Video/Overscan Mask（video/show_overscan） */
  overscan: boolean
  /** 关键帧列表（video_slider 刻度与 VideoPosition 高亮） */
  keyframes: number[]
  /** 当前帧号（FrameAtTime EXACT） */
  currentFrame: number
  /** 帧率状态机（timecodes 文件 > 探测 CFR）：滑块帧↔时间换算与时间框显示 */
  frameRate: Framerate
  /** 视频总帧数（provider GetFrameCount 语义；滑块 max = 帧数-1） */
  frameCount: number
  /** requestVideoFrameCallback 探测到的真实帧率回调 */
  onDetectedFps: (fps: number) => void
  /** WebCodecs 视频源读流收集到的关键帧（mkv 等无原生 keyframes 来源时） */
  onKeyframesChange?: (keyframes: number[]) => void
  /** 当前解码通道上报（状态栏指示）：'native'=浏览器原生 <video>，'webcodecs'=WebCodecs，null=无视频 */
  onPlaybackModeChange?: (mode: VideoPlaybackMode | null) => void
  /** 解码通道覆盖：true=强制 WebCodecs，false=强制原生，缺省/null=自动（<video> onError 切换） */
  decoderOverride?: boolean | null
  style?: CSSProperties
}

/** 视频解码通道 */
export type VideoPlaybackMode = 'native' | 'webcodecs'

const VICON = (name: string) => aegisubIconUrl(name, 16)

/** colorspace.cpp clip_colorval */
function clipColorVal(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/** colorspace.cpp rgb_to_hsl（0-255 量化：H=int(h*256/6)、S=int(s*255)、L=int(l*255)，截断） */
function rgbToHsl255(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (min + max) / 2
  let h = 0
  let s = 0
  if (min !== max) {
    s = l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min)
    if (rn === max) h = (gn - bn) / (max - min)
    else if (gn === max) h = (bn - rn) / (max - min) + 2
    else h = (rn - gn) / (max - min) + 4
  }
  if (h < 0) h += 6
  if (h >= 6) h -= 6
  return [
    clipColorVal(Math.trunc((h * 256) / 6)),
    clipColorVal(Math.trunc(s * 255)),
    clipColorVal(Math.trunc(l * 255)),
  ]
}

/** colorspace.cpp hsl_to_rgb（S=0 灰、L=128&S=255 主色特例，浮点公式，输出截断） */
function hslToRgb255(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  if (l === 128 && s === 255) {
    if (h === 0 || h === 255) return [255, 0, 0]
    if (h === 43) return [255, 255, 0]
    if (h === 85) return [0, 255, 0]
    if (h === 128) return [0, 255, 255]
    if (h === 171) return [0, 0, 255]
    if (h === 213) return [255, 0, 255]
  }
  const hf = h / 255
  const sf = s / 255
  const lf = l / 255
  const temp2 = lf < 0.5 ? lf * (1 + sf) : lf + sf - lf * sf
  const temp1 = 2 * lf - temp2
  const channel = (t: number): number => {
    if (6 * t < 1) return temp1 + (temp2 - temp1) * 6 * t
    if (2 * t < 1) return temp2
    if (3 * t < 2) return temp1 + (temp2 - temp1) * (2 / 3 - t) * 6
    return temp1
  }
  const t0 = hf + 1 / 3
  const t2 = hf - 1 / 3
  return [
    clipColorVal(Math.trunc(channel(t0 > 1 ? t0 - 1 : t0) * 255)),
    clipColorVal(Math.trunc(channel(hf) * 255)),
    clipColorVal(Math.trunc(channel(t2 < 0 ? t2 + 1 : t2) * 255)),
  ]
}

/**
 * video_provider_dummy.cpp 棋盘亮色：rgb_to_hsl(red, blue, green)（G/B 槽互换是源码行为）
 * → L += 24（无符号字节回绕，超亮色反而变暗）→ hsl_to_rgb → 输出再互换回 (red, green, blue)
 */
function dummyCheckerLightColor(r: number, g: number, b: number): string {
  const [h, s, l] = rgbToHsl255(r, b, g)
  let light = (l + 24) & 0xff
  if (light < 24) light = (light - 48) & 0xff
  const [rr, gg, bb] = hslToRgb255(h, s, light)
  return `rgb(${rr},${bb},${gg})`
}

/** 解析 '#hex' / 'rgb(r,g,b)' 为 RGB 分量（棋盘格计算用） */
function colorComponents(color: string): [number, number, number] {
  const hex = cssColorToHex(color)
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

/** 绘制 dummy 视频背景（对应 video_provider_dummy.cpp：纯色或 8×8 视频像素棋盘格）；scale = 显示像素/视频像素 */
function drawDummyBackground(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  pattern: boolean,
  scale: number,
): void {
  context.fillStyle = color
  context.fillRect(x, y, w, h)
  if (!pattern) return
  // (y/8 & 1) != (x/8 & 1) 的块用 L+=24 亮色覆盖，首块 (0,0) 为基色
  const [r, g, b] = colorComponents(color)
  const cell = 8 * scale
  context.fillStyle = dummyCheckerLightColor(r, g, b)
  const cols = Math.ceil(w / cell)
  const rows = Math.ceil(h / cell)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if ((row & 1) !== (col & 1)) context.fillRect(x + col * cell, y + row * cell, cell, cell)
    }
  }
}

/** dummy 背景的 CSS 版本（jassub 接管字幕时由 .dummy-video-stage div 承担，避免交互 canvas 遮住字幕层）；scale = 显示像素/视频像素 */
function dummyBackgroundCss(dummy: { color: string; pattern: boolean }, scale: number): string {
  if (!dummy.pattern) return dummy.color
  const [r, g, b] = colorComponents(dummy.color)
  const cell = 8 * scale
  // 左上角锚定，首块为基色（conic 从 0 度顺时针：0-25% 为右上块）
  return `repeating-conic-gradient(${dummyCheckerLightColor(r, g, b)} 0% 25%, ${dummy.color} 0% 50%) 0 0 / ${cell * 2}px ${cell * 2}px`
}
const VISUAL_TOOLS = [
  ['video/tool/cross', 'visual_standard'],
  ['video/tool/drag', 'visual_move'],
  ['video/tool/rotate/z', 'visual_rotatez'],
  ['video/tool/rotate/xy', 'visual_rotatexy'],
  ['video/tool/scale', 'visual_scale'],
  ['video/tool/clip', 'visual_clip'],
  ['video/tool/vector_clip', 'visual_vector_clip'],
  ['', ''],
  ['help/video', 'visual_help'],
] as const

interface HitBox {
  cue: SubtitleCue
  left: number
  right: number
  top: number
  bottom: number
}

// ---------------------------------------------------------------------------
// 矢量裁剪工具（visual_tool_vector_clip.cpp）
// ---------------------------------------------------------------------------
const VCLIP_MODES = [
  'video/tool/vclip/drag',
  'video/tool/vclip/line',
  'video/tool/vclip/bicubic',
  '',
  'video/tool/vclip/convert',
  'video/tool/vclip/insert',
  'video/tool/vclip/remove',
  '',
  'video/tool/vclip/freehand',
  'video/tool/vclip/freehand_smooth',
] as const

/** rgb(r,g,b) → rgba(r,g,b,alpha) */
function withAlpha(color: string, alpha: number): string {
  const match = /rgba?\(([^)]*)\)/.exec(color)
  if (!match) return color
  const parts = match[1].split(',').map((item) => item.trim())
  return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`
}

/** Colour/Visual Tools 选项 → 视觉工具绘制颜色（preferences.cpp Interface_Colours） */
function visualToolColors() {
  const lines = getOptionString('Colour/Visual Tools/Lines Primary')
  const secondary = getOptionString('Colour/Visual Tools/Lines Secondary')
  return {
    lines,
    secondary,
    selected: getOptionString('Colour/Visual Tools/Highlight Secondary'),
    active: getOptionString('Colour/Visual Tools/Highlight Primary'),
    shadow: `rgba(0,0,0,${getOption<number>('Colour/Visual Tools/Shaded Area Alpha')})`,
    linesFaint: withAlpha(lines, 0.5),
    linesStrong: withAlpha(lines, 0.9),
    // 特征点填充（visual_tool.cpp DrawAllFeatures：0.3 透明度）
    baseFill: withAlpha(getOptionString('Colour/Visual Tools/Highlight Primary'), 0.3),
    activeFill: withAlpha(getOptionString('Colour/Visual Tools/Highlight Secondary'), 0.3),
    selFill: withAlpha(lines, 0.3),
  }
}

interface VClipFeature {
  key: string
  index: number
  point: number
  pos: Vec2
  shape: 'circle' | 'square'
}

interface VClipState {
  inverse: boolean
  spline: Spline
  mode: string
  selected: Set<string>
  active: string | null
  /** 拖动起点（脚本坐标） */
  dragStart: Vec2 | null
  /** 拖动开始时各选中特征的原坐标 */
  dragOriginal: Map<string, Vec2>
  /** drag 模式框选起点 */
  boxStart: Vec2 | null
  /** 当前鼠标位置（脚本坐标，line/bicubic 预览用） */
  mouse: Vec2 | null
}

function makeFeatures(spline: Spline): VClipFeature[] {
  const features: VClipFeature[] = []
  spline.curves.forEach((curve: SplineCurve, index: number) => {
    if (curve.type === 'point') {
      features.push({ key: `${index}:0`, index, point: 0, pos: curve.p1, shape: 'circle' })
    } else if (curve.type === 'line') {
      features.push({ key: `${index}:1`, index, point: 1, pos: curve.p2, shape: 'circle' })
    } else {
      features.push({ key: `${index}:1`, index, point: 1, pos: curve.p2, shape: 'square' })
      features.push({ key: `${index}:2`, index, point: 2, pos: curve.p3, shape: 'square' })
      features.push({ key: `${index}:3`, index, point: 3, pos: curve.p4, shape: 'circle' })
    }
  })
  return features
}

/** 子路径折线（POINT 分割，贝塞尔按采样） */
function splinePolylines(spline: Spline): Vec2[][] {
  const paths: Vec2[][] = []
  let current: Vec2[] = []
  for (const curve of spline.curves) {
    if (curve.type === 'point') {
      if (current.length > 1) paths.push(current)
      current = [curve.p1]
    } else if (curve.type === 'line') {
      if (!current.length) current.push(curve.p1)
      current.push(curve.p2)
    } else {
      if (!current.length) current.push(curve.p1)
      current.push(...spline.sampleBicubic(curve).slice(1))
    }
  }
  if (current.length > 1) paths.push(current)
  return paths
}

function plainText(text: string): string[] {
  return text
    .replace(/\{[^}]*}/g, '')
    .replaceAll('\\h', ' ')
    .split(/\\N|\\n/)
}

function drawCue(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  style: SubtitleStyle,
  playResX: number,
  playResY: number,
  /** false：只计算包围盒不落笔（字幕由 jassub/libass 绘制时） */
  draw = true,
): { left: number; right: number; top: number; bottom: number } {
  const scaleX = width / Math.max(1, playResX)
  const scaleY = height / Math.max(1, playResY)
  const scale = scaleY
  const overrides = readVisualOverrides(text)
  const fontSize = Math.max(1, style.fontSize * scale)
  const lines = plainText(text)
  const lineHeight = fontSize * 1.2
  const defaultVertical =
    style.alignment <= 3
      ? height - Math.max(18, style.marginV * scale) - lineHeight * (lines.length - 1)
      : style.alignment >= 7
        ? Math.max(fontSize, style.marginV * scale + fontSize)
        : height / 2
  const defaultHorizontal = [1, 4, 7].includes(style.alignment)
    ? Math.max(16, style.marginL * scale)
    : [3, 6, 9].includes(style.alignment)
      ? width - Math.max(16, style.marginR * scale)
      : width / 2
  const horizontal = overrides.pos ? overrides.pos.x * scaleX : defaultHorizontal
  const vertical = overrides.pos ? overrides.pos.y * scaleY : defaultVertical
  context.textAlign = [1, 4, 7].includes(style.alignment)
    ? 'left'
    : [3, 6, 9].includes(style.alignment)
      ? 'right'
      : 'center'
  context.textBaseline = 'alphabetic'
  context.lineJoin = 'round'
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : '400 '}${fontSize}px "${style.fontName}", sans-serif`
  context.fillStyle = assColorToCss(style.primaryColor)
  context.strokeStyle = assColorToCss(style.outlineColor, '#000000')
  context.lineWidth = Math.max(1, style.outline * scale * 2)
  context.save()
  if (overrides.clip) {
    context.beginPath()
    context.rect(
      overrides.clip.x1 * scaleX,
      overrides.clip.y1 * scaleY,
      (overrides.clip.x2 - overrides.clip.x1) * scaleX,
      (overrides.clip.y2 - overrides.clip.y1) * scaleY,
    )
    if (!overrides.clip.inverse) context.clip()
  }
  context.translate(horizontal, vertical)
  context.rotate((overrides.rotationZ * Math.PI) / 180)
  const xyScaleX = Math.max(0.05, Math.abs(Math.cos((overrides.rotationY * Math.PI) / 180)))
  const xyScaleY = Math.max(0.05, Math.abs(Math.cos((overrides.rotationX * Math.PI) / 180)))
  context.scale((overrides.scaleX / 100) * xyScaleX, (overrides.scaleY / 100) * xyScaleY)
  let boxLeft = width
  let boxRight = 0
  lines.forEach((line, index) => {
    const y = (index - (lines.length - 1)) * lineHeight
    const measured = context.measureText(line)
    const textWidth =
      Math.abs(measured.actualBoundingBoxLeft) + Math.abs(measured.actualBoundingBoxRight) ||
      measured.width
    if (draw) {
      if (style.shadow > 0) {
        context.shadowColor = assColorToCss(style.backColor, 'rgba(0,0,0,.7)')
        context.shadowBlur = 0
        context.shadowOffsetX = style.shadow * scale
        context.shadowOffsetY = style.shadow * scale
      }
      if (style.outline > 0) context.strokeText(line, 0, y)
      context.fillText(line, 0, y)
      context.shadowColor = 'transparent'
    }
    const lineLeft =
      context.textAlign === 'center'
        ? -textWidth / 2
        : context.textAlign === 'right'
          ? -textWidth
          : 0
    boxLeft = Math.min(boxLeft, horizontal + lineLeft - style.outline * scale)
    boxRight = Math.max(boxRight, horizontal + lineLeft + textWidth + style.outline * scale)
  })
  context.restore()
  const scaledHeight = lineHeight * Math.max(0.05, overrides.scaleY / 100)
  const top = vertical - scaledHeight * (lines.length - 1) - style.outline * scale
  const bottom = vertical + lineHeight + style.outline * scale
  return { left: boxLeft, right: boxRight, top, bottom }
}

interface VideoSliderProps {
  /** 最后一个可寻址帧（video_slider.cpp VideoOpened：GetFrameCount() - 1） */
  maxFrame: number
  /** 当前帧（video_controller GetFrameN） */
  currentFrame: number
  keyframes: number[]
  /** Video/Slider/Show Keyframes */
  showKeyframes: boolean
  onSeekFrame: (frame: number) => void
  /** Shift+滚轮/Shift+方向键：按关键帧步进（video/frame/prev|next/keyframe） */
  onKeyframeStep: (direction: 1 | -1) => void
}

/** %+dms（video_box.cpp UpdateTimeBoxes：C++ 整数截断 + 显式符号） */
function signedMs(value: number): string {
  return `${value < 0 ? '-' : '+'}${Math.abs(Math.trunc(value))}ms`
}

/** 自定义 Seek 滑块，与 video_slider.cpp 绘制一致（轨道 + 箭头游标 + 关键帧刻度 + 底部选区条） */
function VideoSliderControl({
  maxFrame,
  currentFrame,
  keyframes,
  showKeyframes,
  onSeekFrame,
  onKeyframeStep,
}: VideoSliderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draggingRef = useRef(false)
  const [focused, setFocused] = useState(false)
  const focusedRef = useRef(false)
  const theme = useSystemTheme()
  // 画布 CSS 尺寸：视频栏过大/过小拉伸后立即按新尺寸重绘，避免游标变形
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const frame = Math.min(Math.max(0, currentFrame), maxFrame)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      const w = Math.max(1, canvas.clientWidth)
      const h = Math.max(1, canvas.clientHeight)
      setCanvasSize((current) => (current.w === w && current.h === h ? current : { w, h }))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // 系统色随主题切换（video_slider.cpp 用 wxSYS_COLOUR_* 绘制，对应系统深浅色）
    const { shad, high, face, bord } = SLIDER_PALETTES[theme]
    const sel = 'rgb(123,251,232)'

    const x1 = 5
    const x2 = w - 5
    const y1 = 8
    const y2 = h - 8

    // 背景
    ctx.fillStyle = face
    ctx.fillRect(0, 0, w, h)

    // 焦点虚线框（OnPaint：HasFocus 时 3DDKSHADOW 点线边框）
    if (focused) {
      ctx.strokeStyle = shad
      ctx.setLineDash([1, 2])
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
      ctx.setLineDash([])
    }

    // 轨道（凹陷边框）
    ctx.strokeStyle = shad
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y1)
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1, y2)
    ctx.stroke()
    ctx.strokeStyle = high
    ctx.beginPath()
    ctx.moveTo(x1, y2)
    ctx.lineTo(x2, y2)
    ctx.moveTo(x2, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    const getXAtValue = (value: number) => (value * (w - 10)) / maxFrame + 5
    const curX = getXAtValue(Math.min(Math.max(0, frame), maxFrame))

    // 关键帧刻度（video_slider.cpp L219-227：轨道上方的 3DDKSHADOW 短竖线；Video/Slider/Show Keyframes）
    if (showKeyframes) {
      ctx.strokeStyle = shad
      for (const keyframe of keyframes) {
        if (keyframe < 0 || keyframe > maxFrame) continue
        const x = getXAtValue(keyframe)
        ctx.beginPath()
        ctx.moveTo(x, 2)
        ctx.lineTo(x, 8)
        ctx.stroke()
      }
    }

    // 填充游标背景
    ctx.fillStyle = face
    ctx.fillRect(curX - 2, y1 - 1, 4, y2 - y1 + 5)

    // 高光
    ctx.strokeStyle = high
    ctx.beginPath()
    ctx.moveTo(curX, y1 - 2)
    ctx.lineTo(curX - 4, y1 + 2)
    ctx.moveTo(curX - 3, y1 + 2)
    ctx.lineTo(curX - 3, y2 + 5)
    ctx.stroke()

    // 阴影
    ctx.strokeStyle = shad
    ctx.beginPath()
    ctx.moveTo(curX + 1, y1 - 1)
    ctx.lineTo(curX + 4, y1 + 2)
    ctx.moveTo(curX + 3, y1 + 2)
    ctx.lineTo(curX + 3, y2 + 5)
    ctx.moveTo(curX - 3, y2 + 4)
    ctx.lineTo(curX + 3, y2 + 4)
    ctx.stroke()

    // 轮廓（黑色箭头）
    ctx.strokeStyle = bord
    ctx.beginPath()
    ctx.moveTo(curX, y1 - 3)
    ctx.lineTo(curX - 4, y1 + 1)
    ctx.moveTo(curX, y1 - 3)
    ctx.lineTo(curX + 4, y1 + 1)
    ctx.moveTo(curX - 4, y1 + 1)
    ctx.lineTo(curX - 4, y2 + 5)
    ctx.moveTo(curX + 4, y1 + 1)
    ctx.lineTo(curX + 4, y2 + 5)
    ctx.moveTo(curX - 3, y2 + 5)
    ctx.lineTo(curX + 4, y2 + 5)
    ctx.moveTo(curX - 3, y2)
    ctx.lineTo(curX + 4, y2)
    ctx.stroke()

    // 底部选区条（HasFocus 时亮色，否则 2/5 暗色；video_slider.cpp L257-260）
    ctx.fillStyle = focused ? sel : `rgb(${(123 * 2) / 5},${(251 * 2) / 5},${(232 * 2) / 5})`
    ctx.fillRect(curX - 3, y2 + 1, 7, 4)
    // canvasSize 仅为尺寸变化时触发重绘（effect 内直接读 clientWidth/Height）
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [frame, keyframes, maxFrame, showKeyframes, focused, canvasSize, theme])

  const getXAtValue = (value: number): number => {
    if (maxFrame <= 0) return 0
    const w = Math.max(1, canvasRef.current?.clientWidth ?? 1)
    return (value * (w - 10)) / maxFrame + 5
  }

  const seekFromX = (x: number, snapKeyframe = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = Math.max(1, canvas.clientWidth)
    if (w <= 10) return
    const value = ((x - 5) * maxFrame) / (w - 10)
    // video_slider.cpp Shift+点击：lower_bound 吸附关键帧（越过末帧取最后一帧）
    if (snapKeyframe && keyframes.length) {
      let index = keyframes.findIndex((keyframe) => keyframe >= value)
      if (index < 0) index = keyframes.length - 1
      else if (
        index + 1 < keyframes.length &&
        value - keyframes[index] > keyframes[index] + 1 - value
      )
        index += 1
      if (keyframes[index] === frame) return
      onSeekFrame(keyframes[index])
      return
    }
    // 普通点击：GetValueAtX 整数截断
    const target = Math.floor(value)
    if (target === frame) return
    onSeekFrame(target)
  }

  const seekFromPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    seekFromX(event.clientX - bounds.left, event.shiftKey)
  }

  return (
    <canvas
      className="video-slider"
      ref={canvasRef}
      tabIndex={0}
      aria-label={tPlain('Video timeline')}
      onFocus={() => {
        focusedRef.current = true
        setFocused(true)
      }}
      onBlur={() => {
        focusedRef.current = false
        setFocused(false)
      }}
      onPointerDown={(event) => {
        const canvas = event.currentTarget
        // OnMouse：按下即聚焦；刚聚焦（原本无焦点）时点击位置离游标 <4px 只聚焦不寻址
        const hadFocus = focusedRef.current
        canvas.focus()
        draggingRef.current = true
        canvas.setPointerCapture(event.pointerId)
        const bounds = canvas.getBoundingClientRect()
        const x = event.clientX - bounds.left
        if (!hadFocus && Math.abs(x - getXAtValue(frame)) < 4) return
        seekFromX(x, event.shiftKey)
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) seekFromPointer(event)
      }}
      onPointerUp={(event) => {
        draggingRef.current = false
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          // Shift+Left/Right 为 Video 热键关键帧跳转（OnCharHook → hotkey::check）
          if (event.shiftKey) {
            onKeyframeStep(event.key === 'ArrowRight' ? 1 : -1)
            return
          }
          onSeekFrame(frame + (event.key === 'ArrowRight' ? 1 : -1))
        }
      }}
      onWheel={(event) => {
        event.preventDefault()
        // Shift+滚轮按关键帧步进，否则逐帧（滚轮向下 = 下一帧）
        if (event.shiftKey) {
          onKeyframeStep(event.deltaY > 0 ? 1 : -1)
          return
        }
        onSeekFrame(frame + (event.deltaY > 0 ? 1 : -1))
      }}
    />
  )
}

export function PreviewPane({
  document,
  media,
  currentTimeMs,
  activeCue,
  onTimeChange,
  onDurationChange,
  onOpenMedia,
  mediaAction,
  onCommand,
  onPatchCue,
  isCommandEnabled,
  isCommandChecked,
  windowZoom,
  onWindowZoomChange,
  onIntrinsicSizeChange,
  intrinsicWidth,
  intrinsicHeight,
  localFontsEpoch,
  onLocalFontsAuthorize,
  overscan,
  keyframes,
  currentFrame,
  frameRate,
  frameCount,
  onDetectedFps,
  onKeyframesChange,
  onPlaybackModeChange,
  decoderOverride,
  style: panelStyle,
}: PreviewPaneProps) {
  const optionsVersion = useOptionsVersion() // Preferences 提交后重渲染（滑条关键帧/滚轮行为/工具配色）
  const stageRef = useRef<HTMLDivElement>(null)
  const zoomStageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // WebCodecs 视频回退：<video> 无法解码的容器（mkv 等）onError 后切换
  const [wcMode, setWcMode] = useState(false)
  const [wcError, setWcError] = useState<string | null>(null)
  // 媒体更换时在渲染期复位回退模式（render-phase state adjustment）
  const [wcMedia, setWcMedia] = useState(media)
  if (wcMedia !== media) {
    setWcMedia(media)
    setWcMode(false)
    setWcError(null)
  }
  const wcCanvasRef = useRef<HTMLCanvasElement>(null)
  const wcSourceRef = useRef<WebCodecsVideoSource | null>(null)
  const onKeyframesChangeRef = useRef(onKeyframesChange)
  // 实际生效的解码通道：状态栏覆盖（手动切换）优先，否则自动（<video> onError）
  const wcActive = decoderOverride ?? wcMode
  // 状态栏解码通道指示（原生 / WebCodecs；无视频为 null）
  const onPlaybackModeChangeRef = useRef(onPlaybackModeChange)
  useEffect(() => {
    onPlaybackModeChangeRef.current = onPlaybackModeChange
  }, [onPlaybackModeChange])
  useEffect(() => {
    onPlaybackModeChangeRef.current?.(media?.url ? (wcActive ? 'webcodecs' : 'native') : null)
  }, [media, wcActive])
  // Subtitle/Provider：'canvas' 用内置 drawCue，其余（jassub/libass 历史值）走 JASSUB
  const assEnabled = getOptionString('Subtitle/Provider') !== 'canvas'
  const [assRenderer, setAssRenderer] = useState<AssRenderer | null>(null)
  const assRendererRef = useRef<AssRenderer | null>(null)
  const [assError, setAssError] = useState(false)
  // 系统字体授权提示：支持但未授权时在预览区给出显性入口（浏览器安全模型要求
  // 用户手势授权，藏进 Fonts Collector 等于不可发现）
  const [fontAccess, setFontAccess] = useState<
    'pending' | 'available' | 'granted' | 'denied' | 'off' | 'dismissed'
  >('pending')
  const [fontAccessError, setFontAccessError] = useState('')
  useEffect(() => {
    let cancelled = false
    void probeLocalFonts().then(({ supported, permission }) => {
      if (cancelled) return
      // 'unknown'：permissions API 不认识 local-fonts 但 API 本身可用，同样给入口
      setFontAccess(
        supported && permission !== 'granted' && permission !== 'denied' ? 'available' : 'off',
      )
    })
    return () => {
      cancelled = true
    }
    // 仅挂载时探测一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 用户手势内请求系统字体授权：成功后 epoch++ 重建 jassub，libass 立即换用系统字体 */
  const enableSystemFonts = async () => {
    setFontAccessError('')
    try {
      const api = window as Window & { queryLocalFonts?: () => Promise<unknown[]> }
      if (!api.queryLocalFonts) {
        setFontAccessError(tPlain('This browser does not expose local fonts.'))
        return
      }
      await api.queryLocalFonts()
      setFontAccess('off')
      onLocalFontsAuthorize?.()
    } catch (cause) {
      setFontAccessError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const [durationMs, setDurationMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [dummyPlaying, setDummyPlaying] = useState(false)
  const [visualTool, setVisualTool] = useState('video/tool/cross')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  // Tool/Visual/Autohide 的悬停状态
  const [videoHover, setVideoHover] = useState(false)
  const hasVideo = !!(media?.url || media?.dummy)
  // VideoBox::UpdateTimeBoxes：时间框显示当前帧的 EXACT 时间（帧率未加载时退回媒体时间）
  const frameTimeMs = frameRate.isLoaded()
    ? frameRate.timeAtFrame(currentFrame, 'exact')
    : currentTimeMs
  const hitBoxesRef = useRef<HitBox[]>([])
  const currentRef = useRef(currentTimeMs)
  // video/copy_coordinates：鼠标在视频上的最近位置（视频分辨率坐标）
  const mousePosRef = useRef<{ x: number; y: number } | null>(null)
  // ---- 矢量裁剪工具状态 ----
  const [vclip, setVclip] = useState<VClipState | null>(null)
  const vclipRef = useRef<VClipState | null>(null)
  // 真实帧率探测：每个媒体只探测一次（requestVideoFrameCallback 采样 mediaTime 间隔中位数）
  const fpsProbedRef = useRef<string | null>(null)
  const onDetectedFpsRef = useRef(onDetectedFps)
  // ref 与渲染值同步（事件处理器读取）
  useEffect(() => {
    currentRef.current = currentTimeMs
    vclipRef.current = vclip
    onDetectedFpsRef.current = onDetectedFps
    onKeyframesChangeRef.current = onKeyframesChange
  })

  /** 短暂静音播放采样帧间隔后暂停并回到原位置，得到容器真实 fps。
   *  外部 seek（auto seek/滑块）或暂停会立即让位：不回跳位置、尽快暂停，
   *  避免探测播放与用户操作抢夺播放头（表现为"auto seek 后视频自己播放"）。 */
  const probeVideoFps = useCallback((video: HTMLVideoElement, mediaKey: string) => {
    const callbackHost = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime: number }) => void,
      ) => number
    }
    if (!callbackHost.requestVideoFrameCallback) return
    if (fpsProbedRef.current === mediaKey) return
    fpsProbedRef.current = mediaKey
    if (!Number.isFinite(video.duration) || video.duration <= 0) return

    const times: number[] = []
    const startPos = video.currentTime
    const wasMuted = video.muted
    let finished = false
    let externallySeeked = false
    video.muted = true

    const reportFps = () => {
      // 中位数吸收 seek 跨越产生的离群 delta；只保留 <0.5s 的正常帧间隔
      const deltas = times
        .slice(1)
        .map((time, index) => time - times[index])
        .filter((delta) => delta > 0 && delta < 0.5)
        .sort((a, b) => a - b)
      if (deltas.length < 5) return
      const median = deltas[Math.floor(deltas.length / 2)]
      const fps = median > 0.0005 ? Math.round((1 / median) * 1000) / 1000 : 0
      if (fps >= 5 && fps <= 240) onDetectedFpsRef.current(fps)
    }
    const finish = (restore: boolean) => {
      if (finished) return
      finished = true
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('pause', onPause)
      window.clearTimeout(timeoutId)
      video.pause()
      video.muted = wasMuted
      // 外部已 seek（auto seek/滑块）时不回跳：用户的寻址位置优先
      if (restore && !externallySeeked) video.currentTime = startPos
    }
    const onSeeking = () => {
      externallySeeked = true
    }
    const onPause = () => finish(false)
    const timeoutId = window.setTimeout(() => finish(!externallySeeked), 3000)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('pause', onPause)
    const step = (_now: number, metadata: { mediaTime: number }) => {
      if (finished) return
      times.push(metadata.mediaTime)
      if (times.length < 12) {
        callbackHost.requestVideoFrameCallback!(step)
        return
      }
      finish(!externallySeeked)
      reportFps()
    }
    callbackHost.requestVideoFrameCallback(step)
    void video.play().catch(() => {
      // 自动播放被拒绝时跳过探测（保持默认 24fps）
      finish(false)
    })
  }, [])
  const windowZoomRef = useRef(windowZoom)
  const onWindowZoomChangeRef = useRef(onWindowZoomChange)
  const dragRef = useRef<{
    cue: SubtitleCue
    startX: number
    startY: number
    baseX: number
    baseY: number
    baseScaleX: number
    baseScaleY: number
    baseRotationX: number
    baseRotationY: number
    baseRotationZ: number
  } | null>(null)

  useEffect(() => {
    windowZoomRef.current = windowZoom
    onWindowZoomChangeRef.current = onWindowZoomChange
  }, [onWindowZoomChange, windowZoom])

  // ---- 视频平移与内容缩放（video_display.cpp 的 pan_x/pan_y 与 contentZoomValue）----
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [contentZoom, setContentZoom] = useState(1)
  const panRef = useRef(pan)
  const contentZoomRef = useRef(contentZoom)
  const middleDragRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    panRef.current = pan
    contentZoomRef.current = contentZoom
  }, [pan, contentZoom])

  /** 媒体显示框（video / WebCodecs 包裹层 / dummy 框）相对舞台的矩形，含平移与缩放后的实际位置 */
  const mediaRect = () => {
    const stage = stageRef.current
    if (!stage) return { left: 0, top: 0, width: 1, height: 1 }
    const bounds = stage.getBoundingClientRect()
    const el = stage.querySelector<HTMLElement>('video, .webcodecs-video-wrap, .dummy-video-stage')
    if (!el)
      return {
        left: 0,
        top: 0,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      }
    const rect = el.getBoundingClientRect()
    return {
      left: rect.left - bounds.left,
      top: rect.top - bounds.top,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    }
  }

  // PositionVideo：pan 夹在 ±(0.5·内容 + 0.4·视口)，不允许平移出界太远
  const clampPan = useCallback((x: number, y: number) => {
    const stage = stageRef.current
    const el = stage?.querySelector<HTMLElement>('video, .webcodecs-video-wrap, .dummy-video-stage')
    if (!stage || !el) return { x, y }
    const maxX = 0.5 * el.offsetWidth + 0.4 * stage.clientWidth
    const maxY = 0.5 * el.offsetHeight + 0.4 * stage.clientHeight
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  }, [])

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const next = clampPan(panRef.current.x + dx, panRef.current.y + dy)
      panRef.current = next
      setPan(next)
    },
    [clampPan],
  )

  // ZoomAndPan：以光标为锚点缩放内容，平移补偿保持锚点下的点不动
  const zoomContentAt = useCallback(
    (newZoom: number, clientX: number, clientY: number) => {
      const stage = stageRef.current
      if (!stage) return
      const bounds = stage.getBoundingClientRect()
      const cx = clientX - bounds.left - bounds.width / 2
      const cy = clientY - bounds.top - bounds.height / 2
      const zoom = Math.max(0.125, Math.min(10, newZoom))
      const anchorX = (cx - panRef.current.x) / contentZoomRef.current
      const anchorY = (cy - panRef.current.y) / contentZoomRef.current
      const next = clampPan(cx - anchorX * zoom, cy - anchorY * zoom)
      panRef.current = next
      setPan(next)
      contentZoomRef.current = zoom
      setContentZoom(zoom)
    },
    [clampPan],
  )

  // ---- 滚轮行为（video_display.cpp OnMouseWheel；Video/Scroll Action、Ctrl/Shift Scroll Action）----
  // 0/1 缩放视频框（±0.125/齿）、2/3 内容缩放（光标锚点，0.125..10）、4/5 平移（5px/齿）、6 无操作；
  // Ctrl+Shift 组合无操作。notches 归一化：Chrome 每齿 100px、Firefox 每齿 3 行（源码 wheel/GetWheelDelta）。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey && event.shiftKey) return
      const action = event.ctrlKey
        ? getOptionInt('Video/Ctrl Scroll Action')
        : event.shiftKey
          ? getOptionInt('Video/Shift Scroll Action')
          : getOptionInt('Video/Scroll Action')
      const notches =
        -event.deltaY /
        (event.deltaMode === event.DOM_DELTA_LINE
          ? 3
          : event.deltaMode === event.DOM_DELTA_PAGE
            ? 1
            : 100)
      switch (action) {
        case 0:
          onWindowZoomChangeRef.current(
            Math.max(0.125, Math.min(3, windowZoomRef.current + 0.125 * notches)),
          )
          break
        case 1:
          onWindowZoomChangeRef.current(
            Math.max(0.125, Math.min(3, windowZoomRef.current - 0.125 * notches)),
          )
          break
        case 2:
          zoomContentAt(
            contentZoomRef.current * (1 + 0.125 * notches),
            event.clientX,
            event.clientY,
          )
          break
        case 3:
          zoomContentAt(
            contentZoomRef.current * (1 - 0.125 * notches),
            event.clientX,
            event.clientY,
          )
          break
        case 4:
          panBy(0, 5 * notches)
          break
        case 5:
          panBy(5 * notches, 0)
          break
        default:
          break
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [panBy, zoomContentAt])

  const renderOverlay = useCallback(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const ratio = window.devicePixelRatio || 1
    const cssWidth = Math.max(1, stage.clientWidth)
    const cssHeight = Math.max(1, stage.clientHeight)
    const pixelWidth = Math.max(1, Math.round(cssWidth * ratio))
    const pixelHeight = Math.max(1, Math.round(cssHeight * ratio))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, cssWidth, cssHeight)
    // jassub/libass 接管字幕绘制时，交互 canvas 只保留辅助绘制与 hitbox
    const assActive =
      !!assRenderer && !assError && getOptionString('Subtitle/Provider') !== 'canvas' && hasVideo
    const active = document.cues.filter(
      (cue) => !cue.comment && cue.startMs <= currentTimeMs && cue.endMs >= currentTimeMs,
    )

    // dummy 视频：按视频分辨率等比 letterbox（不拉伸），黑边 + 背景 + 视频坐标系内绘制字幕
    if (media?.dummy) {
      const { width: vw, height: vh, color, pattern } = media.dummy
      // 字幕/背景画在媒体显示框上（含平移与内容缩放后的实际位置，与 DOM 框对齐）
      const rect = mediaRect()
      const s = Math.min(rect.width / vw, rect.height / vh)
      const vwPx = vw * s
      const vhPx = vh * s
      const ox = rect.left + (rect.width - vwPx) / 2
      const oy = rect.top + (rect.height - vhPx) / 2
      // assActive 时背景由 .dummy-video-stage div 绘制（交互 canvas 在字幕层之上，画背景会遮住 jassub）
      if (!assActive) {
        context.fillStyle = '#000'
        context.fillRect(0, 0, cssWidth, cssHeight)
        drawDummyBackground(context, ox, oy, vwPx, vhPx, color, pattern, s)
      }
      context.save()
      context.translate(ox, oy)
      context.scale(s, s)
      const boxes: HitBox[] = []
      for (const cue of active) {
        const style = document.styles.find((item) => item.name === cue.style) ?? document.styles[0]
        if (!style) continue
        const box = drawCue(context, vw, vh, cue.text, style, vw, vh, !assActive)
        boxes.push({
          cue,
          left: ox + box.left * s,
          right: ox + box.right * s,
          top: oy + box.top * s,
          bottom: oy + box.bottom * s,
        })
      }
      hitBoxesRef.current = boxes
      context.restore()
    } else {
      const playResY = Number(document.scriptInfo.PlayResY) || 1080
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
      // 字幕画在媒体显示框（含平移/内容缩放后的实际位置）上，hitbox 同步按该框映射
      const rect = mediaRect()
      const boxX = rect.left
      const boxY = rect.top
      const boxWidth = rect.width
      const boxHeight = rect.height
      const boxes: HitBox[] = []
      for (const cue of active) {
        const style = document.styles.find((item) => item.name === cue.style) ?? document.styles[0]
        if (!style) continue
        const box = drawCue(
          context,
          boxWidth,
          boxHeight,
          cue.text,
          style,
          playResX,
          playResY,
          !assActive,
        )
        boxes.push({
          cue,
          left: boxX + box.left,
          right: boxX + box.right,
          top: boxY + box.top,
          bottom: boxY + box.bottom,
        })
      }
      hitBoxesRef.current = boxes
    }

    // ---- 视觉工具参考线（visual_tool*.cpp Draw()；颜色 = Colour/Visual Tools）----
    if (hasVideo && visualTool !== 'video/tool/cross') {
      const colors = visualToolColors()
      const playResY = Number(document.scriptInfo.PlayResY) || 1080
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
      // 脚本坐标 → 舞台像素（跟随平移/内容缩放后的媒体显示框）
      const rect = mediaRect()
      const mapX = (x: number) => rect.left + (x / playResX) * rect.width
      const mapY = (y: number) => rect.top + (y / playResY) * rect.height
      const pxScale = rect.width / playResX
      const rad = Math.PI / 180
      // 行位置（脚本坐标）：\pos / \move 起点；无则用 hitbox 中心近似对齐推算位置
      const linePos = (cue: SubtitleCue): { x: number; y: number } => {
        const o = readVisualOverrides(cue.text)
        if (o.pos) return o.pos
        if (o.move) return { x: o.move.x1, y: o.move.y1 }
        const box = hitBoxesRef.current.find((item) => item.cue.id === cue.id)
        if (box)
          return {
            x: (((box.left + box.right) / 2 - rect.left) / rect.width) * playResX,
            y: (((box.top + box.bottom) / 2 - rect.top) / rect.height) * playResY,
          }
        return { x: playResX / 2, y: playResY / 2 }
      }
      // 特征点（visual_feature.cpp Draw；线 = Lines Secondary 1px，填充由调用方给）
      const drawFeature = (
        x: number,
        y: number,
        shape: 'square' | 'circle' | 'triangle' | 'small-circle',
        fill: string,
      ) => {
        context.strokeStyle = colors.secondary
        context.fillStyle = fill
        context.lineWidth = 1
        context.beginPath()
        if (shape === 'square' || shape === 'circle') {
          if (shape === 'square') context.rect(x - 6, y - 6, 12, 12)
          else context.arc(x, y, 6, 0, Math.PI * 2)
          context.fill()
          context.stroke()
          context.beginPath()
          context.moveTo(x, y - 12)
          context.lineTo(x, y + 12)
          context.moveTo(x - 12, y)
          context.lineTo(x + 12, y)
          context.stroke()
        } else if (shape === 'triangle') {
          context.moveTo(x - 9, y - 6)
          context.lineTo(x + 9, y - 6)
          context.lineTo(x, y + 10)
          context.closePath()
          context.fill()
          context.stroke()
          context.beginPath()
          context.moveTo(x, y)
          context.lineTo(x, y - 16)
          context.moveTo(x, y)
          context.lineTo(x - 14, y + 8)
          context.moveTo(x, y)
          context.lineTo(x + 14, y + 8)
          context.stroke()
        } else {
          context.arc(x, y, 3, 0, Math.PI * 2)
          context.fill()
          context.stroke()
        }
      }
      const startOf = (o: ReturnType<typeof readVisualOverrides>) =>
        o.move ? { x: o.move.x1, y: o.move.y1 } : o.pos

      if (visualTool === 'video/tool/drag') {
        // visual_tool_drag.cpp Draw：位置方框 + \move 终点圆（箭头连线）+ \org 三角（虚线）
        for (const cue of active) {
          const o = readVisualOverrides(cue.text)
          const fill = cue.id === activeCue?.id ? colors.selFill : colors.baseFill
          const start = startOf(o)
          if (!start && !o.org) continue
          const sx = mapX(start?.x ?? 0)
          const sy = mapY(start?.y ?? 0)
          if (start) drawFeature(sx, sy, 'square', fill)
          if (start && o.move) {
            const ex = mapX(o.move.x2)
            const ey = mapY(o.move.y2)
            const dx = ex - sx
            const dy = ey - sy
            if (dx * dx + dy * dy >= 30 * 30) {
              const len = Math.hypot(dx, dy)
              const ux = dx / len
              const uy = dy / len
              const endX = ex - ux * 20
              const endY = ey - uy * 20
              context.strokeStyle = withAlpha(colors.lines, 0.8)
              context.fillStyle = withAlpha(colors.lines, 0.8)
              context.lineWidth = 2
              context.beginPath()
              context.moveTo(sx + ux * 10, sy + uy * 10)
              context.lineTo(endX, endY)
              context.stroke()
              context.beginPath()
              context.moveTo(ex - ux * 10, ey - uy * 10)
              context.lineTo(endX - uy * 4, endY + ux * 4)
              context.lineTo(endX + uy * 4, endY - ux * 4)
              context.closePath()
              context.fill()
            }
            drawFeature(ex, ey, 'circle', fill)
          }
          if (o.org) {
            const ox = mapX(o.org.x)
            const oy = mapY(o.org.y)
            if (start) {
              const dx = ox - sx
              const dy = oy - sy
              if (dx * dx + dy * dy >= 20 * 20) {
                const len = Math.hypot(dx, dy)
                const ux = dx / len
                const uy = dy / len
                context.strokeStyle = withAlpha(colors.lines, 0.5)
                context.lineWidth = 2
                context.setLineDash([6, 6])
                context.beginPath()
                context.moveTo(sx + ux * 10, sy + uy * 10)
                context.lineTo(ox - ux * 10, oy - uy * 10)
                context.stroke()
                context.setLineDash([])
              }
            }
            drawFeature(ox, oy, 'triangle', fill)
          }
        }
      } else if (visualTool === 'video/tool/rotate/z' && activeCue) {
        // visual_tool_rotatez.cpp Draw：外接圆环 + 6 组弧形刻度 + 当前角度基线 + 角度柄 + 原点三角
        const o = readVisualOverrides(activeCue.text)
        const pos = linePos(activeCue)
        const org = o.org ?? pos
        const ox = mapX(org.x)
        const oy = mapY(org.y)
        const px = mapX(pos.x)
        const py = mapY(pos.y)
        const oRadius = Math.hypot(px - ox, py - oy)
        const radius = Math.max(oRadius, 50)
        context.save()
        // 3D 旋转的 2D 正交近似：ry 压缩 X 轴、rx 压缩 Y 轴，fsc 缩放（frz 不参与环绘制）
        context.translate(ox, oy)
        context.scale(Math.cos(o.rotationY * rad) || 1, Math.cos(o.rotationX * rad) || 1)
        context.scale(o.scaleX / 100, o.scaleY / 100)
        // 圆环（r±4）
        context.beginPath()
        context.arc(0, 0, radius + 4, 0, Math.PI * 2)
        context.arc(0, 0, radius - 4, 0, Math.PI * 2, true)
        context.fillStyle = colors.baseFill
        context.fill('evenodd')
        context.strokeStyle = colors.secondary
        context.lineWidth = 1
        context.stroke()
        // 6 组弧形刻度（r+12..r+30，每 60° ±15°）
        for (let i = 0; i < 6; i++) {
          const from = (i * 60 - 15) * rad
          const to = (i * 60 + 15) * rad
          context.beginPath()
          context.arc(0, 0, radius + 12, from, to)
          context.arc(0, 0, radius + 30, to, from, true)
          context.closePath()
          context.fillStyle = colors.baseFill
          context.fill()
          context.strokeStyle = colors.secondary
          context.stroke()
        }
        // 当前角度基线（穿过原点）与角度柄圆
        const angle = o.rotationZ * rad
        const ax = Math.cos(angle)
        const ay = Math.sin(angle)
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(-ax * radius, -ay * radius)
        context.lineTo(ax * radius, ay * radius)
        context.stroke()
        if (oRadius > 0) {
          // 原点→文字位置（按当前角度反推）的连线 + 文字下方横线
          const posAngle = Math.atan2(py - oy, px - ox)
          const rpx = Math.cos(angle - posAngle) * oRadius
          const rpy = Math.sin(angle - posAngle) * oRadius
          context.beginPath()
          context.moveTo(0, 0)
          context.lineTo(rpx, rpy)
          context.stroke()
          context.beginPath()
          context.moveTo(rpx - ax * 20, rpy - ay * 20)
          context.lineTo(rpx + ax * 20, rpy + ay * 20)
          context.stroke()
        }
        context.strokeStyle = colors.secondary
        context.fillStyle = colors.baseFill
        context.lineWidth = 1
        for (const sign of [1, -1]) {
          context.beginPath()
          context.arc(ax * radius * sign, ay * radius * sign, 4, 0, Math.PI * 2)
          context.fill()
          context.stroke()
        }
        context.restore()
        drawFeature(ox, oy, 'triangle', colors.selFill)
        // 鼠标位置连线（距原点 >10px）
        const mouse = mousePosRef.current
        if (mouse) {
          const mxp = mapX(mouse.x)
          const myp = mapY(mouse.y)
          if (Math.hypot(mxp - ox, myp - oy) > 10) {
            context.strokeStyle = colors.secondary
            context.lineWidth = 1
            context.beginPath()
            context.moveTo(ox, oy)
            context.lineTo(mxp, myp)
            context.stroke()
          }
        }
      } else if (visualTool === 'video/tool/rotate/xy' && activeCue) {
        // visual_tool_rotatexy.cpp Draw：随行 3D 旋转的渐隐变换网格 + 三轴向量箭头
        const o = readVisualOverrides(activeCue.text)
        const pos = linePos(activeCue)
        const org = o.org ?? pos
        const gridRadius = 15 // 每侧线数
        const spacing = 20 // 线距（脚本像素）
        const halfLen = spacing * (gridRadius + 1) // 320
        context.save()
        context.translate(mapX(org.x), mapY(org.y))
        context.scale(pxScale, pxScale)
        // 2D 近似：面内旋转 rz + ry/rx 压缩 + fsc + fax/fay 剪切（点先经剪切）
        context.scale(Math.cos(o.rotationY * rad) || 1, Math.cos(o.rotationX * rad) || 1)
        context.rotate(o.rotationZ * rad)
        context.scale(o.scaleX / 100, o.scaleY / 100)
        context.transform(1, o.fay, o.fax, 1, 0, 0)
        context.lineWidth = 2
        for (let i = -gridRadius; i <= gridRadius; i++) {
          context.strokeStyle = withAlpha(colors.secondary, 1 - Math.abs(i) * (0.9 / gridRadius))
          context.beginPath()
          context.moveTo(i * spacing, -halfLen)
          context.lineTo(i * spacing, halfLen)
          context.moveTo(-halfLen, i * spacing)
          context.lineTo(halfLen, i * spacing)
          context.stroke()
        }
        context.restore()
        // 三轴向量（50px + 锥形箭头；Z 轴为进深的正交投影近似）
        const originX = mapX(org.x)
        const originY = mapY(org.y)
        const cosRz = Math.cos(o.rotationZ * rad)
        const sinRz = Math.sin(o.rotationZ * rad)
        const cosRx = Math.cos(o.rotationX * rad)
        const cosRy = Math.cos(o.rotationY * rad)
        const axes = [
          [50 * cosRz * cosRy, 50 * sinRz * cosRx],
          [-50 * sinRz * cosRy, 50 * cosRz * cosRx],
          [50 * Math.sin(o.rotationY * rad), -50 * Math.sin(o.rotationX * rad)],
        ]
        context.strokeStyle = colors.lines
        context.fillStyle = colors.lines
        context.lineWidth = 2
        for (const [ex, ey] of axes) {
          const gx = originX + ex * pxScale
          const gy = originY + ey * pxScale
          const len = Math.hypot(ex, ey) || 1
          const ux = ex / len
          const uy = ey / len
          context.beginPath()
          context.moveTo(originX, originY)
          context.lineTo(gx, gy)
          context.stroke()
          context.beginPath()
          context.moveTo(gx + ux * 10 * pxScale, gy + uy * 10 * pxScale)
          context.lineTo(gx - uy * 3 * pxScale, gy + ux * 3 * pxScale)
          context.lineTo(gx + uy * 3 * pxScale, gy - ux * 3 * pxScale)
          context.closePath()
          context.fill()
        }
      } else if (visualTool === 'video/tool/scale' && activeCue) {
        // visual_tool_scale.cpp Draw：随行旋转的标尺 + 当前缩放指示线 + 端点圆 + 标尺脚
        const o = readVisualOverrides(activeCue.text)
        const pos = linePos(activeCue)
        const baseLen = 160
        const guideSize = 10
        const halfLen = baseLen / 2
        // 基点钳制在视频框内保证标尺可见（pos.Max(...).Min(...)）
        const baseX =
          rect.left +
          Math.max(
            halfLen + guideSize,
            Math.min(mapX(pos.x) - rect.left, rect.width - halfLen - guideSize * 3),
          )
        const baseY =
          rect.top +
          Math.max(
            halfLen + guideSize,
            Math.min(mapY(pos.y) - rect.top, rect.height - halfLen - guideSize * 3),
          )
        const hx = (o.scaleX * baseLen) / 200
        const hy = (o.scaleY * baseLen) / 200
        const minor = halfLen + guideSize * 1.5
        context.save()
        context.translate(baseX, baseY)
        context.scale(Math.cos(o.rotationY * rad) || 1, Math.cos(o.rotationX * rad) || 1)
        context.rotate(o.rotationZ * rad)
        // 当前缩放指示线
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(minor, -hy)
        context.lineTo(minor, hy)
        context.moveTo(-hx, minor)
        context.lineTo(hx, minor)
        context.stroke()
        // 端点圆（r4）
        context.strokeStyle = colors.secondary
        context.fillStyle = colors.baseFill
        context.lineWidth = 1
        for (const [cx, cy] of [
          [minor, -hy],
          [minor, hy],
          [-hx, minor],
          [hx, minor],
        ]) {
          context.beginPath()
          context.arc(cx, cy, 4, 0, Math.PI * 2)
          context.fill()
          context.stroke()
        }
        // 标尺（竖直 + 水平）
        context.beginPath()
        context.rect(halfLen, -halfLen, guideSize, halfLen * 2)
        context.rect(-halfLen, halfLen, halfLen * 2, guideSize)
        context.fill()
        context.stroke()
        // 标尺脚
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(halfLen + guideSize, -halfLen)
        context.lineTo(halfLen + guideSize + guideSize / 2, -halfLen)
        context.moveTo(halfLen + guideSize, halfLen)
        context.lineTo(halfLen + guideSize + guideSize / 2, halfLen)
        context.moveTo(-halfLen, halfLen + guideSize)
        context.lineTo(-halfLen, halfLen + guideSize + guideSize / 2)
        context.moveTo(halfLen, halfLen + guideSize)
        context.lineTo(halfLen, halfLen + guideSize + guideSize / 2)
        context.stroke()
        context.restore()
      } else if (visualTool === 'video/tool/clip' && activeCue) {
        // visual_tool_clip.cpp Draw：矩形裁剪框 + 框外（\iclip 为框内）黑色阴影 + 四角小圆柄
        const o = readVisualOverrides(activeCue.text)
        const x1 = o.clip ? Math.min(o.clip.x1, o.clip.x2) : 0
        const y1 = o.clip ? Math.min(o.clip.y1, o.clip.y2) : 0
        const x2 = o.clip ? Math.max(o.clip.x1, o.clip.x2) : playResX
        const y2 = o.clip ? Math.max(o.clip.y1, o.clip.y2) : playResY
        const rx1 = mapX(x1)
        const ry1 = mapY(y1)
        const rx2 = mapX(x2)
        const ry2 = mapY(y2)
        context.fillStyle = colors.shadow
        if (o.clip?.inverse) {
          context.fillRect(rx1, ry1, rx2 - rx1, ry2 - ry1)
        } else {
          context.fillRect(rect.left, rect.top, rect.width, ry1 - rect.top)
          context.fillRect(rect.left, ry2, rect.width, rect.top + rect.height - ry2)
          context.fillRect(rect.left, ry1, rx1 - rect.left, ry2 - ry1)
          context.fillRect(rx2, ry1, rect.left + rect.width - rx2, ry2 - ry1)
        }
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        context.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1)
        context.strokeStyle = colors.secondary
        context.fillStyle = colors.selFill
        context.lineWidth = 1
        for (const [cx, cy] of [
          [rx1, ry1],
          [rx2, ry1],
          [rx1, ry2],
          [rx2, ry2],
        ]) {
          context.beginPath()
          context.arc(cx, cy, 3, 0, Math.PI * 2)
          context.fill()
          context.stroke()
        }
      }
    }

    // VideoDisplay::DrawOverscanMask：BBC 标准双圈遮罩（16:9+ 用 10%/5% 与 3.5%；其余用 6.7%/5% 与 3.3%/3.5%）
    if (overscan) {
      const ar = cssWidth / Math.max(1, cssHeight)
      const masks =
        ar > 1.75
          ? [
              [0.1, 0.05],
              [0.035, 0.035],
            ]
          : [
              [0.067, 0.05],
              [0.033, 0.035],
            ]
      context.fillStyle = 'rgba(30,70,200,.5)'
      for (const [hx, vy] of masks) {
        const insetX = cssWidth * hx
        const insetY = cssHeight * vy
        context.fillRect(0, 0, cssWidth, insetY)
        context.fillRect(0, cssHeight - insetY, cssWidth, insetY)
        context.fillRect(0, insetY, insetX, cssHeight - insetY * 2)
        context.fillRect(cssWidth - insetX, insetY, insetX, cssHeight - insetY * 2)
      }
    }

    // ---- 矢量裁剪绘制（visual_tool_vector_clip.cpp Draw；颜色 = Colour/Visual Tools）----
    if (vclip && hasVideo) {
      const vcl = visualToolColors()
      const playResY = Number(document.scriptInfo.PlayResY) || 1080
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
      // 样条坐标映射到媒体显示框（与字幕框一致，平移/缩放后跟随视频）
      const rect = mediaRect()
      const mx = (p: Vec2) => rect.left + (p.x / playResX) * rect.width
      const my = (p: Vec2) => rect.top + (p.y / playResY) * rect.height
      const paths = splinePolylines(vclip.spline).map((path) =>
        path.map((p) => ({ x: mx(p), y: my(p) })),
      )

      // 阴影：\clip 阴影画多边形外部（evenodd 反填），\iclip 画内部
      context.beginPath()
      if (!vclip.inverse && paths.length) context.rect(0, 0, cssWidth, cssHeight)
      for (const path of paths) {
        context.moveTo(path[0].x, path[0].y)
        for (const p of path.slice(1)) context.lineTo(p.x, p.y)
        context.closePath()
      }
      context.fillStyle = vcl.shadow
      context.fill('evenodd')

      // 轮廓（2px，alpha 0.5）
      context.strokeStyle = vcl.linesFaint
      context.lineWidth = 2
      for (const path of paths) {
        context.beginPath()
        context.moveTo(path[0].x, path[0].y)
        for (const p of path.slice(1)) context.lineTo(p.x, p.y)
        context.closePath()
        context.stroke()
      }

      // 贝塞尔控制柄虚线
      context.setLineDash([6, 4])
      context.strokeStyle = vcl.linesStrong
      context.lineWidth = 1
      for (const curve of vclip.spline.curves) {
        if (curve.type !== 'bicubic') continue
        context.beginPath()
        context.moveTo(mx(curve.p1), my(curve.p1))
        context.lineTo(mx(curve.p2), my(curve.p2))
        context.moveTo(mx(curve.p3), my(curve.p3))
        context.lineTo(mx(curve.p4), my(curve.p4))
        context.stroke()
      }

      // line/bicubic 追加模式：鼠标到形状起点/末端的闭合提示虚线
      if (
        vclip.mouse &&
        vclip.dragStart &&
        (vclip.mode === 'video/tool/vclip/line' || vclip.mode === 'video/tool/vclip/bicubic')
      ) {
        const first = vclip.spline.curves.find((curve) => curve.type === 'point')
        const last = vclip.spline.curves[vclip.spline.curves.length - 1]
        const mouse = { x: mx(vclip.mouse), y: my(vclip.mouse) }
        context.strokeStyle = vcl.linesStrong
        if (first) {
          context.beginPath()
          context.moveTo(mouse.x, mouse.y)
          context.lineTo(mx(first.p1), my(first.p1))
          context.stroke()
        }
        if (last) {
          const end = last.type === 'line' ? last.p2 : last.type === 'bicubic' ? last.p4 : last.p1
          context.beginPath()
          context.moveTo(mouse.x, mouse.y)
          context.lineTo(mx(end), my(end))
          context.stroke()
        }
      }
      context.setLineDash([])

      // 特征点（端点圆 r2，贝塞尔柄方块 6×6）
      for (const feature of makeFeatures(vclip.spline)) {
        const color =
          vclip.active === feature.key
            ? vcl.active
            : vclip.selected.has(feature.key)
              ? vcl.selected
              : vcl.lines
        const px = mx(feature.pos)
        const py = my(feature.pos)
        context.strokeStyle = color
        context.fillStyle = color
        if (feature.shape === 'circle') {
          context.beginPath()
          context.arc(px, py, 2, 0, Math.PI * 2)
          context.globalAlpha = 0.6
          context.fill()
          context.globalAlpha = 0.5
          context.lineWidth = 1
          context.stroke()
        } else {
          context.globalAlpha = 0.6
          context.fillRect(px - 3, py - 3, 6, 6)
          context.globalAlpha = 0.5
          context.lineWidth = 1
          context.strokeRect(px - 3, py - 3, 6, 6)
        }
        context.globalAlpha = 1
      }

      // drag 模式框选虚线框
      if (vclip.boxStart && vclip.mouse) {
        context.setLineDash([6, 4])
        context.strokeStyle = vcl.lines
        context.lineWidth = 1
        context.strokeRect(
          Math.min(mx(vclip.boxStart), mx(vclip.mouse)),
          Math.min(my(vclip.boxStart), my(vclip.mouse)),
          Math.abs(mx(vclip.mouse) - mx(vclip.boxStart)),
          Math.abs(my(vclip.mouse) - my(vclip.boxStart)),
        )
        context.setLineDash([])
      }
    }
    // optionsVersion 并非直接读取：Preferences 配色提交后强制 renderOverlay 重建重绘
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentTimeMs,
    document,
    media,
    optionsVersion,
    overscan,
    visualTool,
    vclip,
    hasVideo,
    assRenderer,
    assError,
    // 平移/内容缩放改变媒体显示框位置，overlay 绘制与 hitbox 需跟随重算
    pan,
    contentZoom,
  ])

  useEffect(() => {
    renderOverlay()
    const observer = new ResizeObserver(renderOverlay)
    if (stageRef.current) observer.observe(stageRef.current)
    return () => observer.disconnect()
  }, [renderOverlay])

  // ---- JASSUB（libass WASM）字幕渲染器生命周期（对应原版 SubtitlesProvider）----
  useEffect(() => {
    if (!assEnabled) return
    const host = zoomStageRef.current
    if (!host) return
    let cancelled = false
    createAssRenderer(host, exportAss(document))
      .then((renderer) => {
        if (cancelled) {
          renderer.destroy()
          return
        }
        assRendererRef.current = renderer
        setAssRenderer(renderer)
      })
      .catch(() => {
        // worker/wasm 加载失败：回退内置 drawCue
        if (!cancelled) setAssError(true)
      })
    return () => {
      cancelled = true
      assRendererRef.current?.destroy()
      assRendererRef.current = null
      setAssRenderer(null)
    }
    // document 经下方 setTrack 增量同步，不触发重建；
    // localFontsEpoch：本地字体授权后重建实例，libass 用新权限重新匹配字体
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [assEnabled, localFontsEpoch])

  // 文档变化 → 防抖替换 libass track（wrapper 内防抖）
  useEffect(() => {
    assRenderer?.setTrack(exportAss(document))
  }, [assRenderer, document])

  // 时间/媒体/缩放变化 → 驱动 libass 渲染（storage = 视频分辨率）
  useEffect(() => {
    if (!assRenderer || !hasVideo) return
    const storageWidth = media?.dummy ? media.dummy.width : intrinsicWidth
    const storageHeight = media?.dummy ? media.dummy.height : intrinsicHeight
    assRenderer.render(currentTimeMs, storageWidth, storageHeight)
    // contentZoom 改变媒体框尺寸，需同步 JASSUB canvas 盒
  }, [
    assRenderer,
    currentTimeMs,
    media,
    intrinsicWidth,
    intrinsicHeight,
    windowZoom,
    contentZoom,
    hasVideo,
  ])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing) return
    let frame = 0
    const update = () => {
      onTimeChange(video.currentTime * 1000)
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [onTimeChange, playing])

  useEffect(() => {
    const video = videoRef.current
    if (video && !playing && Math.abs(video.currentTime * 1000 - currentTimeMs) > 40)
      video.currentTime = currentTimeMs / 1000
  }, [currentTimeMs, playing])

  // WebCodecs 源：暂停状态跟随外部时间（音频栏拖动等）；播放中由源自己上报
  useEffect(() => {
    const source = wcSourceRef.current
    if (source && !source.playing && Math.abs(source.currentTime - currentTimeMs) > 60)
      source.seek(currentTimeMs)
  }, [currentTimeMs, playing])

  useEffect(() => {
    // dummy 视频 / 合成音频：无 <video> 元数据，直接取时长
    if (media?.dummy) {
      // oxlint-disable-next-line react/set-state-in-effect
      setDurationMs(media.dummy.lengthMs)
      onDurationChange(media.dummy.lengthMs)
      onIntrinsicSizeChange(media.dummy.width, media.dummy.height)
    } else if (media?.syntheticAudio) {
      // oxlint-disable-next-line react/set-state-in-effect
      setDurationMs(media.syntheticAudio.durationMs)
      onDurationChange(media.syntheticAudio.durationMs)
    }
  }, [media, onDurationChange, onIntrinsicSizeChange])

  // ---- WebCodecs 视频回退（<video> onError 或状态栏手动切换 → wcActive → 创建源） ----
  useEffect(() => {
    // 模式/错误的复位在渲染期完成；这里只销毁旧源（媒体更换或通道切换）
    wcSourceRef.current?.destroy()
    wcSourceRef.current = null
  }, [media, wcActive])

  useEffect(() => {
    const canvas = wcCanvasRef.current
    if (!wcActive || wcSourceRef.current || !canvas || !media?.url) return
    let cancelled = false
    // media.file 缺失（token 句柄）时经 URL 取回字节
    const ensureFile = async (): Promise<File | null> => {
      if (media.file) return media.file
      try {
        const blob = await (await fetch(media.url)).blob()
        return new File([blob], media.name || 'media')
      } catch {
        return null
      }
    }
    void ensureFile().then((file) => {
      if (cancelled || !file) return
      void WebCodecsVideoSource.create(file, canvas, {
        onDurationChange: (value) => {
          // oxlint-disable-next-line react/set-state-in-effect
          setDurationMs(value)
          onDurationChange(value)
        },
        onIntrinsicSize: (width, height) => onIntrinsicSizeChange(width, height),
        onFrameRate: (fps) => {
          if (fps >= 5 && fps <= 240) onDetectedFpsRef.current(fps)
        },
        onPlaying: setPlaying,
        onTimeUpdate: onTimeChange,
        onKeyframes: (list) => onKeyframesChangeRef.current?.(list),
        onError: (message) => {
          logError('video', `WebCodecs 解码器错误：${message}`)
          setWcError(message)
        },
      })
        .then((opened) => {
          if (cancelled) {
            opened.source?.destroy()
            return
          }
          if (opened.source) {
            wcSourceRef.current = opened.source
            logInfo('video', 'WebCodecs 回退视频已打开')
          } else if (opened.reason) {
            logError('video', `WebCodecs 回退打开失败：${opened.reason}`)
            setWcError(opened.reason)
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'WebCodecs 视频打开失败'
          if (!cancelled) {
            logError('video', `WebCodecs 回退打开失败：${message}`)
            setWcError(message)
          }
        })
    })
    return () => {
      cancelled = true
    }
  }, [wcActive, media, onDurationChange, onIntrinsicSizeChange, onTimeChange])

  // 原生 <video> 搁浅告警：8 秒既无 metadata 也无 error（个别容器/驱动组合会静默卡住）
  useEffect(() => {
    if (!media?.url || media.dummy || media.syntheticAudio || wcActive) return
    const timer = window.setTimeout(() => {
      const video = videoRef.current
      if (video && video.readyState === 0 && !video.error)
        logWarning(
          'video',
          `原生 <video> 8 秒无元数据且无 error（readyState=0，疑似容器/解码静默不受支持）：${media.name}`,
        )
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [media, wcActive])

  // 缩放框：外部 windowZoom 变化直接反映到显示值；用户输入存草稿
  const [zoomDraft, setZoomDraft] = useState<string | null>(null)
  const zoomText = zoomDraft ?? `${Math.round(windowZoom * 1000) / 10}%`

  const commitZoom = (text = zoomText) => {
    const value = Number.parseFloat(text)
    setZoomDraft(null)
    if (!Number.isFinite(value)) return
    onWindowZoomChange(Math.max(0.125, Math.min(3, value / 100)))
  }

  const seek = (value: number) => {
    const clamped = Math.max(0, Math.min(durationMs || value, value))
    const source = wcSourceRef.current
    if (source) {
      source.seek(clamped)
      onTimeChange(clamped)
      return
    }
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000
    onTimeChange(clamped)
  }

  // dummy 视频播放：无 <video> 元素，用 rAF 推进当前时间
  useEffect(() => {
    if (!dummyPlaying || !media?.dummy) return
    let frame = 0
    const tick = () => {
      const next = currentRef.current + 1000 / 24
      if (next >= (media.dummy?.lengthMs ?? 0)) {
        setDummyPlaying(false)
        onTimeChange(media.dummy?.lengthMs ?? 0)
      } else {
        onTimeChange(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [dummyPlaying, media, onTimeChange])

  useEffect(() => {
    if (!mediaAction.sequence) return
    const video = videoRef.current
    const wcSource = wcSourceRef.current
    const frame = 1000 / 24
    if (mediaAction.type.startsWith('video/tool/')) {
      // 外部命令流切换视觉工具
      // oxlint-disable-next-line react/set-state-in-effect
      setVisualTool(mediaAction.type)
      return
    }
    if (mediaAction.type.startsWith('zoom-')) {
      if (mediaAction.type === 'zoom-in' || mediaAction.type === 'zoom-out') {
        onWindowZoomChangeRef.current(
          Math.max(
            0.125,
            Math.min(3, windowZoomRef.current + (mediaAction.type === 'zoom-in' ? 0.125 : -0.125)),
          ),
        )
      } else {
        const value = Number(mediaAction.type.slice(5))
        if (Number.isFinite(value) && value > 0)
          onWindowZoomChangeRef.current(Math.max(0.125, Math.min(3, value / 100)))
      }
      return
    }
    // video/reset_pan：复位平移与内容缩放（video_display.cpp ResetContentZoom：
    // pan_x/pan_y = 0、contentZoomValue = 1，不动 windowZoomValue）
    if (mediaAction.type === 'reset-pan') {
      panRef.current = { x: 0, y: 0 }
      setPan({ x: 0, y: 0 })
      contentZoomRef.current = 1
      setContentZoom(1)
      return
    }
    // dummy 视频的播放控制
    if (
      media?.dummy &&
      (mediaAction.type === 'toggle' || mediaAction.type === 'play' || mediaAction.type === 'stop')
    ) {
      if (mediaAction.type === 'toggle') setDummyPlaying((prev) => !prev)
      else setDummyPlaying(mediaAction.type === 'play')
      return
    }
    const currentTime = () => {
      if (wcSource) return wcSource.currentTime
      if (video) return video.currentTime * 1000
      return 0
    }
    const duration = () => {
      if (wcSource) return durationMs
      if (video && Number.isFinite(video.duration)) return video.duration * 1000
      return 0
    }
    const actionSeek = (timeMs: number) => {
      const clamped = Math.max(0, Math.min(duration() || timeMs, timeMs))
      if (wcSource) wcSource.seek(clamped)
      else if (video) video.currentTime = clamped / 1000
      onTimeChange(clamped)
    }
    switch (mediaAction.type) {
      case 'toggle':
        if (wcSource) wcSource.toggle()
        else if (video) {
          if (video.paused) void video.play()
          else video.pause()
        }
        break
      case 'play':
        if (wcSource) wcSource.play()
        else if (video?.paused) void video.play()
        break
      case 'stop':
        if (wcSource) wcSource.pause()
        else if (video) video.pause()
        break
      case 'frame-prev':
        actionSeek(currentTime() - frame)
        break
      case 'frame-next':
        actionSeek(currentTime() + frame)
        break
      case 'start':
        actionSeek(0)
        break
      case 'end':
        actionSeek(duration())
        break
    }
    // windowZoom/onWindowZoomChange 经 ref 读取且不入依赖：mediaAction 从不清除，
    // 依赖它们会让过期 action（如 reset-pan）在每次窗口缩放变化时重放，锁死缩放
  }, [durationMs, media, mediaAction, onTimeChange])

  const hitTest = (x: number, y: number): HitBox | null => {
    const stage = stageRef.current
    if (!stage) return null
    const bounds = stage.getBoundingClientRect()
    const px = x - bounds.left
    const py = y - bounds.top
    for (let i = hitBoxesRef.current.length - 1; i >= 0; i--) {
      const box = hitBoxesRef.current[i]
      if (px >= box.left && px <= box.right && py >= box.top && py <= box.bottom) return box
    }
    return null
  }

  // ---- 矢量裁剪：激活/解析（visual_tool_vector_clip.cpp DoRefresh）----
  useEffect(() => {
    if (visualTool !== 'video/tool/vector_clip') {
      // 工具切换时销毁矢量裁剪会话
      // oxlint-disable-next-line react/set-state-in-effect
      setVclip(null)
      return
    }
    const spline = new Spline()
    let inverse = false
    if (activeCue) {
      const info = readVectorClip(activeCue.text)
      if (info) {
        inverse = info.inverse
        spline.scale = info.scale
        spline.decode(info.drawing)
        if (info.scale !== 1) spline.curves = scaleSpline(spline, 1 / 2 ** (info.scale - 1)).curves
      }
    }
    setVclip({
      inverse,
      spline,
      mode: spline.curves.length ? 'video/tool/vclip/drag' : 'video/tool/vclip/line',
      selected: new Set(),
      active: null,
      dragStart: null,
      dragOriginal: new Map(),
      boxStart: null,
      mouse: null,
    })
  }, [visualTool, activeCue])

  const scriptTransform = () => {
    const stage = stageRef.current
    if (!stage) return null
    const bounds = stage.getBoundingClientRect()
    // 脚本坐标经媒体显示框映射（平移/内容缩放后跟随视频，对应源码 display area）
    const rect = mediaRect()
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    return {
      playResX,
      playResY,
      toScript: (clientX: number, clientY: number): Vec2 =>
        vec(
          ((clientX - bounds.left - rect.left) / rect.width) * playResX,
          ((clientY - bounds.top - rect.top) / rect.height) * playResY,
        ),
      /** 显示像素 → 脚本单位（命中半径换算） */
      pixelToScript: playResY / rect.height,
    }
  }

  const commitVclip = (state: VClipState) => {
    if (!activeCue) return
    const scaled =
      state.spline.scale !== 1
        ? scaleSpline(state.spline, 2 ** (state.spline.scale - 1))
        : state.spline
    const drawing = scaled.encode()
    if (!drawing.trim()) return
    onPatchCue(
      activeCue.id,
      { text: setVectorClip(activeCue.text, state.inverse, `(${drawing})`) },
      tPlain('visual typesetting'),
    )
  }

  const hitFeature = (state: VClipState, pos: Vec2, radiusScript: number): VClipFeature | null => {
    let best: VClipFeature | null = null
    let bestDistance = Infinity
    for (const feature of makeFeatures(state.spline)) {
      const distance = (feature.pos.x - pos.x) ** 2 + (feature.pos.y - pos.y) ** 2
      if (distance <= radiusScript ** 2 && distance < bestDistance) {
        bestDistance = distance
        best = feature
      }
    }
    return best
  }

  /** remove 模式删点（visual_tool_vector_clip.cpp：柄拉直/端点接合） */
  const removeVclipFeature = (spline: Spline, feature: VClipFeature) => {
    const curve = spline.curves[feature.index]
    if (!curve) return
    const nextCurve = spline.curves[feature.index + 1]
    if (curve.type === 'bicubic' && (feature.point === 1 || feature.point === 2)) {
      curve.type = 'line'
      curve.p2 = curve.p4
      return
    }
    if (nextCurve) {
      if (curve.type === 'point') {
        nextCurve.p1 = nextCurve.type === 'bicubic' ? nextCurve.p4 : nextCurve.p2
        nextCurve.type = 'point'
      } else {
        nextCurve.p1 = curve.p1
      }
    }
    spline.curves.splice(feature.index, 1)
  }

  const vclipPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const state = vclipRef.current
    const transform = scriptTransform()
    if (!state || !transform || !activeCue) return
    const pos = transform.toScript(event.clientX, event.clientY)
    const radius = 3 * transform.pixelToScript
    const next: VClipState = {
      ...state,
      selected: new Set(state.selected),
      dragOriginal: new Map(),
    }
    const mode = state.mode
    const curves = next.spline.curves
    const lastEnd = (): Vec2 =>
      curves.length
        ? curves[curves.length - 1].type === 'line'
          ? curves[curves.length - 1].p2
          : curves[curves.length - 1].p4
        : pos

    if (mode === 'video/tool/vclip/remove') {
      const hit = hitFeature(state, pos, radius)
      if (hit) {
        removeVclipFeature(next.spline, hit)
        next.selected.clear()
        next.active = null
        setVclip(next)
        commitVclip(next)
      }
      return
    }
    if (mode === 'video/tool/vclip/convert') {
      const closest = next.spline.closestParametric(pos, true)
      if (closest && closest.index < curves.length) {
        const curve = curves[closest.index]
        if (curve.type === 'line') {
          curve.type = 'bicubic'
          curve.p4 = curve.p2
          curve.p2 = vec(
            curve.p1.x * 0.75 + curve.p4.x * 0.25,
            curve.p1.y * 0.75 + curve.p4.y * 0.25,
          )
          curve.p3 = vec(
            curve.p1.x * 0.25 + curve.p4.x * 0.75,
            curve.p1.y * 0.25 + curve.p4.y * 0.75,
          )
        } else if (curve.type === 'bicubic') {
          curve.type = 'line'
          curve.p2 = curve.p4
        }
        setVclip(next)
        commitVclip(next)
      }
      return
    }
    if (mode === 'video/tool/vclip/insert') {
      const closest = next.spline.closestParametric(pos, true)
      if (!closest) return
      if (closest.index >= curves.length) {
        // 闭合边：追加一段到新顶点（子路径隐式闭合）
        curves.push({
          type: 'line',
          p1: lastEnd(),
          p2: closest.point,
          p3: closest.point,
          p4: closest.point,
        })
      } else {
        next.spline.splitCurve(closest.index, closest.t)
      }
      setVclip(next)
      commitVclip(next)
      return
    }
    if (mode === 'video/tool/vclip/line' || mode === 'video/tool/vclip/bicubic') {
      if (!curves.length) {
        curves.push({ type: 'point', p1: pos, p2: pos, p3: pos, p4: pos })
      } else if (mode === 'video/tool/vclip/line') {
        curves.push({ type: 'line', p1: lastEnd(), p2: pos, p3: pos, p4: pos })
      } else {
        const start = lastEnd()
        curves.push({
          type: 'bicubic',
          p1: start,
          p2: vec(start.x * 0.75 + pos.x * 0.25, start.y * 0.75 + pos.y * 0.25),
          p3: vec(start.x * 0.25 + pos.x * 0.75, start.y * 0.25 + pos.y * 0.75),
          p4: pos,
        })
      }
      next.dragStart = pos
      next.mouse = pos
      setVclip(next)
      return
    }
    if (mode === 'video/tool/vclip/freehand' || mode === 'video/tool/vclip/freehand_smooth') {
      next.spline.curves = [{ type: 'point', p1: pos, p2: pos, p3: pos, p4: pos }]
      next.dragStart = pos
      next.mouse = pos
      setVclip(next)
      return
    }

    // drag 模式：命中特征拖动，空白处框选
    const hit = hitFeature(state, pos, radius)
    if (hit) {
      if (!next.selected.has(hit.key)) {
        next.selected = event.ctrlKey ? new Set([...next.selected, hit.key]) : new Set([hit.key])
      }
      next.active = hit.key
      next.dragStart = pos
      for (const key of next.selected) {
        const feature = makeFeatures(state.spline).find((item) => item.key === key)
        if (feature) next.dragOriginal.set(key, feature.pos)
      }
    } else {
      if (!event.altKey) next.selected = new Set()
      next.active = null
      next.dragStart = pos
      next.boxStart = pos
    }
    setVclip(next)
  }

  const vclipPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const state = vclipRef.current
    const transform = scriptTransform()
    if (!state || !transform) return
    const pos = transform.toScript(event.clientX, event.clientY)
    const next: VClipState = { ...state, mouse: pos }
    const mode = state.mode
    const curves = next.spline.curves

    if (next.boxStart) {
      // 框选
      const minX = Math.min(next.boxStart.x, pos.x)
      const maxX = Math.max(next.boxStart.x, pos.x)
      const minY = Math.min(next.boxStart.y, pos.y)
      const maxY = Math.max(next.boxStart.y, pos.y)
      next.selected = new Set(
        makeFeatures(next.spline)
          .filter(
            (feature) =>
              feature.pos.x >= minX &&
              feature.pos.x <= maxX &&
              feature.pos.y >= minY &&
              feature.pos.y <= maxY,
          )
          .map((feature) => feature.key),
      )
    } else if (
      next.dragStart &&
      (mode === 'video/tool/vclip/line' || mode === 'video/tool/vclip/bicubic')
    ) {
      const curve = curves[curves.length - 1]
      if (curve) {
        if (mode === 'video/tool/vclip/line') {
          curve.p2 = pos
        } else {
          curve.p4 = pos
          curve.p2 = vec(curve.p1.x * 0.75 + pos.x * 0.25, curve.p1.y * 0.75 + pos.y * 0.25)
          curve.p3 = vec(curve.p1.x * 0.25 + pos.x * 0.75, curve.p1.y * 0.25 + pos.y * 0.75)
        }
      }
    } else if (
      next.dragStart &&
      (mode === 'video/tool/vclip/freehand' || mode === 'video/tool/vclip/freehand_smooth')
    ) {
      const threshold = (mode === 'video/tool/vclip/freehand' ? 30 : 60) * transform.pixelToScript
      const last = curves[curves.length - 1]
      const anchor = last ? (last.type === 'line' ? last.p2 : last.p4) : next.dragStart
      if ((pos.x - anchor.x) ** 2 + (pos.y - anchor.y) ** 2 >= threshold * threshold) {
        curves.push({ type: 'line', p1: anchor, p2: pos, p3: anchor, p4: pos })
      }
    } else if (next.dragStart) {
      // 拖动选中特征（Shift = 单轴约束）
      let dx = pos.x - next.dragStart.x
      let dy = pos.y - next.dragStart.y
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      for (const [key, original] of next.dragOriginal) {
        const [index, point] = key.split(':').map(Number)
        next.spline.movePoint(index, point, vec(original.x + dx, original.y + dy))
      }
    }
    setVclip(next)
  }

  const vclipPointerUp = (): void => {
    const state = vclipRef.current
    if (!state) return
    const wasInteracting = state.dragStart !== null
    const next: VClipState = { ...state, dragStart: null, boxStart: null, dragOriginal: new Map() }
    if (wasInteracting && state.mode === 'video/tool/vclip/freehand_smooth') {
      next.spline.smooth()
      next.mode = 'video/tool/vclip/drag' // 松开自动切回 drag
    }
    setVclip(next)
    if (wasInteracting) commitVclip(next)
  }

  const canvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // 源码视觉工具只响应左键；中键留给拖动平移，右键留给上下文菜单
    if (event.button !== 0) return
    if (visualTool === 'video/tool/vector_clip') {
      vclipPointerDown(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const hit = hitTest(event.clientX, event.clientY)
    const cue = hit?.cue ?? activeCue
    if (!cue) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const stage = stageRef.current
    if (!stage) return
    const overrides = readVisualOverrides(cue.text)
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    const bounds = stage.getBoundingClientRect()
    const rect = mediaRect()
    const pointerX = ((event.clientX - bounds.left - rect.left) / rect.width) * playResX
    const pointerY = ((event.clientY - bounds.top - rect.top) / rect.height) * playResY
    const baseX = overrides.pos?.x ?? pointerX
    const baseY = overrides.pos?.y ?? pointerY
    dragRef.current = {
      cue,
      startX: event.clientX,
      startY: event.clientY,
      baseX,
      baseY,
      baseScaleX: overrides.scaleX,
      baseScaleY: overrides.scaleY,
      baseRotationX: overrides.rotationX,
      baseRotationY: overrides.rotationY,
      baseRotationZ: overrides.rotationZ,
    }
    if (visualTool === 'video/tool/clip') {
      onPatchCue(
        cue.id,
        {
          text: setOverride(
            cue.text,
            'clip',
            `(${Math.round(pointerX)},${Math.round(pointerY)},${Math.round(pointerX)},${Math.round(pointerY)})`,
          ),
        },
        tPlain('Set clipping rectangle'),
      )
    }
  }

  const canvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (vclipRef.current) {
      vclipPointerMove(event)
      return
    }
    const drag = dragRef.current
    if (!drag) return
    const stage = stageRef.current
    if (!stage) return
    // 屏幕像素 → 视频坐标的缩放：经媒体显示框换算（平移/内容缩放后拖动量一致）
    const rect = mediaRect()
    const scale =
      rect.height /
      (media?.dummy ? media.dummy.height : Number(document.scriptInfo.PlayResY) || 1080)
    if (visualTool === 'video/tool/drag') {
      const dx = Math.round((event.clientX - drag.startX) / scale)
      const dy = Math.round((event.clientY - drag.startY) / scale)
      onPatchCue(
        drag.cue.id,
        { text: setPosition(drag.cue.text, drag.baseX + dx, drag.baseY + dy) },
        tPlain('Move subtitle'),
      )
    } else if (visualTool === 'video/tool/scale') {
      let dx = ((event.clientX - drag.startX) / scale) * 1.25
      let dy = ((drag.startY - event.clientY) / scale) * 1.25
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      if (event.altKey) dx = dy = Math.abs(dx) > Math.abs(dy) ? dx : dy
      let sx = Math.max(0, drag.baseScaleX + dx)
      let sy = Math.max(0, drag.baseScaleY + dy)
      if (event.ctrlKey) {
        sx = Math.round(sx / 25) * 25
        sy = Math.round(sy / 25) * 25
      }
      const text = setOverride(
        setOverride(drag.cue.text, 'fscx', `${Math.round(sx)}`),
        'fscy',
        `${Math.round(sy)}`,
      )
      onPatchCue(drag.cue.id, { text }, tPlain('Scale subtitle'))
    } else if (visualTool === 'video/tool/rotate/z') {
      const originX = drag.startX
      const originY = drag.startY
      let angle =
        drag.baseRotationZ +
        (Math.atan2(event.clientY - originY, event.clientX - originX) * 180) / Math.PI
      if (event.ctrlKey) angle = Math.round(angle / 30) * 30
      angle = ((angle % 360) + 360) % 360
      onPatchCue(
        drag.cue.id,
        { text: setOverride(drag.cue.text, 'frz', angle.toFixed(2)) },
        tPlain('Rotate subtitle'),
      )
    } else if (visualTool === 'video/tool/rotate/xy') {
      let rx = drag.baseRotationX - (event.clientY - drag.startY) * 2
      let ry = drag.baseRotationY + (event.clientX - drag.startX) * 2
      if (event.shiftKey) {
        if (Math.abs(rx - drag.baseRotationX) > Math.abs(ry - drag.baseRotationY))
          ry = drag.baseRotationY
        else rx = drag.baseRotationX
      }
      if (event.ctrlKey) {
        rx = Math.round(rx / 30) * 30
        ry = Math.round(ry / 30) * 30
      }
      const text = setOverride(
        setOverride(drag.cue.text, 'frx', `${((rx % 360) + 360) % 360}`),
        'fry',
        `${((ry % 360) + 360) % 360}`,
      )
      onPatchCue(drag.cue.id, { text }, tPlain('Rotate subtitle'))
    } else if (visualTool === 'video/tool/clip') {
      const bounds = stage.getBoundingClientRect()
      const clipRect = mediaRect()
      const playResY = Number(document.scriptInfo.PlayResY) || 1080
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
      const x2 = ((event.clientX - bounds.left - clipRect.left) / clipRect.width) * playResX
      const y2 = ((event.clientY - bounds.top - clipRect.top) / clipRect.height) * playResY
      const value = `(${Math.round(Math.min(drag.baseX, x2))},${Math.round(Math.min(drag.baseY, y2))},${Math.round(Math.max(drag.baseX, x2))},${Math.round(Math.max(drag.baseY, y2))})`
      onPatchCue(
        drag.cue.id,
        { text: setOverride(drag.cue.text, 'clip', value) },
        tPlain('Set clipping rectangle'),
      )
    }
  }

  const canvasDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (visualTool !== 'video/tool/cross' || !activeCue) return
    const stage = stageRef.current
    if (!stage) return
    const bounds = stage.getBoundingClientRect()
    const rect = mediaRect()
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    const x = ((event.clientX - bounds.left - rect.left) / rect.width) * playResX
    const y = ((event.clientY - bounds.top - rect.top) / rect.height) * playResY
    onPatchCue(
      activeCue.id,
      { text: setPosition(activeCue.text, x, y) },
      tPlain('Position subtitle'),
    )
  }

  const canvasPointerUp = () => {
    if (vclipRef.current) {
      vclipPointerUp()
      return
    }
    dragRef.current = null
  }

  // ---- video_context 命令（video_display.cpp 右键菜单）----

  /** 合成当前帧画布：full=视频+字幕 / raw=仅视频 / subs=仅字幕（透明背景） */
  const buildFrameCanvas = (kind: 'full' | 'raw' | 'subs'): HTMLCanvasElement | null => {
    const stage = stageRef.current
    const overlay = canvasRef.current
    if (!stage || !overlay) return null
    const ratio = window.devicePixelRatio || 1
    const cssWidth = Math.max(1, stage.clientWidth)
    const cssHeight = Math.max(1, stage.clientHeight)

    if (kind === 'subs' && !media?.dummy) {
      // 真实视频：overlay 画布本身就是透明背景 + 字幕
      const canvas = window.document.createElement('canvas')
      canvas.width = overlay.width
      canvas.height = overlay.height
      canvas.getContext('2d')?.drawImage(overlay, 0, 0)
      return canvas
    }

    const canvas = window.document.createElement('canvas')
    canvas.width = Math.round(cssWidth * ratio)
    canvas.height = Math.round(cssHeight * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

    if (media?.dummy) {
      const rect = mediaRect()
      if (kind === 'full') {
        // dummy 的 overlay 已含背景与字幕
        ctx.drawImage(overlay, 0, 0, cssWidth, cssHeight)
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, cssWidth, cssHeight)
        const { width: vw, height: vh, color, pattern } = media.dummy
        const s = Math.min(rect.width / vw, rect.height / vh)
        drawDummyBackground(
          ctx,
          rect.left + (rect.width - vw * s) / 2,
          rect.top + (rect.height - vh * s) / 2,
          vw * s,
          vh * s,
          color,
          pattern,
          s,
        )
      }
      return canvas
    }

    // 真实视频：按显示框实际位置与尺寸绘制（含平移与内容缩放）
    const video = videoRef.current
    if (video) {
      const rect = mediaRect()
      ctx.drawImage(video, rect.left, rect.top, rect.width, rect.height)
    }
    if (kind === 'full') ctx.drawImage(overlay, 0, 0, cssWidth, cssHeight)
    return canvas
  }

  const saveFrame = (kind: 'full' | 'raw' | 'subs') => {
    const canvas = buildFrameCanvas(kind)
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      const stamp = Math.round(currentRef.current)
      anchor.href = url
      anchor.download = `frame-${stamp}${kind === 'raw' ? '-raw' : kind === 'subs' ? '-subs' : ''}.png`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const copyFrame = async (kind: 'full' | 'raw' | 'subs') => {
    const canvas = buildFrameCanvas(kind)
    if (!canvas) return
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('no blob')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch {
      // 剪贴板写入可能被浏览器拒绝
    }
  }

  const copyCoordinates = () => {
    const pos = mousePosRef.current
    if (!pos) return
    void navigator.clipboard
      ?.writeText(`${Math.round(pos.x)},${Math.round(pos.y)}`)
      .catch(() => undefined)
  }

  const runVideoContextCommand = (id: string) => {
    setContextMenu(null)
    switch (id) {
      case 'video/frame/save':
        saveFrame('full')
        return
      case 'video/frame/save/raw':
        saveFrame('raw')
        return
      case 'video/frame/save/subs':
        saveFrame('subs')
        return
      case 'video/frame/copy':
        void copyFrame('full')
        return
      case 'video/frame/copy/raw':
        void copyFrame('raw')
        return
      case 'video/frame/copy/subs':
        void copyFrame('subs')
        return
      case 'video/copy_coordinates':
        copyCoordinates()
        return
      default:
        onCommand(id)
    }
  }

  useEffect(() => {
    if (!contextMenu) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.grid-context-menu')) setContextMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [contextMenu])

  return (
    <section className="preview-panel" aria-label={tPlain('Video preview')} style={panelStyle}>
      <div
        className="video-content"
        onMouseEnter={() => setVideoHover(true)}
        onMouseLeave={() => setVideoHover(false)}
      >
        {/* Tool/Visual/Autohide：仅鼠标位于视频上时显示视觉工具条 */}
        {!(getOptionBool('Tool/Visual/Autohide') && !videoHover) && (
          <div className="visual-toolbar" aria-label={tPlain('Visual tools')}>
            {VISUAL_TOOLS.map(([id, icon]) =>
              id === '' ? (
                <div className="visual-sep" key="visual-sep" />
              ) : (
                <button
                  className={`visual-tool${visualTool === id ? ' pressed' : ''}`}
                  title={commandTooltip(id, 'Video')}
                  aria-label={commandTooltip(id, 'Video')}
                  key={id}
                  disabled={!isCommandEnabled(id)}
                  aria-pressed={
                    id.startsWith('video/tool/')
                      ? visualTool === id || isCommandChecked(id)
                      : undefined
                  }
                  onClick={() => onCommand(id)}
                >
                  <img src={VICON(icon)} alt="" width={16} height={16} draggable={false} />
                </button>
              ),
            )}
          </div>
        )}
        {vclip && (
          <div
            className="visual-toolbar visual-subtoolbar"
            aria-label={tPlain('Vector clip sub tools')}
          >
            {VCLIP_MODES.map((id, index) =>
              id === '' ? (
                <div className="visual-sep" key={`vsub-sep-${index}`} />
              ) : (
                <button
                  className={`visual-tool${vclip.mode === id ? ' pressed' : ''}`}
                  title={commandTooltip(id, 'Video')}
                  aria-label={commandTooltip(id, 'Video')}
                  aria-pressed={vclip.mode === id}
                  key={id}
                  onClick={() =>
                    setVclip((current) =>
                      current ? { ...current, mode: id, dragStart: null, boxStart: null } : current,
                    )
                  }
                >
                  {commandIcon(id, 16) ? (
                    <img
                      src={commandIcon(id, 16)}
                      alt=""
                      width={16}
                      height={16}
                      draggable={false}
                    />
                  ) : (
                    <span className="tool-button-label">{COMMANDS[id]?.label?.[0]}</span>
                  )}
                </button>
              ),
            )}
          </div>
        )}
        <div
          className="video-stage"
          ref={stageRef}
          tabIndex={0}
          data-shortcut-context="Video"
          onPointerDown={(event) => {
            // video_display.cpp OnMouseEvent：按住中键拖动平移视频画面（Pan(位置差)）
            if (event.button !== 1 || !hasVideo) return
            event.preventDefault()
            middleDragRef.current = { x: event.clientX, y: event.clientY }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = middleDragRef.current
            if (drag && event.buttons & 4) {
              panBy(event.clientX - drag.x, event.clientY - drag.y)
              middleDragRef.current = { x: event.clientX, y: event.clientY }
            }
            // video/copy_coordinates：记录鼠标在视频分辨率坐标下的最近位置
            const bounds = event.currentTarget.getBoundingClientRect()
            const rect = mediaRect()
            const playResY = Number(document.scriptInfo.PlayResY) || 1080
            const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
            mousePosRef.current = {
              x: ((event.clientX - bounds.left - rect.left) / rect.width) * playResX,
              y: ((event.clientY - bounds.top - rect.top) / rect.height) * playResY,
            }
          }}
          onPointerUp={(event) => {
            if (event.button === 1) middleDragRef.current = null
          }}
          onPointerCancel={() => {
            middleDragRef.current = null
          }}
          onMouseDown={(event) => {
            // 压制中键默认行为（自动滚动/剪贴板粘贴），避免干扰拖动平移
            if (event.button === 1) event.preventDefault()
          }}
          onAuxClick={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (hasVideo) setContextMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          {fontAccess === 'available' && hasVideo && (
            <div className="system-fonts-hint" role="status">
              <span>
                {fontAccessError
                  ? `System fonts unavailable: ${fontAccessError}`
                  : tPlain(
                      'Subtitles render with built-in fallback fonts. Authorize access to use the fonts installed on this system.',
                    )}
              </span>
              {!fontAccessError && (
                <button onClick={() => void enableSystemFonts()}>
                  {tPlain('Enable system fonts')}
                </button>
              )}
              <button
                className="system-fonts-hint-close"
                aria-label={tPlain('Dismiss')}
                onClick={() => setFontAccess('dismissed')}
              >
                ×
              </button>
            </div>
          )}
          <div
            className="video-zoom-stage"
            ref={zoomStageRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
          >
            {media?.url && !wcActive ? (
              <video
                ref={videoRef}
                src={media.url}
                preload="metadata"
                style={{
                  width: `${Math.round(intrinsicWidth * windowZoom * contentZoom)}px`,
                  height: `${Math.round(intrinsicHeight * windowZoom * contentZoom)}px`,
                }}
                onLoadedMetadata={(event) => {
                  const value = Number.isFinite(event.currentTarget.duration)
                    ? event.currentTarget.duration * 1000
                    : 0
                  setDurationMs(value)
                  onDurationChange(value)
                  onIntrinsicSizeChange(
                    event.currentTarget.videoWidth,
                    event.currentTarget.videoHeight,
                  )
                  probeVideoFps(event.currentTarget, media.url)
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                // 浏览器解不了容器/编解码（mkv 等）→ 自动切 WebCodecs（手动强制原生时不切，仅记录）
                onError={() => {
                  const mediaError = videoRef.current?.error
                  logWarning(
                    'video',
                    `原生 <video> 解码失败（MediaError code=${mediaError?.code ?? '?'} ${mediaError?.message ?? ''}）` +
                      (decoderOverride === false ? '' : '，自动切换 WebCodecs 解码'),
                  )
                  setWcMode(true)
                }}
              />
            ) : media?.url && wcActive ? (
              <div
                className="webcodecs-video-wrap"
                style={{
                  position: 'relative',
                  width: `${Math.round(intrinsicWidth * windowZoom * contentZoom)}px`,
                  height: `${Math.round(intrinsicHeight * windowZoom * contentZoom)}px`,
                }}
              >
                <canvas
                  ref={wcCanvasRef}
                  className="webcodecs-video"
                  style={{ width: '100%', height: '100%', background: '#000' }}
                />
                {wcError && <div className="webcodecs-video-error">{wcError}</div>}
              </div>
            ) : media?.dummy ? (
              <div
                className="dummy-video-stage"
                aria-label={tPlain('Dummy video')}
                style={{
                  width: `${Math.round(media.dummy.width * windowZoom * contentZoom)}px`,
                  height: `${Math.round(media.dummy.height * windowZoom * contentZoom)}px`,
                  background:
                    assRenderer && !assError
                      ? dummyBackgroundCss(media.dummy, windowZoom * contentZoom)
                      : undefined,
                }}
              />
            ) : (
              <button className="empty-media" onClick={onOpenMedia}>
                <Video size={28} aria-hidden="true" />
                <span>{tPlain('Open media')}</span>
              </button>
            )}
          </div>
          <canvas
            ref={canvasRef}
            className="subtitle-overlay"
            style={{
              pointerEvents: !hasVideo ? 'none' : 'auto',
            }}
            onPointerDown={canvasPointerDown}
            onPointerMove={canvasPointerMove}
            onPointerUp={canvasPointerUp}
            onPointerCancel={canvasPointerUp}
            onDoubleClick={canvasDoubleClick}
          />
        </div>
      </div>
      <div className="video-static-line" />
      <VideoSliderControl
        maxFrame={Math.max(1, frameCount - 1)}
        currentFrame={hasVideo ? currentFrame : 0}
        keyframes={hasVideo ? keyframes : []}
        showKeyframes={getOptionBool('Video/Slider/Show Keyframes')}
        onSeekFrame={(target) =>
          seek(frameRate.timeAtFrame(Math.max(0, Math.min(frameCount - 1, target)), 'exact'))
        }
        onKeyframeStep={(direction) =>
          onCommand(direction > 0 ? 'video/frame/next/keyframe' : 'video/frame/prev/keyframe')
        }
      />
      <div className="video-bottom">
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/play')}
          disabled={!hasVideo}
          title={commandTooltip('video/play', 'Video')}
          aria-label={commandTooltip('video/play', 'Video')}
        >
          <img
            src={VICON(playing || dummyPlaying ? 'button_pause' : 'button_play')}
            alt=""
            width={16}
            height={16}
            draggable={false}
          />
        </button>
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/play/line')}
          disabled={!hasVideo}
          title={commandTooltip('video/play/line', 'Video')}
          aria-label={commandTooltip('video/play/line', 'Video')}
        >
          <img src={VICON('button_playline')} alt="" width={16} height={16} draggable={false} />
        </button>
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/stop')}
          disabled={!hasVideo}
          title={commandTooltip('video/stop', 'Video')}
          aria-label={commandTooltip('video/stop', 'Video')}
        >
          <img src={VICON('button_stop')} alt="" width={16} height={16} draggable={false} />
        </button>
        <button
          className={`video-tool-btn${isCommandChecked('video/opt/autoscroll') ? ' pressed' : ''}`}
          onClick={() => onCommand('video/opt/autoscroll')}
          disabled={!hasVideo}
          title={commandTooltip('video/opt/autoscroll', 'Video')}
          aria-label={commandTooltip('video/opt/autoscroll', 'Video')}
          aria-pressed={isCommandChecked('video/opt/autoscroll')}
        >
          <img
            src={VICON('toggle_video_autoscroll')}
            alt=""
            width={16}
            height={16}
            draggable={false}
          />
        </button>
        <input
          className="video-position"
          readOnly
          // VideoBox::UpdateTimeBoxes：显示帧的 EXACT 时间（非原始媒体时间）
          value={hasVideo ? `${formatVideoTime(frameTimeMs)} - ${currentFrame}` : ''}
          aria-label={tPlain('Current frame time and number')}
          title={tPlain('Current frame time and number')}
          // 关键帧高亮（video_box.cpp：当前帧是关键帧时用网格选中色反色）
          style={
            hasVideo && keyframes.includes(currentFrame)
              ? {
                  background: getOptionString('Colour/Subtitle Grid/Background/Selection'),
                  color: getOptionString('Colour/Subtitle Grid/Selection'),
                }
              : undefined
          }
        />
        <input
          className="video-subs-pos"
          readOnly
          value={
            hasVideo && activeCue
              ? `${signedMs(frameTimeMs - activeCue.startMs)}; ${signedMs(frameTimeMs - activeCue.endMs)}`
              : ''
          }
          aria-label={tPlain('Time of this frame relative to start and end of current subs')}
          title={tPlain('Time of this frame relative to start and end of current subs')}
        />
        <input
          className="video-zoom"
          list="video-zoom-options"
          value={zoomText}
          onChange={(event) => {
            setZoomDraft(event.target.value)
          }}
          onBlur={() => commitZoom()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitZoom(event.currentTarget.value)
            if (event.key === 'Escape') setZoomDraft(null)
          }}
          aria-label={tPlain('Video zoom')}
        />
        <datalist id="video-zoom-options">
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={`${(i + 1) * 12.5}%`} />
          ))}
        </datalist>
      </div>

      {contextMenu && (
        <MenuPopup x={contextMenu.x} y={contextMenu.y} label={tPlain('Video context menu')}>
          {getVideoContext().map((item, index) => {
            if (item.separator)
              return <div className="menu-separator" role="separator" key={`vsep-${index}`} />
            if (!item.command)
              return (
                <button className="menu-item" role="menuitem" disabled key={`vdis-${index}`}>
                  <span className="menu-label">{item.label}</span>
                </button>
              )
            return (
              <button
                className="menu-item"
                role="menuitem"
                key={item.command}
                disabled={!isCommandEnabled(item.command)}
                onClick={() => runVideoContextCommand(item.command!)}
              >
                <span className="menu-label">
                  {item.label ?? tPlain(COMMANDS[item.command]?.label ?? item.command)}
                </span>
              </button>
            )
          })}
        </MenuPopup>
      )}
    </section>
  )
}
