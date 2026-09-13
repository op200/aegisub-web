/**
 * WebCodecs 分段音频播放器 —— <audio> 元素无法播放的容器（mkv/avi 等）的回退路径。
 *
 * 对应原版 Aegisub 的 audio_provider 链（audio_provider_ffmpegsource.cpp）：
 * 解封装（web-demuxer）→ AudioDecoder 解码 → AudioBuffer 分段排期（WebAudio 时钟驱动）。
 * 播放区间 [startMs, endMs) 在 play() 时给定（音频计时按行播放的语义，
 * audio_player_audio.cpp 的 PlayRange），进度以 AudioContext.currentTime 推算。
 */
import { AVSeekFlag } from 'web-demuxer'

import { openDemuxer, type DemuxProbe } from './demux'
import { audioDataToChannels } from './pcm'

export interface WebCodecsAudioEvents {
  /** 播放进度（ms，播放区间内） */
  onTime(timeMs: number): void
  /** 到达区间末尾或流结束 */
  onEnd(): void
  onError(message: string): void
}

const SCHEDULE_AHEAD_SEC = 1.2 // 排期超前量
const SCHEDULED_SOURCE_HIGH = 12 // 已排期 source 上限（内存背压）
const DECODE_QUEUE_HIGH = 24

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface ScheduledSource {
  source: AudioBufferSourceNode
  startWhen: number // ctx.currentTime
  endWhen: number
}

export class WebCodecsAudioPlayer {
  private probe: DemuxProbe
  private config: AudioDecoderConfig
  private events: WebCodecsAudioEvents
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private sources: ScheduledSource[] = []
  private decoder: AudioDecoder | null = null
  private reader: ReadableStreamDefaultReader<EncodedAudioChunk> | null = null
  private playingState = false
  /** 本次播放的锚点：anchorMs 对应 anchorWhen（ctx 时钟） */
  private anchorMs = 0
  private anchorWhen = 0
  /** 顺序排期游标：下一个解码块应排期的时间点（ms，播放区间内相对值） */
  private nextStartMs = 0
  private endMs = 0
  private streamDone = false
  private reportRaf = 0
  private generation = 0
  private volume = 1
  private destroyed = false

  private constructor(probe: DemuxProbe, config: AudioDecoderConfig, events: WebCodecsAudioEvents) {
    this.probe = probe
    this.config = config
    this.events = events
  }

  /** 探测并打开：无音频轨 / 编解码不受支持时返回 null */
  static async create(
    file: File,
    events: WebCodecsAudioEvents,
  ): Promise<WebCodecsAudioPlayer | null> {
    // Firefox 130+ 才有 AudioDecoder
    if (typeof AudioDecoder === 'undefined') return null
    let probe: DemuxProbe
    try {
      probe = await openDemuxer(file)
    } catch {
      return null
    }
    try {
      if (!probe.audioStream) {
        probe.demuxer.destroy()
        return null
      }
      const config = await probe.demuxer.getDecoderConfig('audio')
      if (!config?.codec) {
        probe.demuxer.destroy()
        return null
      }
      const support = await AudioDecoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) {
        probe.demuxer.destroy()
        return null
      }
      return new WebCodecsAudioPlayer(probe, config, events)
    } catch {
      probe.demuxer.destroy()
      return null
    }
  }

  get playing(): boolean {
    return this.playingState
  }

  /** 当前播放位置（ms；未播放时为上次停止位置） */
  get currentTime(): number {
    if (!this.context || !this.playingState) return this.anchorMs
    return this.positionMs()
  }

  private positionMs(): number {
    return this.anchorMs + (this.context!.currentTime - this.anchorWhen) * 1000
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.gain) this.gain.gain.value = this.volume
  }

  /** 播放 [startMs, endMs)。可重入：先停掉上一次。 */
  play(startMs: number, endMs: number): void {
    if (this.destroyed) return
    const epoch = ++this.generation
    void this.doPlay(Math.max(0, startMs), Math.max(startMs, endMs), epoch)
  }

  private async doPlay(startMs: number, endMs: number, epoch: number): Promise<void> {
    this.teardownPlayback()
    this.playingState = true
    this.anchorMs = startMs
    this.endMs = endMs
    this.streamDone = false
    try {
      // AudioContext 需要用户手势；play 均由命令/点击触发
      if (!this.context || this.context.state === 'closed') {
        this.context = new AudioContext()
        this.gain = this.context.createGain()
        this.gain.gain.value = this.volume
        this.gain.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') await this.context.resume()
      if (epoch !== this.generation || this.destroyed) return

      // 解码器与读流从目标位置重建
      const decoder = new AudioDecoder({
        output: (ad) => {
          if (epoch !== this.generation) {
            ad.close()
            return
          }
          this.scheduleChunk(ad, epoch)
        },
        error: (error) => {
          if (epoch === this.generation) this.stopWithEnd(error.message)
        },
      })
      decoder.configure(this.config)
      this.decoder = decoder
      const stream = this.probe.demuxer.read(
        'audio',
        startMs / 1000,
        undefined,
        AVSeekFlag.AVSEEK_FLAG_BACKWARD,
      )
      const reader = stream.getReader()
      this.reader = reader
      this.nextStartMs = startMs
      // 排期锚点留一点启动余量，避免首块立即过期
      this.anchorWhen = this.context.currentTime + 0.06

      this.startReporter()
      for (;;) {
        if (epoch !== this.generation || this.destroyed) return
        if (this.nextStartMs >= endMs) {
          // 区间排期已满：读完排期后即视为结束（reporter 兜底）
          void reader.cancel().catch(() => undefined)
          this.reader = null
          await decoder.flush().catch(() => undefined)
          if (epoch === this.generation) this.streamDone = true
          return
        }
        const { done, value } = await reader.read()
        if (epoch !== this.generation || this.destroyed) return
        if (done || !value) {
          this.streamDone = true
          await decoder.flush().catch(() => undefined)
          return
        }
        try {
          decoder.decode(value)
        } catch (error) {
          // EncodedAudioChunk 由 GC 回收（无 close）
          this.stopWithEnd(error instanceof Error ? error.message : 'Audio decode failed')
          return
        }
        // 背压：按时间水位（排期超前 1.2s）+ 已排期 source 数 + 解码队列
        while (
          epoch === this.generation &&
          !this.destroyed &&
          (this.sources.length >= SCHEDULED_SOURCE_HIGH ||
            decoder.decodeQueueSize > DECODE_QUEUE_HIGH ||
            this.nextStartMs - Math.min(this.endMs, this.positionMs()) >= SCHEDULE_AHEAD_SEC * 1000)
        ) {
          await sleep(8)
        }
      }
    } catch (error) {
      if (epoch === this.generation) {
        this.stopWithEnd(error instanceof Error ? error.message : 'Audio playback failed')
      }
    }
  }

  /** AudioData → AudioBuffer 按顺序排期（时间戳不信任，避免容器 gap 造成爆音） */
  private scheduleChunk(ad: AudioData, epoch: number): void {
    try {
      const context = this.context
      if (!context || epoch !== this.generation || this.destroyed) {
        ad.close()
        return
      }
      if (this.nextStartMs >= this.endMs) {
        ad.close()
        return
      }
      const channels = audioDataToChannels(ad)
      const frames = ad.numberOfFrames
      const chunkMs = (frames / (ad.sampleRate || this.config.sampleRate || 48000)) * 1000
      const buffer = context.createBuffer(
        Math.min(channels.length, 8),
        Math.max(1, frames),
        ad.sampleRate || 48000,
      )
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        buffer.copyToChannel(channels[channel] ?? new Float32Array(frames), channel)
      }
      const when = this.anchorWhen + (this.nextStartMs - this.anchorMs) / 1000
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.gain!)
      source.start(Math.max(when, context.currentTime + 0.005))
      const endWhen = Math.max(when, context.currentTime + 0.005) + buffer.duration
      this.sources.push({ source, startWhen: endWhen - buffer.duration, endWhen })
      this.nextStartMs += chunkMs
      // 清理已播完的 source
      const now = context.currentTime
      if (this.sources.length > 4) {
        this.sources = this.sources.filter((item) => item.endWhen > now - 0.5)
      }
    } finally {
      ad.close()
    }
  }

  /** 进度上报 + 结束检测（rAF 循环，播放期间运行） */
  private startReporter(): void {
    cancelAnimationFrame(this.reportRaf)
    const epoch = this.generation
    const tick = () => {
      if (epoch !== this.generation || this.destroyed || !this.context) return
      const position = Math.min(this.endMs, Math.max(this.anchorMs, this.positionMs()))
      this.events.onTime(position)
      const scheduledEnd = this.sources.length ? this.sources[this.sources.length - 1].endWhen : 0
      const drained =
        this.streamDone && (!scheduledEnd || this.context.currentTime >= scheduledEnd - 0.02)
      if (position >= this.endMs - 20 || drained) {
        const finalPosition = drained ? Math.max(this.anchorMs, position) : this.endMs
        this.stopInternal()
        this.anchorMs = finalPosition
        this.events.onTime(finalPosition)
        this.events.onEnd()
        return
      }
      this.reportRaf = requestAnimationFrame(tick)
    }
    this.reportRaf = requestAnimationFrame(tick)
  }

  /** 停止播放（保留实例与 AudioContext） */
  stop(): void {
    if (!this.playingState) return
    const position = this.context
      ? Math.min(this.endMs, Math.max(this.anchorMs, this.positionMs()))
      : this.anchorMs
    this.stopInternal()
    this.anchorMs = position
  }

  private stopWithEnd(message: string): void {
    this.stopInternal()
    this.events.onError(message)
    this.events.onEnd()
  }

  /** 停掉排期与读流（playingState=false，进度锚点保留） */
  private stopInternal(): void {
    this.playingState = false
    this.generation += 1
    cancelAnimationFrame(this.reportRaf)
    for (const item of this.sources) {
      try {
        item.source.stop()
      } catch {
        // 未开始的 source stop 会抛错，忽略
      }
      item.source.disconnect()
    }
    this.sources = []
    if (this.reader) {
      const reader = this.reader
      this.reader = null
      void reader.cancel().catch(() => undefined)
    }
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        // 已关闭
      }
      this.decoder = null
    }
    this.streamDone = false
  }

  private teardownPlayback(): void {
    this.stopInternal()
  }

  destroy(): void {
    this.destroyed = true
    this.stopInternal()
    if (this.gain) {
      this.gain.disconnect()
      this.gain = null
    }
    if (this.context) {
      void this.context.close().catch(() => undefined)
      this.context = null
    }
    this.probe.demuxer.destroy()
  }
}
