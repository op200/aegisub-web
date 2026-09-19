/// <reference lib="webworker" />
/**
 * 后台索引 worker —— 对应原版 FFMS2 的独立索引线程（audio_provider_ffmpegsource.cpp /
 * video_provider_ffmpegsource.cpp 在后台线程建索引，界面全程可交互）。
 *
 * 三类任务（每个 worker 实例跑一个任务，主线程用完即弃）：
 * 1. audio-demux：web-demuxer 拆音频包 + AudioDecoder 流式解码 + StreamAnalyzer
 *    峰值/频谱分析，分析成本全部落在 worker；进度以增量切片（新提交的桶/brick）上报，
 *    主线程装配成渐进快照驱动波形/频谱渐进绘制。
 * 2. audio-pcm：decodeAudioData 快路径解码出的多声道 PCM（主线程解码后转移过来）
 *    混音 + 分析。
 * 3. video-scan：解复用扫描视频关键帧 + 全部视频包 PTS（App 的后台索引 +
 *    demux.ts extractVideoKeyframes 的 worker 化）。
 */
import './workerWindow'
import { AVSeekFlag, AVMediaType } from 'web-demuxer'
import type { WebAVStream } from 'web-demuxer'

import { ptsToMs } from '../core/vfr'
import { openDemuxer } from './demux'
import { audioDataToMono } from './pcm'
import { finalize, StreamAnalyzer } from './peakAnalyzer'

interface AudioDemuxJob {
  kind: 'audio-demux'
  file: File
}

interface AudioPcmJob {
  kind: 'audio-pcm'
  channels: Float32Array[]
  sampleRate: number
  durationMs: number
}

interface VideoScanJob {
  kind: 'video-scan'
  file: File
}

type Job = AudioDemuxJob | AudioPcmJob | VideoScanJob

/** 进度消息：新提交的桶/brick 增量切片（bFrom/kFrom 为起始于全局布局的偏移） */
interface ProgressMsg {
  type: 'progress'
  progress: number
  bFrom: number
  min: Float32Array
  max: Float32Array
  avg: Float32Array
  kFrom: number
  kData: Uint8Array | null
}

interface MetaMsg {
  type: 'meta'
  durationMs: number
  buckets: number
  columns: number
  nbrBins: number
  msPerColumn: number
  sampleRate: number
}

interface DoneMsg {
  type: 'done'
  durationMs: number
  peakMin: Float32Array
  peakMax: Float32Array
  peakAvg: Float32Array
  spectrum: {
    width: number
    height: number
    data: Uint8Array
    msPerColumn: number
    sampleRate: number
  } | null
}

interface KeyframesMsg {
  type: 'keyframes'
  timesMs: number[]
}

interface FrameTimesMsg {
  type: 'frameTimes'
  framesMs: number[]
}

interface ErrorMsg {
  type: 'error'
  message: string
}

/** video-scan 完成（无音频载荷） */
interface ScanDoneMsg {
  type: 'scan-done'
}

type Response =
  | MetaMsg
  | ProgressMsg
  | DoneMsg
  | KeyframesMsg
  | FrameTimesMsg
  | ScanDoneMsg
  | ErrorMsg

/** 主线程装配侧的类型引用（仅类型导入，不构成运行时依赖） */
export type PeaksWorkerResponse = Response

const post = (msg: Response, transfer: Transferable[] = []) =>
  self.postMessage(msg, transfer as ArrayBuffer[])

// ---------------------------------------------------------------------------
// 音频：demux + WebCodecs 解码 + 分析（全部在 worker 内）
// ---------------------------------------------------------------------------
async function runAudioDemux(file: File): Promise<void> {
  const probe = await openDemuxer(file)
  try {
    if (!probe.audioStream) throw new Error('No audio track')
    const config = await probe.demuxer.getDecoderConfig('audio')
    if (!config?.codec) throw new Error('Unsupported audio codec')
    const support = await AudioDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported)
      throw new Error(`Audio codec ${config.codec} is not supported by WebCodecs`)
    const durationMs = Math.round(
      ((probe.info.duration && probe.info.duration > 0
        ? probe.info.duration
        : probe.audioStream.duration) || 0) * 1000,
    )
    const analyzer = new StreamAnalyzer(config.sampleRate, durationMs)
    // 主线程 live buffer 按此容量一次性分配；后续 ensure() 扩容（时间戳越界等
    // 边界情况）不得超报——超出会让主线程 TypedArray.set 抛 RangeError
    const capBuckets = analyzer.peakMin.length
    post({
      type: 'meta',
      durationMs,
      buckets: capBuckets,
      columns: analyzer.spectrum?.width ?? 0,
      nbrBins: analyzer.brickBins,
      msPerColumn: analyzer.spectrum?.msPerColumn ?? 0,
      sampleRate: config.sampleRate,
    })
    // 增量上报游标（桶与 brick 均为单调推进，切片即可覆盖全部新写入）
    let reportedBuckets = 0
    let reportedBricks = 0
    let lastReport = performance.now()
    const report = (force: boolean) => {
      const now = performance.now()
      if (!force && now - lastReport < 200) return
      lastReport = now
      const bFrom = reportedBuckets
      const bCount = Math.max(0, Math.min(analyzer.committedBuckets, capBuckets) - reportedBuckets)
      const kFrom = reportedBricks
      const kCount = analyzer.committedBricks - reportedBricks
      const nbrBins = analyzer.brickBins
      reportedBuckets += bCount
      reportedBricks += kCount
      post({
        type: 'progress',
        progress: analyzer.progress,
        bFrom,
        min: analyzer.peakMin.slice(bFrom, bFrom + bCount),
        max: analyzer.peakMax.slice(bFrom, bFrom + bCount),
        avg: analyzer.peakAvg.slice(bFrom, bFrom + bCount),
        kFrom,
        kData:
          analyzer.spectrum && kCount > 0
            ? analyzer.spectrum.data.slice(kFrom * nbrBins, (kFrom + kCount) * nbrBins)
            : null,
      })
    }
    // FFMS2（audio_provider_ffmpegsource.cpp）按解码输出顺序线性供样。
    // 不能用容器时间戳定位：web-demuxer 对部分 mkv 音轨的包 ts 大多为 0、少数跳变，
    // 按 ts 摆放会在波形上打出大段静音空洞。
    let writePos = 0
    const decoder = new AudioDecoder({
      output: (ad) => {
        const mono = audioDataToMono(ad)
        analyzer.push(mono, writePos)
        writePos += mono.length
        ad.close()
        report(false)
      },
      error: () => undefined,
    })
    decoder.configure(config)
    const stream = probe.demuxer.read('audio', 0, undefined, AVSeekFlag.AVSEEK_FLAG_BACKWARD)
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      try {
        decoder.decode(value)
      } catch {
        // EncodedAudioChunk 由 GC 回收（无 close）；解码失败即结束
        break
      }
      // 背压：解码队列满时等待（worker 内 sleep 不阻塞主线程）
      while (decoder.decodeQueueSize > 24) await new Promise((resolve) => setTimeout(resolve, 8))
    }
    await decoder.flush()
    decoder.close()
    report(true)
    const peaks = finalize(analyzer, durationMs, 1)
    const transfer: Transferable[] = [
      peaks.peakMin.buffer,
      peaks.peakMax.buffer,
      peaks.peakAvg.buffer,
    ]
    if (peaks.spectrum) transfer.push(peaks.spectrum.data.buffer)
    post(
      {
        type: 'done',
        durationMs,
        peakMin: peaks.peakMin,
        peakMax: peaks.peakMax,
        peakAvg: peaks.peakAvg,
        spectrum: peaks.spectrum,
      },
      transfer,
    )
  } finally {
    probe.demuxer.destroy()
  }
}

// ---------------------------------------------------------------------------
// 音频：decodeAudioData 快路径的 PCM 分析（解码留在主线程——AudioContext 不可入 worker）
// ---------------------------------------------------------------------------
function runAudioPcm(job: AudioPcmJob): void {
  const { channels, sampleRate, durationMs } = job
  const analyzer = new StreamAnalyzer(sampleRate, durationMs)
  const length = channels[0]?.length ?? 0
  const count = channels.length
  const chunk = 1 << 20
  for (let start = 0; start < length; start += chunk) {
    const size = Math.min(chunk, length - start)
    const mono = new Float32Array(size)
    for (let channel = 0; channel < count; channel++) {
      const data = channels[channel]
      for (let index = 0; index < size; index++) mono[index] += data[start + index] / count
    }
    analyzer.push(mono, start)
  }
  const peaks = finalize(analyzer, durationMs, 1)
  const transfer: Transferable[] = [
    peaks.peakMin.buffer,
    peaks.peakMax.buffer,
    peaks.peakAvg.buffer,
  ]
  if (peaks.spectrum) transfer.push(peaks.spectrum.data.buffer)
  post(
    {
      type: 'done',
      durationMs,
      peakMin: peaks.peakMin,
      peakMax: peaks.peakMax,
      peakAvg: peaks.peakAvg,
      spectrum: peaks.spectrum,
    },
    transfer,
  )
}

// ---------------------------------------------------------------------------
// 视频：关键帧 + 全部视频包 PTS 扫描（demux.ts extractVideoKeyframes 的 worker 化）
// ---------------------------------------------------------------------------
async function runVideoScan(file: File): Promise<void> {
  const demuxer = (await openDemuxer(file)).demuxer
  try {
    const info = await demuxer.getMediaInfo()
    const streams = (info.streams ?? []) as WebAVStream[]
    if (!streams.some((stream) => stream.codec_type === AVMediaType.AVMEDIA_TYPE_VIDEO)) {
      post({ type: 'scan-done' })
      return
    }
    const found: number[] = []
    const frameTimes: number[] = []
    let reported = 0
    const reader = demuxer.readMediaPacket('video').getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // (int)((PTS * TimeBase->Num) / TimeBase->Den)：毫秒截断（浮点补偿见 ptsToMs）
      frameTimes.push(ptsToMs(value.timestamp))
      if (value.keyframe) {
        found.push(ptsToMs(value.timestamp))
        if (found.length - reported >= 32) {
          reported = found.length
          post({ type: 'keyframes', timesMs: found.slice() })
        }
      }
    }
    if (found.length > reported) post({ type: 'keyframes', timesMs: found.slice() })
    // 包按封装（解码）顺序到来，B 帧会乱序；FFMS2 索引按显示序——升序排序后建表。
    // 全 0 / 单包的畸形容器不产出（调用方回退 CFR 探测）
    if (frameTimes.length >= 2) {
      const sorted = [...frameTimes].sort((a, b) => a - b)
      if (sorted[sorted.length - 1] > 0) post({ type: 'frameTimes', framesMs: sorted })
    }
    post({ type: 'scan-done' })
  } finally {
    demuxer.destroy()
  }
}

self.onmessage = async ({ data }: MessageEvent<Job>) => {
  try {
    if (data.kind === 'audio-demux') await runAudioDemux(data.file)
    else if (data.kind === 'audio-pcm') runAudioPcm(data)
    else if (data.kind === 'video-scan') await runVideoScan(data.file)
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
