/**
 * WebCodecs 视频渲染源 —— <video> 元素无法播放的容器（mkv/avi 等）的回退路径。
 *
 * 对应原版 Aegisub 的 video_provider（async_video_provider.cpp 的异步解码语义）：
 * 解封装（web-demuxer）→ VideoDecoder 解码 → canvas 逐帧上屏；
 * seek 从目标时间前最近的关键帧开始解码到目标帧（与 libav 的 AVSEEK_FLAG_BACKWARD 一致）。
 */
import { AVSeekFlag } from 'web-demuxer'

import { openDemuxer, parseFraction, type DemuxProbe } from './demux'

export interface WebCodecsVideoEvents {
  onDurationChange(durationMs: number): void
  onIntrinsicSize(width: number, height: number): void
  onFrameRate(fps: number): void
  onPlaying(playing: boolean): void
  onTimeUpdate(timeMs: number): void
  onError(message: string): void
  /** 关键帧时间（ms，增量上报全量列表；对应原版视频 provider 的 keyframes） */
  onKeyframes?(timesMs: number[]): void
}

const FRAME_BUFFER_HIGH = 24 // 已解码帧缓冲上限（内存背压）
const DECODE_QUEUE_HIGH = 32 // 解码器排队上限

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface WebCodecsVideoOpenResult {
  source: WebCodecsVideoSource | null
  /** source 为 null 时的失败原因（界面提示 + 诊断；如浏览器不支持 WebCodecs / 编解码不支持） */
  reason: string
}

export class WebCodecsVideoSource {
  private probe: DemuxProbe
  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private events: WebCodecsVideoEvents
  private decoder: VideoDecoder
  private reader: ReadableStreamDefaultReader<EncodedVideoChunk> | null = null
  /** 解码输出（呈现顺序），drawUpTo 消费 */
  private frames: VideoFrame[] = []
  private streamDone = false
  private readingAhead = false
  private seekJob: Promise<void> = Promise.resolve()
  private raf = 0
  private playingState = false
  private playStartMs = 0
  private playStartWall = 0
  private currentTimeUs = 0
  private durationMs = 0
  private destroyed = false
  /** 首个解码帧的原始 PTS（µs）。对外时间线以"首帧 = 0"归一化——FFMS2 的
   *  Framerate(TimecodesVector) 会把 timecodes.front() 平移到 0（normalize_timecodes），
   *  桌面版 seek 又按帧号进行；web 按 seek 按时间走，必须与归一化时间码表同一时间线，
   *  否则容器首帧 PTS ≠ 0 时（mkv 时延/MP4 edit list）帧号整体错位。 */
  private baseUs: number | null = null
  /** 已发现关键帧（ms，升序）；读流时从 chunk.type === 'key' 收集 */
  private keyframeMs: number[] = []
  private keyframeReported = 0

  private constructor(probe: DemuxProbe, canvas: HTMLCanvasElement, events: WebCodecsVideoEvents) {
    this.probe = probe
    this.canvas = canvas
    this.events = events
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable')
    this.context = context
    this.decoder = new VideoDecoder({
      output: (frame) => {
        // VideoFrame 必须手动 close（Encoded*Chunk 才是 GC 回收）；未消费帧见 closeAllFrames
        if (this.destroyed) {
          frame.close()
          return
        }
        if (this.baseUs === null) this.baseUs = frame.timestamp
        this.frames.push(frame)
      },
      error: (error) => this.events.onError(error.message),
    })
  }

  /** 探测并打开：失败时返回 { source: null, reason }（reason 用于界面提示与诊断） */
  static async create(
    file: File,
    canvas: HTMLCanvasElement,
    events: WebCodecsVideoEvents,
  ): Promise<WebCodecsVideoOpenResult> {
    if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return {
        source: null,
        reason: '此浏览器不支持 WebCodecs（Firefox 需要 130+，旧版/移动版不支持）',
      }
    }
    let probe: DemuxProbe
    try {
      probe = await openDemuxer(file)
    } catch (error) {
      return {
        source: null,
        reason: `解封装失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    try {
      if (!probe.videoStream) {
        probe.demuxer.destroy()
        return { source: null, reason: '容器中没有视频轨' }
      }
      const config = await probe.demuxer.getDecoderConfig('video')
      if (!config || !config.codec) {
        probe.demuxer.destroy()
        return { source: null, reason: '无法获取视频解码配置' }
      }
      const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) {
        probe.demuxer.destroy()
        return {
          source: null,
          reason: `此浏览器不支持解码 ${config.codec}（Firefox 的 HEVC 需要 134+ 且依赖系统；10bit H.264 多数浏览器不支持）`,
        }
      }
      const source = new WebCodecsVideoSource(probe, canvas, events)
      await source.open(config, probe)
      return { source, reason: '' }
    } catch (error) {
      probe.demuxer.destroy()
      return { source: null, reason: error instanceof Error ? error.message : '打开视频解码器失败' }
    }
  }

  private async open(config: VideoDecoderConfig, probe: DemuxProbe): Promise<void> {
    const stream = probe.videoStream!
    const width = stream.width || config.codedWidth || 640
    const height = stream.height || config.codedHeight || 360
    this.canvas.width = width
    this.canvas.height = height
    this.durationMs = Math.round(
      ((probe.info.duration && probe.info.duration > 0 ? probe.info.duration : stream.duration) ||
        0) * 1000,
    )
    this.events.onDurationChange(this.durationMs)
    this.events.onIntrinsicSize(width, height)
    const fps = parseFraction(stream.avg_frame_rate) || parseFraction(stream.r_frame_rate) || 24
    this.events.onFrameRate(fps)
    this.decoder.configure(config)
    // 打开即建读流（reader 仅由 restartReader 创建，doSeek 之外必须显式建立，
    // 否则 showFirstFrame/播放 pumpChunk 拿不到数据 → 永久黑屏卡 0）
    await this.restartReader(0)
    // <video preload="metadata"> 会呈现首帧；回退路径同样解码并绘制首帧，避免打开后是黑画布
    await this.showFirstFrame()
  }

  /** 解码并绘制首帧；10s 无输出视为解码器不可用（错误经 onError 上报） */
  private async showFirstFrame(): Promise<void> {
    const deadline = performance.now() + 10000
    for (;;) {
      if (this.destroyed) return
      if (this.frames.length > 0) break
      if (performance.now() > deadline) {
        this.events.onError('解码首帧超时（解码器无输出，可能被系统/驱动拒绝）')
        return
      }
      const ok = await this.pumpChunk()
      if (!ok) return // 流结束或已由 onError 上报
      if (this.decoder.decodeQueueSize > 0) await sleep(0)
    }
    while (this.decoder.decodeQueueSize > 0 && !this.destroyed) await sleep(4)
    if (this.destroyed || !this.frames.length) return
    this.drawUpTo(this.frames[0].timestamp)
    this.flushKeyframes()
    // 首帧 PTS 已知：以归一化时间线重报时长（open 时容器时长含首帧前偏移）
    if (this.baseUs !== null && this.baseUs > 0)
      this.events.onDurationChange(Math.max(0, this.durationMs - this.baseMs))
  }

  get duration(): number {
    return Math.max(0, this.durationMs - this.baseMs)
  }

  get playing(): boolean {
    return this.playingState
  }

  /** 首帧 PTS（ms）；首个解码帧出现前为 0 */
  private get baseMs(): number {
    return (this.baseUs ?? 0) / 1000
  }

  /** 对外当前位置（ms，归一化时间线） */
  private get currentTimeMs(): number {
    return Math.max(0, (this.currentTimeUs - (this.baseUs ?? 0)) / 1000)
  }

  /** 对外只读当前位置（ms，归一化时间线；内部 currentTimeUs 为原始 PTS） */
  get currentTime(): number {
    return this.currentTimeMs
  }

  toggle(): void {
    if (this.playingState) this.pause()
    else this.play()
  }

  play(): void {
    if (this.destroyed || this.playingState) return
    if (this.streamDone && !this.frames.length) {
      // 播放到结尾后再播放：重新 seek 到当前位置起流，随后继续播放
      this.seek(this.currentTimeMs)
      this.seekJob = this.seekJob.then(() => {
        if (!this.destroyed && !this.playingState) this.play()
      })
      return
    }
    this.playStartMs = this.currentTimeUs / 1000
    this.playStartWall = performance.now()
    this.playingState = true
    this.events.onPlaying(true)
    const tick = () => {
      if (!this.playingState || this.destroyed) return
      const nowMs = this.playStartMs + (performance.now() - this.playStartWall)
      void this.pumpAhead()
      this.drawUpTo(Math.round(nowMs * 1000))
      this.events.onTimeUpdate(this.currentTimeMs)
      if (this.streamDone && !this.frames.length) {
        // 流结束且缓冲耗尽：停在结尾
        this.playingState = false
        this.events.onPlaying(false)
        if (this.durationMs > 0) {
          this.currentTimeUs = this.durationMs * 1000
          this.events.onTimeUpdate(this.duration)
        }
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  pause(): void {
    if (!this.playingState) return
    this.playingState = false
    cancelAnimationFrame(this.raf)
    this.events.onPlaying(false)
    this.events.onTimeUpdate(this.currentTimeMs)
  }

  /** seek（可重入，串行执行）：从目标前关键帧解码到目标帧。
   *  入参为归一化时间线（首帧 = 0）；内部换回原始 PTS 再驱动解复用器 */
  seek(timeMs: number): void {
    if (this.destroyed) return
    const target = Math.max(0, Math.min(this.duration || timeMs, timeMs))
    this.seekJob = this.seekJob.then(() => this.doSeek(target + this.baseMs)).catch(() => undefined)
  }

  private async doSeek(targetMs: number): Promise<void> {
    const wasPlaying = this.playingState
    this.playingState = false
    cancelAnimationFrame(this.raf)
    this.events.onPlaying(false)
    const targetUs = Math.round(targetMs * 1000)
    await this.restartReader(targetMs / 1000)
    this.closeAllFrames()
    // 解码到出现 ≥ 目标时间的帧（起点为关键帧，之间全部可用于绘制）
    for (;;) {
      if (this.destroyed) return
      if (this.frames.some((frame) => frame.timestamp >= targetUs)) break
      const ok = await this.pumpChunk()
      if (!ok) break
      if (this.decoder.decodeQueueSize > 0 && !this.frames.length) await sleep(0)
    }
    while (this.decoder.decodeQueueSize > 0 && !this.destroyed) await sleep(4)
    // 目标时间早于首帧时（如 seek 0）也至少显示首帧（<video> seek 语义）
    const firstTs = this.frames[0]?.timestamp
    this.drawUpTo(Math.max(targetUs, firstTs ?? targetUs))
    this.closeAllFrames()
    this.flushKeyframes()
    // 停在请求时间（帧间隙内取不到精确帧；与 <video>.currentTime 语义一致，
    // 也避免暂停同步 effect 因差值 ≥ 帧时长而反复 seek）
    this.currentTimeUs = targetUs
    if (wasPlaying) this.play()
    else this.events.onTimeUpdate(this.currentTimeMs)
  }

  destroy(): void {
    this.destroyed = true
    this.playingState = false
    cancelAnimationFrame(this.raf)
    void this.reader?.cancel().catch(() => undefined)
    this.reader = null
    this.closeAllFrames()
    try {
      this.decoder.close()
    } catch {
      // 已关闭
    }
    this.probe.demuxer.destroy()
  }

  private async restartReader(startSec: number): Promise<void> {
    if (this.reader) {
      const previous = this.reader
      this.reader = null
      await previous.cancel().catch(() => undefined)
    }
    const stream = this.probe.demuxer.read(
      'video',
      Math.max(0, startSec),
      undefined,
      AVSeekFlag.AVSEEK_FLAG_BACKWARD,
    )
    this.reader = stream.getReader()
    this.streamDone = false
  }

  /** 读一个包并送入解码器；false = 流结束或被取代 */
  private async pumpChunk(): Promise<boolean> {
    const reader = this.reader
    if (!reader || this.destroyed) return false
    const { done, value } = await reader.read()
    if (this.reader !== reader) return false
    if (done || !value) {
      this.streamDone = true
      return false
    }
    if (value.type === 'key') this.collectKeyframe(value.timestamp / 1000)
    try {
      this.decoder.decode(value)
    } catch (error) {
      // EncodedVideoChunk 由 GC 回收（无 close）
      this.events.onError(error instanceof Error ? error.message : 'Video decode failed')
      return false
    }
    return true
  }

  /** 收集关键帧时间并增量上报（升序去重） */
  private collectKeyframe(timeMs: number): void {
    if (!this.events.onKeyframes) return
    const list = this.keyframeMs
    if (list.length && timeMs <= list[list.length - 1]) return
    list.push(timeMs)
    // 每新增 16 个关键帧上报一次（避免逐帧触发 React setState）
    if (list.length - this.keyframeReported >= 16) {
      this.keyframeReported = list.length
      this.events.onKeyframes(list.slice())
    }
  }

  /** 流尾/寻址结束后把剩余关键帧补报出去 */
  private flushKeyframes(): void {
    if (this.events.onKeyframes && this.keyframeMs.length > this.keyframeReported) {
      this.keyframeReported = this.keyframeMs.length
      this.events.onKeyframes(this.keyframeMs.slice())
    }
  }

  /** 播放期间按水位持续喂数据（背压：帧缓冲 + 解码队列） */
  private async pumpAhead(): Promise<void> {
    if (this.readingAhead) return
    this.readingAhead = true
    try {
      while (this.playingState && !this.streamDone && !this.destroyed) {
        if (
          this.frames.length >= FRAME_BUFFER_HIGH ||
          this.decoder.decodeQueueSize >= DECODE_QUEUE_HIGH
        ) {
          await sleep(8)
          continue
        }
        const ok = await this.pumpChunk()
        if (!ok) break
      }
    } finally {
      this.readingAhead = false
    }
  }

  /** 绘制 ≤ displayUs 的最后一帧，丢弃更早的帧（保留之后的供后续绘制） */
  private drawUpTo(displayUs: number): void {
    let drawIndex = -1
    for (let index = 0; index < this.frames.length; index++) {
      if (this.frames[index].timestamp <= displayUs) drawIndex = index
      else break
    }
    if (drawIndex >= 0) {
      const frame = this.frames[drawIndex]
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth
        this.canvas.height = frame.displayHeight
      }
      this.context.drawImage(frame, 0, 0)
      this.currentTimeUs = Math.max(this.currentTimeUs, frame.timestamp)
      for (let index = 0; index <= drawIndex; index++) this.frames[index].close()
      this.frames.splice(0, drawIndex + 1)
    }
  }

  private closeAllFrames(): void {
    for (const frame of this.frames) frame.close()
    this.frames = []
  }
}
