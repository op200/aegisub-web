import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getOption,
  getOptionBool,
  getOptionInt,
  getOptionString,
  useOptionsVersion,
} from '../../config/options'
import type { SubtitleCue } from '../../core/types'
import { extractAudioPeaks } from '../../media/audioPeaks'
import type { MediaSource } from '../../platform/types'
import { tPlain } from '../i18n'
import { rafThrottle, serialLatest, type RafThrottled, type SerialLatest } from '../rafThrottle'

interface WaveformProps {
  media: MediaSource | null
  durationMs: number
  currentTimeMs: number
  videoTimeMs: number | null
  selectedCue: SubtitleCue | null
  /** 全部行（Audio/Inactive Lines Display Mode 的非活动行边界绘制） */
  cues: SubtitleCue[]
  /** 关键帧列表（Audio/Display/Draw/Keyframes in * Mode 与标记拖动吸附） */
  keyframes: number[]
  /** 视频帧率（关键帧帧号 → 时间换算） */
  fps: number
  /** audio/karaoke 开关（决定用哪个关键帧显示开关） */
  karaokeMode: boolean
  /** 播放状态（Audio/Lock Scroll on Cursor 跟随光标） */
  playing: boolean
  autoScroll: boolean
  /** 双击网格行的 ScrollToActiveLine 请求（App 侧 nonce 递增，0=无） */
  scrollToActiveLine: number
  view: 'waveform' | 'spectrum'
  /** AudioDisplay::zoom_level（= -HorizontalZoom 滑块值），约 -30..50 */
  zoomLevel?: number
  /** 振幅缩放（AudioDisplay::SetAmplitudeScale） */
  amplitude?: number
  /** Ctrl+滚轮缩放（AudioBox::OnMouseWheel） */
  onWheelZoom?: (delta: number) => void
  onVideoSeek: (timeMs: number) => void
  onDurationChange: (durationMs: number) => void
  onPatchCue: (
    id: string,
    patch: Partial<Omit<SubtitleCue, 'id'>>,
    label: string,
  ) => Promise<unknown> | void
}

interface AudioData {
  durationMs: number
  /** 每个峰值桶的时长（ms）——桶索引 = timeMs / msPerBucket */
  msPerBucket: number
  peakMin: Float32Array
  peakMax: Float32Array
  peakAvg: Float32Array
  /** 解码进度（0..1，已解码时间占比）；1 = 完成。流式路径渐进上报 */
  progress: number
  spectrum: {
    width: number
    height: number
    data: Uint8Array
    msPerColumn: number
    sampleRate: number
  } | null
}

async function runWorker(
  payload:
    | { samples: Float32Array; durationMs: number }
    | { synthetic: { kind: 'blank' | 'noise' }; durationMs: number },
  buckets: number,
): Promise<AudioData> {
  const worker = new Worker(new URL('../../workers/waveform.worker.ts', import.meta.url), {
    type: 'module',
  })
  return await new Promise<AudioData>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<AudioData>) => {
      worker.terminate()
      resolve(data)
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message))
    }
    const transfer: Transferable[] = 'samples' in payload ? [payload.samples.buffer] : []
    worker.postMessage({ ...payload, buckets }, transfer)
  })
}

/** media.file 缺失（token 句柄）时经 URL 取回字节再喂给解复用器 */
async function ensureFile(media: MediaSource): Promise<File> {
  if (media.file) return media.file
  const blob = await (await fetch(media.url)).blob()
  return new File([blob], media.name || 'media')
}

/** 真实媒体：extractAudioPeaks 两条路径（decodeAudioData 快路径 / demuxer+WebCodecs 流式），渐进上报 */
async function createAudioData(
  media: MediaSource,
  onProgress?: (data: AudioData) => void,
): Promise<AudioData> {
  const file = await ensureFile(media)
  const toAudioData = (peaks: {
    durationMs: number
    msPerBucket: number
    peakMin: Float32Array
    peakMax: Float32Array
    peakAvg: Float32Array
    progress: number
    spectrum: {
      width: number
      height: number
      data: Uint8Array
      msPerColumn: number
      sampleRate: number
    } | null
  }): AudioData => ({
    durationMs: peaks.durationMs,
    msPerBucket: peaks.msPerBucket,
    peakMin: peaks.peakMin,
    peakMax: peaks.peakMax,
    peakAvg: peaks.peakAvg,
    progress: peaks.progress,
    spectrum: peaks.spectrum,
  })
  return toAudioData(
    await extractAudioPeaks(
      file,
      onProgress ? (peaks) => onProgress(toAudioData(peaks)) : undefined,
    ),
  )
}

// ---------------------------------------------------------------------------
// 与 Aegisub 一致的布局常量（audio_display.cpp）
// ---------------------------------------------------------------------------
const TIMELINE_H = 16 // 时间刻度线高度（文本高度 + 4）
const SCROLLBAR_H = 15 // 滚动条高度
const FOOT_SIZE = 6 // 标记脚尺寸

// ---------------------------------------------------------------------------
// 配色（Colour/Schemes/*，default_config.json；方案名来自 Audio/Colour Schemes）
// ---------------------------------------------------------------------------
interface Scheme {
  hue: number
  hueScale?: number
  sat: number
  satScale?: number
  lBase: number
  lScale: number
}

type SchemeVariant = 'Normal' | 'Inactive' | 'Selection' | 'Primary'

/** 读取 Colour/Schemes/<name>/<variant> 的 HSL 参数 */
function readScheme(schemeName: string, variant: SchemeVariant): Scheme {
  const base = `Colour/Schemes/${schemeName}/${variant}`
  const num = (key: string) => getOption<number>(`${base}/${key}`)
  return {
    hue: num('Hue Offset'),
    hueScale: num('Hue Scale'),
    sat: num('Saturation Offset'),
    satScale: num('Saturation Scale'),
    lBase: num('Lightness Offset'),
    lScale: num('Lightness Scale'),
  }
}

/** 读取 Colour/Schemes/<name>/UI{ Focused} 的界面色 */
function readSchemeUi(schemeName: string): { light: string; dark: string; sel: string } {
  const base = `Colour/Schemes/${schemeName}/UI`
  return {
    light: getOptionString(`${base}/Light`),
    dark: getOptionString(`${base}/Dark`),
    sel: getOptionString(`${base}/Selection`),
  }
}

/** 'rgba(r,g,b,a0-255)' → CSS rgba（alpha 归一化到 0..1） */
function cssAlphaColor(value: string): string {
  const match = /rgba?\(([^)]*)\)/.exec(value)
  if (!match) return value
  const parts = match[1].split(',').map((item) => item.trim())
  if (parts.length >= 4) {
    const alpha = Math.max(0, Math.min(255, Number(parts[3]) || 0)) / 255
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha.toFixed(3)})`
  }
  return `rgb(${parts[0]},${parts[1]},${parts[2]})`
}

/** 与 colorspace.cpp hsl_to_rgb 一致的 HSL→RGB（0..255 输入） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const hh = h / 255
  const ss = s / 255
  const ll = l / 255
  const temp2 = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const temp1 = 2 * ll - temp2
  const hue2rgb = (p: number, q: number, t0: number) => {
    let t = t0
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (6 * t < 1) return p + (q - p) * 6 * t
    if (2 * t < 1) return q
    if (3 * t < 2) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  // colorspace.cpp 用 (int)(r*255) 截断，保持一致
  const r = Math.floor(hue2rgb(temp1, temp2, hh + 1 / 3) * 255)
  const g = Math.floor(hue2rgb(temp1, temp2, hh) * 255)
  const b = Math.floor(hue2rgb(temp1, temp2, hh - 1 / 3) * 255)
  return [r, g, b]
}

/** 配色方案在级别 t（0..1）处的颜色 */
function schemeColor(scheme: Scheme, t: number): string {
  const [r, g, b] = hslToRgb(
    Math.max(0, Math.min(255, scheme.hue + t * (scheme.hueScale ?? 0))),
    Math.max(0, Math.min(255, scheme.sat + t * (scheme.satScale ?? 0))),
    Math.max(0, Math.min(255, scheme.lBase + t * scheme.lScale)),
  )
  return `rgb(${r},${g},${b})`
}

/** AudioDisplay::GetZoomLevelFactor */
function zoomFactor(level: number): number {
  let factor = 100
  if (level > 0) {
    factor += 25 * level
  } else if (level < 0) {
    if (level >= -5) factor += 10 * level
    else if (level >= -11) factor = 50 + (level + 5) * 5
    else factor = 20 + level + 11
    if (factor <= 0) factor = 1
  }
  return factor
}

export function Waveform({
  media,
  durationMs,
  currentTimeMs,
  videoTimeMs,
  selectedCue,
  cues,
  keyframes,
  fps,
  karaokeMode,
  playing,
  autoScroll,
  scrollToActiveLine,
  view,
  zoomLevel = 0,
  amplitude = 1,
  onWheelZoom,
  onVideoSeek,
  onDurationChange,
  onPatchCue,
}: WaveformProps) {
  const optionsVersion = useOptionsVersion() // Preferences 提交后重绘
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [data, setData] = useState<AudioData | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const scrollLeftRef = useRef(0)
  scrollLeftRef.current = scrollLeft
  const wheelZoomRef = useRef(onWheelZoom)
  wheelZoomRef.current = onWheelZoom
  const dragRef = useRef<
    | { mode: 'timeline' | 'scrollbar'; startX: number; startScroll: number }
    | { mode: 'marker'; marker: 'start' | 'end' }
    | null
  >(null)

  // 标记拖动提交走「串行最新目标」通道（对齐 async_video_provider.cpp 的 RequestFrame：
  // 在途不排队、新目标覆盖待发槽位、pointerup 冲刷最终值）。apply → worker 往返 +
  // 全应用重渲染远慢于 pointermove 频率（125Hz+），逐个排队会让松开鼠标后画面按队列
  // 把中间位置慢慢回放；中间目标一律丢弃，只保留最新
  const patchCueRef = useRef(onPatchCue)
  patchCueRef.current = onPatchCue
  const markerCommitRef = useRef<SerialLatest<
    [string, Partial<Omit<SubtitleCue, 'id'>>, string]
  > | null>(null)
  if (!markerCommitRef.current)
    markerCommitRef.current = serialLatest((id, patch, label) =>
      patchCueRef.current(id, patch, label),
    )
  const scrollThrottleRef = useRef<RafThrottled | null>(null)
  if (!scrollThrottleRef.current) scrollThrottleRef.current = rafThrottle()

  // ---- 音频数据加载（合成音频走 worker；真实媒体走 extractAudioPeaks，流式渐进上报） ----
  useEffect(() => {
    let cancelled = false
    setData(null)
    setUnavailable(false)
    if (!media?.file && !media?.syntheticAudio) {
      if (media) setUnavailable(true)
      return
    }
    const apply = (result: AudioData) => {
      if (cancelled) return
      setData(result)
      if (result.durationMs > 0) onDurationChange(result.durationMs)
    }
    const load: Promise<AudioData> = media.syntheticAudio
      ? // 合成音频：直接在 worker 生成峰值/频谱，避免物化 1.6GB 样本
        runWorker(
          {
            synthetic: { kind: media.syntheticAudio.kind },
            durationMs: media.syntheticAudio.durationMs,
          },
          2400,
        ).then((result) => ({
          ...result,
          msPerBucket: result.durationMs / Math.max(1, result.peakMin.length),
          progress: 1,
        }))
      : createAudioData(media, apply)
    void load.then(apply).catch(() => {
      if (!cancelled) setUnavailable(true)
    })
    return () => {
      cancelled = true
    }
  }, [media, onDurationChange])

  // ---- 尺寸监听 ----
  useEffect(() => {
    const el = canvasRef.current?.parentElement
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- 缩放/滚动模型（AudioDisplay::SetZoomLevel / ScrollPixelToLeft） ----
  const msPerPixel = 2000 / zoomFactor(zoomLevel)
  const pixelAudioWidth = durationMs > 0 ? Math.max(1, Math.floor(durationMs / msPerPixel)) : 1
  const maxScroll = Math.max(0, pixelAudioWidth - Math.max(1, size.w))
  const clampedScroll = Math.min(Math.max(0, scrollLeft), maxScroll)

  useEffect(() => {
    setScrollLeft((current) => Math.min(Math.max(0, current), maxScroll))
  }, [maxScroll])

  // ScrollTimeRangeInView（audio_display.cpp）：5% 边距，完全可见不动，可容纳则居中
  const scrollRangeInView = useCallback(
    (cue: SubtitleCue) => {
      if (durationMs <= 0) return
      const clientWidth = Math.max(1, size.w)
      const begin = cue.startMs / msPerPixel
      const end = cue.endMs / msPerPixel
      const rangeLen = end - begin
      const leftAdjust = clientWidth / 20
      const clientLeft = clampedScroll + leftAdjust
      const visibleWidth = (clientWidth * 9) / 10
      let target = clampedScroll
      if (!(begin >= clientLeft && end <= clientLeft + visibleWidth)) {
        if (rangeLen < visibleWidth) {
          target = begin - (visibleWidth - rangeLen) / 2 - leftAdjust
        } else if (!(begin < clientLeft && end > clientLeft + visibleWidth)) {
          if (end >= clientLeft && end < clientLeft + visibleWidth) {
            target = end - clientWidth - leftAdjust
          } else {
            target = begin - leftAdjust
          }
        }
      }
      setScrollLeft(Math.min(Math.max(0, target), maxScroll))
    },
    [durationMs, size.w, msPerPixel, clampedScroll, maxScroll],
  )

  // 选中行变化时滚动到可见（Audio/Auto/Scroll，ScrollTimeRangeInView）
  const lastSelKeyRef = useRef('')
  useEffect(() => {
    if (!autoScroll || !selectedCue) return
    const key = `${selectedCue.id}|${selectedCue.startMs}|${selectedCue.endMs}`
    if (lastSelKeyRef.current === key) return
    lastSelKeyRef.current = key
    scrollRangeInView(selectedCue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, selectedCue?.id])

  // 双击网格行的 ScrollToActiveLine（audio_box.cpp，base_grid.cpp 双击调用）：不受
  // Audio/Auto/Scroll 开关限制且无去重——重复双击当前行也要保证行范围可见
  const lastScrollNonceRef = useRef(0)
  useEffect(() => {
    if (scrollToActiveLine === lastScrollNonceRef.current) return
    lastScrollNonceRef.current = scrollToActiveLine
    if (selectedCue) scrollRangeInView(selectedCue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToActiveLine])

  // 播放光标不自动滚动（Audio/Lock Scroll on Cursor 默认关闭）

  // ---- 频谱调色板 LUT（AudioColorScheme：2^12 级 HSL 调色板，audio_colorscheme.cpp） ----
  const specLutRef = useRef<{ normal: Uint8Array; primary: Uint8Array } | null>(null)
  useEffect(() => {
    if (view !== 'spectrum') {
      specLutRef.current = null
      return
    }
    const schemeName = getOptionString('Colour/Audio Display/Spectrum')
    const clamp255 = (value: number) => Math.max(0, Math.min(255, value))
    const build = (variant: SchemeVariant): Uint8Array => {
      const scheme = readScheme(schemeName, variant)
      const lut = new Uint8Array(4097 * 3)
      for (let i = 0; i <= 4096; i++) {
        const t = i / 4096
        const [r, g, b] = hslToRgb(
          clamp255(scheme.hue + t * (scheme.hueScale ?? 0)),
          clamp255(scheme.sat + t * (scheme.satScale ?? 0)),
          clamp255(scheme.lBase + t * scheme.lScale),
        )
        lut[i * 3] = r
        lut[i * 3 + 1] = g
        lut[i * 3 + 2] = b
      }
      return lut
    }
    specLutRef.current = { normal: build('Normal'), primary: build('Primary') }
  }, [view, optionsVersion])

  // ---- 绘制 ----
  const drawWaveform = () => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    const ratio = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(size.w * ratio))
    const H = Math.max(1, Math.round(size.h * ratio))
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    // ---- 配色与显示开关（Preferences → Audio / Interface → Colors） ----
    // audio_display.cpp ReloadRenderingSettings：整个视图（含时间轴/滚动条 UI 色）
    // 频谱视图用 Spectrum 方案、波形视图用 Waveform 方案
    const schemeName = getOptionString(
      view === 'spectrum' ? 'Colour/Audio Display/Spectrum' : 'Colour/Audio Display/Waveform',
    )
    const schemeNormal = readScheme(schemeName, 'Normal')
    const schemePrimary = readScheme(schemeName, 'Primary')
    const schemeUi = readSchemeUi(schemeName)
    const UI_LIGHT = schemeUi.light
    const UI_DARK = schemeUi.dark
    const UI_SEL = schemeUi.sel
    const CURSOR_COLOR = getOptionString('Colour/Audio Display/Play Cursor')
    const LINE_START = getOptionString('Colour/Audio Display/Line boundary Start')
    const LINE_END = getOptionString('Colour/Audio Display/Line boundary End')
    const INACTIVE_LINE_COLOR = getOptionString('Colour/Audio Display/Line Boundary Inactive Line')
    const SECONDS_COLOR = getOptionString('Colour/Audio Display/Seconds Line')
    const KEYFRAME_COLOR = getOptionString('Colour/Audio Display/Keyframe')
    const CURRENT_FRAME_COLOR = cssAlphaColor(
      getOptionString('Colour/Audio Display/Current Frame Range'),
    )
    const PREVIOUS_FRAME_COLOR = cssAlphaColor(
      getOptionString('Colour/Audio Display/Previous Frame Range'),
    )
    const boundaryWidth = getOptionInt('Audio/Line Boundaries Thickness')
    const drawSecondsBoundaries = getOptionBool('Audio/Display/Draw/Seconds')
    const drawCursorTime = getOptionBool('Audio/Display/Draw/Cursor Time')
    const drawVideoPosition = getOptionBool('Audio/Display/Draw/Video Position')
    const drawKeyframes = getOptionBool(
      karaokeMode
        ? 'Audio/Display/Draw/Keyframes in Karaoke Mode'
        : 'Audio/Display/Draw/Keyframes in Dialogue Mode',
    )
    const inactiveMode = getOptionInt('Audio/Inactive Lines Display Mode')
    const inactiveComments = getOptionBool('Audio/Display/Draw/Inactive Comments')
    const waveformStyle = getOptionInt('Audio/Display/Waveform Style') // 0 Maximum / 1 Maximum + Average
    const frameMs = fps > 0 ? 1000 / fps : 1000 / 24

    const audioTop = TIMELINE_H
    const audioHeight = Math.max(1, size.h - TIMELINE_H - SCROLLBAR_H)
    const midpoint = Math.floor(audioHeight / 2)
    const centerY = audioTop + midpoint
    const scroll = clampedScroll
    const absXFromTime = (timeMs: number) => timeMs / msPerPixel

    // ================= 时间刻度线（AudioDisplayTimeline::Paint） =================
    {
      ctx.fillStyle = UI_DARK
      ctx.fillRect(0, 0, size.w, TIMELINE_H)
      ctx.strokeStyle = UI_LIGHT
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, TIMELINE_H - 1)
      ctx.lineTo(size.w, TIMELINE_H - 1)
      ctx.stroke()

      const pxPerSec = 1000 / msPerPixel
      let minorDivisor = 1000
      let majorModulo = 10
      if (pxPerSec > 3000) {
        minorDivisor = 1
        majorModulo = 10
      } else if (pxPerSec > 300) {
        minorDivisor = 10
        majorModulo = 10
      } else if (pxPerSec > 30) {
        minorDivisor = 100
        majorModulo = 10
      } else if (pxPerSec > 3) {
        minorDivisor = 1000
        majorModulo = 10
      } else if (pxPerSec > 1 / 3) {
        minorDivisor = 10000
        majorModulo = 6
      } else if (pxPerSec > 1 / 9) {
        minorDivisor = 60000
        majorModulo = 10
      } else if (pxPerSec > 1 / 90) {
        minorDivisor = 600000
        majorModulo = 6
      } else {
        minorDivisor = 3600000
        majorModulo = 10
      }

      ctx.font = '10px "Segoe UI", sans-serif'
      ctx.textBaseline = 'top'
      ctx.fillStyle = UI_LIGHT
      const scrollMs = scroll * msPerPixel
      let nextMark = Math.floor(scrollMs / minorDivisor)
      if (nextMark * minorDivisor < scrollMs) nextMark += 1
      let lastTextRight = -1
      let lastHour = -1
      let lastMinute = -1
      if (durationMs < 3_600_000) lastHour = 0 // 短于 1 小时不显示小时
      for (let guard = 0; guard < 100000; guard++) {
        const markPos = Math.round((nextMark * minorDivisor) / msPerPixel - scroll)
        if (markPos > size.w) break
        const isMajor = nextMark % majorModulo === 0
        ctx.strokeStyle = UI_LIGHT
        ctx.beginPath()
        if (isMajor) {
          ctx.moveTo(markPos, TIMELINE_H - 6)
          ctx.lineTo(markPos, TIMELINE_H - 1)
        } else {
          ctx.moveTo(markPos, TIMELINE_H - 4)
          ctx.lineTo(markPos, TIMELINE_H - 1)
        }
        ctx.stroke()

        if (isMajor && markPos > lastTextRight) {
          const markTime = (nextMark * minorDivisor) / 1000
          const markHour = Math.floor(markTime / 3600)
          const markMinute = Math.floor(markTime / 60) % 60
          const markSecond = markTime - markHour * 3600 - markMinute * 60
          let timeString = ''
          if (markHour !== lastHour) {
            timeString = `${markHour}:${String(markMinute).padStart(2, '0')}:`
            lastHour = markHour
            lastMinute = markMinute
          } else if (markMinute !== lastMinute) {
            timeString = `${markMinute}:`
            lastMinute = markMinute
          }
          if (minorDivisor >= 100) {
            // %02d（Decisecond/Second/Minute...）
            timeString += String(Math.floor(markSecond)).padStart(2, '0')
          } else if (minorDivisor === 10) {
            // %02.1f（Centisecond）
            timeString += markSecond.toFixed(1).padStart(4, '0')
          } else {
            // %02.2f（Millisecond）
            timeString += markSecond.toFixed(2).padStart(5, '0')
          }
          ctx.fillText(timeString, markPos, 1)
          const tw = ctx.measureText(timeString).width
          lastTextRight = markPos + tw
        }
        nextMark += 1
      }
    }

    // ================= 音频区域 =================
    const inSelection = (timeMs: number) =>
      !!selectedCue && timeMs >= selectedCue.startMs && timeMs < selectedCue.endMs
    const styleAt = (timeMs: number): Scheme => (inSelection(timeMs) ? schemePrimary : schemeNormal)

    // 背景（Normal + 选区 Primary 覆盖；频谱视图用 Spectrum 方案的 palette(0) 静音色）
    const specLut = view === 'spectrum' ? specLutRef.current : null
    ctx.fillStyle = specLut
      ? `rgb(${specLut.normal[0]},${specLut.normal[1]},${specLut.normal[2]})`
      : schemeColor(schemeNormal, 0)
    ctx.fillRect(0, audioTop, size.w, audioHeight)
    if (selectedCue) {
      const sx1 = Math.max(0, Math.round(absXFromTime(selectedCue.startMs) - scroll))
      const sx2 = Math.min(size.w, Math.round(absXFromTime(selectedCue.endMs) - scroll))
      if (sx2 > sx1) {
        ctx.fillStyle = specLut
          ? `rgb(${specLut.primary[0]},${specLut.primary[1]},${specLut.primary[2]})`
          : schemeColor(schemePrimary, 0)
        ctx.fillRect(sx1, audioTop, sx2 - sx1, audioHeight)
      }
    }

    if (view === 'spectrum' && specLut && data?.spectrum) {
      // === audio_renderer_spectrum.cpp Render()：频率轴线性/对数混合 + 逐像素 bin 采样 ===
      const { width: cols, height: nbrBins, data: spec, msPerColumn, sampleRate } = data.spectrum
      const { normal: lutNormal, primary: lutPrimary } = specLut
      // minband/maxband：半开区间，跳过 DC，上限 20kHz
      const minband = 1
      const maxband = Math.max(
        minband + 1,
        Math.min(nbrBins, Math.round((nbrBins * 20000) / (sampleRate / 2))),
      )
      const scaleLog = Math.log(maxband / minband)
      // FreqCurve 0..4 → 1kHz 锚点相对位置（audio_display.cpp spectrum_fref_pos）
      const curve = Math.max(0, Math.min(4, getOptionInt('Audio/Renderer/Spectrum/FreqCurve')))
      const frefPos = [0.001, 0.125, 0.333, 0.425, 0.999][curve]
      const bFref = Math.max(1, Math.min(maxband - 1, (nbrBins * 1000) / (sampleRate / 2)))
      const clin = minband + (maxband - minband) * frefPos
      const clog = minband * Math.exp(frefPos * scaleLog)
      const logRatio = Math.max(0, Math.min(1, (bFref - clin) / (clog - clin)))

      const imgW = Math.max(1, Math.round(size.w * ratio))
      const imgH = Math.max(1, Math.round(audioHeight * ratio))
      // 频率曲线与列无关，先预采样每行的 bin 位置（curveAt[y] = y/imgH 处的 bin）
      const curveAt = new Float64Array(imgH + 1)
      // bin_cur 起始为 minband（audio_renderer_spectrum.cpp Render），不能是 0（DC bin）
      curveAt[0] = minband
      for (let y = 1; y < imgH; y++) {
        const posRel = y / imgH
        const bLin = minband + posRel * (maxband - minband)
        const bLog = minband * Math.exp(posRel * scaleLog)
        curveAt[y] = bLin + logRatio * (bLog - bLin)
      }
      curveAt[imgH] = maxband

      const image = ctx.createImageData(imgW, imgH)
      const px = image.data
      const ampScale = Math.max(0, amplitude) // pal->map(val * amplitude_scale)
      for (let ax = 0; ax < imgW; ax++) {
        const time = (scroll + ax / ratio) * msPerPixel
        let col = Math.floor(time / msPerColumn) // block_index：取包含该时刻的 brick
        col = col < 0 ? 0 : col >= cols ? cols - 1 : col
        const power = col * nbrBins
        const lut =
          selectedCue && time >= selectedCue.startMs && time < selectedCue.endMs
            ? lutPrimary
            : lutNormal
        let binPrv = minband
        for (let y = 0; y < imgH; y++) {
          const binCur = curveAt[y]
          const binNxt = curveAt[y + 1]
          let val = 0
          // 相邻 bin 插值
          if (binNxt - binPrv < 2) {
            const bin0 = Math.floor(binCur)
            const bin1 = Math.min(bin0 + 1, nbrBins - 1)
            const frac = binCur - bin0
            const v0 = spec[power + bin0] ?? 0
            const v1 = spec[power + bin1] ?? 0
            val = (v0 + frac * (v1 - v0)) / 255
          }
          // 取区间内最大 bin（std::max_element 半开区间 [binInf, binSup)）
          else {
            const binInf = Math.max(0, Math.min(Math.floor((binPrv + binCur) / 2), nbrBins - 2))
            const binSup = Math.min(Math.floor((binCur + binNxt) / 2), nbrBins - 1)
            let m = 0
            for (let bin = binInf; bin < binSup; bin++) {
              const v = spec[power + bin]
              if (v > m) m = v
            }
            val = m / 255
          }
          // get_color 的 mid<size_t>(0, val*factor, factor)：float→size_t 截断
          const idx = Math.max(0, Math.min(4096, Math.floor(val * ampScale * 4096)))
          const offset = (imgH - 1 - y) * imgW * 4 + ax * 4 // 低频在底部
          px[offset] = lut[idx * 3]
          px[offset + 1] = lut[idx * 3 + 1]
          px[offset + 2] = lut[idx * 3 + 2]
          px[offset + 3] = 255
          binPrv = binCur
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.putImageData(image, 0, Math.round(audioTop * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    } else if (data?.peakMin && data.peakMax && data.msPerBucket > 0) {
      const { peakMin, peakMax, peakAvg, msPerBucket } = data
      const len = Math.min(peakMin.length, peakMax.length)
      const bucketAt = (timeMs: number) =>
        Math.min(len - 1, Math.max(0, Math.floor(timeMs / msPerBucket)))
      // AudioWaveformRenderer：每像素取真实负峰/正峰。
      ctx.lineWidth = 1
      for (let x = 0; x < size.w; x++) {
        const time = (scroll + x) * msPerPixel
        const idx = bucketAt(time)
        const minimum = Math.max(-midpoint, (peakMin[idx] ?? 0) * amplitude * midpoint)
        const maximum = Math.min(midpoint, (peakMax[idx] ?? 0) * amplitude * midpoint)
        ctx.strokeStyle = schemeColor(styleAt(time), 0.4)
        ctx.beginPath()
        ctx.moveTo(x, centerY - maximum)
        ctx.lineTo(x, centerY - minimum)
        ctx.stroke()
      }
      // Waveform Style = Maximum + Average：平均值折线（WaveformRendererMaxAvg）
      if (waveformStyle === 1 && peakAvg.length) {
        ctx.strokeStyle = schemeColor(styleAt(scroll * msPerPixel), 0.8)
        ctx.lineWidth = 1
        ctx.beginPath()
        let pen = false
        for (let x = 0; x < size.w; x++) {
          const idx = bucketAt((scroll + x) * msPerPixel)
          const y =
            centerY -
            Math.max(-midpoint, Math.min(midpoint, (peakAvg[idx] ?? 0) * amplitude * midpoint))
          if (pen) ctx.lineTo(x, y)
          else {
            ctx.moveTo(x, y)
            pen = true
          }
        }
        ctx.stroke()
      }
      // 零线与峰值使用 pal.get(0.4)。
      ctx.lineWidth = 1
      let runStart = 0
      let runStyle = styleAt(scroll * msPerPixel)
      for (let x = 1; x <= size.w; x++) {
        const st = styleAt((scroll + x) * msPerPixel)
        if (st !== runStyle) {
          ctx.strokeStyle = schemeColor(runStyle, 0.4)
          ctx.beginPath()
          ctx.moveTo(runStart, centerY)
          ctx.lineTo(x, centerY)
          ctx.stroke()
          runStart = x
          runStyle = st
        }
      }
      ctx.strokeStyle = schemeColor(runStyle, 0.4)
      ctx.beginPath()
      ctx.moveTo(runStart, centerY)
      ctx.lineTo(size.w, centerY)
      ctx.stroke()
    }

    // ================= 秒边界（Audio/Display/Draw/Seconds） =================
    if (drawSecondsBoundaries && durationMs > 0) {
      ctx.strokeStyle = SECONDS_COLOR
      ctx.lineWidth = 1
      ctx.beginPath()
      const firstSecond = Math.floor((scroll * msPerPixel) / 1000)
      const lastSecond = Math.ceil(((scroll + size.w) * msPerPixel) / 1000)
      for (let second = firstSecond; second <= lastSecond; second++) {
        const x = Math.round(absXFromTime(second * 1000) - scroll)
        if (x < 0 || x >= size.w) continue
        ctx.moveTo(x + 0.5, audioTop)
        ctx.lineTo(x + 0.5, audioTop + audioHeight)
      }
      ctx.stroke()
    }

    // ================= 关键帧（Audio/Display/Draw/Keyframes in * Mode） =================
    if (drawKeyframes && keyframes.length && durationMs > 0) {
      ctx.strokeStyle = KEYFRAME_COLOR
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const keyframe of keyframes) {
        const x = Math.round(absXFromTime(keyframe * frameMs) - scroll)
        if (x < 0 || x >= size.w) continue
        ctx.moveTo(x + 0.5, audioTop)
        ctx.lineTo(x + 0.5, audioTop + audioHeight)
      }
      ctx.stroke()
    }

    // ================= 非活动行边界（Audio/Inactive Lines Display Mode） =================
    if (inactiveMode > 0 && selectedCue && durationMs > 0) {
      const usable = (cue: SubtitleCue) => (inactiveComments ? true : !cue.comment)
      let targets: SubtitleCue[]
      if (inactiveMode === 3) {
        targets = cues.filter((cue) => cue.id !== selectedCue.id && usable(cue))
      } else {
        const index = cues.findIndex((cue) => cue.id === selectedCue.id)
        const previous = [...cues.slice(0, Math.max(0, index))].reverse().find(usable)
        const next = cues.slice(index + 1).find(usable)
        targets =
          inactiveMode === 1
            ? previous
              ? [previous]
              : []
            : [previous, next].filter((item): item is SubtitleCue => Boolean(item))
      }
      ctx.strokeStyle = INACTIVE_LINE_COLOR
      ctx.lineWidth = boundaryWidth
      ctx.beginPath()
      for (const cue of targets) {
        for (const timeMs of [cue.startMs, cue.endMs]) {
          const x = Math.round(absXFromTime(timeMs) - scroll)
          if (x < 0 || x >= size.w) continue
          ctx.moveTo(x, audioTop)
          ctx.lineTo(x, audioTop + audioHeight)
        }
      }
      ctx.stroke()
    }

    // ================= 视频帧范围（VideoPositionMarkerProvider） =================
    if (drawVideoPosition && videoTimeMs !== null && durationMs > 0) {
      const frame = Math.max(0, Math.floor(videoTimeMs / frameMs))
      const frameStart = frame * frameMs
      const frameEnd = (frame + 1) * frameMs
      const previousStart = Math.max(0, (frame - 1) * frameMs)
      const drawFrameRange = (startMs: number, endMs: number, color: string) => {
        const x1 = Math.round(absXFromTime(startMs) - scroll) + 1
        const x2 = Math.round(absXFromTime(endMs) - scroll)
        if (x2 < 0 || x1 > size.w) return
        ctx.fillStyle = color
        ctx.fillRect(x1, audioTop, Math.max(1, x2 - x1), audioHeight)
      }
      drawFrameRange(previousStart, frameStart, PREVIOUS_FRAME_COLOR)
      drawFrameRange(frameStart, frameEnd, CURRENT_FRAME_COLOR)
      const videoX = Math.round(absXFromTime(frameStart) - scroll)
      if (videoX >= 0 && videoX < size.w) {
        ctx.strokeStyle = CURSOR_COLOR
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(videoX, audioTop)
        ctx.lineTo(videoX, audioTop + audioHeight)
        ctx.stroke()
      }
    }

    // ================= 行边界标记（AudioMarker + PaintFoot） =================
    if (selectedCue) {
      const drawMarker = (timeMs: number, color: string, dir: number) => {
        const mx = Math.round(absXFromTime(timeMs) - scroll)
        if (mx < -FOOT_SIZE || mx > size.w + FOOT_SIZE) return
        ctx.strokeStyle = color
        ctx.lineWidth = boundaryWidth
        ctx.beginPath()
        ctx.moveTo(mx, audioTop)
        ctx.lineTo(mx, audioTop + audioHeight)
        ctx.stroke()
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(mx + FOOT_SIZE * dir, audioTop)
        ctx.lineTo(mx, audioTop)
        ctx.lineTo(mx, audioTop + FOOT_SIZE)
        ctx.closePath()
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(mx + FOOT_SIZE * dir, audioTop + audioHeight)
        ctx.lineTo(mx, audioTop + audioHeight - FOOT_SIZE)
        ctx.lineTo(mx, audioTop + audioHeight)
        ctx.closePath()
        ctx.fill()
      }
      // 起点标记（红）脚朝右；终点标记（蓝）脚朝左
      drawMarker(selectedCue.startMs, LINE_START, 1)
      drawMarker(selectedCue.endMs, LINE_END, -1)
    }

    // ================= 播放光标（PaintTrackCursor，白色竖线 + 光标时间） =================
    if (durationMs > 0) {
      const cx = Math.round(absXFromTime(currentTimeMs) - scroll)
      if (cx >= 0 && cx < size.w) {
        ctx.strokeStyle = CURSOR_COLOR
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx, audioTop)
        ctx.lineTo(cx, audioTop + audioHeight)
        ctx.stroke()
        // Audio/Display/Draw/Cursor Time：光标处时间标签
        if (drawCursorTime) {
          const label = `${(currentTimeMs / 1000).toFixed(3)}`
          ctx.font = '10px "Segoe UI", sans-serif'
          const labelWidth = ctx.measureText(label).width + 6
          const labelX = cx + 4 + labelWidth > size.w ? cx - labelWidth - 4 : cx + 4
          ctx.fillStyle = UI_DARK
          ctx.globalAlpha = 0.75
          ctx.fillRect(labelX, audioTop + 2, labelWidth, 13)
          ctx.globalAlpha = 1
          ctx.fillStyle = CURSOR_COLOR
          ctx.textBaseline = 'top'
          ctx.textAlign = 'left'
          ctx.fillText(label, labelX + 3, audioTop + 3)
        }
      }
    }

    // ================= 滚动条（AudioDisplayScrollbar::Paint） =================
    {
      const sy = size.h - SCROLLBAR_H
      ctx.fillStyle = UI_DARK
      ctx.fillRect(0, sy, size.w, SCROLLBAR_H)
      ctx.strokeStyle = UI_LIGHT
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, sy + 0.5, size.w - 1, SCROLLBAR_H - 1)
      // 选区范围
      if (selectedCue && durationMs > 0) {
        const ss = Math.round((absXFromTime(selectedCue.startMs) / pixelAudioWidth) * size.w)
        const sl = Math.max(
          1,
          Math.round(
            ((selectedCue.endMs - selectedCue.startMs) / msPerPixel / pixelAudioWidth) * size.w,
          ),
        )
        ctx.fillStyle = UI_SEL
        ctx.fillRect(ss, sy, sl, SCROLLBAR_H)
      }
      // 加载进度标记（audio_display.cpp OnLoadTimer → scrollbar->Paint(dc, focus, audio_load_position)）：
      // 解码未完成时在滚动条上画 25px 宽、Dark→Light 线性渐变标记，右缘 = 滚动条宽度 × 解码前沿占比
      if (data && data.progress > 0 && data.progress < 1) {
        const markerRight = size.w * data.progress
        const markerX = Math.round(markerRight) - 25
        const grad = ctx.createLinearGradient(markerX, 0, markerX + 25, 0)
        grad.addColorStop(0, UI_DARK)
        grad.addColorStop(1, UI_LIGHT)
        ctx.fillStyle = grad
        ctx.fillRect(markerX, sy + 1, 25, SCROLLBAR_H - 2)
      }
      // 滑块（thumb，最小 10px）
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth))
      const thumbX = Math.round((size.w * scroll) / pixelAudioWidth)
      ctx.fillStyle = UI_LIGHT
      ctx.fillRect(thumbX, sy, thumbW, SCROLLBAR_H)
    }

    // 无数据提示
    if (!media) {
      ctx.fillStyle = '#9a9a9a'
      ctx.font = '11px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tPlain('No audio'), size.w / 2, audioTop + audioHeight / 2)
    } else if (media && !data && !unavailable) {
      ctx.fillStyle = '#9a9a9a'
      ctx.font = '11px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tPlain('Decoding audio...'), size.w / 2, audioTop + audioHeight / 2)
    } else if (unavailable) {
      ctx.fillStyle = '#a15d00'
      ctx.font = '11px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tPlain('Waveform unavailable'), size.w / 2, audioTop + audioHeight / 2)
    }
  }

  // 统一异步弃帧优化：rAF 合流，高频失效（拖拽标记/播放推进/滚轮）一帧至多绘制一次
  const drawWaveformRef = useRef(drawWaveform)
  const drawRafRef = useRef(0)
  useEffect(() => {
    drawWaveformRef.current = drawWaveform
    if (drawRafRef.current) return
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0
      drawWaveformRef.current()
    })
    return () => {
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current)
        drawRafRef.current = 0
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    amplitude,
    clampedScroll,
    cues,
    currentTimeMs,
    data,
    durationMs,
    fps,
    karaokeMode,
    keyframes,
    media,
    msPerPixel,
    optionsVersion,
    pixelAudioWidth,
    selectedCue,
    size,
    unavailable,
    videoTimeMs,
    view,
  ])

  // ---- 播放时跟随光标（Audio/Lock Scroll on Cursor） ----
  useEffect(() => {
    if (!getOptionBool('Audio/Lock Scroll on Cursor') || !playing || durationMs <= 0) return
    const cursorX = currentTimeMs / msPerPixel - clampedScroll
    if (cursorX < size.w * 0.1 || cursorX > size.w * 0.9) {
      const target = currentTimeMs / msPerPixel - size.w / 2
      setScrollLeft(Math.min(Math.max(0, target), Math.max(0, pixelAudioWidth - size.w)))
    }
  }, [clampedScroll, currentTimeMs, durationMs, msPerPixel, pixelAudioWidth, playing, size.w])

  // ---- 鼠标滚轮（AudioBox::OnMouseWheel；Audio/Wheel Default to Zoom 决定默认行为） ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const wheelDefaultZoom = getOptionBool('Audio/Wheel Default to Zoom')
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // 默认：滚轮滚动 / Ctrl 缩放；开启选项后反转
      const zoom = event.ctrlKey !== wheelDefaultZoom
      if (zoom) {
        const delta = -Math.sign(event.deltaY)
        wheelZoomRef.current?.(delta)
      } else {
        const max = Math.max(0, pixelAudioWidth - Math.max(1, size.w))
        setScrollLeft((current) => Math.min(Math.max(0, current + event.deltaY), max))
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, pixelAudioWidth])

  // ---- 指针交互 ----
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    event.currentTarget.setPointerCapture(event.pointerId)
    if (y >= size.h - SCROLLBAR_H) {
      if (event.button !== 0) return
      // AudioDisplayScrollbar：左键按下即将 thumb 中心定位到鼠标。
      dragRef.current = { mode: 'scrollbar', startX: x, startScroll: clampedScroll }
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth))
      const shaft = Math.max(1, size.w - thumbW)
      setScrollLeft(Math.min(Math.max(0, ((x - thumbW / 2) / shaft) * maxScroll), maxScroll))
      return
    }
    if (y < TIMELINE_H) {
      if (event.button !== 0) return
      // AudioDisplayTimeline：仅左键拖动滚动。
      dragRef.current = { mode: 'timeline', startX: x, startScroll: clampedScroll }
      return
    }
    const time = Math.max(0, Math.min(durationMs, Math.round((clampedScroll + x) * msPerPixel)))
    if (event.button === 1) {
      // AudioDisplay::OnMouseEvent：中键将视频跳转到指针时间。
      onVideoSeek(time)
      return
    }
    // Audio/Start Drag Sensitivity：标记命中半径（1..15px）
    const sensitivity = getOptionInt('Audio/Start Drag Sensitivity')
    const dragTiming = getOptionBool('Audio/Drag Timing')
    if (selectedCue && y < size.h - SCROLLBAR_H && event.button === 2) {
      onPatchCue(selectedCue.id, { endMs: Math.max(selectedCue.startMs, time) }, 'Set end time')
      dragRef.current = { mode: 'marker', marker: 'end' }
      return
    }
    if (selectedCue && y < size.h - SCROLLBAR_H && event.button === 0) {
      const startX = selectedCue.startMs / msPerPixel - clampedScroll
      const endX = selectedCue.endMs / msPerPixel - clampedScroll
      if (Math.abs(x - startX) <= sensitivity) {
        dragRef.current = { mode: 'marker', marker: 'start' }
        return
      }
      if (Math.abs(x - endX) <= sensitivity) {
        dragRef.current = { mode: 'marker', marker: 'end' }
        return
      }
      // Drag Timing（默认 true）：左键点击设置左标记、拖动右标记；
      // 关闭时左键点击/拖动只移动左（start）标记。
      if (dragTiming) {
        onPatchCue(selectedCue.id, { startMs: Math.min(time, selectedCue.endMs) }, 'Set start time')
        dragRef.current = { mode: 'marker', marker: 'end' }
      } else {
        onPatchCue(selectedCue.id, { startMs: Math.min(time, selectedCue.endMs) }, 'Set start time')
        dragRef.current = { mode: 'marker', marker: 'start' }
      }
      return
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const canvas = canvasRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    if (drag.mode === 'marker' && selectedCue) {
      let time = Math.max(0, Math.min(durationMs, Math.round((clampedScroll + x) * msPerPixel)))
      // Audio/Snap/Enable + Audio/Snap/Distance：拖动标记吸附最近关键帧
      if (getOptionBool('Audio/Snap/Enable') && keyframes.length && fps > 0) {
        const snapDistanceMs = getOptionInt('Audio/Snap/Distance') * msPerPixel
        let best: number | null = null
        let bestDistance = snapDistanceMs
        for (const keyframe of keyframes) {
          const keyframeMs = keyframe * (1000 / fps)
          const distance = Math.abs(keyframeMs - time)
          if (distance <= bestDistance) {
            best = keyframeMs
            bestDistance = distance
          }
        }
        if (best !== null) time = Math.round(best)
      }
      if (drag.marker === 'start') {
        markerCommitRef.current!(
          selectedCue.id,
          { startMs: Math.min(time, selectedCue.endMs) },
          'Adjust start time',
        )
      } else {
        markerCommitRef.current!(
          selectedCue.id,
          { endMs: Math.max(time, selectedCue.startMs) },
          'Adjust end time',
        )
      }
      return
    }
    if (drag.mode === 'marker') return
    let target = drag.startScroll + (x - drag.startX)
    if (drag.mode === 'scrollbar' && maxScroll > 0) {
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth))
      const shaft = Math.max(1, size.w - thumbW)
      target = ((x - thumbW / 2) / shaft) * maxScroll
    }
    scrollThrottleRef.current!(() => setScrollLeft(Math.min(Math.max(0, target), maxScroll)))
  }

  const handlePointerUp = () => {
    dragRef.current = null
    // 冲刷挂起的最终提交（快速拖动在一帧内完成时不丢最后一次 patch）
    markerCommitRef.current?.flush()
    scrollThrottleRef.current?.flush()
  }

  return (
    <div
      className="waveform"
      title={
        unavailable ? tPlain('Waveform unavailable for this media format') : tPlain('Click to seek')
      }
    >
      <canvas
        ref={canvasRef}
        tabIndex={-1}
        onContextMenu={(event) => event.preventDefault()}
        // Audio/Auto/Focus：鼠标悬停时把焦点交给音频显示（热键即时生效）
        onMouseEnter={() => {
          if (getOptionBool('Audio/Auto/Focus')) canvasRef.current?.focus()
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
