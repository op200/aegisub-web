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
import { WebDemuxer, AVSeekFlag, AVMediaType } from 'web-demuxer'
import type { WebAVStream, WebMediaInfo } from 'web-demuxer'
import demuxerWasmAsset from 'web-demuxer/wasm?url'

// web-demuxer 的 worker 由 blob URL 创建（内嵌 base64 脚本），blob: 无层次路径，
// worker 内 fetch 相对/根相对 URL 会 "Failed to parse URL" —— 必须先解析为绝对 URL
const demuxerWasmUrl = new URL(demuxerWasmAsset, globalThis.location.href).href

export { AVSeekFlag, AVMediaType }
export type { WebAVStream, WebMediaInfo }

export interface DemuxProbe {
  demuxer: WebDemuxer
  info: WebMediaInfo
  videoStream: WebAVStream | null
  audioStream: WebAVStream | null
}

/** '24000/1001' → 23.976（vfr.cpp 的有理数帧率） */
export function parseFraction(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num) || num <= 0) return 0
  const divisor = Number.isFinite(den) && den > 0 ? den : 1
  return num / divisor
}

/** 打开文件并读取头信息（容器不支持时抛错） */
export async function openDemuxer(file: File): Promise<DemuxProbe> {
  const demuxer = new WebDemuxer({ wasmFilePath: demuxerWasmUrl })
  try {
    await demuxer.load(file)
    const info = await demuxer.getMediaInfo()
    const streams = (info.streams ?? []) as WebAVStream[]
    return {
      demuxer,
      info,
      videoStream:
        streams.find((stream) => stream.codec_type === AVMediaType.AVMEDIA_TYPE_VIDEO) ?? null,
      audioStream:
        streams.find((stream) => stream.codec_type === AVMediaType.AVMEDIA_TYPE_AUDIO) ?? null,
    }
  } catch (error) {
    demuxer.destroy()
    throw error
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
 */
export async function extractVideoKeyframes(
  file: File,
  onProgress: (timesMs: number[]) => void,
  isStale: () => boolean,
): Promise<void> {
  const demuxer = new WebDemuxer({ wasmFilePath: demuxerWasmUrl })
  try {
    await demuxer.load(file)
    if (isStale()) return
    const info = await demuxer.getMediaInfo()
    const streams = (info.streams ?? []) as WebAVStream[]
    if (!streams.some((stream) => stream.codec_type === AVMediaType.AVMEDIA_TYPE_VIDEO)) return
    const found: number[] = []
    let reported = 0
    const reader = demuxer.readMediaPacket('video').getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (isStale()) return
      if (value.keyframe) {
        found.push(value.timestamp * 1000)
        if (found.length - reported >= 32) {
          reported = found.length
          onProgress(found.slice())
        }
      }
    }
    if (!isStale() && found.length > reported) onProgress(found.slice())
  } finally {
    demuxer.destroy()
  }
}
