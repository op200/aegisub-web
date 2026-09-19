/**
 * 流式音频峰值/频谱分析器 —— 波形图与频谱图的数据源（纯计算，无 DOM 依赖，
 * 主线程与 peaks.worker.ts 共用）。
 *
 * 参考 Aegisub 渲染端数据需求（src/audio_renderer_waveform.cpp 每像素 peak、
 * src/audio_renderer_spectrum.cpp FFT 功率块），产出固定时间分辨率的峰值桶
 * （MS_PER_BUCKET）+ 全程频谱 brick（对齐 FillBlock 派生模型）。
 */
import { fft } from './fft'

export interface SpectrumData {
  /** 时间列数 */
  width: number
  /** 频率 bin 数（= 1<<derivation_size，48kHz 时 512） */
  height: number
  /** width*height，0..255（= power*255），列主序（data[col * height + bin]） */
  data: Uint8Array
  /** 每列时长（ms） */
  msPerColumn: number
  /** 音频采样率（频率轴换算） */
  sampleRate: number
}

export interface AudioPeaks {
  durationMs: number
  /** 每个峰值桶的时长（ms） */
  msPerBucket: number
  peakMin: Float32Array
  peakMax: Float32Array
  peakAvg: Float32Array
  spectrum: SpectrumData | null
  /** 流式解码进度 0..1（快路径恒 1） */
  progress: number
}

export const MS_PER_BUCKET = 4
// 频谱 derivation 档位（audio_display.cpp ReloadRenderingSettings）：官方构建（FFTW）对
// Quality 1 +2 → 档 3：width=9、distance=6（FFT 1024 样本 / brick 64 样本 ≈1.33ms @48kHz）
export const SPECTRUM_DERIVATION_SIZE = 9
export const SPECTRUM_DERIVATION_DIST = 6
// brick 存储上限（Uint8/列）。原版 DataBlockCache 用 Audio/Renderer/Spectrum/Memory Max=128MB
// 但按需重算（分辨率恒为 2^dist）；我们全量预烘焙，超限只能拉大列步长（时间分辨率下降）。
// 256MB 下 24min@48kHz 步长 132 样本（≈2.75ms/列，原版 64 样本 1.33ms），显著减小拖影
export const SPECTRUM_MAX_BYTES = 256 * 1024 * 1024

export class StreamAnalyzer {
  readonly sampleRate: number
  readonly durationMs: number
  peakMin: Float32Array
  peakMax: Float32Array
  peakAvg: Float32Array
  private filled: Uint8Array
  private nextSample = 0 // 绝对样本游标
  private bucketCursor = -1 // 当前未完结桶索引
  private curMin = 0
  private curMax = 0
  private sum = 0
  private count = 0
  // 频谱（audio_renderer_spectrum.cpp brick 模型：brick b 的 FFT 窗 = 样本
  // [b*stride - 2^size, b*stride + 2^size)，矩形窗，log10(mag*scale+1) 量化到 0..255）
  readonly spectrum: SpectrumData | null
  private fftLength: number
  private nbrBins: number
  private halfWindow: number
  private derivationSize: number
  private strideSamples: number
  private columns: number
  private ring: Float32Array // 末尾 fftLength 个样本的环形缓冲
  private ringEnd = 0 // 环内绝对样本末尾（exclusive）
  private nextBrick = 0
  private nextBrickEnd = 0 // 下一个 brick 的窗口末样本（nextBrick*stride + half）
  private re: Float32Array
  private im: Float32Array

  constructor(sampleRate: number, durationMs: number) {
    this.sampleRate = sampleRate
    this.durationMs = durationMs
    const buckets = durationMs > 0 ? Math.max(1, Math.ceil(durationMs / MS_PER_BUCKET)) : 65536
    this.peakMin = new Float32Array(buckets)
    this.peakMax = new Float32Array(buckets)
    this.peakAvg = new Float32Array(buckets)
    this.filled = new Uint8Array(buckets)
    if (durationMs > 0) {
      // update_derivation_values：>50kHz 逐倍升档
      let size = SPECTRUM_DERIVATION_SIZE
      let dist = SPECTRUM_DERIVATION_DIST
      let mult = sampleRate / 50000
      while (mult > 1) {
        size++
        dist++
        mult *= 0.5
      }
      this.derivationSize = size
      this.fftLength = 2 << size
      this.nbrBins = 1 << size
      this.halfWindow = 1 << size
      // 列步长：目标 2^dist 样本（≈brick 分辨率），受内存上限约束
      const totalSamples = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
      const maxColumns = Math.max(1, Math.floor(SPECTRUM_MAX_BYTES / this.nbrBins))
      this.columns = Math.max(1, Math.min(Math.ceil(totalSamples / (1 << dist)), maxColumns))
      this.strideSamples = Math.max(1 << dist, Math.ceil(totalSamples / this.columns))
      this.spectrum = {
        width: this.columns,
        height: this.nbrBins,
        data: new Uint8Array(this.columns * this.nbrBins),
        msPerColumn: (this.strideSamples / sampleRate) * 1000,
        sampleRate,
      }
      this.ring = new Float32Array(this.fftLength)
      this.nextBrickEnd = this.halfWindow
      this.re = new Float32Array(this.fftLength)
      this.im = new Float32Array(this.fftLength)
    } else {
      this.columns = 0
      this.derivationSize = SPECTRUM_DERIVATION_SIZE
      this.fftLength = 2 << SPECTRUM_DERIVATION_SIZE
      this.nbrBins = 1 << SPECTRUM_DERIVATION_SIZE
      this.halfWindow = 1 << SPECTRUM_DERIVATION_SIZE
      this.strideSamples = 1 << SPECTRUM_DERIVATION_DIST
      this.spectrum = null
      this.ring = new Float32Array(this.fftLength)
      this.re = new Float32Array(this.fftLength)
      this.im = new Float32Array(this.fftLength)
    }
  }

  /** 追加一段单声道 PCM（absoluteSample 为流内绝对样本位置） */
  push(mono: Float32Array, absoluteSample: number): void {
    const gap = absoluteSample - this.nextSample
    if (gap > this.sampleRate * 0.1) {
      // 时间戳跳变：补静音
      this.fillSilence(this.nextSample, absoluteSample)
    }
    const start = gap < 0 ? -gap : 0 // 负偏移（重叠）直接截掉
    this.nextSample = Math.max(this.nextSample, absoluteSample) + (mono.length - start)
    let index = Math.round(start)
    let samplePos = absoluteSample + index
    const length = mono.length
    // 频谱环形缓冲：逐样本推进并即时提交就绪 brick。
    // 环形缓冲只保留最近 fftLength 个样本，若先整块 append 再统一提交，
    // chunk > fftLength（decodeAudioData 快路径一次 1M 样本、opus 大包 120ms=5760）
    // 时旧窗口数据已被覆盖，brick 会读到陈旧样本产生周期性伪影
    const mask = this.fftLength - 1
    while (this.ringEnd < samplePos) {
      this.ring[this.ringEnd & mask] = 0 // 小间隙补零
      this.ringEnd++
      this.commitReadyBricks()
    }
    for (let k = index; k < length; k++) {
      this.ring[this.ringEnd & mask] = mono[k]
      this.ringEnd++
      this.commitReadyBricks()
    }
    while (index < length) {
      const bucket = Math.floor((samplePos * 1000) / this.sampleRate / MS_PER_BUCKET)
      const boundary = ((bucket + 1) * MS_PER_BUCKET * this.sampleRate) / 1000
      const take = Math.min(length - index, Math.max(1, Math.ceil(boundary) - samplePos))
      let mn = this.curMin
      let mx = this.curMax
      let sum = this.sum
      for (let k = 0; k < take; k++) {
        const value = mono[index + k]
        if (value < mn) mn = value
        if (value > mx) mx = value
        sum += value
      }
      this.curMin = mn
      this.curMax = mx
      this.sum = sum
      this.count += take
      index += take
      samplePos += take
      // 桶完结（到达边界）→ 落盘
      if (samplePos >= boundary - 1e-9) {
        this.commitBucket(bucket)
      }
    }
  }

  /** 补静音区间（时间戳跳变） */
  private fillSilence(fromSample: number, toSample: number): void {
    const fromBucket = Math.floor((fromSample * 1000) / this.sampleRate / MS_PER_BUCKET)
    const toBucket = Math.floor((toSample * 1000) / this.sampleRate / MS_PER_BUCKET)
    this.commitBucket(
      this.bucketCursor < 0 ? fromBucket - 1 : Math.max(this.bucketCursor, fromBucket - 1),
    )
    this.ensure(toBucket + 1)
    for (
      let bucket = Math.max(0, fromBucket);
      bucket < Math.min(toBucket, this.peakMin.length);
      bucket++
    ) {
      if (!this.filled[bucket]) {
        this.filled[bucket] = 1
        this.peakAvg[bucket] = 0
      }
    }
    if (this.spectrum) {
      // 静音区间：环形缓冲补零 + 逐样本提交就绪 brick
      const mask = this.fftLength - 1
      while (this.ringEnd < toSample) {
        this.ring[this.ringEnd & mask] = 0
        this.ringEnd++
        this.commitReadyBricks()
      }
    }
  }

  /** 提交所有窗口已完整进入环形缓冲的 brick（窗口末 = brick*stride + half ≤ ringEnd） */
  private commitReadyBricks(): void {
    while (this.spectrum && this.nextBrick < this.columns && this.ringEnd >= this.nextBrickEnd) {
      this.commitBrick(this.nextBrick++)
      this.nextBrickEnd += this.strideSamples
    }
  }

  private commitBucket(bucket: number): void {
    if (this.bucketCursor >= 0 && this.count > 0) {
      this.ensure(this.bucketCursor + 1)
      this.peakMin[this.bucketCursor] = this.curMin
      this.peakMax[this.bucketCursor] = this.curMax
      this.peakAvg[this.bucketCursor] = this.sum / this.count
      this.filled[this.bucketCursor] = 1
    }
    // 跳过的空桶补零
    const from = Math.max(0, this.bucketCursor + 1)
    this.ensure(bucket + 1)
    for (let b = from; b <= bucket && b < this.filled.length; b++) {
      if (!this.filled[b]) {
        this.filled[b] = 1
        this.peakAvg[b] = 0
      }
    }
    this.bucketCursor = bucket
    this.curMin = 0
    this.curMax = 0
    this.sum = 0
    this.count = 0
  }

  private ensure(size: number): void {
    if (size <= this.peakMin.length) return
    let capacity = this.peakMin.length
    while (capacity < size) capacity *= 2
    const grow = (old: Float32Array) => {
      const next = new Float32Array(capacity)
      next.set(old)
      return next
    }
    this.peakMin = grow(this.peakMin)
    this.peakMax = grow(this.peakMax)
    this.peakAvg = grow(this.peakAvg)
    const filled = new Uint8Array(capacity)
    filled.set(this.filled)
    this.filled = filled
  }

  /** FillBlock：brick b = FFT(样本 [b*stride - 2^size, b*stride + 2^size))，log10(mag*scale+1) */
  private commitBrick(brick: number): void {
    const spectrum = this.spectrum
    if (!spectrum || brick >= spectrum.width) return
    const mask = this.fftLength - 1
    const first = brick * this.strideSamples - this.halfWindow // 窗起点，可为负（补零）
    for (let i = 0; i < this.fftLength; i++) {
      const pos = first + i
      this.re[i] = pos >= 0 && pos < this.ringEnd ? this.ring[pos & mask] : 0
      this.im[i] = 0
    }
    fft(this.re, this.im)
    // FillBlock 的 scale_factor：scale_fix * 9 / sqrt(2 * fftLength)
    const scaleFix = 1 / Math.sqrt(2 ** (this.derivationSize - SPECTRUM_DERIVATION_SIZE))
    const scaleFactor = (scaleFix * 9) / Math.sqrt(2 * this.fftLength)
    const base = brick * this.nbrBins
    for (let bin = 0; bin < this.nbrBins; bin++) {
      const mag = Math.sqrt(this.re[bin] * this.re[bin] + this.im[bin] * this.im[bin]) * scaleFactor
      const value = Math.round(Math.log10(mag + 1) * 255)
      spectrum.data[base + bin] = value > 255 ? 255 : value < 0 ? 0 : value
    }
  }

  /** 完结并裁剪 */
  finish(): { peakMin: Float32Array; peakMax: Float32Array; peakAvg: Float32Array } {
    this.commitBucket(Math.floor((this.nextSample * 1000) / this.sampleRate / MS_PER_BUCKET))
    // 末尾不足整窗的 brick：原版 GetAudio 越界补零照常计算，这里窗口读不到的部分
    // 在 commitBrick 内已按 0 处理，直接全部提交，避免音频结尾残留静音列
    if (this.spectrum) {
      while (this.nextBrick < this.columns) this.commitBrick(this.nextBrick++)
    }
    const size = this.bucketCursor + 1
    return {
      peakMin: this.peakMin.slice(0, Math.max(1, size)),
      peakMax: this.peakMax.slice(0, Math.max(1, size)),
      peakAvg: this.peakAvg.slice(0, Math.max(1, size)),
    }
  }

  get progress(): number {
    if (this.durationMs <= 0) return 0
    return Math.min(1, ((this.nextSample / this.sampleRate) * 1000) / this.durationMs)
  }

  /** 已完结桶数（高水位，用于 worker 增量上报） */
  get committedBuckets(): number {
    return this.bucketCursor + 1
  }

  /** 已提交 brick 数（高水位，用于 worker 增量上报） */
  get committedBricks(): number {
    return this.nextBrick
  }

  get brickBins(): number {
    return this.nbrBins
  }
}

/** 完结收口（progress=1） */
export function finalize(
  analyzer: StreamAnalyzer,
  durationMs: number,
  progress: number,
): AudioPeaks {
  const peaks = analyzer.finish()
  return {
    durationMs,
    msPerBucket: MS_PER_BUCKET,
    ...peaks,
    spectrum: analyzer.spectrum,
    progress,
  }
}
