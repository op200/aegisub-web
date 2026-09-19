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
import { WebDemuxer, AVMediaType } from 'web-demuxer'
import type { WebAVStream, WebMediaInfo } from 'web-demuxer'
import demuxerWasmAsset from 'web-demuxer/wasm?url'

import type { PeaksWorkerResponse } from './peaks.worker'

// web-demuxer 的 worker 由 blob URL 创建（内嵌 base64 脚本），blob: 无层次路径，
// worker 内 fetch 相对/根相对 URL 会 "Failed to parse URL" —— 必须先解析为绝对 URL
const demuxerWasmUrl = new URL(demuxerWasmAsset, globalThis.location.href).href

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
      worker.postMessage({ kind: 'video-scan', file })
    })
  } finally {
    worker.terminate()
  }
}
