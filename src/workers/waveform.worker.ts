/// <reference lib="webworker" />

interface WaveformRequest {
  samples?: Float32Array
  durationMs?: number
  buckets: number
  /** 合成音频（dummy-audio:silence|noise）：不传 samples，直接生成峰值/频谱 */
  synthetic?: { kind: 'blank' | 'noise' }
}

interface SpectrumResult {
  width: number
  height: number
  data: Uint8Array
  msPerColumn: number
  sampleRate: number
}

interface WaveformResponse {
  durationMs: number
  peakMin: Float32Array
  peakMax: Float32Array
  /** 每桶平均振幅（Audio/Display/Waveform Style = Maximum + Average 时渲染） */
  peakAvg: Float32Array
  spectrum: SpectrumResult | null
}

/** 就地 radix-2 迭代 FFT（正变换，未归一化） */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

// 频谱派生档位（audio_display.cpp Quality 1 + FFTW 2 → 档 3：width=9/distance=6）
const SPEC_SIZE = 9
const SPEC_DIST = 6
// 与 audioPeaks.ts SPECTRUM_MAX_BYTES 一致（256MB 折算列数上限）
const SPEC_MAX_BYTES = 256 * 1024 * 1024
const SYNTHETIC_SAMPLE_RATE = 48000

/** 派生参数升级（update_derivation_values：>50kHz 逐倍升档） */
function derivation(sampleRate: number): {
  size: number
  dist: number
  fftLength: number
  nbrBins: number
  half: number
} {
  let size = SPEC_SIZE
  let dist = SPEC_DIST
  let mult = sampleRate / 50000
  while (mult > 1) {
    size++
    dist++
    mult *= 0.5
  }
  return { size, dist, fftLength: 2 << size, nbrBins: 1 << size, half: 1 << size }
}

/** FillBlock 幅值映射：log10(sqrt(re²+im²) * 9/sqrt(2·N) + 1) → 0..255 */
function fillBrick(
  re: Float32Array,
  im: Float32Array,
  data: Uint8Array,
  base: number,
  nbrBins: number,
  scale: number,
): void {
  for (let bin = 0; bin < nbrBins; bin++) {
    const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) * scale
    const value = Math.round(Math.log10(mag + 1) * 255)
    data[base + bin] = value > 255 ? 255 : value < 0 ? 0 : value
  }
}

/** 列布局：目标 2^dist 样本一列，受内存上限约束 */
function columnLayout(
  durationMs: number,
  sampleRate: number,
  requestedColumns: number,
  nbrBins: number,
  dist: number,
) {
  const totalSamples = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const maxColumns = Math.max(1, Math.floor(SPEC_MAX_BYTES / nbrBins))
  const columns = Math.max(
    1,
    Math.min(
      Math.ceil(totalSamples / (1 << dist)),
      Math.min(Math.max(1, requestedColumns), maxColumns),
    ),
  )
  return { columns, msPerColumn: durationMs / columns }
}

/** 真实样本频谱：brick b 的 FFT 窗 = 样本 [b·stride − half, b·stride + half)，矩形窗 */
function computeSpectrum(
  samples: Float32Array,
  buckets: number,
  durationMs: number,
  sampleRate: number,
): SpectrumResult {
  const { size, dist, fftLength, nbrBins, half } = derivation(sampleRate)
  void size
  const stride = Math.max(1 << dist, Math.ceil(samples.length / Math.max(1, buckets)))
  const requested = Math.max(1, Math.ceil(samples.length / stride))
  const { columns, msPerColumn } = columnLayout(durationMs, sampleRate, requested, nbrBins, dist)
  const data = new Uint8Array(columns * nbrBins)
  const re = new Float32Array(fftLength)
  const im = new Float32Array(fftLength)
  const scale = 9 / Math.sqrt(2 * fftLength)
  for (let col = 0; col < columns; col++) {
    const first = Math.round(col * (samples.length / columns)) - half
    for (let i = 0; i < fftLength; i++) {
      const pos = first + i
      re[i] = pos >= 0 && pos < samples.length ? samples[pos] : 0
      im[i] = 0
    }
    fft(re, im)
    fillBrick(re, im, data, col * nbrBins, nbrBins, scale)
  }
  return { width: columns, height: nbrBins, data, msPerColumn, sampleRate }
}

/** 合成噪声频谱：每列一段新鲜白噪声窗口做 FFT（不物化长时间样本） */
function computeNoiseSpectrum(
  buckets: number,
  durationMs: number,
  sampleRate: number,
): SpectrumResult {
  const { size, dist, fftLength, nbrBins } = derivation(sampleRate)
  void size
  const { columns, msPerColumn } = columnLayout(durationMs, sampleRate, buckets, nbrBins, dist)
  const data = new Uint8Array(columns * nbrBins)
  const re = new Float32Array(fftLength)
  const im = new Float32Array(fftLength)
  const scale = 9 / Math.sqrt(2 * fftLength)
  for (let col = 0; col < columns; col++) {
    for (let i = 0; i < fftLength; i++) {
      re[i] = Math.random() * 2 - 1
      im[i] = 0
    }
    fft(re, im)
    fillBrick(re, im, data, col * nbrBins, nbrBins, scale)
  }
  return { width: columns, height: nbrBins, data, msPerColumn, sampleRate }
}

/** 合成静音频谱：全 0 */
function computeBlankSpectrum(
  buckets: number,
  durationMs: number,
  sampleRate: number,
): SpectrumResult {
  const { size, dist, fftLength, nbrBins } = derivation(sampleRate)
  void size
  void fftLength
  const { columns, msPerColumn } = columnLayout(durationMs, sampleRate, buckets, nbrBins, dist)
  return {
    width: columns,
    height: nbrBins,
    data: new Uint8Array(columns * nbrBins),
    msPerColumn,
    sampleRate,
  }
}

self.onmessage = ({ data }: MessageEvent<WaveformRequest>) => {
  // 合成音频：不物化 samples
  if (data.synthetic) {
    const { kind } = data.synthetic
    const buckets = data.buckets
    const peakMin = new Float32Array(buckets)
    const peakMax = new Float32Array(buckets)
    const peakAvg = new Float32Array(buckets)
    let spectrum: SpectrumResult
    if (kind === 'noise') {
      for (let b = 0; b < buckets; b++) {
        peakMin[b] = -(0.4 + Math.random() * 0.6)
        peakMax[b] = 0.4 + Math.random() * 0.6
      }
      spectrum = computeNoiseSpectrum(buckets, data.durationMs ?? 0, SYNTHETIC_SAMPLE_RATE)
    } else {
      // blank：峰值全 0，频谱全 0
      spectrum = computeBlankSpectrum(buckets, data.durationMs ?? 0, SYNTHETIC_SAMPLE_RATE)
    }
    const response: WaveformResponse = {
      durationMs: data.durationMs ?? 0,
      peakMin,
      peakMax,
      peakAvg,
      spectrum,
    }
    self.postMessage(response, [
      peakMin.buffer,
      peakMax.buffer,
      peakAvg.buffer,
      spectrum.data.buffer,
    ])
    return
  }

  const samples = data.samples ?? new Float32Array(0)
  const bucketSize = Math.max(1, Math.ceil(samples.length / data.buckets))
  const bucketCount = Math.ceil(samples.length / bucketSize)
  const peakMin = new Float32Array(bucketCount)
  const peakMax = new Float32Array(bucketCount)
  const peakAvg = new Float32Array(bucketCount)
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    let minimum = 0
    let maximum = 0
    let sum = 0
    const end = Math.min(samples.length, (bucket + 1) * bucketSize)
    for (let index = bucket * bucketSize; index < end; index++) {
      const sample = samples[index]
      minimum = Math.min(minimum, sample)
      maximum = Math.max(maximum, sample)
      sum += sample
    }
    peakMin[bucket] = minimum
    peakMax[bucket] = maximum
    peakAvg[bucket] = sum / Math.max(1, end - bucket * bucketSize)
  }
  const response: WaveformResponse = {
    durationMs: data.durationMs ?? 0,
    peakMin,
    peakMax,
    peakAvg,
    spectrum: computeSpectrum(samples, data.buckets, data.durationMs ?? 0, SYNTHETIC_SAMPLE_RATE),
  }
  const transfer: Transferable[] = [peakMin.buffer, peakMax.buffer, peakAvg.buffer]
  if (response.spectrum) transfer.push(response.spectrum.data.buffer)
  self.postMessage(response, transfer)
}
