import { Video } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

import {
  getOption,
  getOptionBool,
  getOptionInt,
  getOptionString,
  setOption,
  useOptionsVersion,
} from '../../config/options'
import { blockText, parseBlocks } from '../../core/assTags'
import {
  defaultLinePosition,
  findTagInBlocks,
  floatToString,
  formatG4,
  readVisualOverrides,
  removeOverride,
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
import { ptsToMs } from '../../core/vfr'
import { detachElementGain, setElementGain } from '../../media/elementGain'
import { WebCodecsVideoSource } from '../../media/webcodecsVideo'
import type { MediaSource } from '../../platform/types'
import { aegisubIconUrl, commandIcon } from '../aegisubIcons'
import { getVideoContext } from '../aegisubMenus'
import { createAssRenderer, type AssRenderer } from '../assRenderer'
import { assColorToCss, cssColorToHex } from '../color'
import { COMMANDS, commandTooltip } from '../commands'
import { tPlain } from '../i18n'
import { logError, logInfo, logWarning } from '../log'
import { serialLatest, type SerialLatest } from '../rafThrottle'
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
  onPatchCue: (
    id: string,
    patch: Partial<Omit<SubtitleCue, 'id'>>,
    label: string,
  ) => Promise<unknown> | void
  /** 批量补丁（一次 apply = 一条 undo 记录）：SetSelectedOverride 多行同改语义 */
  onPatchCues: (
    patches: { id: string; patch: Partial<Omit<SubtitleCue, 'id'>> }[],
    label: string,
  ) => Promise<unknown> | void
  /** 当前选中行（含活动行）：视觉工具 SetSelectedOverride 的目标集合 */
  selectedCues: SubtitleCue[]
  onPatchStyle: (id: string, patch: Partial<Omit<SubtitleStyle, 'id'>>, label: string) => void
  isCommandEnabled: (id: string) => boolean
  isCommandChecked: (id: string) => boolean
  windowZoom: number
  /** 设备像素比（源码 GetContentScaleFactor）：视频显示尺寸按物理设备像素换算 */
  devicePixelRatio: number
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
  /** 播放音量增益（源码唯一 audio player 同时供视频出声，AudioPane 音量滑条统一控制） */
  playbackGain: number
  style?: CSSProperties
}

/** 视频解码通道 */
export type VideoPlaybackMode = 'native' | 'webcodecs'

const VICON = (name: string) => aegisubIconUrl(`${name}_64`)

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
  ['video/tool/perspective', 'visual_perspective'],
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

// ---------------------------------------------------------------------------
// GL 变换复刻（gl_wrap.cpp）：视觉工具参考线的精确 3D 数学
// ---------------------------------------------------------------------------
// 源码经 OpenGL 变换链绘制参考线：glOrtho(0,W,H,0) 的 y 向下视口 + SetRotation 的
// 透视矩阵（w=2500(z+1)，点按 1/(1+z) 收缩）。顶点依次经过：
//   shear(\fax/\fay) → fsc 缩放 → Rz(绕 -z) → Rx(绕 -x) → Ry(绕 -y) →
//   z×(8/zScale) → 透视除法 → baseScale(脚本→显示像素) → 平移 origin
// 3D 直线变换后仍是直线（端点即可）；圆/环/弧需在 3D 空间采样成折线。
interface GlMapperOptions {
  /** gl.SetOrigin（显示像素） */
  origin: [number, number]
  /** 最先应用的 SetScale（perspective 网格：bbox 高 / spacing / 4 的 glScale） */
  preScale?: { x: number; y: number }
  /** 旋转前的 SetScale（rotatexy：100·video/script，即脚本像素→显示像素） */
  baseScale?: { x: number; y: number }
  /** 角度（度） */
  rotX?: number
  rotY?: number
  rotZ?: number
  /** SetRotation 第 4 参（默认 1；web 不建模 layout res） */
  zScale?: number
  /** 旋转后的 SetScale（\fscx/\fscy 百分比） */
  fsc?: { x: number; y: number }
  /** SetShear（\fax/\fay） */
  shear?: { x: number; y: number }
}

function makeGlMapper(o: GlMapperOptions): (x: number, y: number, z?: number) => [number, number] {
  const rad = Math.PI / 180
  const cx = Math.cos((o.rotX ?? 0) * rad)
  const sx = Math.sin((o.rotX ?? 0) * rad)
  const cy = Math.cos((o.rotY ?? 0) * rad)
  const sy = Math.sin((o.rotY ?? 0) * rad)
  const cz = Math.cos((o.rotZ ?? 0) * rad)
  const sz = Math.sin((o.rotZ ?? 0) * rad)
  const zScale = o.zScale ?? 1
  const fscX = (o.fsc?.x ?? 100) / 100
  const fscY = (o.fsc?.y ?? 100) / 100
  const fax = o.shear?.x ?? 0
  const fay = o.shear?.y ?? 0
  const bsx = o.baseScale?.x ?? 1
  const bsy = o.baseScale?.y ?? 1
  const psx = o.preScale?.x ?? 1
  const psy = o.preScale?.y ?? 1
  return (px, py, pz = 0) => {
    // gl.SetScale(100*glScale)（perspective 网格）在顶点上最先生效
    let x = px * psx
    let y = py * psy
    let z = pz
    // SetShear(fax, fay) 列主序矩阵 {1,fay,0,0 | fax,1,0,0}：x' = x + fax·y；y' = fay·x + y
    const sx0 = x + fax * y
    const sy0 = fay * x + y
    x = sx0
    y = sy0
    // SetScale(fsc)
    x *= fscX
    y *= fscY
    // glRotatef(rz, 0,0,-1)
    const x1 = cz * x + sz * y
    const y1 = -sz * x + cz * y
    x = x1
    y = y1
    // glRotatef(rx, -1,0,0)
    const y2 = cx * y + sx * z
    const z2 = -sx * y + cx * z
    y = y2
    z = z2
    // glRotatef(ry, 0,-1,0)
    const x3 = cy * x - sy * z
    z = sy * x + cy * z
    x = x3
    // glScalef(1,1,8/zScale) + P 矩阵（w 行 = z+2500）→ 屏幕偏移按
    // 2500/(2500 + z·8/zScale) 收缩（z 为脚本像素单位）
    const w = 1 + (z * 8) / (zScale * 2500)
    x /= w
    y /= w
    // baseScale + SetOrigin 平移
    return [x * bsx + o.origin[0], y * bsy + o.origin[1]]
  }
}

/** 3D 变换后的圆（透视下为椭圆）：采样成折线，fill+stroke */
function drawGlCircle(
  context: CanvasRenderingContext2D,
  map: (x: number, y: number, z?: number) => [number, number],
  cx: number,
  cy: number,
  r: number,
  fill: string,
  stroke: string,
): void {
  context.beginPath()
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2
    const [px, py] = map(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    if (i === 0) context.moveTo(px, py)
    else context.lineTo(px, py)
  }
  context.closePath()
  context.fillStyle = fill
  context.fill()
  context.strokeStyle = stroke
  context.lineWidth = 1
  context.stroke()
}

/** 3D 变换后的圆环/环带扇区（DrawRing）：外弧正向 + 内弧反向闭合，evenodd 填充 + 描边 */
function drawGlRing(
  context: CanvasRenderingContext2D,
  map: (x: number, y: number, z?: number) => [number, number],
  r1: number,
  r2: number,
  startDeg: number,
  endDeg: number,
  fill: string,
  stroke: string,
): void {
  const rad = Math.PI / 180
  const a0 = startDeg * rad
  const a1 = endDeg * rad
  const steps = Math.max(12, Math.round(((r1 * (a1 - a0)) / (2 * Math.PI)) * 8))
  const outer: [number, number][] = []
  const inner: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    // 源码用 Vector2D::FromAngle(angle) = (cos(-a), sin(-a))：屏幕 Y 向下，弧朝向需翻转
    outer.push(map(Math.cos(a) * r1, -Math.sin(a) * r1))
    inner.push(map(Math.cos(a) * r2, -Math.sin(a) * r2))
  }
  context.beginPath()
  outer.forEach(([px, py], i) => (i === 0 ? context.moveTo(px, py) : context.lineTo(px, py)))
  for (let i = steps; i >= 0; i--) context.lineTo(inner[i][0], inner[i][1])
  context.closePath()
  if (fill) {
    context.fillStyle = fill
    context.fill('evenodd')
  }
  if (stroke) {
    context.strokeStyle = stroke
    context.lineWidth = 1
    context.stroke()
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

/** UpdateHold：矩形角点/位置钳制在脚本分辨率区域内（visual_tool_clip.cpp ClampToVideo） */
function clampToScript(value: number, max: number): number {
  return Math.max(0, Math.min(max, value))
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

// ---------------------------------------------------------------------------
// 3D 透视工具（visual_tool_perspective.cpp，fork arch1t3cht feature 分支）
// ---------------------------------------------------------------------------

/** visual_tool_perspective.h VisualToolPerspectiveSetting 位掩码 */
const PERSP_OUTER = 1
const PERSP_LOCK_OUTER = 2
const PERSP_GRID = 4
// 照抄 vtp.h：PERSP_LAST 是 SetSubTool 里 ToggleTool 循环的上界（web 端按钮声明式渲染，无循环）
// oxlint-disable-next-line no-unused-vars
const PERSP_LAST = 8
const PERSP_ORGMODE_CENTER = 0
const PERSP_ORGMODE_NOFAX = 16
const PERSP_ORGMODE_KEEP = 32
const PERSP_ORGMODE = 48

/** visual_tool_perspective.cpp default_screen_z（web 不建模 layout res，比值恒为 1） */
const PERSP_SCREEN_Z = 312.5

/** 子工具条位开关（SetToolbar 顺序：plane / lock_outer / grid，orgmode 按钮另写） */
const PERSP_SUBTOOLS: { id: string; bit: number }[] = [
  { id: 'video/tool/perspective/plane', bit: PERSP_OUTER },
  { id: 'video/tool/perspective/lock_outer', bit: PERSP_LOCK_OUTER },
  { id: 'video/tool/perspective/grid', bit: PERSP_GRID },
]

/** \org 模式 → 图标所对应的命令（orgmode 按钮图标随模式变化，点击一律 cycle） */
const PERSP_ORG_COMMANDS: Record<number, string> = {
  [PERSP_ORGMODE_CENTER]: 'video/tool/perspective/orgmode/center',
  [PERSP_ORGMODE_NOFAX]: 'video/tool/perspective/orgmode/nofax',
  [PERSP_ORGMODE_KEEP]: 'video/tool/perspective/orgmode/keep',
}

/** 特征组（VisualToolPerspectiveFeatureType） */
const FEATURE_INNER = 0
const FEATURE_OUTER = 1
const FEATURE_CENTER = 2
const FEATURE_ORG = 3

interface V3 {
  x: number
  y: number
  z: number
}

const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z })
const addV3 = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z)
const subV3 = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z)
const mulV3 = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s)
const crossV3 = (a: V3, b: V3): V3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
const lenV3 = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
/** vector3d.cpp RotateX */
const rotateX3 = (a: V3, angle: number): V3 =>
  v3(
    a.x,
    a.y * Math.cos(angle) - a.z * Math.sin(angle),
    a.y * Math.sin(angle) + a.z * Math.cos(angle),
  )
/** vector3d.cpp RotateY */
const rotateY3 = (a: V3, angle: number): V3 =>
  v3(
    a.x * Math.cos(angle) - a.z * Math.sin(angle),
    a.y,
    a.x * Math.sin(angle) + a.z * Math.cos(angle),
  )
/** vector3d.cpp RotateZ */
const rotateZ3 = (a: V3, angle: number): V3 =>
  v3(
    a.x * Math.cos(angle) - a.y * Math.sin(angle),
    a.x * Math.sin(angle) + a.y * Math.cos(angle),
    a.z,
  )

const addV = (a: Vec2, b: Vec2): Vec2 => vec(a.x + b.x, a.y + b.y)
const subV = (a: Vec2, b: Vec2): Vec2 => vec(a.x - b.x, a.y - b.y)
const mulV = (a: Vec2, s: number): Vec2 => vec(a.x * s, a.y * s)
const divV = (a: Vec2, b: Vec2): Vec2 => vec(a.x / b.x, a.y / b.y)
const dotV = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const lenV = (a: Vec2): number => Math.hypot(a.x, a.y)
const sqLenV = (a: Vec2): number => a.x * a.x + a.y * a.y
/** vector2d.cpp Unit：零向量回退 (0,0) */
const unitV = (a: Vec2): Vec2 => {
  const len = lenV(a)
  return len === 0 ? vec(0, 0) : vec(a.x / len, a.y / len)
}
/** vector2d.cpp SingleAxis */
const singleAxisV = (a: Vec2): Vec2 => (Math.abs(a.x) < Math.abs(a.y) ? vec(0, a.y) : vec(a.x, 0))

/** visual_tool_perspective.cpp Solve2x2（含主元交换的 LU 分解） */
function solve2x2(
  a11: number,
  a12: number,
  a21: number,
  a22: number,
  b1: number,
  b2: number,
): [number, number] {
  if (Math.abs(a11) < Math.abs(a21)) {
    const tb = b1
    b1 = b2
    b2 = tb
    const t1 = a11
    a11 = a21
    a21 = t1
    const t2 = a12
    a12 = a22
    a22 = t2
  }
  a21 = a21 / a11
  a22 = a22 - a21 * a12
  const z1 = b1
  const z2 = b2 - a21 * z1
  const x2 = z2 / a22
  const x1 = (z1 - a12 * x2) / a11
  return [x1, x2]
}

/** QuadMidpoint：对角线交点 */
function quadMidpoint(quad: Vec2[]): Vec2 {
  const diag1 = subV(quad[2], quad[0])
  const diag2 = subV(quad[1], quad[3])
  const b = subV(quad[3], quad[0])
  const [la1] = solve2x2(diag1.x, diag2.x, diag1.y, diag2.y, b.x, b.y)
  return addV(quad[0], mulV(diag1, la1))
}

interface QuadRel {
  x1: number
  y1: number
  x2: number
  x3: number
  x4: number
  y2: number
  y3: number
  y4: number
}

/** UnwrapQuadRel：以 quad[0] 为原点展开其余三角 */
function unwrapQuadRel(quad: Vec2[]): QuadRel {
  const x1 = quad[0].x
  const y1 = quad[0].y
  return {
    x1,
    y1,
    x2: quad[1].x - x1,
    x3: quad[2].x - x1,
    x4: quad[3].x - x1,
    y2: quad[1].y - y1,
    y3: quad[2].y - y1,
    y4: quad[3].y - y1,
  }
}

/** XYToUV（Mathematica 导出的四次有理式，逐字移植） */
function xyToUv(quad: Vec2[], xy: Vec2): Vec2 {
  const { x1, y1, x2, x3, x4, y2, y3, y4 } = unwrapQuadRel(quad)
  const x = xy.x - x1
  const y = xy.y - y1
  const u = -(
    ((x3 * y2 - x2 * y3) *
      (x4 * y - x * y4) *
      (x4 * (-y2 + y3) + x3 * (y2 - y4) + x2 * (-y3 + y4))) /
    (x3 * x3 * (x4 * y2 * y2 * (-y + y4) + y4 * (x * y2 * (y2 - y4) + x2 * (y - y2) * y4)) +
      x3 *
        (x4 * x4 * y2 * y2 * (y - y3) +
          2 * x4 * (x2 * y * y3 * (y2 - y4) + x * y2 * (-y2 + y3) * y4) +
          x2 * y4 * (x2 * (-y + y3) * y4 + 2 * x * y2 * (-y3 + y4))) +
      y3 *
        (x * x4 * x4 * y2 * (y2 - y3) +
          x2 * x4 * x4 * (y2 * y3 + y * (-2 * y2 + y3)) -
          x2 * x2 * (x4 * y * (y3 - 2 * y4) + x4 * y3 * y4 + x * y4 * (-y3 + y4))))
  )
  const v =
    ((x2 * y - x * y2) *
      (x4 * y3 - x3 * y4) *
      (x4 * (y2 - y3) + x2 * (y3 - y4) + x3 * (-y2 + y4))) /
    (x3 *
      (x4 * x4 * y2 * y2 * (-y + y3) +
        x2 * y4 * (2 * x * y2 * (y3 - y4) + x2 * (y - y3) * y4) -
        2 * x4 * (x2 * y * y3 * (y2 - y4) + x * y2 * (-y2 + y3) * y4)) +
      x3 * x3 * (x4 * y2 * y2 * (y - y4) + y4 * (x2 * (-y + y2) * y4 + x * y2 * (-y2 + y4))) +
      y3 *
        (x * x4 * x4 * y2 * (-y2 + y3) +
          x2 * x4 * x4 * (2 * y * y2 - y * y3 - y2 * y3) +
          x2 * x2 * (x4 * y * (y3 - 2 * y4) + x4 * y3 * y4 + x * y4 * (-y3 + y4))))
  return vec(u, v)
}

/** UVToXY（Mathematica 导出的有理式，逐字移植） */
function uvToXy(quad: Vec2[], uv: Vec2): Vec2 {
  const { x1, y1, x2, x3, x4, y2, y3, y4 } = unwrapQuadRel(quad)
  const u = uv.x
  const v = uv.y
  const d =
    x4 * ((-1 + u + v) * y2 + y3 - v * y3) +
    x3 * (y2 - u * y2 + (-1 + v) * y4) +
    x2 * ((-1 + u) * y3 - (-1 + u + v) * y4)
  const x = (v * x4 * (x3 * y2 - x2 * y3) + u * x2 * (x4 * y3 - x3 * y4)) / d
  const y = (v * y4 * (x3 * y2 - x2 * y3) + u * y2 * (x4 * y3 - x3 * y4)) / d
  return vec(x + x1, y + y1)
}

/** MakeRect：左上/右上/右下/左下 */
function makeRect(a: Vec2, b: Vec2): Vec2[] {
  return [vec(a.x, a.y), vec(b.x, a.y), vec(b.x, b.y), vec(a.x, b.y)]
}

interface PerspFeature {
  key: string
  group: number
  index: number
  type: 'big-triangle' | 'small-circle'
  pos: Vec2
  /** StartDrag 记录的位置（HasMoved 判定） */
  start: Vec2
  layer: number
}

interface PerspState {
  /** 当前活动行 id（环境平面映射的键） */
  cueId: string
  settings: number
  angleX: number
  angleY: number
  angleZ: number
  fax: number
  fay: number
  align: number
  bbox: [Vec2, Vec2]
  fsc: Vec2
  org: Vec2
  pos: Vec2
  bord: Vec2
  shad: Vec2
  /** 内框四角在外框 UV 空间中的矩形（默认 0.25..0.75） */
  c1: Vec2
  c2: Vec2
  centerf: PerspFeature
  orgf: PerspFeature | null
  inner: PerspFeature[]
  outer: PerspFeature[]
  oldInner: Vec2[]
  oldOuter: Vec2[]
  features: PerspFeature[]
  active: string | null
  selected: Set<string>
  dragStart: Vec2 | null
  dragging: boolean
  selChanged: boolean
  ctrlDown: boolean
  shiftDown: boolean
  altDown: boolean
}

/** 环境平面（AmbientPlane）持久化。 */
// 偏差说明：源码把外框四角以 "_aegi_perspective_ambient_plane" 键写入 ASS 的
// Extradata（随文件保存），并写到全部选中行。web 侧没有 Extradata 通道，且不应把
// 工具的内部状态写进字幕文本，故改用会话内的 Map<cueId, 四角脚本坐标>。后果：
// 环境平面在刷新页面/重新打开文件后不保留（源码可保留），且只跟随活动行而非全部选中行。
const perspAmbientPlane = new Map<string, Vec2[]>()

/** 特征柄命中半径选项（visual_feature.cpp Tool/Visual/Shape Handle Size） */
function perspHandleSize(): number {
  return getOptionInt('Tool/Visual/Shape Handle Size')
}

/** visual_feature.cpp VisualDraggableFeature::IsMouseOver */
function perspIsMouseOver(feature: PerspFeature, mouse: Vec2): boolean {
  const dx = mouse.x - feature.pos.x
  const dy = mouse.y - feature.pos.y
  if (feature.type === 'big-triangle') {
    if (dy < -10 || dy > 6) return false
    const offset = dy - 6
    return 16 * dx + 9 * offset < 0 && 16 * dx - 9 * offset > 0
  }
  return dx * dx + dy * dy < 3 * perspHandleSize()
}

const perspHasOuterBits = (settings: number) => (settings & PERSP_OUTER) !== 0
const perspOuterLockedBits = (settings: number) =>
  perspHasOuterBits(settings) && (settings & PERSP_LOCK_OUTER) !== 0
const perspOrgModeBits = (settings: number) => settings & PERSP_ORGMODE
const perspHasOrgfBits = (settings: number) => perspOrgModeBits(settings) === PERSP_ORGMODE_KEEP

const perspHasOuter = (state: PerspState) => perspHasOuterBits(state.settings)
const perspOuterLocked = (state: PerspState) => perspOuterLockedBits(state.settings)

/** 透视工具所需的坐标换算环境（显示像素 = 相对视频舞台的 CSS 像素） */
interface PerspEnv {
  playResX: number
  playResY: number
  /** 源码 screenZ()：不建模 layout res，恒为 default_screen_z */
  screenZ: number
  rect: { left: number; top: number; width: number; height: number }
  fromScript: (p: Vec2) => Vec2
  toScript: (p: Vec2) => Vec2
  clientToStage: (clientX: number, clientY: number) => Vec2
}

/** 逐行文本量取（visual_tool.cpp GetLineBaseExtents 的文本分支）。 */
// 偏差说明：源码走 Automation4::CalculateTextExtents（真实字体度量），web 用
// canvas measureText 近似；量取失败时回退源码的兜底估算 fontsize*len / fontsize。
let perspMeasureCtx: CanvasRenderingContext2D | null | undefined
function perspTextExtents(
  lines: string[],
  fontSize: number,
  fontName: string,
  bold: boolean,
  italic: boolean,
): { width: number; height: number } {
  if (perspMeasureCtx === undefined) {
    perspMeasureCtx = document.createElement('canvas').getContext('2d')
  }
  let width = 0
  let height = 0
  for (const line of lines) {
    let lineWidth: number
    let lineHeight: number
    const ctx = perspMeasureCtx
    if (ctx) {
      ctx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px "${fontName}", sans-serif`
      const metrics = ctx.measureText(line)
      lineWidth =
        Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight) ||
        metrics.width
      lineHeight = fontSize * 1.2
    } else {
      lineWidth = fontSize * line.length
      lineHeight = fontSize
    }
    width = Math.max(width, lineWidth)
    height += lineHeight
  }
  return { width, height }
}

/** visual_tool.cpp GetLineBaseExtents */
function perspBaseExtents(cue: SubtitleCue, style: SubtitleStyle | undefined): [Vec2, Vec2] {
  const blocks = parseBlocks(cue.text)
  const ptag = findTagInBlocks(blocks, '\\p')
  const level = ptag ? Math.trunc(Number.parseFloat(ptag.params) || 0) : 0
  if (ptag && level !== 0) {
    // Spline::SetScale(level) → scale = 1 << (level-1)，DecodeFromAss 按 FromScript 除以 scale
    const drawing = blocks
      .filter((block) => block.type === 'drawing')
      .map((block) => blockText(block))
      .join('')
    const spline = new Spline()
    spline.decode(drawing)
    if (!spline.curves.length) return [vec(0, 0), vec(0, 0)]
    const scale = 2 ** (level - 1)
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bot = -Infinity
    for (const curve of spline.curves) {
      // spline_curve.cpp AnchorPoints
      const anchors =
        curve.type === 'point'
          ? [curve.p1]
          : curve.type === 'line'
            ? [curve.p1, curve.p2]
            : [curve.p1, curve.p2, curve.p3, curve.p4]
      for (const point of anchors) {
        left = Math.min(left, point.x / scale)
        top = Math.min(top, point.y / scale)
        right = Math.max(right, point.x / scale)
        bot = Math.max(bot, point.y / scale)
      }
    }
    return [vec(left, top), vec(right, bot)]
  }
  let fontSize = style?.fontSize ?? 0
  let fontName = style?.fontName ?? 'Arial'
  const fsTag = findTagInBlocks(blocks, '\\fs')
  if (fsTag) {
    const value = Number.parseFloat(fsTag.params)
    if (Number.isFinite(value)) fontSize = value
  }
  const fnTag = findTagInBlocks(blocks, '\\fn')
  if (fnTag) fontName = fnTag.params
  const extents = perspTextExtents(
    plainText(cue.text),
    fontSize,
    fontName,
    style?.bold ?? false,
    style?.italic ?? false,
  )
  return [vec(0, 0), vec(extents.width, extents.height)]
}

/** MakeFeatures：重建特征列表（center / [org] / inner[4] / [outer[4]]） */
function perspMakeFeatures(state: PerspState): void {
  state.inner = []
  state.outer = []
  state.orgf = null
  state.features = []
  state.active = null
  state.selected = new Set()
  state.centerf = {
    key: 'center',
    group: FEATURE_CENTER,
    index: 0,
    type: 'big-triangle',
    pos: vec(0, 0),
    start: vec(0, 0),
    layer: 0,
  }
  state.features.push(state.centerf)
  if (perspHasOrgfBits(state.settings)) {
    state.orgf = {
      key: 'org',
      group: FEATURE_ORG,
      index: 0,
      type: 'big-triangle',
      pos: vec(0, 0),
      start: vec(0, 0),
      layer: 0,
    }
    state.features.push(state.orgf)
  }
  for (let i = 0; i < 4; i++) {
    const inner: PerspFeature = {
      key: `inner:${i}`,
      group: FEATURE_INNER,
      index: i,
      type: 'small-circle',
      pos: vec(0, 0),
      start: vec(0, 0),
      layer: 0,
    }
    state.inner.push(inner)
    state.features.push(inner)
    if (perspHasOuterBits(state.settings)) {
      const outer: PerspFeature = {
        key: `outer:${i}`,
        group: FEATURE_OUTER,
        index: i,
        type: 'small-circle',
        pos: vec(0, 0),
        start: vec(0, 0),
        layer: 0,
      }
      state.outer.push(outer)
      state.features.push(outer)
    }
  }
}

/** UpdateInner：内框四角 = 外框 UV 空间中 c1..c2 矩形的像 */
function perspUpdateInner(state: PerspState): void {
  const uv = makeRect(state.c1, state.c2)
  const quad = state.outer.map((feature) => feature.pos)
  for (let i = 0; i < 4; i++) state.inner[i].pos = uvToXy(quad, uv[i])
}

/** UpdateOuter：外框四角 = 内框 UV 空间中 [-c1/(c2-c1), (1-c1)/(c2-c1)] 矩形的像 */
function perspUpdateOuter(state: PerspState): void {
  if (!perspHasOuter(state)) return
  const uv = makeRect(
    vec(-state.c1.x / (state.c2.x - state.c1.x), -state.c1.y / (state.c2.y - state.c1.y)),
    vec((1 - state.c1.x) / (state.c2.x - state.c1.x), (1 - state.c1.y) / (state.c2.y - state.c1.y)),
  )
  const quad = state.inner.map((feature) => feature.pos)
  for (let i = 0; i < 4; i++) state.outer[i].pos = uvToXy(quad, uv[i])
}

/** SetFeaturePositions：center 取内框对角线交点，org 取 \org 的显示位置 */
function perspSetFeaturePositions(state: PerspState, env: PerspEnv): void {
  state.centerf.pos = quadMidpoint(state.inner.map((feature) => feature.pos))
  if (state.orgf) state.orgf.pos = env.fromScript(state.org)
}

/** SaveFeaturePositions：记录本次拖拽前的四角位置（old_inner/old_outer） */
function perspSaveFeaturePositions(state: PerspState): void {
  state.oldInner = state.inner.map((feature) => ({ ...feature.pos }))
  if (perspHasOuter(state)) state.oldOuter = state.outer.map((feature) => ({ ...feature.pos }))
}

/** SaveOuterToLines：把外框四角存进环境平面映射（见 perspAmbientPlane 偏差说明） */
function perspSaveOuterToLines(state: PerspState, env: PerspEnv): void {
  if (!perspHasOuter(state)) return
  const corners = state.outer.map((feature) => env.toScript(feature.pos))
  if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return
  perspAmbientPlane.set(state.cueId, corners)
}

/** TextToPersp：从活动行的标签值推导内框四角，并恢复环境平面 */
function perspTextToPersp(state: PerspState, env: PerspEnv): void {
  const textWidth = Math.max(state.bbox[1].x - state.bbox[0].x, 1)
  const textHeight = Math.max(state.bbox[1].y - state.bbox[0].y, 1)
  let shiftX = 0
  let shiftY = 0
  switch ((state.align - 1) % 3) {
    case 1:
      shiftX = -textWidth / 2
      break
    case 2:
      shiftX = -textWidth
      break
    default:
      break
  }
  switch (Math.trunc((state.align - 1) / 3)) {
    case 0:
      shiftY = -textHeight
      break
    case 1:
      shiftY = -textHeight / 2
      break
    default:
      break
  }
  const screenZ = env.screenZ
  const textRect = makeRect(state.bbox[0], state.bbox[1])
  for (let i = 0; i < 4; i++) {
    const point = textRect[i]
    // 源码两行都用剪切前的 p.X()，故先算两份再赋值
    const px = point.x + point.y * state.fax
    const py = point.x * state.fay + point.y
    let x = ((px + shiftX) * state.fsc.x) / 100
    let y = ((py + shiftY) * state.fsc.y) / 100
    x += state.pos.x - state.org.x
    y += state.pos.y - state.org.y
    let q = v3(x, y, 0)
    q = rotateZ3(q, (-state.angleZ * Math.PI) / 180)
    q = rotateX3(q, (-state.angleX * Math.PI) / 180)
    q = rotateY3(q, (state.angleY * Math.PI) / 180)
    q = mulV3(q, screenZ / (q.z + screenZ))
    state.inner[i].pos = env.fromScript(vec(q.x + state.org.x, q.y + state.org.y))
  }

  const savedOuter = perspAmbientPlane.get(state.cueId)
  if (savedOuter) {
    const d1 = xyToUv(savedOuter, env.toScript(state.inner[0].pos))
    const d2 = xyToUv(savedOuter, env.toScript(state.inner[2].pos))
    if (
      Number.isFinite(d1.x) &&
      Number.isFinite(d1.y) &&
      Number.isFinite(d2.x) &&
      Number.isFinite(d2.y)
    ) {
      state.c1 = d1
      state.c2 = d2
    }
  }
  perspUpdateOuter(state)
}

/** WrapSetOverride：值与默认值（或其相反数）相同则删除标签，否则写入 %.Nf */
function perspWrapSetOverride(
  text: string,
  tag: string,
  value: number,
  precision: number,
  defaultValue = 0,
): string {
  const formatted = value.toFixed(precision)
  const defaultFormatted = defaultValue.toFixed(precision)
  if (
    formatted === defaultFormatted ||
    (defaultValue === 0 && (-value).toFixed(precision) === defaultFormatted)
  ) {
    return removeOverride(text, tag)
  }
  return setOverride(text, tag, formatted)
}

/** InnerToText：把内框四角反解为变换标签值；数值无效时返回 null（源码 return false） */
function perspInnerToText(state: PerspState, env: PerspEnv): PerspValues | null {
  const q0 = env.toScript(state.inner[0].pos)
  const q1 = env.toScript(state.inner[1].pos)
  const q2 = env.toScript(state.inner[2].pos)
  const q3 = env.toScript(state.inner[3].pos)

  // 找一个投影为该四边形的平行四边形（与平移无关）
  const diag = subV(q2, q0)
  const side2 = subV(q1, q2)
  const side3 = subV(q3, q2)
  const [z1, z3] = solve2x2(side2.x, side3.x, side2.y, side3.y, -diag.x, -diag.y)
  const midpoint = quadMidpoint([q0, q1, q2, q3])

  let org = state.org
  const mode = perspOrgModeBits(state.settings)
  if (mode === PERSP_ORGMODE_CENTER) {
    org = midpoint
  } else if (mode === PERSP_ORGMODE_NOFAX) {
    const edge1 = subV(q1, q0)
    const edge3 = subV(q3, q0)
    // 平移 t（把 q0 移到 t）后四边形能反投影为矩形，t 落在该二次曲线上
    const a = (1 - z1) * (1 - z3)
    const b = subV(addV(mulV(edge1, z1), mulV(edge3, z3)), mulV(addV(edge1, edge3), z1 * z3))
    const c = z1 * z3 * dotV(edge1, edge3) + (z1 - 1) * (z3 - 1) * env.screenZ * env.screenZ
    // 默认把 \org 放在四边形中心
    let t = subV(q0, midpoint)
    if (a === 0) {
      // 退化：二次曲线退化成直线（b=0 时无解，保留原 t）
      if (sqLenV(b) !== 0) t = addV(t, mulV(b, (c - dotV(t, b)) / sqLenV(b)))
    } else {
      // 二次曲线是圆：配方求圆心与半径
      const circleCenter = divV(b, vec(2 * a, 2 * a))
      const sqRadius = (sqLenV(b) / (4 * a) - c) / a
      if (sqRadius <= 0) {
        org = circleCenter
      } else {
        const radius = Math.sqrt(sqRadius)
        const center2t = subV(t, circleCenter)
        t =
          lenV(center2t) === 0
            ? addV(circleCenter, vec(radius, 0))
            : addV(circleCenter, mulV(unitV(center2t), radius))
      }
    }
    org = subV(q0, t)
  }

  // 以 org 为原点归一化
  const nq0 = subV(q0, org)
  const nq1 = subV(q1, org)
  const nq2 = subV(q2, org)
  const nq3 = subV(q3, org)

  const screenZ = env.screenZ
  let r = [
    v3(nq0.x, nq0.y, screenZ),
    mulV3(v3(nq1.x, nq1.y, screenZ), z1),
    mulV3(v3(nq2.x, nq2.y, screenZ), z1 + z3 - 1),
    mulV3(v3(nq3.x, nq3.y, screenZ), z3),
  ]

  // 投影到原点的点的 z 坐标
  const side0 = subV3(r[1], r[0])
  const side1 = subV3(r[3], r[0])
  const [orgla0, orgla1] = solve2x2(side0.x, side1.x, side0.y, side1.y, -r[0].x, -r[0].y)
  const orgz = addV3(addV3(r[0], mulV3(side0, orgla0)), mulV3(side1, orgla1)).z

  // 归一化使原点 z = screenZ，并把屏幕平面移到 z = 0
  r = r.map((value) => subV3(mulV3(value, screenZ / orgz), v3(0, 0, screenZ)))

  // 求旋转
  let n = crossV3(subV3(r[1], r[0]), subV3(r[3], r[0]))
  let roty = Math.atan(n.x / n.z)
  if (n.z < 0) roty += Math.PI
  n = rotateY3(n, roty)
  const rotx = Math.atan(n.y / n.z)

  r = r.map((value) => rotateX3(rotateY3(value, roty), rotx))

  let ab = subV3(r[1], r[0])
  let rotz = Math.atan(ab.y / ab.x)
  if (ab.x < 0) rotz += Math.PI

  r = r.map((value) => rotateZ3(value, -rotz))

  // 此时是平面内的水平平行四边形，可读出剪切与尺寸
  ab = subV3(r[1], r[0])
  const ad = subV3(r[3], r[0])
  const rawfax = ad.x / ad.y
  const quadWidth = lenV3(ab)
  const quadHeight = Math.abs(ad.y)
  const scaleX = quadWidth / Math.max(state.bbox[1].x - state.bbox[0].x, 1)
  const scaleY = quadHeight / Math.max(state.bbox[1].y - state.bbox[0].y, 1)
  const shiftV = state.align <= 3 ? 1 : state.align <= 6 ? 0.5 : 0
  const shiftH = state.align % 3 === 0 ? 1 : state.align % 3 === 2 ? 0.5 : 0
  const pos = addV(
    subV(addV(org, vec(r[0].x, r[0].y)), vec(state.bbox[0].x * scaleX, state.bbox[0].y * scaleY)),
    vec(quadWidth * shiftH, quadHeight * shiftV),
  )
  const angleX = (rotx * 180) / Math.PI
  const angleY = (-roty * 180) / Math.PI
  const angleZ = (-rotz * 180) / Math.PI
  const oldFsc = state.fsc
  const fsc = vec(100 * scaleX, 100 * scaleY)
  const fax = (rawfax * scaleY) / scaleX
  const bord = vec((state.bord.x * fsc.x) / oldFsc.x, (state.bord.y * fsc.y) / oldFsc.y)
  const shad = vec((state.shad.x * fsc.x) / oldFsc.x, (state.shad.y * fsc.y) / oldFsc.y)

  const allValues = [
    fax,
    fsc.x,
    fsc.y,
    angleZ,
    angleX,
    angleY,
    bord.x,
    bord.y,
    shad.x,
    shad.y,
    org.x,
    org.y,
    pos.x,
    pos.y,
  ]
  if (allValues.some((value) => !Number.isFinite(value))) return null

  state.org = org
  state.pos = pos
  state.fsc = fsc
  state.fax = fax
  state.fay = 0
  state.angleX = angleX
  state.angleY = angleY
  state.angleZ = angleZ
  state.bord = bord
  state.shad = shad

  // 写回全部选中行（源码遍历 selectionController->GetSelectedSet）
  return { bord, shad, fsc, angleX, angleY, angleZ, fax, org, pos }
}

/** InnerToText 产出的标签值（供调用方写回各行文本） */
interface PerspValues {
  bord: Vec2
  shad: Vec2
  fsc: Vec2
  angleX: number
  angleY: number
  angleZ: number
  fax: number
  org: Vec2
  pos: Vec2
}

/** 把 InnerToText 的结果写进一行文本（标签顺序与源码一致） */
function perspApplyValues(
  text: string,
  values: PerspValues,
  style: SubtitleStyle | undefined,
): string {
  let result = text
  result = perspWrapSetOverride(result, 'fax', values.fax, 6)
  result = perspWrapSetOverride(result, 'fay', 0, 6)
  result = perspWrapSetOverride(result, 'fscx', values.fsc.x, 2, style?.scaleX ?? 0)
  result = perspWrapSetOverride(result, 'fscy', values.fsc.y, 2, style?.scaleY ?? 0)
  result = perspWrapSetOverride(result, 'frz', values.angleZ, 4, style?.angle ?? 0)
  result = perspWrapSetOverride(result, 'frx', values.angleX, 4)
  result = perspWrapSetOverride(result, 'fry', values.angleY, 4)
  result = removeOverride(result, 'bord')
  result = removeOverride(result, 'shad')
  result = perspWrapSetOverride(result, 'xbord', values.bord.x, 2, style?.outline ?? 0)
  result = perspWrapSetOverride(result, 'ybord', values.bord.y, 2, style?.outline ?? 0)
  result = perspWrapSetOverride(result, 'xshad', values.shad.x, 2, style?.shadow ?? 0)
  result = perspWrapSetOverride(result, 'yshad', values.shad.y, 2, style?.shadow ?? 0)
  result = setOverride(
    result,
    'org',
    `(${floatToString(values.org.x)},${floatToString(values.org.y)})`,
  )
  result = setOverride(
    result,
    'pos',
    `(${floatToString(values.pos.x)},${floatToString(values.pos.y)})`,
  )
  return result
}

/** 视觉工具拖拽：VisualToolPerspectiveDraggableFeature::UpdateDrag + VisualDraggableFeature::UpdateDrag */
function perspFeatureUpdateDrag(
  state: PerspState,
  feature: PerspFeature,
  delta: Vec2,
  singleAxis: boolean,
): void {
  let d = delta
  let axisLock = singleAxis
  // Ctrl+Alt 的单轴约束在后面的手动吸附里处理
  if (state.ctrlDown && state.altDown) axisLock = false
  if (
    axisLock &&
    !(feature.group === FEATURE_CENTER && !(perspHasOuter(state) && !perspOuterLocked(state)))
  ) {
    // 吸附到四边形透视平面内的两条轴
    const quad = state.oldInner
    const posUV = xyToUv(quad, feature.pos)
    const axis1 = unitV(subV(uvToXy(quad, addV(posUV, vec(1, 0))), feature.pos))
    const axis2 = unitV(subV(uvToXy(quad, addV(posUV, vec(0, 1))), feature.pos))
    const snap1 = mulV(axis1, dotV(d, axis1))
    const snap2 = mulV(axis2, dotV(d, axis2))
    d = sqLenV(subV(snap1, d)) <= sqLenV(subV(snap2, d)) ? snap1 : snap2
    axisLock = false
  }
  if (axisLock) d = singleAxisV(d)
  feature.pos = addV(feature.start, d)
}

/** 视觉工具 UpdateDrag：由四角位置反解变换系数；返回值供调用方写回各行文本 */
function perspUpdateDrag(
  state: PerspState,
  env: PerspEnv,
  feature: PerspFeature,
): PerspValues | null {
  if (feature === state.centerf) {
    const oldCenter = quadMidpoint(state.inner.map((item) => item.pos))
    if (perspHasOuter(state) && !perspOuterLocked(state)) {
      const quad = state.outer.map((item) => item.pos)
      const oldUv = xyToUv(quad, oldCenter)
      const newUv = xyToUv(quad, state.centerf.pos)
      const diff = subV(newUv, oldUv)
      state.c1 = addV(state.c1, diff)
      state.c2 = addV(state.c2, diff)
      perspUpdateInner(state)
    } else {
      const diff = subV(state.centerf.pos, oldCenter)
      for (let i = 0; i < 4; i++) state.inner[i].pos = addV(state.inner[i].pos, diff)
      perspUpdateOuter(state)
    }
  } else if (perspHasOrgfBits(state.settings) && feature === state.orgf) {
    state.org = env.toScript(feature.pos)
  }

  let changedQuad: PerspFeature[] = []
  let changedQuadOld: Vec2[] = []
  if (feature.group === FEATURE_INNER) {
    changedQuad = state.inner
    changedQuadOld = state.oldInner
  } else if (perspHasOuter(state) && feature.group === FEATURE_OUTER) {
    changedQuad = state.outer
    changedQuadOld = state.oldOuter
  }

  if (changedQuad.length && !state.ctrlDown) {
    // 非凸四边形时对角线交点不在内部，此时放弃本次拖拽
    const diag1 = subV(changedQuad[2].pos, changedQuad[0].pos)
    const diag2 = subV(changedQuad[1].pos, changedQuad[3].pos)
    const b = subV(changedQuad[3].pos, changedQuad[0].pos)
    const [la1, la2] = solve2x2(diag1.x, diag2.x, diag1.y, diag2.y, b.x, b.y)
    if (la1 < 0 || la1 > 1 || -la2 < 0 || -la2 > 1) {
      perspTextToPersp(state, env)
      return null
    }
  }

  const i = feature.index

  if (state.ctrlDown && changedQuad.length) {
    // Ctrl：整体变形（保持平面），可叠加 Alt 吸附
    if (state.altDown) {
      if (state.shiftDown) {
        // Alt+Shift：吸附到最近的原角点
        let bestSnap = -1
        let minDist = -1
        for (let j = 0; j < 4; j++) {
          const dist = sqLenV(subV(feature.pos, changedQuadOld[j]))
          if (bestSnap === -1 || dist < minDist) {
            bestSnap = j
            minDist = dist
          }
        }
        feature.pos = { ...changedQuadOld[bestSnap] }
      } else {
        // Alt：吸附到两条对角方向之一
        const center = quadMidpoint(changedQuadOld)
        const diff = subV(feature.pos, center)
        const snapDirection1 = unitV(subV(changedQuadOld[0], center))
        const snapDirection2 = unitV(subV(changedQuadOld[1], center))
        const snap1 = mulV(snapDirection1, dotV(diff, snapDirection1))
        const snap2 = mulV(snapDirection2, dotV(diff, snapDirection2))
        feature.pos = addV(
          center,
          sqLenV(subV(snap1, diff)) <= sqLenV(subV(snap2, diff)) ? snap1 : snap2,
        )
      }
    }

    const relUv = subV(xyToUv(changedQuadOld, feature.pos), vec(0.5, 0.5))
    for (let j = 0; j < 4; j++) {
      const flipi = vec(i === 1 || i === 2 ? -1 : 1, i >= 2 ? -1 : 1)
      const flipj = vec(j === 1 || j === 2 ? -1 : 1, j >= 2 ? -1 : 1)
      changedQuad[j].pos = uvToXy(
        changedQuadOld,
        addV(vec(0.5, 0.5), vec(relUv.x * flipi.x * flipj.x, relUv.y * flipi.y * flipj.y)),
      )
    }

    if (perspHasOuter(state)) {
      if (feature.group === FEATURE_INNER) {
        if (!perspOuterLocked(state)) {
          const quad = state.outer.map((item) => item.pos)
          state.c1 = xyToUv(quad, state.inner[0].pos)
          state.c2 = xyToUv(quad, state.inner[2].pos)
          perspUpdateInner(state)
        } else {
          perspUpdateOuter(state)
        }
      } else if (feature.group === FEATURE_OUTER) {
        if (perspOuterLocked(state)) {
          const quad = state.outer.map((item) => item.pos)
          state.c1 = xyToUv(quad, state.inner[0].pos)
          state.c2 = xyToUv(quad, state.inner[2].pos)
          perspUpdateOuter(state)
        } else {
          perspUpdateInner(state)
        }
      }
    }
  } else if (changedQuad.length && perspHasOuter(state)) {
    // 常规：拖动单个角点
    if (feature.group === FEATURE_INNER) {
      if (!perspOuterLocked(state)) {
        const newUv = xyToUv(
          state.outer.map((item) => item.pos),
          feature.pos,
        )
        state.c1 = vec(i === 0 || i === 3 ? newUv.x : state.c1.x, i < 2 ? newUv.y : state.c1.y)
        state.c2 = vec(i === 0 || i === 3 ? state.c2.x : newUv.x, i < 2 ? state.c2.y : newUv.y)
        perspUpdateInner(state)
      } else {
        perspUpdateOuter(state)
      }
    } else if (feature.group === FEATURE_OUTER) {
      if (perspOuterLocked(state)) {
        let d1 = vec(
          -state.c1.x / (state.c2.x - state.c1.x),
          -state.c1.y / (state.c2.y - state.c1.y),
        )
        let d2 = vec(
          (1 - state.c1.x) / (state.c2.x - state.c1.x),
          (1 - state.c1.y) / (state.c2.y - state.c1.y),
        )
        const newUv = xyToUv(
          state.inner.map((item) => item.pos),
          feature.pos,
        )
        d1 = vec(i === 0 || i === 3 ? newUv.x : d1.x, i < 2 ? newUv.y : d1.y)
        d2 = vec(i === 0 || i === 3 ? d2.x : newUv.x, i < 2 ? d2.y : newUv.y)
        state.c1 = vec(-d1.x / (d2.x - d1.x), -d1.y / (d2.y - d1.y))
        state.c2 = vec((1 - d1.x) / (d2.x - d1.x), (1 - d1.y) / (d2.y - d1.y))
        perspUpdateOuter(state)
      } else {
        perspUpdateInner(state)
      }
    }
  }

  // 尾部（源码 UpdateDrag）：InnerToText 失败则 TextToPersp 重建，随后同步特征位置
  const values = perspInnerToText(state, env)
  if (!values) perspTextToPersp(state, env)
  perspSetFeaturePositions(state, env)
  return values
}

/** 读出 OPT 中的子工具设置（构造函数：settings 由 4 个选项拼出） */
function perspReadSettings(): number {
  let settings = 0
  if (getOptionBool('Tool/Visual/Perspective/Outer')) settings |= PERSP_OUTER
  if (getOptionBool('Tool/Visual/Perspective/Outer Locked')) settings |= PERSP_LOCK_OUTER
  if (getOptionBool('Tool/Visual/Perspective/Grid')) settings |= PERSP_GRID
  settings |= getOptionInt('Tool/Visual/Perspective/Org Mode')
  return settings
}

/** DoRefresh：TextToPersp + SetFeaturePositions + SaveFeaturePositions */
function perspDoRefresh(state: PerspState, env: PerspEnv): void {
  perspTextToPersp(state, env)
  perspSetFeaturePositions(state, env)
  perspSaveFeaturePositions(state)
}

/** 构造函数 + MakeFeatures + DoRefresh：由活动行建立完整工具状态 */
function perspMakeState(
  settings: number,
  cue: SubtitleCue,
  style: SubtitleStyle | undefined,
  env: PerspEnv,
): PerspState {
  const overrides = readVisualOverrides(cue.text, style)
  const pos =
    overrides.pos ??
    (overrides.move
      ? vec(overrides.move.x1, overrides.move.y1)
      : defaultLinePosition(cue, style, { x: env.playResX, y: env.playResY }))
  const state: PerspState = {
    cueId: cue.id,
    settings,
    angleX: overrides.rotationX,
    angleY: overrides.rotationY,
    angleZ: overrides.rotationZ,
    fax: overrides.fax,
    fay: overrides.fay,
    align: overrides.alignment,
    bbox: perspBaseExtents(cue, style),
    fsc: vec(overrides.scaleX, overrides.scaleY),
    org: overrides.org ?? pos,
    pos,
    bord: vec(overrides.outlineX, overrides.outlineY),
    shad: vec(overrides.shadowX, overrides.shadowY),
    c1: vec(0.25, 0.25),
    c2: vec(0.75, 0.75),
    centerf: {
      key: 'center',
      group: FEATURE_CENTER,
      index: 0,
      type: 'big-triangle',
      pos: vec(0, 0),
      start: vec(0, 0),
      layer: 0,
    },
    orgf: null,
    inner: [],
    outer: [],
    oldInner: [],
    oldOuter: [],
    features: [],
    active: null,
    selected: new Set(),
    dragStart: null,
    dragging: false,
    selChanged: false,
    ctrlDown: false,
    shiftDown: false,
    altDown: false,
  }
  perspMakeFeatures(state)
  // DoRefresh：TextToPersp + SetFeaturePositions + SaveFeaturePositions
  perspDoRefresh(state, env)
  return state
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

/**
 * 元素时间轴（原始 PTS，秒）→ 应用时间轴（归一化帧率表，ms）。
 * 口径必须与帧表构造一致：帧表 = 各帧原始 PTS 经 ptsToMs 截断后再减首帧的截断值；
 * 若改成"先相减再截断"（ptsToMs(t - offset)），浮点尾差会结果相差 1ms，
 * 使 currentFrame 落到前一帧（VideoPosition/网格帧列错位）。
 */
function elementToAppMs(seconds: number, firstFrameOffsetSec: number): number {
  return Math.max(0, ptsToMs(seconds) - ptsToMs(firstFrameOffsetSec))
}

/**
 * 应用时间轴（帧表时间 + 首帧偏移）→ 元素时间轴时的前移量（ms）。
 * 帧表把原始 PTS 截断到整数 ms，故"帧表时间 + 偏移"可能仍比目标帧的原始 PTS 早
 * 不到 1ms，而 <video> seek 取"PTS ≤ 目标的最后一帧"就会退回前一帧；前移 1ms 补偿
 * （帧间隔远大于 1ms，不会越入下一帧）。偏移本身取自 rVFC 的浮点秒，不参与截断。
 */
const SEEK_TRUNCATION_LEAD_MS = 1

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
  // 拖动寻址合流：pointermove（可达数百 Hz）只记录最新目标，按帧节拍至多寻址一次；
  // pointerup 冲刷最终目标（video_slider.cpp 每次事件 JumpToFrame，provider 侧再按
  // 版本号丢弃被取代的请求——web 侧在入口先合流，省去中间位置的解码呈现）
  const pendingSeekRef = useRef<{ x: number; snap: boolean } | null>(null)
  const seekRafRef = useRef(0)
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
    scheduleSeek(event.clientX - bounds.left, event.shiftKey)
  }

  /** 执行被保留的最新目标（帧节拍或 pointerup 冲刷时调用） */
  const runPendingSeek = () => {
    const pending = pendingSeekRef.current
    pendingSeekRef.current = null
    if (pending) seekFromX(pending.x, pending.snap)
  }

  const scheduleSeek = (x: number, snap: boolean) => {
    pendingSeekRef.current = { x, snap }
    if (seekRafRef.current) return
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = 0
      runPendingSeek()
    })
  }

  const flushSeek = () => {
    if (seekRafRef.current) {
      cancelAnimationFrame(seekRafRef.current)
      seekRafRef.current = 0
    }
    runPendingSeek()
  }

  useEffect(
    () => () => {
      if (seekRafRef.current) cancelAnimationFrame(seekRafRef.current)
    },
    [],
  )

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
        flushSeek()
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false
        flushSeek()
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
  onPatchCues,
  selectedCues,
  isCommandEnabled,
  isCommandChecked,
  windowZoom,
  devicePixelRatio: displayDpr,
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
  playbackGain,
  style: panelStyle,
}: PreviewPaneProps) {
  const optionsVersion = useOptionsVersion() // Preferences 提交后重渲染（滑条关键帧/滚轮行为/工具配色）
  const stageRef = useRef<HTMLDivElement>(null)
  const zoomStageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 十字工具坐标读数专用层（不挂 difference 混合，见 .cross-coordinate-overlay）
  const crossTextRef = useRef<HTMLCanvasElement>(null)
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
  // 当前接线的视频元素（wcActive 切换/媒体更换会替换元素，替换时拆掉旧节点路由）
  const gainVideoRef = useRef<HTMLMediaElement | null>(null)
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
  // 视觉工具实时反馈：鼠标相对 overlay 画布的像素位置、Shift 状态、是否悬停在舞台上
  const mouseStagePxRef = useRef<{ x: number; y: number } | null>(null)
  const mouseShiftRef = useRef(false)
  const mouseOnStageRef = useRef(false)
  // 视觉工具拖拽进行中 → 文档同步走 flushNow 即时渲染（源码每次鼠标事件 Commit+Render）
  const visualDragRef = useRef(false)
  // 拖拽刚结束的时间戳：pointerup 冲刷的最终提交在 effect 运行时拖拽态已复位，
  // 用短时间窗让最终提交仍走 flushNow（否则落入 250ms 防抖，最终帧有延迟感）
  const dragEndedAtRef = useRef(0)
  // 拖拽提交走「串行最新目标」通道（对齐 async_video_provider.cpp 的 RequestFrame：
  // 在途不排队、新目标覆盖待发槽位、pointerup 冲刷最终值）。源码 UpdateDrag 每次鼠标
  // 事件 Commit（C++ 信号廉价），web 的 apply → 全文档序列化 + React 重渲染远慢于
  // 高频 pointermove（可达数百 Hz）——逐个排队会让松开鼠标后画面按队列把中间位置
  // 慢慢回放；中间目标一律丢弃，仅最终位置生效（源码异步渲染同样丢弃中间结果）
  const dragCommitRef = useRef<SerialLatest<[() => unknown]> | null>(null)
  if (!dragCommitRef.current)
    dragCommitRef.current = serialLatest((commit: () => unknown) => commit())
  const scheduleDragCommit = (commit: () => unknown) => dragCommitRef.current!(commit)
  const flushDragCommit = () => dragCommitRef.current!.flush()
  // <video> 元素同一时刻只保留一个在途 seek：拖动/跟随产生的目标远快于解复用 + 解码，
  // 逐个下发会让浏览器按顺序把中间位置解码呈现（"眼睁睁看着图像从 a 慢慢走到 b"）。
  // 在途期间新目标只覆盖待发槽位（中间位置丢弃），seeked 后补发最新目标——与源码
  // async_video_provider 的版本号弃帧（新请求覆盖 frame_number，旧请求被丢弃）同语义
  const videoSeekRef = useRef<number | null>(null)
  // 原生 <video> 时间轴首帧偏移（秒，保留浮点精度）：容器首帧 PTS ≠ 0（mkv 时延 /
  // MP4 start_time）时，元素时间轴（currentTime / rVFC mediaTime）以原始 PTS 为基准，
  // 而应用时间轴（帧率表）已归一化到首帧 = 0（FFMS2 normalize_timecodes 语义）。
  // 两轴必须经该偏移换算，否则跳转到时间 a 时元素呈现"包含 a 的原始时间"对应帧——
  // 帧对齐跳转（行首/滑块/逐帧）恒定比 Aegisub 少 1 帧，偏移更大时少 2 帧及以上。
  // 取值 = 元素呈现的首帧 mediaTime（元素自身时间轴上的首帧时间，见 onLoadedMetadata
  // 校准）；不可截断成整数 ms，否则 seek（帧表时间 + 偏移）会差不到 1ms 落到前一帧；
  // rVFC 不可用时保持 0（退化为不换算，与修复前一致）
  const firstFrameOffsetSecRef = useRef(0)
  const pumpVideoSeek = useCallback(() => {
    const video = videoRef.current
    const target = videoSeekRef.current
    if (!video || target === null || video.seeking) return
    videoSeekRef.current = null
    const offset = firstFrameOffsetSecRef.current
    const offsetMs = ptsToMs(offset)
    const max =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration * 1000 - offsetMs
        : target
    const clamped = Math.max(0, Math.min(max, target))
    video.currentTime = (clamped + SEEK_TRUNCATION_LEAD_MS) / 1000 + offset
  }, [])
  const requestVideoSeek = useCallback(
    (timeMs: number) => {
      videoSeekRef.current = timeMs
      pumpVideoSeek()
    },
    [pumpVideoSeek],
  )
  // ---- 矢量裁剪工具状态 ----
  const [vclip, setVclip] = useState<VClipState | null>(null)
  const vclipRef = useRef<VClipState | null>(null)
  // ---- 3D 透视工具状态（visual_tool_perspective.cpp）----
  const [persp, setPersp] = useState<PerspState | null>(null)
  const perspRef = useRef<PerspState | null>(null)
  // 真实帧率探测：每个媒体只探测一次（requestVideoFrameCallback 采样 mediaTime 间隔中位数）
  const fpsProbedRef = useRef<string | null>(null)
  const onDetectedFpsRef = useRef(onDetectedFps)
  // ref 与渲染值同步（事件处理器读取）
  useEffect(() => {
    currentRef.current = currentTimeMs
    vclipRef.current = vclip
    perspRef.current = persp
    onDetectedFpsRef.current = onDetectedFps
    onKeyframesChangeRef.current = onKeyframesChange
  })

  // 视频播放出声与音频栏共用同一音量增益（源码唯一 audio player；<video>.volume
  // 上限 1.0，经 WebAudio 增益才能覆盖 Aegisub 三次方曲线 >1 的放大区）
  useEffect(() => {
    const el = videoRef.current
    if (el !== gainVideoRef.current) {
      if (gainVideoRef.current) detachElementGain(gainVideoRef.current)
      gainVideoRef.current = el
    }
    if (el) setElementGain(el, playbackGain)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- videoRef 挂载随 media.url/wcActive 条件渲染
  }, [media?.url, wcActive, playbackGain])

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
    /** 行原点（\org 或 \pos）的屏幕像素位置：rotate/z 绕原点旋转（InitializeHold 用 org->pos） */
    originPx: { x: number; y: number }
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

  /** video_display.cpp：viewport = video × windowZoom、content ×= contentZoomValue 都是物理
   *  设备像素，客户区逻辑像素 = 物理 / scale_factor。Web 的 CSS 尺寸 = 物理 / devicePixelRatio：
   *  zoom 100% 时 1 视频像素 : 1 物理屏幕像素（点对点），不在此取整以免破坏设备像素对齐 */
  const mediaCssSize = (intrinsic: number) =>
    Math.max(1, (intrinsic * windowZoom * contentZoom) / (displayDpr > 0 ? displayDpr : 1))

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

  /** 透视工具的坐标换算环境：显示像素 = 相对视频舞台的 CSS 像素 */
  const perspEnv = (): PerspEnv | null => {
    const stage = stageRef.current
    if (!stage) return null
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    const rect = mediaRect()
    const bounds = stage.getBoundingClientRect()
    return {
      playResX,
      playResY,
      screenZ: PERSP_SCREEN_Z,
      rect,
      fromScript: (p) =>
        vec(rect.left + (p.x / playResX) * rect.width, rect.top + (p.y / playResY) * rect.height),
      toScript: (p) =>
        vec(
          ((p.x - rect.left) / rect.width) * playResX,
          ((p.y - rect.top) / rect.height) * playResY,
        ),
      clientToStage: (clientX, clientY) => vec(clientX - bounds.left, clientY - bounds.top),
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
    // 同步清空十字工具读数层（cross 分支命中时再重画）
    const crossTextCanvas = crossTextRef.current
    if (crossTextCanvas) {
      const crossCtx = crossTextCanvas.getContext('2d')
      if (crossCtx) {
        crossCtx.setTransform(1, 0, 0, 1, 0, 0)
        crossCtx.clearRect(0, 0, crossTextCanvas.width, crossTextCanvas.height)
      }
    }
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

    // ---- 十字工具（visual_tool_cross.cpp Draw：全屏十字线 + 鼠标处脚本坐标读数）----
    if (hasVideo && visualTool === 'video/tool/cross' && mouseOnStageRef.current) {
      const rect = mediaRect()
      const mousePx = mouseStagePxRef.current
      const mouseScript = mousePosRef.current
      if (rect.width > 0 && rect.height > 0 && mousePx && mouseScript) {
        const playResY = Number(document.scriptInfo.PlayResY) || 1080
        const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
        // 源码 gl.SetInvert + SetLineColour(*wxWHITE, 1.0, 1)：恒定 1px 反色线。
        // canvas 元素挂 mix-blend-mode: difference（见 JSX 内联样式），画白色即为
        // 对底层视频的反色；0.5 对齐像素保证 1px 不虚
        const cx = Math.round(mousePx.x) + 0.5
        const cy = Math.round(mousePx.y) + 0.5
        context.strokeStyle = 'white'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(rect.left, cy)
        context.lineTo(rect.left + rect.width, cy)
        context.moveTo(cx, rect.top)
        context.lineTo(cx, rect.top + rect.height)
        context.stroke()
        // Shift = 显示对称点坐标（源码 2*video_pos+video_size-mouse_pos 的脚本系等价）
        const sx = mouseShiftRef.current ? playResX - mouseScript.x : mouseScript.x
        const sy = mouseShiftRef.current ? playResY - mouseScript.y : mouseScript.y
        // video_size.X() > script_res.X() 时 3 位小数，否则整数（VisualToolCross::Text）
        const text =
          rect.width > playResX
            ? `${floatToString(sx, 3)},${floatToString(sy, 3)}`
            : `${Math.trunc(sx)},${Math.trunc(sy)}`
        // 坐标读数画在独立层（不反色）：源码 gl_text Print 先在 ±1 偏移画 1px 黑边、
        // 再画白字（gl_text.cpp），保证任意视频底色上可读；层不带 difference 混合
        const textLayer = crossTextRef.current
        if (!textLayer) return
        if (textLayer.width !== pixelWidth || textLayer.height !== pixelHeight) {
          textLayer.width = pixelWidth
          textLayer.height = pixelHeight
        }
        const textCtx = textLayer.getContext('2d')
        if (!textCtx) return
        textCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
        textCtx.font = 'bold 12px Verdana, sans-serif'
        const metrics = textCtx.measureText(text)
        const textWidth = metrics.width
        const textHeight = Math.ceil(
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
        )
        // 源码 Print 原点是文字左上角（glyph 顶点 y..y+h），偏移 4/3px 使坐标读数
        // 落在靠视频中心一侧的象限内、不与十字线重叠
        textCtx.textBaseline = 'top'
        let dx = Math.round(mousePx.x)
        let dy = Math.round(mousePx.y)
        if (dx > rect.left + rect.width / 2) dx -= textWidth + 4
        else dx += 4
        if (dy < rect.top + rect.height / 2) dy += 3
        else dy -= textHeight + 3
        textCtx.fillStyle = 'black'
        textCtx.fillText(text, dx - 1, dy)
        textCtx.fillText(text, dx + 1, dy)
        textCtx.fillText(text, dx, dy - 1)
        textCtx.fillText(text, dx, dy + 1)
        textCtx.fillStyle = 'white'
        textCtx.fillText(text, dx, dy)
      }
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
      const rad = Math.PI / 180
      // 行位置（脚本坐标）：\pos / \move 起点；无则按样式对齐与 Margin 推导（GetLinePosition）
      const linePos = (cue: SubtitleCue): { x: number; y: number } => {
        const o = readVisualOverrides(cue.text)
        if (o.pos) return o.pos
        if (o.move) return { x: o.move.x1, y: o.move.y1 }
        const style = document.styles.find((item) => item.name === cue.style)
        return defaultLinePosition(cue, style, { x: playResX, y: playResY })
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
        // DrawAllFeatures 填充：选中行的起点方框 = Lines Primary 0.3（alt_fill），其余 = Highlight Primary 0.3
        const selectedIds = new Set(selectedCues.map((cue) => cue.id))
        for (const cue of active) {
          const o = readVisualOverrides(cue.text)
          const selected = selectedIds.has(cue.id)
          const start = startOf(o)
          if (!start && !o.org) continue
          const sx = mapX(start?.x ?? 0)
          const sy = mapY(start?.y ?? 0)
          if (start) drawFeature(sx, sy, 'square', selected ? colors.selFill : colors.baseFill)
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
            drawFeature(ex, ey, 'circle', colors.baseFill)
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
            drawFeature(ox, oy, 'triangle', colors.baseFill)
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
        // gl.SetOrigin(org)+SetRotation(rx,ry,0)+SetScale(fsc)：精确 GL 变换链（3D 旋转+透视）
        const map = makeGlMapper({
          origin: [ox, oy],
          rotX: o.rotationX,
          rotY: o.rotationY,
          fsc: { x: o.scaleX, y: o.scaleY },
        })
        // 圆环（r±4）
        drawGlRing(context, map, radius + 4, radius - 4, 0, 360, colors.baseFill, colors.secondary)
        // 6 组弧形刻度（r+12..r+30，每 60° ±15°）
        for (let i = 0; i < 6; i++)
          drawGlRing(
            context,
            map,
            radius + 30,
            radius + 12,
            i * 60 - 15,
            i * 60 + 15,
            colors.baseFill,
            colors.secondary,
          )
        // 当前角度基线（穿过原点）与角度柄圆；Vector2D::FromAngle=(cos(-θ),sin(-θ))，Y 分量取负
        const angle = o.rotationZ * rad
        const ax = Math.cos(angle)
        const ay = -Math.sin(angle)
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        context.beginPath()
        const [blx1, bly1] = map(-ax * radius, -ay * radius)
        const [blx2, bly2] = map(ax * radius, ay * radius)
        context.moveTo(blx1, bly1)
        context.lineTo(blx2, bly2)
        context.stroke()
        if (oRadius > 0) {
          // 原点→文字位置（按当前角度反推）的连线 + 文字下方横线
          // rotated_pos = FromAngle(angle − (pos−org).Angle())·oRadius，Y 分量取负
          const posAngle = Math.atan2(py - oy, px - ox)
          const rpx = Math.cos(angle - posAngle) * oRadius
          const rpy = -Math.sin(angle - posAngle) * oRadius
          context.beginPath()
          const [o0x, o0y] = map(0, 0)
          const [rpX, rpY] = map(rpx, rpy)
          context.moveTo(o0x, o0y)
          context.lineTo(rpX, rpY)
          context.stroke()
          const [u1x, u1y] = map(rpx - ax * 20, rpy - ay * 20)
          const [u2x, u2y] = map(rpx + ax * 20, rpy + ay * 20)
          context.beginPath()
          context.moveTo(u1x, u1y)
          context.lineTo(u2x, u2y)
          context.stroke()
        }
        drawGlCircle(context, map, ax * radius, ay * radius, 4, colors.baseFill, colors.secondary)
        drawGlCircle(context, map, -ax * radius, -ay * radius, 4, colors.baseFill, colors.secondary)
        drawFeature(ox, oy, 'triangle', colors.baseFill)
        // 鼠标位置连线（visual_tool_rotatez.cpp：mouse_pos 存在且距原点平方 >100，
        // 即画布坐标下 10px；离开视频区不画——源码 mouse_pos 出界清空）
        const mouse = mouseOnStageRef.current ? mousePosRef.current : null
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
        // visual_tool_rotatexy.cpp Draw：SetOrigin(org) → SetScale(100·video/script)
        // → SetRotation(rx,ry,rz) → SetScale(fsc) → SetShear 的完整 GL 变换链
        const o = readVisualOverrides(activeCue.text)
        const pos = linePos(activeCue)
        const org = o.org ?? pos
        const gridRadius = 15 // 每侧线数
        const spacing = 20 // 线距（脚本像素）
        const halfLen = spacing * (gridRadius + 1) // 320
        const fade = 0.9 / gridRadius
        const map = makeGlMapper({
          origin: [mapX(org.x), mapY(org.y)],
          baseScale: { x: rect.width / playResX, y: rect.height / playResY },
          rotX: o.rotationX,
          rotY: o.rotationY,
          rotZ: o.rotationZ,
          fsc: { x: o.scaleX, y: o.scaleY },
          shear: { x: o.fax, y: o.fay },
        })
        // 网格：每行两段（中心→±端），顶点 alpha (i+3)%4>1?0:1−|i/8−15|·fade → 中心到端点渐隐
        context.lineWidth = 2
        const halves: [number, number, number, number][] = []
        for (let k = -gridRadius; k <= gridRadius; k++) {
          const p = k * spacing
          halves.push(
            [p, 0, p, -halfLen],
            [p, 0, p, halfLen],
            [0, p, -halfLen, p],
            [0, p, halfLen, p],
          )
        }
        for (const [x1, y1, x2, y2] of halves) {
          const a = 1 - Math.abs(y2 === 0 ? x2 / spacing : y1 / spacing) * fade
          const g = context.createLinearGradient(...map(x1, y1), ...map(x2, y2))
          g.addColorStop(0, withAlpha(colors.secondary, a))
          g.addColorStop(1, withAlpha(colors.secondary, 0))
          context.strokeStyle = g
          context.beginPath()
          context.moveTo(...map(x1, y1))
          context.lineTo(...map(x2, y2))
          context.stroke()
        }
        // 三轴向量 (50,0,0)/(0,50,0)/(0,0,50) + 箭头（源码 GL_LINES 顶点对原样连线）
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        const drawSeg = (a: [number, number, number], b: [number, number, number]) => {
          context.beginPath()
          context.moveTo(...map(...a))
          context.lineTo(...map(...b))
          context.stroke()
        }
        // 源码 6 顶点按 GL_LINES 配对：tip→c1、c2→c3、c4→c1（开放菱形）
        const arrow = (tip: [number, number, number], c: [number, number, number][]) => {
          drawSeg(tip, c[0])
          drawSeg(c[1], c[2])
          drawSeg(c[3], c[0])
        }
        drawSeg([0, 0, 0], [50, 0, 0])
        drawSeg([0, 0, 0], [0, 50, 0])
        drawSeg([0, 0, 0], [0, 0, 50])
        arrow(
          [60, 0, 0],
          [
            [50, -3, -3],
            [50, 3, -3],
            [50, 3, 3],
            [50, -3, 3],
          ],
        )
        arrow(
          [0, 60, 0],
          [
            [-3, 50, -3],
            [3, 50, -3],
            [3, 50, 3],
            [-3, 50, 3],
          ],
        )
        arrow(
          [0, 0, 60],
          [
            [-3, -3, 50],
            [3, -3, 50],
            [3, 3, 50],
            [-3, 3, 50],
          ],
        )
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
      } else if (visualTool === 'video/tool/perspective' && persp && activeCue) {
        // visual_tool_perspective.cpp Draw：内外框四边线（有外框时外框虚线 6px + 内框实线）
        // → DrawAllFeatures → 可选网格（Copied and modified from visual_tool_rotatexy.cpp）
        const state = persp
        context.strokeStyle = colors.lines
        context.lineWidth = 2
        const seg = (a: Vec2, b: Vec2) => {
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        for (let i = 0; i < 4; i++) {
          const next = (i + 1) % 4
          if (perspHasOuter(state)) {
            context.setLineDash([6, 6])
            seg(state.outer[i].pos, state.outer[next].pos)
            context.setLineDash([])
            seg(state.inner[i].pos, state.inner[next].pos)
          } else {
            context.setLineDash([6, 6])
            seg(state.inner[i].pos, state.inner[next].pos)
            context.setLineDash([])
          }
        }
        // DrawAllFeatures：active = Highlight Secondary 0.3、selected = Lines Primary 0.3、
        // 其余 = Highlight Primary 0.3
        for (const feature of state.features) {
          const fill =
            feature.key === state.active
              ? colors.activeFill
              : state.selected.has(feature.key)
                ? colors.selFill
                : colors.baseFill
          drawFeature(
            feature.pos.x,
            feature.pos.y,
            feature.type === 'big-triangle' ? 'triangle' : 'small-circle',
            fill,
          )
        }
        if ((state.settings & PERSP_GRID) !== 0) {
          const gridRadius = 15 // 每侧线数
          const spacing = 20 // 线距
          const halfLen = spacing * (gridRadius + 1)
          const fade = 0.9 / gridRadius
          // glScale = bbox 高 / spacing / 4（SetScale(100*glScale) 内部 /100）
          const glScale = Math.max(state.bbox[1].y - state.bbox[0].y, 1) / spacing / 4
          const map = makeGlMapper({
            origin: [mapX(state.org.x), mapY(state.org.y)],
            preScale: { x: glScale, y: glScale },
            baseScale: { x: rect.width / playResX, y: rect.height / playResY },
            rotX: state.angleX,
            rotY: state.angleY,
            rotZ: state.angleZ,
            fsc: { x: state.fsc.x, y: state.fsc.y },
            shear: { x: state.fax, y: state.fay },
          })
          // 网格中心随内框对角线交点偏移：offset = (ToScriptCoords(center) − org) / glScale
          const center = quadMidpoint(state.inner.map((feature) => feature.pos))
          const offset = {
            x: (((center.x - rect.left) / rect.width) * playResX - state.org.x) / glScale,
            y: (((center.y - rect.top) / rect.height) * playResY - state.org.y) / glScale,
          }
          // 每条线两段（轴心 → 两端），轴心亮 alpha = 1 − |k|·fade、远端透明
          const gridSeg = (x1: number, y1: number, x2: number, y2: number, alpha: number) => {
            const from = map(x1 + offset.x, y1 + offset.y)
            const to = map(x2 + offset.x, y2 + offset.y)
            const gradient = context.createLinearGradient(from[0], from[1], to[0], to[1])
            gradient.addColorStop(0, withAlpha(colors.secondary, alpha))
            gradient.addColorStop(1, withAlpha(colors.secondary, 0))
            context.strokeStyle = gradient
            context.beginPath()
            context.moveTo(from[0], from[1])
            context.lineTo(to[0], to[1])
            context.stroke()
          }
          context.lineWidth = 2
          for (let k = -gridRadius; k <= gridRadius; k++) {
            const p = k * spacing
            const alpha = 1 - Math.abs(k) * fade
            gridSeg(p, 0, p, -halfLen, alpha)
            gridSeg(p, 0, p, halfLen, alpha)
            gridSeg(0, p, -halfLen, p, alpha)
            gridSeg(0, p, halfLen, p, alpha)
          }
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
      context.setLineDash([])

      // convert/insert 模式：高亮最近曲线（visual_tool_vector_clip.cpp Draw highlighted line；
      // 源码画曲线两端点直线，闭合边不算）
      if (
        vclip.mouse &&
        (vclip.mode === 'video/tool/vclip/convert' || vclip.mode === 'video/tool/vclip/insert') &&
        !vclip.active &&
        vclip.spline.curves.length > 1
      ) {
        const closest = vclip.spline.closestParametric(vclip.mouse, true)
        const curve = closest ? vclip.spline.curves[closest.index] : null
        if (curve) {
          const end = curve.type === 'bicubic' ? curve.p4 : curve.p2
          context.strokeStyle = vcl.selected
          context.lineWidth = 2
          context.beginPath()
          context.moveTo(mx(curve.p1), my(curve.p1))
          context.lineTo(mx(end), my(end))
          context.stroke()
        }
      }

      // insert 模式：插入点预览圆（visual_tool_vector_clip.cpp Draw preview of insert point）
      if (vclip.mode === 'video/tool/vclip/insert' && vclip.mouse) {
        const closest = vclip.spline.closestParametric(vclip.mouse, true)
        if (closest) {
          context.strokeStyle = vcl.lines
          context.lineWidth = 2
          context.beginPath()
          context.arc(mx(closest.point), my(closest.point), 4, 0, Math.PI * 2)
          context.stroke()
        }
      }

      // line/bicubic 模式：鼠标到形状起点/末端的闭合提示虚线（源码 Draw：悬停即画，非按住时也画）
      if (
        vclip.mouse &&
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
    persp,
    hasVideo,
    assRenderer,
    assError,
    // 平移/内容缩放改变媒体显示框位置与尺寸，overlay 绘制与 hitbox 需跟随重算
    // （窗口缩放会改变 stage 尺寸，由下面的 ResizeObserver 触发重绘，无需入表）
    pan,
    contentZoom,
  ])

  // 十字工具随鼠标移动实时重绘（visual_tool_cross.cpp 每次鼠标事件后 Render），
  // rAF 合流避免高频 pointermove 全量重绘
  const overlayRenderRafRef = useRef(0)
  const renderOverlayRef = useRef<() => void>(() => {})
  const scheduleOverlayRender = useCallback(() => {
    if (overlayRenderRafRef.current) return
    overlayRenderRafRef.current = requestAnimationFrame(() => {
      overlayRenderRafRef.current = 0
      renderOverlayRef.current()
    })
  }, [])

  // 统一异步弃帧优化：renderOverlay 变化（拖拽高频提交/时间更新等）只调度，
  // rAF 合流后一帧至多重绘一次 overlay；由 ref 间接调用保证取到最新闭包
  useEffect(() => {
    renderOverlayRef.current = renderOverlay
    scheduleOverlayRender()
    const observer = new ResizeObserver(scheduleOverlayRender)
    if (stageRef.current) observer.observe(stageRef.current)
    return () => {
      observer.disconnect()
      if (overlayRenderRafRef.current) {
        cancelAnimationFrame(overlayRenderRafRef.current)
        overlayRenderRafRef.current = 0
      }
    }
  }, [renderOverlay, scheduleOverlayRender])

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

  // 文档变化 → 替换 libass track：视觉工具拖拽中走 flushNow 即时渲染（源码每次
  // 鼠标事件 Commit+Render），其余（编辑器高频修改）走防抖
  useEffect(() => {
    const content = exportAss(document)
    if (visualDragRef.current) assRenderer?.flushNow(content)
    else assRenderer?.setTrack(content)
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
      // ptsToMs：暂停时 currentTime 即所 seek 的帧 PTS，浮点直接乘 1000 会差 1ms
      // 导致 currentFrame 落到前一帧（VideoPosition/网格帧列错位）；减去首帧偏移换回
      // 归一化应用时间轴（元素时间轴以原始 PTS 为基准）
      onTimeChange(elementToAppMs(video.currentTime, firstFrameOffsetSecRef.current))
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [onTimeChange, playing])

  useEffect(() => {
    const video = videoRef.current
    // 音频栏拖动等外部寻址：走单在途 seek 通道（新目标覆盖待发，中间位置丢弃）。
    // 比较在归一化时间轴上进行（元素位置 - 首帧偏移）
    if (
      video &&
      !playing &&
      Math.abs(elementToAppMs(video.currentTime, firstFrameOffsetSecRef.current) - currentTimeMs) >
        40
    )
      requestVideoSeek(currentTimeMs)
  }, [currentTimeMs, playing, requestVideoSeek])

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
    // 通道/媒体更换：丢弃上一元素的待发 seek 目标与首帧偏移校准
    videoSeekRef.current = null
    firstFrameOffsetSecRef.current = 0
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
            // 打开即呈首帧的 <video preload="metadata"> 语义仅适用于刚加载媒体
            // （currentTimeMs=0）；手动切换/回退时外部时间线已在中途，新源从首帧
            // 起步必须对齐当前播放头，否则画面停在首帧（如黑场开头）造成"切换后
            // 无法渲染"的观感
            const target = currentRef.current
            if (Math.abs(opened.source.currentTime - target) > 60) opened.source.seek(target)
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
    // 原生 <video>：经单在途通道下发（拖动期间中间目标被丢弃，仅最新目标生效）
    if (videoRef.current) requestVideoSeek(clamped)
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
      // 元素时间轴 - 首帧偏移 = 归一化应用时间轴
      if (video) return elementToAppMs(video.currentTime, firstFrameOffsetSecRef.current)
      return 0
    }
    const duration = () => {
      if (wcSource) return durationMs
      if (video && Number.isFinite(video.duration))
        return Math.max(0, video.duration * 1000 - ptsToMs(firstFrameOffsetSecRef.current))
      return 0
    }
    const actionSeek = (timeMs: number) => {
      const clamped = Math.max(0, Math.min(duration() || timeMs, timeMs))
      if (wcSource) wcSource.seek(clamped)
      else if (video) requestVideoSeek(clamped)
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
  }, [durationMs, media, mediaAction, onTimeChange, requestVideoSeek])

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
  // 工具是否已激活：activeCue 刷新（每次提交后）只重解析样条，子工具模式保留
  // （源码 mode 仅在 SetToolbar 激活时按 features.empty() 设置），否则第二次点击
  // 就落入 drag 模式，线/双三次工具永远画不出第二条边
  const vclipActiveRef = useRef(false)
  useEffect(() => {
    if (visualTool !== 'video/tool/vector_clip') {
      // 工具切换时销毁矢量裁剪会话
      vclipActiveRef.current = false
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
    const fresh: VClipState = {
      inverse,
      spline,
      mode: spline.curves.length ? 'video/tool/vclip/drag' : 'video/tool/vclip/line',
      selected: new Set(),
      active: null,
      dragStart: null,
      dragOriginal: new Map(),
      boxStart: null,
      mouse: null,
    }
    if (!vclipActiveRef.current) {
      vclipActiveRef.current = true
      setVclip(fresh)
      return
    }
    // DoRefresh：活动行/提交后重解析样条并清空选择与拖拽态，保留当前子工具模式与
    // 鼠标位置（源码 mouse_pos 是 OnMouseEvent 级状态，不随 DoRefresh 清除）
    setVclip((current) =>
      current ? { ...fresh, mode: current.mode, mouse: current.mouse } : fresh,
    )
  }, [visualTool, activeCue])

  // ---- 3D 透视：激活/刷新（visual_tool_perspective.cpp 构造 + DoRefresh）----
  // 工具是否已激活：activeCue 刷新（每次提交后）只重跑 DoRefresh 重建四角，子工具模式保留
  // （源码 settings 仅在构造时按 OPT 读取）。activeCue.text 不入依赖：拖拽提交会抖动。
  const perspActiveRef = useRef(false)
  useEffect(() => {
    if (visualTool !== 'video/tool/perspective') {
      // 工具切换时销毁透视会话
      perspActiveRef.current = false
      // oxlint-disable-next-line react/set-state-in-effect
      setPersp(null)
      return
    }
    const env = perspEnv()
    if (!env || !activeCue) {
      // oxlint-disable-next-line react/set-state-in-effect
      setPersp(null)
      return
    }
    const style = document.styles.find((item) => item.name === activeCue.style)
    const settings =
      perspActiveRef.current && perspRef.current ? perspRef.current.settings : perspReadSettings()
    perspActiveRef.current = true
    // oxlint-disable-next-line react/set-state-in-effect
    setPersp(perspMakeState(settings, activeCue, style, env))
    // 透视状态里的四角/网格坐标是"屏幕像素"（TextToPersp 由 mediaRect 换算），媒体框一变就必须
    // 重跑 DoRefresh 才能刷新：窗口缩放（windowZoom）与平移/内容缩放一样会改变媒体框几何，
    // 缺这一项时缩放视频后辅助线仍画在旧坐标上（留在原地不刷新）
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- activeCue.text 不入依赖（拖拽抖动）
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- activeCue.text 不入依赖（拖拽抖动）
  }, [visualTool, activeCue?.id, pan, contentZoom, windowZoom])

  /** SetSubTool：位掩码写回 4 个 OPT（源码 optOuter/optOuterLocked/optGrid/optOrgMode） */
  const perspStoreSettings = (settings: number) => {
    setOption('Tool/Visual/Perspective/Outer', perspHasOuterBits(settings))
    setOption('Tool/Visual/Perspective/Outer Locked', perspOuterLockedBits(settings))
    setOption('Tool/Visual/Perspective/Grid', (settings & PERSP_GRID) !== 0)
    setOption('Tool/Visual/Perspective/Org Mode', perspOrgModeBits(settings))
  }

  const perspSetSubTool = (settings: number) => {
    perspStoreSettings(settings)
    const state = perspRef.current
    const env = perspEnv()
    if (!state || !env) return
    state.settings = settings
    // SetSubTool：MakeFeatures（内部 DoRefresh）+ Render
    perspMakeFeatures(state)
    perspDoRefresh(state, env)
    setPersp({ ...state })
  }

  /** 子工具按钮：orgmode 一律触发 cycle（center→nofax→keep），其余异或切换 */
  const perspSubToolClick = (id: string) => {
    const settings = perspRef.current?.settings ?? perspReadSettings()
    if (id === 'video/tool/perspective/orgmode/center') {
      // video/tool/perspective/orgmode/cycle
      const mode = perspOrgModeBits(settings)
      const nextMode =
        mode === PERSP_ORGMODE_CENTER
          ? PERSP_ORGMODE_NOFAX
          : mode === PERSP_ORGMODE_NOFAX
            ? PERSP_ORGMODE_KEEP
            : PERSP_ORGMODE_CENTER
      perspSetSubTool((settings & ~PERSP_ORGMODE) | nextMode)
      return
    }
    const bit =
      id === 'video/tool/perspective/plane'
        ? PERSP_OUTER
        : id === 'video/tool/perspective/lock_outer'
          ? PERSP_LOCK_OUTER
          : PERSP_GRID
    perspSetSubTool(settings ^ bit)
  }

  // 子工具条渲染值：工具未激活时回退读 OPT（与源码构造时 settings 读取一致）
  const perspSettings = persp?.settings ?? perspReadSettings()
  const perspOrgCommand = PERSP_ORG_COMMANDS[perspSettings & PERSP_ORGMODE]
  // 源码 SetToolShortHelp：StrDisplay(c) + ". Click to cycle.\n" + GetTooltip("Video")
  const perspOrgTitle = `${tPlain(COMMANDS[perspOrgCommand]?.label ?? perspOrgCommand)}. ${tPlain('Click to cycle.')}\n${commandTooltip(perspOrgCommand, 'Video')}`

  /** OnMouseEvent 的未拖拽命中检测：layer 最大者优先，同层取列表中较后者 */
  const perspHitTest = (state: PerspState, mouse: Vec2): PerspFeature | null => {
    let active: PerspFeature | null = null
    let maxLayer = -Infinity
    for (const feature of state.features) {
      if (perspIsMouseOver(feature, mouse) && feature.layer >= maxLayer) {
        active = feature
        maxLayer = feature.layer
      }
    }
    return active
  }

  /** InnerToText 结果写回全部选中行（源码遍历 selectionController->GetSelectedSet） */
  const perspCommitValues = (values: PerspValues, label = 'visual typesetting') => {
    if (!selectedCues.length) return
    onPatchCues(
      selectedCues.map((cue) => ({
        id: cue.id,
        patch: {
          text: perspApplyValues(
            cue.text,
            values,
            document.styles.find((item) => item.name === cue.style),
          ),
        },
      })),
      tPlain(label),
    )
  }

  const perspPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const state = perspRef.current
    const env = perspEnv()
    if (!state || !env) return
    const mouse = env.clientToStage(event.clientX, event.clientY)
    state.ctrlDown = event.ctrlKey
    state.shiftDown = event.shiftKey
    state.altDown = event.altKey
    const active = perspHitTest(state, mouse)
    state.active = active?.key ?? null
    if (active) {
      if (!state.selected.has(active.key)) {
        state.selChanged = true
        if (!event.ctrlKey) state.selected.clear()
        state.selected.add(active.key)
      } else {
        state.selChanged = false
      }
      // StartDrag：记录本次拖拽前的四角位置
      for (const feature of state.features)
        if (state.selected.has(feature.key)) feature.start = { ...feature.pos }
      state.dragStart = mouse
      state.dragging = true
      event.currentTarget.setPointerCapture(event.pointerId)
    } else {
      // 源码：空白处按下清空特征选择；InitializeHold 默认 false → 无 hold
      if (!event.altKey) state.selected.clear()
      state.active = null
    }
    setPersp({ ...state })
  }

  const perspPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const state = perspRef.current
    const env = perspEnv()
    if (!state || !env) return
    const mouse = env.clientToStage(event.clientX, event.clientY)
    state.ctrlDown = event.ctrlKey
    state.shiftDown = event.shiftKey
    state.altDown = event.altKey
    if (!state.dragging) {
      // 未拖拽：仅更新悬停高亮（源码每次鼠标事件重算 active_feature 并 Render）
      const active = perspHitTest(state, mouse)
      const key = active?.key ?? null
      if (key !== state.active) {
        state.active = key
        setPersp({ ...state })
      }
      return
    }
    if (!(event.buttons & 1)) return
    // UpdateDrag：先按位移量移动全部选中特征，再逐个反解变换系数
    const delta = subV(mouse, state.dragStart ?? mouse)
    for (const feature of state.features)
      if (state.selected.has(feature.key))
        perspFeatureUpdateDrag(state, feature, delta, event.shiftKey)
    let values: PerspValues | null = null
    for (const feature of state.features)
      if (state.selected.has(feature.key)) values = perspUpdateDrag(state, env, feature)
    // 与其他视觉工具同一「串行最新目标」通道：pointermove 可达数百 Hz，而一次提交要
    // 走全文档序列化 + apply + flushNow 即时渲染（见 dragCommitRef 注释）——逐个排队会
    // 在途任务堆积、鼠标停住后画面继续回放中间位置；中间目标一律丢弃，仅最新位置生效
    if (values) scheduleDragCommit(() => perspCommitValues(values))
    // 四角/网格随鼠标实时重绘（源码 UpdateDrag 尾部 Render）：只调度 rAF 合流的 overlay
    // 重绘，不在 pointermove 里 setState——renderOverlay 读的就是被就地改写的
    // perspRef.current（同一对象引用），而 setState 会让整棵 PreviewPane 每个鼠标事件
    // 重渲染一次（其余视觉工具 pointermove 只走 scheduleDragCommit，无任何 setState）
    scheduleOverlayRender()
  }

  const perspPointerUp = (): void => {
    const state = perspRef.current
    if (!state) return
    if (state.dragging) {
      state.dragging = false
      const active = state.active
        ? (state.features.find((feature) => feature.key === state.active) ?? null)
        : null
      const moved = active && (active.pos.x !== active.start.x || active.pos.y !== active.start.y)
      // 鼠标未移动：调整选中集（源码 HasMoved 判定）；否则 EndDrag（保存四角与环境平面）
      if (active && !moved) {
        if (!state.selChanged) {
          if (state.ctrlDown) state.selected.delete(active.key)
          else {
            state.selected.clear()
            state.selected.add(active.key)
          }
        }
      } else if (active) {
        perspSaveFeaturePositions(state)
        const env = perspEnv()
        if (env) perspSaveOuterToLines(state, env)
      }
    }
    state.active = null
    state.dragStart = null
    setPersp({ ...state })
  }

  /** OnDoubleClick：把离鼠标最近的（外框未锁定时为外框）角点直接移到鼠标处 */
  const perspDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const state = perspRef.current
    const env = perspEnv()
    if (!state || !env) return
    const mouse = env.clientToStage(event.clientX, event.clientY)
    const quad = perspHasOuter(state) && !perspOuterLocked(state) ? state.outer : state.inner
    let best = 0
    let bestDistance = -1
    for (let i = 0; i < 4; i++) {
      const distance = lenV(subV(quad[i].pos, mouse))
      if (bestDistance === -1 || distance < bestDistance) {
        best = i
        bestDistance = distance
      }
    }
    quad[best].pos = mouse
    const values = perspUpdateDrag(state, env, quad[best])
    if (values) perspCommitValues(values)
    setPersp({ ...state })
  }

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

  const commitVclip = (state: VClipState, label = 'visual typesetting') => {
    if (!activeCue) return
    const scaled =
      state.spline.scale !== 1
        ? scaleSpline(state.spline, 2 ** (state.spline.scale - 1))
        : state.spline
    const drawing = scaled.encode()
    if (!drawing.trim()) return
    // Save()：样条值写入全部选中行；\iclip 行保持 \iclip（源码按各行文本子串判断）
    onPatchCues(
      selectedCues.map((cue) => ({
        id: cue.id,
        patch: {
          text: setVectorClip(
            cue.text,
            /\\iclip/.test(cue.text) ? true : state.inverse,
            `(${drawing})`,
          ),
        },
      })),
      tPlain(label),
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
        commitVclip(next, 'delete control point')
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
    visualDragRef.current = true
    if (visualTool === 'video/tool/vector_clip') {
      vclipPointerDown(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (visualTool === 'video/tool/perspective') {
      perspPointerDown(event)
      return
    }
    const hit = hitTest(event.clientX, event.clientY)
    // 源码语义：drag 工具点击的是特征（属于其所在行）；hold 工具（scale/rotate/clip）
    // 无可点击特征，始终以活动行为基准（InitializeHold），改动经 SetSelectedOverride
    // 应用到全部选中行。无活动行时源码不进入 hold
    const holdTool =
      visualTool === 'video/tool/scale' ||
      visualTool === 'video/tool/rotate/z' ||
      visualTool === 'video/tool/rotate/xy' ||
      visualTool === 'video/tool/clip'
    const cue = holdTool ? activeCue : (hit?.cue ?? activeCue)
    if (!cue) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const stage = stageRef.current
    if (!stage) return
    // GetLineScale/GetLineRotation 的缺省值取自行样式（ScaleX/ScaleY/Angle）
    const cueStyle = document.styles.find((item) => item.name === cue.style)
    const overrides = readVisualOverrides(cue.text, cueStyle)
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    const bounds = stage.getBoundingClientRect()
    const rect = mediaRect()
    // UpdateHold：矩形角点钳制在视频区域内
    const rawX = ((event.clientX - bounds.left - rect.left) / rect.width) * playResX
    const rawY = ((event.clientY - bounds.top - rect.top) / rect.height) * playResY
    const pointerX = clampToScript(rawX, playResX)
    const pointerY = clampToScript(rawY, playResY)
    // clip 工具：cur_1 基点 = 钳制后的点击点（InitializeHold + UpdateHold 钳制），
    // 其余工具基点 = 行 \pos（无则点击点）
    const baseX = visualTool === 'video/tool/clip' ? pointerX : (overrides.pos?.x ?? pointerX)
    const baseY = visualTool === 'video/tool/clip' ? pointerY : (overrides.pos?.y ?? pointerY)
    // 行原点（GetLineOrigin > GetLinePosition）：\org > \pos/\move 起点 > 样式对齐默认位置。
    // rotate/z 的 InitializeHold/UpdateHold 绕该点计算鼠标角度（非按下点）
    const lineOriginScript =
      overrides.org ??
      overrides.pos ??
      (overrides.move ? { x: overrides.move.x1, y: overrides.move.y1 } : null) ??
      defaultLinePosition(cue, cueStyle, { x: playResX, y: playResY })
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
      originPx: {
        x: bounds.left + rect.left + (lineOriginScript.x / playResX) * rect.width,
        y: bounds.top + rect.top + (lineOriginScript.y / playResY) * rect.height,
      },
    }
  }

  const canvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // 鼠标状态跟踪（十字/旋转工具 Draw 的输入）：相对 overlay 的像素位置、Shift 状态、在台上
    const bounds = event.currentTarget.getBoundingClientRect()
    mouseStagePxRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    mouseShiftRef.current = event.shiftKey
    mouseOnStageRef.current = true
    // 源码每次鼠标事件后 Render：Draw 含 mouse_pos 的工具都要随移动实时重绘
    // （visual_tool_cross.cpp 十字线、visual_tool_rotatez.cpp 原点→鼠标连线）
    if (visualTool === 'video/tool/cross' || visualTool === 'video/tool/rotate/z')
      scheduleOverlayRender()
    if (vclipRef.current) {
      vclipPointerMove(event)
      return
    }
    if (perspRef.current) {
      perspPointerMove(event)
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
      // 源码 Feature::UpdateDrag(mouse_pos - drag_start)：按 mousedown 起的位移量移动
      const dx = (event.clientX - drag.startX) / scale
      const dy = (event.clientY - drag.startY) / scale
      const mo = readVisualOverrides(drag.cue.text)
      // UpdateDrag：\move 行只更新起点，终点与 t1/t2 原样保留（Str() 两位小数去尾零）
      const text = mo.move
        ? setOverride(
            drag.cue.text,
            'move',
            `(${floatToString(mo.move.x1 + dx)},${floatToString(mo.move.y1 + dy)},${floatToString(mo.move.x2)},${floatToString(mo.move.y2)}${
              mo.move.t1 !== undefined && mo.move.t2 !== undefined
                ? `,${mo.move.t1},${mo.move.t2}`
                : ''
            })`,
          )
        : setPosition(drag.cue.text, drag.baseX + dx, drag.baseY + dy)
      scheduleDragCommit(() => onPatchCue(drag.cue.id, { text }, tPlain('visual typesetting')))
    } else if (visualTool === 'video/tool/scale') {
      let dx = ((event.clientX - drag.startX) / scale) * 1.25
      let dy = ((drag.startY - event.clientY) / scale) * 1.25
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      // UpdateHold：Alt 锁定纵横比——短轴 delta 按初始缩放比换算
      if (event.altKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = dx * (drag.baseScaleY / drag.baseScaleX)
        else dx = dy * (drag.baseScaleX / drag.baseScaleY)
      }
      let sx = Math.max(0, drag.baseScaleX + dx)
      let sy = Math.max(0, drag.baseScaleY + dy)
      if (event.ctrlKey) {
        sx = Math.round(sx / 25) * 25
        sy = Math.round(sy / 25) * 25
      }
      // UpdateHold：std::to_string((int)...) 截断取整；SetSelectedOverride 应用到全部选中行
      const valueX = `${Math.trunc(sx)}`
      const valueY = `${Math.trunc(sy)}`
      scheduleDragCommit(() =>
        onPatchCues(
          selectedCues.map((cue) => ({
            id: cue.id,
            patch: { text: setOverride(setOverride(cue.text, 'fscx', valueX), 'fscy', valueY) },
          })),
          tPlain('visual typesetting'),
        ),
      )
    } else if (visualTool === 'video/tool/rotate/z') {
      // UpdateHold：angle 绕行原点（org->pos）旋转——originPx 在 pointerdown 时算好，
      // 终值 = 基准角 + (原点→按下点角) − (原点→当前点角)
      const a0 = Math.atan2(drag.originPx.y - drag.startY, drag.originPx.x - drag.startX)
      const a1 = Math.atan2(drag.originPx.y - event.clientY, drag.originPx.x - event.clientX)
      let angle = drag.baseRotationZ + ((a0 - a1) * 180) / Math.PI
      if (event.ctrlKey) angle = Math.round(angle / 30) * 30
      angle = ((angle % 360) + 360) % 360
      // SetSelectedOverride("\\frz", agi::format("%.4g", ...)) 应用到全部选中行
      const value = formatG4(angle)
      scheduleDragCommit(() =>
        onPatchCues(
          selectedCues.map((cue) => ({
            id: cue.id,
            patch: { text: setOverride(cue.text, 'frz', value) },
          })),
          tPlain('visual typesetting'),
        ),
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
      // UpdateHold：fmodf(angle + 360, 360) 后 agi::format("%.4g", ...)；
      // SetSelectedOverride 应用到全部选中行
      const valueX = formatG4(((rx % 360) + 360) % 360)
      const valueY = formatG4(((ry % 360) + 360) % 360)
      scheduleDragCommit(() =>
        onPatchCues(
          selectedCues.map((cue) => ({
            id: cue.id,
            patch: { text: setOverride(setOverride(cue.text, 'frx', valueX), 'fry', valueY) },
          })),
          tPlain('visual typesetting'),
        ),
      )
    } else if (visualTool === 'video/tool/clip') {
      const stageBounds = stage.getBoundingClientRect()
      const clipRect = mediaRect()
      const playResY = Number(document.scriptInfo.PlayResY) || 1080
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
      // UpdateHold：cur_1/cur_2 都钳制在视频区域内
      const rawX = ((event.clientX - stageBounds.left - clipRect.left) / clipRect.width) * playResX
      const rawY = ((event.clientY - stageBounds.top - clipRect.top) / clipRect.height) * playResY
      const x2 = clampToScript(rawX, playResX)
      const y2 = clampToScript(rawY, playResY)
      // CommitHold：ToScriptCoords(...).Str() 两位小数去尾零；\iclip 行保持 \iclip
      // （源码按各行文本子串判断），提交消息为默认 "visual typesetting"
      const clipX1 = floatToString(Math.min(drag.baseX, x2))
      const clipY1 = floatToString(Math.min(drag.baseY, y2))
      const clipX2 = floatToString(Math.max(drag.baseX, x2))
      const clipY2 = floatToString(Math.max(drag.baseY, y2))
      const value = `(${clipX1},${clipY1},${clipX2},${clipY2})`
      scheduleDragCommit(() =>
        onPatchCues(
          selectedCues.map((cue) => ({
            id: cue.id,
            patch: {
              text: setOverride(cue.text, /\\iclip/.test(cue.text) ? 'iclip' : 'clip', value),
            },
          })),
          tPlain('visual typesetting'),
        ),
      )
    }
  }

  const canvasDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (visualTool === 'video/tool/perspective' && perspRef.current) {
      perspDoubleClick(event)
      return
    }
    if (visualTool !== 'video/tool/cross' || !activeCue) return
    const stage = stageRef.current
    if (!stage) return
    const bounds = stage.getBoundingClientRect()
    const rect = mediaRect()
    const playResY = Number(document.scriptInfo.PlayResY) || 1080
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9)
    const x = ((event.clientX - bounds.left - rect.left) / rect.width) * playResX
    const y = ((event.clientY - bounds.top - rect.top) / rect.height) * playResY
    // VisualToolCross::OnDoubleClick：d = 点击点 − 当前行位置；\move 行两端点与 \org
    // 随 d 平移（保 t1/t2），无 \move 时写 \pos(点击点)。Text() = 显示宽 > 脚本宽时
    // 3 位小数，否则 DStr 整数截断
    const fmt = (v: number) => (rect.width > playResX ? floatToString(v, 3) : `${Math.trunc(v)}`)
    const o = readVisualOverrides(activeCue.text)
    const cur = o.pos ?? (o.move ? { x: o.move.x1, y: o.move.y1 } : null)
    let dx = 0
    let dy = 0
    if (cur) {
      dx = x - cur.x
      dy = y - cur.y
    } else {
      // 无 \pos/\move 的默认位置近似为 hitbox 中心（\pos 本身仍精确写点击点，仅影响 \org 平移量）
      const box = hitBoxesRef.current.find((item) => item.cue.id === activeCue.id)
      if (box) {
        dx = x - (box.left + box.right) / 2
        dy = y - (box.top + box.bottom) / 2
      }
    }
    let text = activeCue.text
    if (o.move) {
      const points = `${fmt(o.move.x1 + dx)},${fmt(o.move.y1 + dy)},${fmt(o.move.x2 + dx)},${fmt(o.move.y2 + dy)}`
      text = setOverride(
        text,
        'move',
        o.move.t1 !== undefined && o.move.t2 !== undefined
          ? `(${points},${o.move.t1},${o.move.t2})`
          : `(${points})`,
      )
    } else {
      text = setOverride(text, 'pos', `(${fmt(x)},${fmt(y)})`)
    }
    if (o.org) text = setOverride(text, 'org', `(${fmt(o.org.x + dx)},${fmt(o.org.y + dy)})`)
    onPatchCue(activeCue.id, { text }, tPlain('positioning'))
  }

  const canvasPointerUp = () => {
    // 先同步冲刷最后一批拖拽提交（保持 flushNow 即时渲染路径），再退出拖拽态
    flushDragCommit()
    dragEndedAtRef.current = performance.now()
    visualDragRef.current = false
    if (vclipRef.current) {
      vclipPointerUp()
      return
    }
    if (perspRef.current) {
      perspPointerUp()
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
    // 快捷键上下文挂面板根：源码 video_box 全箱属 Video 上下文——按钮/滑条聚焦时
    // Video 热键仍可用（此前只挂 canvas，点按钮后上下文落回 Default 使热键失效）
    <section
      className="preview-panel"
      aria-label={tPlain('Video preview')}
      style={panelStyle}
      data-shortcut-context="Video"
    >
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
                  {commandIcon(id) ? (
                    <img src={commandIcon(id)} alt="" width={16} height={16} draggable={false} />
                  ) : (
                    <span className="tool-button-label">{COMMANDS[id]?.label?.[0]}</span>
                  )}
                </button>
              ),
            )}
          </div>
        )}
        {visualTool === 'video/tool/perspective' && (
          <div
            className="visual-toolbar visual-subtoolbar"
            aria-label={tPlain('Perspective sub tools')}
          >
            <div className="visual-sep" />
            {PERSP_SUBTOOLS.map(({ id, bit }) => (
              <button
                className={`visual-tool${(perspSettings & bit) !== 0 ? ' pressed' : ''}`}
                title={commandTooltip(id, 'Video')}
                aria-label={commandTooltip(id, 'Video')}
                key={id}
                // 源码 EnableTool(lock_outer, subtool & PERSP_OUTER)：未启用 plane 时禁用
                disabled={
                  id === 'video/tool/perspective/lock_outer' && !perspHasOuterBits(perspSettings)
                }
                aria-pressed={(perspSettings & bit) !== 0}
                onClick={() => perspSubToolClick(id)}
              >
                <img src={commandIcon(id)} alt="" width={16} height={16} draggable={false} />
              </button>
            ))}
            <button
              className="visual-tool"
              title={perspOrgTitle}
              aria-label={perspOrgTitle}
              // 源码 ToggleTool(orgmode, false)：org 模式按钮恒不按下
              aria-pressed={false}
              onClick={() => perspSubToolClick('video/tool/perspective/orgmode/center')}
            >
              <img
                src={commandIcon(perspOrgCommand)}
                alt=""
                width={16}
                height={16}
                draggable={false}
              />
            </button>
          </div>
        )}
        <div
          className="video-stage"
          ref={stageRef}
          tabIndex={0}
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
                  width: `${mediaCssSize(intrinsicWidth)}px`,
                  height: `${mediaCssSize(intrinsicHeight)}px`,
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
                  // 首帧偏移校准（每个元素实例一次）：首帧 present 时的 mediaTime 即元素
                  // 时间轴上的首帧时间（容器首帧 PTS）。校准后若元素位置与归一化时间轴
                  // 不符（如中途从 WebCodecs 切回、元素重挂载后仍停在首帧），补一次同步 seek
                  const host = event.currentTarget
                  host.requestVideoFrameCallback?.((_now, metadata) => {
                    if (videoRef.current !== host) return
                    firstFrameOffsetSecRef.current = metadata.mediaTime
                    // 时长与元素位置同一时间轴（原始 PTS），同样换算到归一化应用时间轴
                    if (Number.isFinite(host.duration)) {
                      const appDuration = Math.max(
                        0,
                        host.duration * 1000 - ptsToMs(metadata.mediaTime),
                      )
                      setDurationMs(appDuration)
                      onDurationChange(appDuration)
                    }
                    if (host.paused) requestVideoSeek(currentRef.current)
                  })
                  probeVideoFps(event.currentTarget, media.url)
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                // 在途 seek 完成 → 补发被覆盖期间保留的最新目标（弃中间位置）
                onSeeked={() => pumpVideoSeek()}
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
                  width: `${mediaCssSize(intrinsicWidth)}px`,
                  height: `${mediaCssSize(intrinsicHeight)}px`,
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
                  width: `${mediaCssSize(media.dummy.width)}px`,
                  height: `${mediaCssSize(media.dummy.height)}px`,
                  background:
                    assRenderer && !assError
                      ? dummyBackgroundCss(
                          media.dummy,
                          (windowZoom * contentZoom) / (displayDpr > 0 ? displayDpr : 1),
                        )
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
              // 十字工具：源码 SetCursor(wxCURSOR_BLANK) 隐藏光标（十字线即光标）；
              // gl.SetInvert 的反色十字线经 difference 混合实现（白线 = 反转底层视频）
              cursor: visualTool === 'video/tool/cross' ? 'none' : 'default',
              mixBlendMode: visualTool === 'video/tool/cross' ? 'difference' : undefined,
            }}
            onPointerDown={canvasPointerDown}
            onPointerMove={canvasPointerMove}
            onPointerUp={canvasPointerUp}
            onPointerCancel={canvasPointerUp}
            onPointerLeave={() => {
              // 鼠标离开视频区：清除十字工具状态并重绘擦除（源码 mouse_pos 清空）
              mouseOnStageRef.current = false
              mouseStagePxRef.current = null
              if (visualTool === 'video/tool/cross' || visualTool === 'video/tool/rotate/z')
                renderOverlay()
            }}
            onDoubleClick={canvasDoubleClick}
          />
          <canvas ref={crossTextRef} className="cross-coordinate-overlay" />
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
