/**
 * web-demuxer（ffmpeg WASM）解复用封装 —— mkv/mp4/webm 等容器的统一入口。
 *
 * 对应原版 Aegisub 的 FFMS2 provider 链（src/video_provider_ffmpegsource.cpp /
 * src/audio_provider_ffmpegsource.cpp）中的"解封装"层：浏览器 <video>/<audio> 无法
 * 播放的容器（mkv 等）由此拆出音视频包，再交给 WebCodecs 解码。
 *
 * 注意：web-demuxer 的 d.ts 无 default export（只能 named import），
 * info.streams 类型不精确，需断言为 WebAVStream[]。
 */
// 仅类型导入：web-demuxer 主模块在打开文件时动态加载，避免进首屏 chunk
import type {
  AVMediaType,
  AVSeekFlag,
  WebAVPacket,
  WebAVStream,
  WebDemuxer,
  WebMediaInfo,
} from 'web-demuxer'
import demuxerWasmAsset from 'web-demuxer/wasm?url'

import type { PeaksWorkerResponse } from './peaks.worker'

// web-demuxer 的 worker 由 blob URL 创建（内嵌 base64 脚本），blob: 无层次路径，
// worker 内 fetch 相对/根相对 URL 会 "Failed to parse URL" —— 必须先解析为绝对 URL
const demuxerWasmUrl = new URL(demuxerWasmAsset, globalThis.location.href).href

/**
 * AVSeekFlag.AVSEEK_FLAG_BACKWARD（ffmpeg 枚举值 1，向目标时间前最近的关键帧 seek）。
 * 用常量替代运行时枚举：避免把整个 web-demuxer 静态打进首屏 chunk。
 */
export const AVSEEK_FLAG_BACKWARD = 1 as AVSeekFlag

/** AVMediaType.AVMEDIA_TYPE_VIDEO（ffmpeg 枚举值 0；同上，避免运行时导入枚举） */
export const AVMEDIA_TYPE_VIDEO = 0 as AVMediaType

/** AVMediaType.AVMEDIA_TYPE_AUDIO（ffmpeg 枚举值 1） */
export const AVMEDIA_TYPE_AUDIO = 1 as AVMediaType

export interface DemuxProbe {
  demuxer: WebDemuxer
  info: WebMediaInfo
  streams: WebAVStream[]
  videoStream: WebAVStream | null
  audioStream: WebAVStream | null
}

/** 多轨道选择（ffmpegsource_common.cpp GetTracksOfType 的描述） */
export interface MediaTrackInfo {
  index: number
  kind: 'video' | 'audio'
  codec: string
  /** FFMS2 风格的 “codec - language - title” */
  description: string
  width: number
  height: number
  channels: number
  sampleRate: number
}

function trackDescription(stream: WebAVStream): string {
  const parts = [stream.codec_name || stream.codec_string || 'unknown']
  const tags = stream.tags ?? {}
  const language = tags.language || tags.LANGUAGE
  const title = tags.title || tags.TITLE
  if (language && language !== 'und') parts.push(language)
  if (title) parts.push(title)
  return parts.join(' - ')
}

/** 列出容器内全部视频/音频轨（视频打开前用于多轨选择） */
export async function listMediaTracks(
  file: File,
): Promise<{ videos: MediaTrackInfo[]; audios: MediaTrackInfo[] }> {
  const probe = await openDemuxer(file)
  try {
    const videos: MediaTrackInfo[] = []
    const audios: MediaTrackInfo[] = []
    for (const stream of probe.streams) {
      if (stream.codec_type === AVMEDIA_TYPE_VIDEO) {
        videos.push({
          index: stream.index,
          kind: 'video',
          codec: stream.codec_name || '',
          description: trackDescription(stream),
          width: stream.width || 0,
          height: stream.height || 0,
          channels: 0,
          sampleRate: 0,
        })
      } else if (stream.codec_type === AVMEDIA_TYPE_AUDIO) {
        audios.push({
          index: stream.index,
          kind: 'audio',
          codec: stream.codec_name || '',
          description: trackDescription(stream),
          width: 0,
          height: 0,
          channels: stream.channels || 0,
          sampleRate: stream.sample_rate || 0,
        })
      }
    }
    return { videos, audios }
  } finally {
    probe.demuxer.destroy()
  }
}

/** 按选定流读取解码包并转换为 WebCodecs chunk（streamIndex 缺省 = 首条该类型流） */
export function readEncodedChunks(
  demuxer: WebDemuxer,
  type: 'video' | 'audio',
  startSec: number,
  streamIndex?: number,
  seekFlag?: AVSeekFlag,
): ReadableStream<EncodedVideoChunk | EncodedAudioChunk> {
  const mediaType = type === 'video' ? AVMEDIA_TYPE_VIDEO : AVMEDIA_TYPE_AUDIO
  const packets = demuxer.readAVPacket(
    Math.max(0, startSec),
    undefined,
    mediaType,
    streamIndex,
    seekFlag,
  )
  return packets.pipeThrough(
    new TransformStream<WebAVPacket, EncodedVideoChunk | EncodedAudioChunk>({
      transform(packet, controller) {
        controller.enqueue(demuxer.genEncodedChunk(type, packet))
      },
    }),
  )
}

/** '24000/1001' → 23.976（vfr.cpp 的有理数帧率） */
export function parseFraction(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num) || num <= 0) return 0
  const divisor = Number.isFinite(den) && den > 0 ? den : 1
  return num / divisor
}

/** 打开文件并读取头信息（容器不支持时抛错）；可指定视频/音频流索引（多轨选择） */
export async function openDemuxer(
  file: File,
  options: { videoStreamIndex?: number; audioStreamIndex?: number } = {},
): Promise<DemuxProbe> {
  const { WebDemuxer, AVMediaType } = await import('web-demuxer')
  const demuxer = new WebDemuxer({ wasmFilePath: demuxerWasmUrl })
  try {
    await demuxer.load(file)
    const info = await demuxer.getMediaInfo()
    const streams = (info.streams ?? []) as WebAVStream[]
    const pick = (type: number, index: number | undefined) =>
      (index !== undefined ? streams.find((stream) => stream.index === index) : undefined) ??
      streams.find((stream) => stream.codec_type === type) ??
      null
    return {
      demuxer,
      info,
      streams,
      videoStream: pick(AVMediaType.AVMEDIA_TYPE_VIDEO, options.videoStreamIndex),
      audioStream: pick(AVMediaType.AVMEDIA_TYPE_AUDIO, options.audioStreamIndex),
    }
  } catch (error) {
    demuxer.destroy()
    throw error
  }
}

/** 视频流头信息（probeVideoInfo 结果；对应 FFMS2 建索引时读到的流属性） */
export interface VideoStreamInfo {
  /** 编码尺寸（coded；显示尺寸由 <video>.videoWidth 给出） */
  width: number
  height: number
  /** 容器标称帧率（avg_frame_rate → r_frame_rate），无法解析为 0 */
  fps: number
  /** ffmpeg color_space 名（'bt709' / 'smpte170m' / 'unknown' …） */
  colorSpace: string
  /** ffmpeg color_range 名（'tv' / 'pc' / 'unknown' …） */
  colorRange: string
  /** ffmpeg color_primaries 名（'bt709' / 'bt2020' …；HDR 检测） */
  colorPrimaries: string
  /** ffmpeg color_transfer 名（'smpte2084' / 'arib-std-b67' …；HDR 检测） */
  colorTransfer: string
  /** 显示宽高（旋转后；用于 PlayRes/LayoutRes 比较） */
  displayWidth: number
  displayHeight: number
}

/**
 * 只读容器头（不扫包）取视频流属性：帧率 + 色彩空间。
 *
 * 替代原 requestVideoFrameCallback 播放探测（曾造成"载入后播放约一秒再回第一帧"）：
 * 源码的帧率来自 FFMS2 索引进程读到的流属性，而非播放采样；
 * 播放采样还会把 UI 推进播放态，与源码"载入即暂停"不符。
 */
export async function probeVideoInfo(
  file: File,
  videoStreamIndex?: number,
): Promise<VideoStreamInfo | null> {
  let probe: DemuxProbe | null = null
  try {
    probe = await openDemuxer(file, { videoStreamIndex })
    const stream = probe.videoStream
    if (!stream) return null
    // AsyncVideoProvider::GetDisplayResolution：
    // 旋转 90/270 交换宽高；DAR 来自 display_aspect_ratio / sample_aspect_ratio
    const codedWidth = stream.width || 0
    const codedHeight = stream.height || 0
    const rotated = Math.abs((stream.rotation || 0) % 180) === 90
    const width = rotated ? codedHeight : codedWidth
    const height = rotated ? codedWidth : codedHeight
    let dar = parseFraction(stream.display_aspect_ratio)
    if (!dar && codedHeight > 0) {
      const sar = parseFraction(stream.sample_aspect_ratio)
      dar = sar > 0 ? (codedWidth * sar) / codedHeight : codedWidth / codedHeight
    }
    if (rotated && dar > 0) dar = 1 / dar
    const sar = width > 0 && height > 0 ? width / height : 0
    const displayWidth = dar > 0 && sar > 0 ? Math.round(width * Math.max(1, dar / sar)) : width
    const displayHeight = dar > 0 && sar > 0 ? Math.round(height * Math.max(1, sar / dar)) : height
    return {
      width,
      height,
      fps: parseFraction(stream.avg_frame_rate) || parseFraction(stream.r_frame_rate),
      colorSpace: stream.color_space ?? '',
      colorRange: stream.color_range ?? '',
      colorPrimaries: stream.color_primaries ?? '',
      colorTransfer: stream.color_transfer ?? '',
      displayWidth,
      displayHeight,
    }
  } catch {
    // 容器打不开时保持默认（24fps / 未标记色彩空间），不影响视频播放
    return null
  } finally {
    probe?.demuxer.destroy()
  }
}

/** 文件容器是否需要（或值得）走解复用解码路径 */
export function needsDemuxFallback(name: string): boolean {
  return /\.(mkv|m2ts|ts|avi)$/i.test(name)
}

/**
 * 扫描视频流关键帧时间（project.cpp：FFMS2 provider 建索引时提供 keyframes，是文件的
 * 属性而非解码器的——浏览器原生 <video> 路径拿不到 chunk 类型，必须独立解复用扫描）。
 * 渐进上报全量列表（每 ≥32 个或流结束），timesMs 为毫秒；isStale 返回 true 时中止。
 *
 * 同时收集全部视频包 PTS 毫秒（onFrameTimes）——对应 FFMS2
 * video_provider_ffmpegsource.cpp 的 TimecodesVector：逐帧 `(PTS * TimeBase->Num) /
 * TimeBase->Den`（毫秒截断）后 Framerate(TimecodesVector) 建表，源码视频的"帧率"
 * 实为逐帧时间码表而非标量 CFR。
 *
 * 扫描在 peaks.worker 后台线程执行（FFMS2 索引线程语义）：数万视频包的 read 循环
 * 不再占用主线程，与拖动/渲染并行；isStale 命中时立即 terminate。
 */
export async function extractVideoKeyframes(
  file: File,
  onProgress: (timesMs: number[]) => void,
  isStale: () => boolean,
  onFrameTimes?: (framesMs: number[]) => void,
  videoStreamIndex?: number,
): Promise<void> {
  const worker = new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<PeaksWorkerResponse>) => {
        if (isStale()) {
          worker.terminate()
          resolve()
          return
        }
        if (data.type === 'keyframes') onProgress(data.timesMs)
        else if (data.type === 'frameTimes') onFrameTimes?.(data.framesMs)
        else if (data.type === 'scan-done') {
          worker.terminate()
          resolve()
        } else if (data.type === 'error') {
          worker.terminate()
          reject(new Error(data.message))
        }
      }
      worker.onerror = (event) => {
        worker.terminate()
        reject(new Error(event.message || 'Video scan worker failed to load'))
      }
      worker.postMessage({ kind: 'video-scan', file, videoStreamIndex })
    })
  } finally {
    worker.terminate()
  }
}
